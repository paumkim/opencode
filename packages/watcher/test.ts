#!/usr/bin/env bun
// Self-test for the Watcher module — session-aware stall detection

import { check, checkActiveSessions, summarizeSession, type SessionInfo } from "./src/watcher/watcher"

const TEST_CASES: [string, string][] = [
  ["Process is generating tokens, 47 tokens/sec, active for 3 minutes.", "RUNNING"],
  ["Process has produced no output for 12 minutes, CPU at 0%, memory unchanged.", "STALLED"],
  ["Process started 5 minutes ago, last output was 2 minutes ago, currently generating.", "RUNNING"],
  ["Process generated 200 tokens then stopped, no further output for 8 minutes, no active threads.", "STALLED"],
  ["Process is slow, 2 tokens/sec, but still producing output steadily for 10 minutes.", "RUNNING"],
  ["Process started 30 seconds ago, initializing, no output yet.", "RUNNING"],
  ["Process was generating, last token 15 minutes ago, connection timeout, no response to pings.", "STALLED"],
  ["Process running for 2 hours, steady output, memory stable, no errors.", "RUNNING"],
  ["Process is in defunct state, parent not reaping, no resources being used.", "STALLED"],
  ["Process is thrashing, high swap usage, but still producing 1 token every 30 seconds.", "RUNNING"],
]

console.log("=".repeat(60))
console.log("Watcher Agent — Self-Test")
console.log("=".repeat(60))

let correct = 0
for (let i = 0; i < TEST_CASES.length; i++) {
  const [summary, expected] = TEST_CASES[i]
  const status = check(summary)
  const ok = status === expected ? "PASS" : "FAIL"
  if (status === expected) correct++
  console.log(`  [${ok}] Case ${i + 1}: expected=${expected}, got=${status}`)
}
console.log(`\n  Accuracy: ${correct}/10 (${correct * 10}%)`)

// Session-aware tests
console.log("\n" + "=".repeat(60))
console.log("Session-Aware Tests")
console.log("=".repeat(60))

const now = Date.now()

const activeSessions: SessionInfo[] = [
  {
    sessionID: "ses_abc123",
    title: "Fix login bug",
    lastUpdate: now - 2 * 1000,
    status: "running",
    tokens: { input: 1000, output: 250, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: { additions: 5, deletions: 2, files: 1 },
    latestMessage: { role: "assistant", text: "I fixed the login bug by updating the auth middleware." },
  },
  {
    sessionID: "ses_def456",
    title: "Refactor auth module",
    lastUpdate: now - 20 * 60 * 1000,
    status: "running",
    tokens: { input: 5000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: { additions: 50, deletions: 30, files: 3 },
    latestMessage: { role: "assistant", text: "Let me refactor the auth module..." },
  },
  {
    sessionID: "ses_ghi789",
    title: "New session",
    lastUpdate: now - 30 * 1000,
    status: "running",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
]

for (const s of activeSessions) {
  const summary = summarizeSession(s)
  console.log(`\n  Session ${s.sessionID} (${s.title}):`)
  console.log(`    Summary: ${summary}`)
}

const results = checkActiveSessions(activeSessions)
console.log("\n  Results:")
for (const r of results) {
  const icon = r.status === "STALLED" ? "STALLED" : r.status === "UNKNOWN" ? "UNKNOWN" : "RUNNING"
  console.log(`    [${icon}] ${r.sessionID} "${r.title}": ${r.status} (${r.secondsSinceUpdate}s since update)`)
}

// Count verification
const running = results.filter(r => r.status === "RUNNING").length
const stalled = results.filter(r => r.status === "STALLED").length
console.log(`\n  Active sessions: ${results.length}`)
console.log(`    Running: ${running}`)
console.log(`    Stalled: ${stalled}`)

// Verify: session with no summary should be STALLED
const noSummary = results.find((r) => r.sessionID === "ses_ghi789")
const pass = noSummary?.status === "STALLED"
console.log(`\n  No-summary session detected as STALLED: ${pass ? "PASS" : "FAIL"}`)

// Idle filter test
console.log("\n" + "=".repeat(60))
console.log("Idle Session Filter")
console.log("=".repeat(60))

const withIdle: SessionInfo[] = [
  ...activeSessions,
  {
    sessionID: "ses_idle01",
    title: "Idle session",
    lastUpdate: now - 60 * 60 * 1000,
    status: "idle",
  },
]

const filtered = checkActiveSessions(withIdle)
console.log(`  Total sessions: ${withIdle.length}`)
console.log(`  Checked (non-idle): ${filtered.length}`)
console.log(`  Idle filtered out: ${withIdle.length - filtered.length}`)
const idleExcluded = !filtered.some((r) => r.sessionID === "ses_idle01")
console.log(`  Idle session excluded: ${idleExcluded ? "PASS" : "FAIL"}`)
