import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"

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
export function start() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

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
      await Promise.resolve()
        .then(() => writeHeapSnapshot(file))
        .catch(() => {})
    } finally {
      lock = false
    }
  }

  timer = setInterval(() => {
    void run()
  }, INTERVAL)
  timer.unref?.()
}

export * as Heap from "./heap"
