import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { errorMessage } from "@/util/error"

const INTERVAL = 30_000
// Above this, run a normal collection. Well below the hard limit so ordinary
// long sessions shed their garbage instead of climbing until something breaks.
const SOFT_LIMIT = 1536 * 1024 * 1024
// Above this, force a full collection and capture a snapshot for diagnosis.
const LIMIT = 2 * 1024 * 1024 * 1024
// After a forced collection, leave the heap alone for a while so a genuinely
// large working set does not turn into a GC every interval.
const COOLDOWN = 5 * INTERVAL

let timer: Timer | undefined
let lock = false
let armed = true
let cooledAt = 0

/**
 * Reclaims heap under sustained memory pressure.
 *
 * This previously only wrote a heap snapshot once RSS crossed the limit, which
 * is not a remedy: the snapshot is written through `node:v8`, but Bun runs
 * JavaScriptCore, so it captures nothing useful and, more importantly, nothing
 * ever gave memory back. A long session that accumulated garbage kept every byte
 * until the process was killed. Collecting first and snapshotting only when the
 * hard limit is still exceeded means the snapshot is of a trimmed heap, which is
 * both cheaper and more representative.
 */
export function start(overrides: Partial<HeapHooks> = {}) {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return
  const writeSnapshot = overrides.writeSnapshot ?? ((file: string) => writeHeapSnapshot(file))

  const collect = (aggressive: boolean) => {
    // Bun.gc is the only lever that actually returns memory under Bun; the v8
    // snapshot API is a no-op for JSC. Guard anyway so a runtime without it
    // degrades to the previous behaviour rather than throwing on a timer.
    try {
      ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(aggressive)
    } catch {
      // Collection is best effort.
    }
  }

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= SOFT_LIMIT) {
      armed = true
      return
    }

    const now = Date.now()
    if (now - cooledAt < COOLDOWN) return

    lock = true
    try {
      collect(stat.rss > LIMIT)

      const after = process.memoryUsage()
      if (after.rss <= LIMIT) {
        cooledAt = Date.now()
        return
      }

      if (!armed) return
      armed = false
      const file = path.join(
        Global.Path.log,
        `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
      )
      // The snapshot is the whole point of this path and the user is expected to go find it and
      // attach it, so a failure has to say so. Silently swallowing it produced the worst version of
      // this bug: the process was still over the hard limit after a forced collection, nothing was
      // written, nothing was logged, and the one artefact that would explain the OOM did not exist.
      //
      // `armed` is already false, so this is not retried - reporting it is the only record there
      // will be. `writeHeapSnapshot` goes through node:v8, which is a no-op under Bun's
      // JavaScriptCore, so it is worth saying *which* runtime produced the failure.
      await reportSnapshotFailure(writeSnapshot, file, after.rss)
    } finally {
      lock = false
    }
  }

  timer = setInterval(() => {
    void run()
  }, INTERVAL)
  timer.unref?.()
}

/**
 * Writes the snapshot, reporting a failure rather than letting it vanish.
 *
 * This is the only record the process will leave: `armed` is already false by the time this runs, so
 * the snapshot is never retried. The process is simultaneously over the hard limit after a forced
 * collection, so this line is the sole evidence that the OOM was seen and the capture failed.
 *
 * The message carries the file and the post-collection RSS on purpose. A user who attaches "the
 * heap snapshot opencode mentioned" needs to learn that no such file exists, where it was going to
 * be, and that memory was still over the limit when the attempt failed - which are three different
 * questions and all of them are answerable only here.
 *
 * Exported so the branch is reachable from a test: the watchdog runs on a 30s timer behind a
 * feature flag, so there is no other way to drive it.
 */
export async function reportSnapshotFailure(write: (file: string) => unknown, file: string, rss: number) {
  try {
    await write(file)
  } catch (error) {
    console.error(
      `[heap] memory is still over the limit after a forced collection (${rss} bytes) and the heap snapshot could not be written to ${file}: ${errorMessage(error)}`,
    )
  }
}

/**
 * The side-effecting pieces of the watchdog, injectable so the snapshot-failure path is reachable
 * from a test. Both are process-global by nature - a timer and a v8 call - so there is no other way
 * to drive the branch where a snapshot is attempted at all.
 */
export interface HeapHooks {
  /**
   * Defaults to `writeHeapSnapshot`, which returns the path it wrote. The return value is ignored;
   * only a rejection or a throw is a failure.
   */
  writeSnapshot(file: string): unknown
}

export * as Heap from "./heap"
