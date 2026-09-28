import { afterEach, describe, expect, test } from "bun:test"
import { reportSnapshotFailure } from "@/cli/heap"

const FILE = "/home/u/.local/share/opencode/log/heap-1234-20260101.heapsnapshot"

let restore: (() => void) | undefined

function captureConsole() {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "))
  }
  restore = () => {
    console.error = original
  }
  return lines
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("reportSnapshotFailure", () => {
  test("reports when the snapshot could not be written, naming the file and the RSS", async () => {
    // The regression. This branch only runs when the process is still over the hard limit AFTER a
    // forced collection, and `armed` is already false, so nothing is ever retried. The old code
    // swallowed the failure: the process was over the limit, no file was written, nothing was
    // logged, and the one artefact that would explain the OOM simply did not exist.
    const lines = captureConsole()
    await reportSnapshotFailure(
      () => {
        throw new Error("EACCES: permission denied")
      },
      FILE,
      2_147_483_648,
    )

    expect(lines).toHaveLength(1)
    // Where the user was told to look for a file that is not there.
    expect(lines[0]).toContain(FILE)
    // The reason, not "[object Object]" - the SDK-shaped failures this codebase hits elsewhere.
    expect(lines[0]).toContain("EACCES")
    // And the state that made the attempt necessary in the first place.
    expect(lines[0]).toContain("still over the limit")
    expect(lines[0]).toContain("2147483648")
  })

  test("reports a rejected snapshot write as well as a thrown one", async () => {
    // The old code caught a rejection here, so this half was working; it is pinned so the fix does
    // not regress it while covering the throw.
    const lines = captureConsole()
    await reportSnapshotFailure(
      async () => {
        throw new Error("ENOSPC: no space left on device")
      },
      FILE,
      2_000_000_000,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("ENOSPC")
  })

  test("reports a structured failure rather than rendering it as an object", async () => {
    const lines = captureConsole()
    await reportSnapshotFailure(
      () => {
        throw { code: "ERR_UNKNOWN", message: "v8 is not available under this runtime" }
      },
      FILE,
      2_000_000_000,
    )
    expect(lines[0]).toContain("v8 is not available under this runtime")
    expect(lines[0]).not.toContain("[object Object]")
  })

  test("reports nothing when the snapshot is written", async () => {
    // The direction that must not regress: a successful capture stays quiet, because on that path
    // the file exists and the user has what they need.
    const lines = captureConsole()
    await reportSnapshotFailure(() => "/written/path", FILE, 2_000_000_000)
    expect(lines).toEqual([])
  })

  test("treats the path writeHeapSnapshot returns as success, not a failure", async () => {
    // `writeHeapSnapshot` resolves with the path it wrote. A helper that only treated a void return
    // as success would report every real capture as a failure.
    const lines = captureConsole()
    await reportSnapshotFailure(async () => FILE, FILE, 2_000_000_000)
    expect(lines).toEqual([])
  })

  test("never throws, so a failed snapshot cannot escape the watchdog interval", async () => {
    // The caller is inside a `finally` that releases the lock, and an exception here would surface as
    // an unhandled rejection from a `setInterval` callback. Reporting is the whole contract.
    const lines = captureConsole()
    await reportSnapshotFailure(
      () => {
        throw new Error("everything is down")
      },
      FILE,
      2_000_000_000,
    )
    expect(lines).toHaveLength(1)
  })
})
