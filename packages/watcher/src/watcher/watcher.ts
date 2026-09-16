// Silent Watcher Agent
// Monitors active opencode sessions and detects stalls/hangs.
// Uses TF-IDF + Logistic Regression — pure TypeScript, zero runtime deps.

import modelData from "./model.json" with { type: "json" }

// ── Types ──────────────────────────────────────────────────────

export const Status = ["RUNNING", "STALLED", "UNKNOWN"] as const
export type Status = (typeof Status)[number]

export interface WatchResult {
  readonly sessionID: string
  readonly title: string
  readonly status: Status
  readonly summary: string
  readonly secondsSinceUpdate: number
}

// ── Model ──────────────────────────────────────────────────────

interface ModelData {
  vocab: Record<string, number>
  idf: number[]
  coef: number[][]
  intercept: number[]
  classes: string[]
}

const model = modelData as unknown as ModelData

// ── TF-IDF Vectorization ──────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

function getNgrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "))
  }
  return ngrams
}

function transformTFIDF(text: string): number[] {
  const tokens = tokenize(text)
  const features: string[] = []
  for (const n of [1, 2]) {
    features.push(...getNgrams(tokens, n))
  }

  const tf: Record<string, number> = {}
  for (const f of features) {
    tf[f] = (tf[f] || 0) + 1
  }

  const vec: number[] = new Array(model.idf.length).fill(0)
  for (const [term, count] of Object.entries(tf)) {
    const idx = model.vocab[term]
    if (idx !== undefined) {
      vec[idx] = 1 + Math.log(count)
    }
  }

  for (let i = 0; i < vec.length; i++) {
    if (vec[i] > 0) {
      vec[i] *= model.idf[i]
    }
  }

  return vec
}

// ── Logistic Regression Inference ─────────────────────────────

function softmax(scores: number[]): number[] {
  const maxScore = Math.max(...scores)
  const exps = scores.map((s) => Math.exp(s - maxScore))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

function predictClass(vec: number[]): Status {
  const { coef, intercept, classes } = model
  const scores: number[] = []

  for (let c = 0; c < coef.length; c++) {
    let score = intercept[c] || 0
    for (let i = 0; i < vec.length; i++) {
      score += vec[i] * (coef[c][i] || 0)
    }
    scores.push(score)
  }

  const probs = softmax(scores)
  const maxIdx = probs.indexOf(Math.max(...probs))
  return classes[maxIdx] as Status
}

// ── Session Summary Builder ────────────────────────────────────

export interface SessionInfo {
  sessionID: string
  title: string
  lastUpdate: number // epoch ms
  lastDelta: number // epoch ms — last model progress event
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  summary?: { additions: number; deletions: number; files: number; diffs?: string[] }
  latestMessage?: { role: string; text: string }
  status: "idle" | "running" | "compact" | { type: "busy"; busy: string }
}

/**
 * Build a human-readable summary string from session metadata.
 * If there is no meaningful summary, returns a stalled indicator.
 */
export function summarizeSession(s: SessionInfo, stallThreshold = 30): string {
  const now = Date.now()
  const secondsSinceUpdate = Math.floor((now - s.lastUpdate) / 1000)
  const minutesSinceUpdate = Math.floor(secondsSinceUpdate / 60)
  const secondsSinceTurn = Math.floor((now - s.lastDelta) / 1000)

  const parts: string[] = []

  // Title
  if (s.title && s.title !== "New session") {
    parts.push(`Session: ${s.title}`)
  }

  // Time since last activity
  if (secondsSinceUpdate < 5) {
    parts.push("actively generating")
  } else if (secondsSinceUpdate < stallThreshold) {
    parts.push(`last activity ${secondsSinceUpdate} seconds ago`)
  } else if (minutesSinceUpdate < 2) {
    parts.push(`last activity ${secondsSinceUpdate} seconds ago`)
  } else if (minutesSinceUpdate < 15) {
    parts.push(`last activity ${minutesSinceUpdate} minutes ago`)
  } else {
    parts.push(`last activity ${minutesSinceUpdate} minutes ago, possibly stalled`)
  }

  // Per-turn stall detection
  if (secondsSinceTurn > stallThreshold) {
    parts.push(`no activity for ${secondsSinceTurn} seconds — stalled`)
  }

  // Token activity
  if (s.tokens && s.tokens.output > 0) {
    parts.push(`${s.tokens.output} tokens generated`)
    if (s.tokens.output > 100) {
      parts.push("substantial output generated")
    }
  }

  // Code change summary
  if (s.summary) {
    const changes: string[] = []
    if (s.summary.additions > 0) changes.push(`+${s.summary.additions} lines`)
    if (s.summary.deletions > 0) changes.push(`-${s.summary.deletions} lines`)
    if (s.summary.files > 0) changes.push(`${s.summary.files} files`)
    if (changes.length > 0) {
      parts.push(`code changes: ${changes.join(", ")}`)
    }
  }

  // Latest message content
  if (s.latestMessage && s.latestMessage.text) {
    parts.push(`latest ${s.latestMessage.role}: ${s.latestMessage.text.slice(0, 200)}`)
  }

  // If we have NO meaningful summary at all (no tokens, no summary, no latest
  // message), report stalled regardless of time. A session that has produced
  // nothing is not "running" — it's stalled.
  const hasContent =
    (s.tokens && (s.tokens.output > 0 || s.tokens.input > 0)) ||
    (s.summary && (s.summary.additions > 0 || s.summary.deletions > 0 || s.summary.files > 0)) ||
    (s.latestMessage && s.latestMessage.text && s.latestMessage.text.length > 0)

  if (!hasContent) {
    return `no summary available, no tokens generated, no code changes, no messages, process appears stalled (last activity ${minutesSinceUpdate} minutes ago)`
  }

  return parts.join(". ")
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Classify a process summary as RUNNING, STALLED, or UNKNOWN.
 */
export function check(summary: string): Status {
  return predictClass(transformTFIDF(summary))
}

/**
 * Check a single session's health.
 * If the session has no summary (no tokens, no code changes, no messages),
 * it is reported as STALLED without consulting the classifier.
 */
export function checkSession(session: SessionInfo, stallThreshold = 30): WatchResult {
  const summary = summarizeSession(session, stallThreshold)
  const now = Date.now()
  const secondsSinceTurn = Math.floor((now - session.lastDelta) / 1000)

  // Hard rule: no content at all = stalled. Don't even consult the classifier.
  const hasContent =
    (session.tokens && (session.tokens.output > 0 || session.tokens.input > 0)) ||
    (session.summary && (session.summary.additions > 0 || session.summary.deletions > 0 || session.summary.files > 0)) ||
    (session.latestMessage && session.latestMessage.text && session.latestMessage.text.length > 0)

  if (!hasContent || secondsSinceTurn > stallThreshold) {
    return {
      sessionID: session.sessionID,
      status: "STALLED",
      summary,
      secondsSinceUpdate: Math.floor((now - session.lastUpdate) / 1000),
    }
  }

  const status = predictClass(transformTFIDF(summary))
  return {
    sessionID: session.sessionID,
    status,
    summary,
    secondsSinceUpdate: Math.floor((now - session.lastUpdate) / 1000),
  }
}

/**
 * Check all active sessions. Only sessions with non-idle status are checked.
 * Sessions with no summary are reported as STALLED.
 */
export function checkActiveSessions(sessions: SessionInfo[], stallThreshold = 30): WatchResult[] {
  return sessions
    .filter((s) => s.status !== "idle")
    .map((s) => {
      const summary = summarizeSession(s, stallThreshold)
      const now = Date.now()
      const secondsSinceTurn = Math.floor((now - s.lastDelta) / 1000)

      // Hard rule: no content at all = stalled. Don't even consult the classifier.
      const hasContent =
        (s.tokens && (s.tokens.output > 0 || s.tokens.input > 0)) ||
        (s.summary && (s.summary.additions > 0 || s.summary.deletions > 0 || s.summary.files > 0)) ||
        (s.latestMessage && s.latestMessage.text && s.latestMessage.text.length > 0)

      if (!hasContent || secondsSinceTurn > stallThreshold) {
        return {
          sessionID: s.sessionID,
          title: s.title,
          status: "STALLED" as Status,
          summary,
          secondsSinceUpdate: Math.floor((now - s.lastUpdate) / 1000),
        }
      }

      const status = predictClass(transformTFIDF(summary))
      return {
        sessionID: s.sessionID,
        title: s.title,
        status,
        summary,
        secondsSinceUpdate: Math.floor((now - s.lastUpdate) / 1000),
      }
    })
}

export * as Watcher from "./watcher"