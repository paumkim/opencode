import { createHash } from "node:crypto"

export interface ProgressOptions {
  enabled?: boolean
  repeat_turns?: number
  recovery_turns?: number
}

export type Observation = {
  tool: string
  input: unknown
  status: "completed" | "error"
  result: unknown
}

// Tool inputs/results are JSON data. Sort object keys, retaining full arguments
// (including search queries and read ranges); store only fixed-size digests.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

export function observationSignature(value: Observation): string {
  return createHash("sha256").update(stable(value)).digest("hex")
}

export const PROGRESS_NUDGE = "The recent turns have produced no new successful observations. Do not repeat the same checks. Use the findings already available, try a different permitted check that answers a specific unresolved question, or ask the user a focused question and stop. Research does not require file edits. Do not bypass permissions or run risky commands to demonstrate progress. Continued repetition will stop this run."
export const PROGRESS_STOP = "OpenCode stopped this run because repeated observations continued without new evidence after a recovery nudge. The task may be incomplete; review the findings above or provide new input to resume. No additional model request was made to generate this notice."

/** Owned by one prompt run, not one processor handle or a global session map. */
export class ObservableProgress {
  // Non-evicting Bloom filter: 64 KiB per prompt run, four 32-bit hash probes.
  // No false negatives for previously successful observations, regardless of
  // batch/cycle size. False positives conservatively withhold progress credit
  // (about 0.00009% at 4096 unique successes; saturation can nudge novel work).
  // Reset only for real user input. Failures never enter or churn this history.
  static readonly historyBytes = 64 * 1024
  private readonly history = new Uint8Array(ObservableProgress.historyBytes)
  private repeats = 0
  private loopRemaining: number | undefined
  private userID: string | undefined
  private readonly enabled: boolean
  private readonly repeatTurns: number
  private readonly recoveryTurns: number

  constructor(options: ProgressOptions = {}) {
    this.enabled = options.enabled !== false
    this.repeatTurns = options.repeat_turns ?? 3
    this.recoveryTurns = options.recovery_turns ?? 2
  }

  // Undefined means compaction hid the real user, not a new user. Callers must
  // exclude synthetic nudges/continuations and compaction parts from this ID.
  user(id: string | undefined) {
    if (id === undefined || id === this.userID) return
    this.userID = id
    this.history.fill(0)
    this.repeats = 0
    this.loopRemaining = undefined
  }

  turn(observations: readonly Observation[], loopDetected = false): "continue" | "nudge" | "stop" {
    let changed = false
    for (const observation of observations) {
      if (observation.status !== "completed") continue
      const signature = observationSignature(observation)
      for (let i = 0; i < 4; i++) {
        const bit = Number.parseInt(signature.slice(i * 8, i * 8 + 8), 16) % (this.history.length * 8)
        const byte = bit >>> 3
        const mask = 1 << (bit & 7)
        if (!(this.history[byte] & mask)) changed = true
        this.history[byte] |= mask
      }
    }
    // Existing content-loop signals get one nudge and at most recoveryTurns
    // further non-final turns, even if the detector goes quiet during recovery.
    // This is independent of the observation opt-out. New evidence can recover,
    // but cannot mask a simultaneously asserted real loop signal.
    if (changed && !loopDetected) this.loopRemaining = undefined
    if (this.loopRemaining !== undefined) {
      this.loopRemaining--
      return this.loopRemaining <= 0 ? "stop" : "continue"
    }
    if (loopDetected) {
      this.loopRemaining = this.recoveryTurns
      return "nudge"
    }
    if (!this.enabled || observations.length === 0) return "continue"
    // Failed edit attempts (even with different arguments/errors) cannot buy
    // unlimited recovery. Successful changing read/search results can.
    if (changed) {
      this.repeats = 0
      return "continue"
    }
    this.repeats++
    if (this.repeats >= this.repeatTurns + this.recoveryTurns) return "stop"
    if (this.repeats === this.repeatTurns) return "nudge"
    return "continue"
  }
}
