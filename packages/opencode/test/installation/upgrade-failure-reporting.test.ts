import { describe, expect, test } from "bun:test"
import { describeUpgradeFailure, Installation } from "../../src/installation"

// A failed auto-upgrade used to be discarded by a bare `.catch(() => {})` in
// src/cli/upgrade.ts, so the only trace of a failed upgrade was nothing at all.
// Getting the *reason* into the log is the whole point of the fix, and the
// interesting reason lives in `UpgradeFailedError.stderr`.
describe("describeUpgradeFailure", () => {
  test("surfaces the installer command's own stderr, not a generic message", () => {
    const err = new Installation.UpgradeFailedError({
      stderr: "choco: not running from an elevated command shell",
    })
    expect(describeUpgradeFailure(err)).toBe("choco: not running from an elevated command shell")
  })

  test("distinguishes causes that would otherwise log identically", () => {
    const a = new Installation.UpgradeFailedError({ stderr: "ENOSPC: no space left on device" })
    const b = new Installation.UpgradeFailedError({ stderr: "404 Not Found" })
    expect(describeUpgradeFailure(a)).not.toBe(describeUpgradeFailure(b))
  })

  test("uses a plain Error's message", () => {
    expect(describeUpgradeFailure(new Error("connection reset"))).toBe("connection reset")
  })

  test("handles a thrown string", () => {
    expect(describeUpgradeFailure("registry unreachable")).toBe("registry unreachable")
  })

  test("never produces [object Object] for a non-Error throw", () => {
    const rendered = describeUpgradeFailure({ code: "ENOENT" })
    expect(rendered).not.toBe("[object Object]")
  })

  test("handles an empty message rather than returning nothing", () => {
    expect(describeUpgradeFailure(new Error(""))).toBe("Error")
  })
})
