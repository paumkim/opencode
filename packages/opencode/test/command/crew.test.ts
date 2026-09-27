import { describe, expect, test } from "bun:test"
import { CREW_PROMPT, GOAL_PROMPT } from "@opencode-ai/core/prompt/command"
import { Default } from "@/command"

describe("the /crew command", () => {
  test("is registered alongside /goal", () => {
    expect(Default.CREW).toBe("crew")
    // A name that collides with an existing default would silently replace that command.
    expect(new Set(Object.values(Default)).size).toBe(Object.values(Default).length)
  })

  test("ships a prompt asset", () => {
    expect(CREW_PROMPT.length).toBeGreaterThan(0)
    expect(CREW_PROMPT).toContain("crew.sh")
  })

  test("points at the launcher that ships with the repo, not a temp path", () => {
    // The whole reason this exists: a launcher in /tmp is lost on reboot, and hardcoded project
    // paths break the moment a checkout moves. The prompt must name the in-repo script and the
    // config that supplies the paths.
    expect(CREW_PROMPT).toContain("script/crew.sh")
    expect(CREW_PROMPT).toContain("crew.json")
    expect(CREW_PROMPT).not.toContain("/tmp/")
  })

  test("tells the agent to read git rather than trust an enumerated backlog", () => {
    // The generated prompt is orientation; git log is the contract. If this regresses to a
    // hardcoded list, every window starts from a snapshot that is stale the moment it commits.
    expect(CREW_PROMPT).toContain("git log")
    expect(CREW_PROMPT).toMatch(/git log`? as the contract/i)
  })

  test("requires preflight before launching", () => {
    expect(CREW_PROMPT).toContain("doctor")
  })

  test("carries the memory and project-boundary rules the unattended run depends on", () => {
    expect(CREW_PROMPT).toContain("MemoryMax=6G")
    expect(CREW_PROMPT).toContain("ulimit -v")
    expect(CREW_PROMPT).toMatch(/stay inside its own project/i)
    // A window (or an operator) that can reset, revert or delete would destroy the very work the
    // completed-work ledger claims is done. The launcher only ever halts processes.
    expect(CREW_PROMPT).toMatch(/does not revert, reset, or delete/i)
  })

  test("is independent of the goal prompt", () => {
    expect(CREW_PROMPT).not.toBe(GOAL_PROMPT)
  })
})
