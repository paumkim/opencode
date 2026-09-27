import { describe, expect, test } from "bun:test"
import { continuationPrompt } from "../../src/goal/prompts"
import { buildSystemPrompt } from "../../src/session/prompt/system-prompts"
import { CONTEXT_HYGIENE } from "../../src/session/prompt/shared"

describe("context hygiene reminder", () => {
  test("the system prompt tells the model to manage its own context", () => {
    const prompt = buildSystemPrompt("BASE")

    expect(prompt).toContain(CONTEXT_HYGIENE)
    expect(prompt).toContain("<system_directive>")
  })

  test("the reminder names the tool and the no-permission rule", () => {
    // The two omissions that keep this from working: naming a tool that does not exist, or
    // phrasing it so the model stops to ask permission. Both are pinned here.
    expect(CONTEXT_HYGIENE).toContain("compact")
    expect(CONTEXT_HYGIENE).toMatch(/no permission/i)
  })

  test("the reminder gives a trigger, not just a warning", () => {
    // A bare "keep your context small" is ignored. It has to say when.
    expect(CONTEXT_HYGIENE).toMatch(/when any of these is true/i)
    expect(CONTEXT_HYGIENE).toMatch(/preventive/i)
  })

  test("the goal continuation re-reminds on every goal turn", () => {
    // The system prompt is static; a long goal needs the reminder repeated per turn, or it fades
    // exactly when the context gets heavy enough to need it.
    const goal = {
      id: "ses_test",
      objective: "ship it",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      completed: [],
      checkpoints: [],
    } as never

    const continuation = continuationPrompt(goal)

    expect(continuation).toContain("compact")
    expect(continuation).toMatch(/context/i)
  })
})
