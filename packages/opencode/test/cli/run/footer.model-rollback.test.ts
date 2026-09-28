import { describe, expect, test } from "bun:test"
import { applyModelChangeFailure, modelRollback } from "@/cli/cmd/run/footer"

const A = { providerID: "anthropic", modelID: "claude-opus-5" }
const B = { providerID: "openai", modelID: "gpt-5" }

describe("modelRollback", () => {
  test("rolls back when the failed switch is still the one on display", () => {
    // The regression. The footer sets the model optimistically before the request, so a swallowed
    // failure left it naming the model the user had just chosen while the next prompt went to the
    // configured one. A user who picked a model to get out of a rate limit had no way to learn the
    // switch never happened - and nothing on screen connected the two names.
    const rollback = modelRollback(B, B, A)
    expect(rollback).toBeDefined()
  })

  test("clears the variant when the restore changes model, since a variant belongs to a model", () => {
    expect(modelRollback(B, B, A)?.clearVariant).toBe(true)
  })

  test("does not roll back when the user has since chosen a different model", () => {
    // The guard that makes the rollback safe. A slow request can fail after the user acted again,
    // and reverting then would undo a change they made - trading a stale label for a wrong one.
    expect(modelRollback(A, B, A)).toBeUndefined()
  })

  test("does not roll back when nothing is displayed at all", () => {
    expect(modelRollback(undefined, B, A)).toBeUndefined()
  })

  test("keeps the variant when the restore is the same model", () => {
    // Same provider and model, so the variant the user had is still valid; clearing it would discard
    // a selection the failed request never touched.
    expect(modelRollback(A, A, A)?.clearVariant).toBe(false)
  })

  test("clears the variant when there was no previous model to restore", () => {
    // Falling back to "no model" is a change of model, so a variant left over from the failed
    // selection would belong to a model that is no longer selected.
    expect(modelRollback(B, B, undefined)?.clearVariant).toBe(true)
  })
})

describe("applyModelChangeFailure", () => {
  // This is what the class does, not what it decides. Testing `modelRollback` alone passes whether or
  // not the handler is ever called - which I confirmed by reverting the two `.catch` handlers to
  // `.catch(() => {})` and watching all six tests stay green.
  function ui(current: typeof A | typeof B | undefined) {
    const calls: string[] = []
    return {
      calls,
      gone: false,
      current,
      restore: (model: typeof A | typeof B | undefined) => calls.push(`restore:${model?.modelID ?? "none"}`),
      clearVariant: () => calls.push("clearVariant"),
      notice: (text: string) => calls.push(`notice:${text}`),
    }
  }

  test("restores the previous model and says why the switch failed", () => {
    const surface = ui(B)
    applyModelChangeFailure(surface, B, A, new Error("provider rate limited"))
    // The footer stops naming a model the next prompt will not use.
    expect(surface.calls[0]).toBe("restore:claude-opus-5")
    expect(surface.calls[1]).toBe("clearVariant")
    // And the reason is on screen, which is what the old code left out entirely.
    const notice = surface.calls.find((c) => c.startsWith("notice:"))
    expect(notice).toContain("model switch failed")
    expect(notice).toContain("provider rate limited")
  })

  test("the footer handler is wired to this behaviour, not to a bare catch", async () => {
    // The one link a pure test cannot see. `RunFooter.handleModelSelect` sets the model
    // optimistically and then reacts to the request; the reaction used to be `.catch(() => {})`, and
    // every test above passed with that in place. This reads the source to assert the handler is
    // still there, which is a blunt instrument - but a source-shaped defect that a source-shaped
    // check can catch is better than a green suite that proves nothing.
    const source = await Bun.file(new URL("../../../src/cli/cmd/run/footer.ts", import.meta.url)).text()
    expect(source).toContain("onModelChangeFailed(model, previous, error)")
    expect(source).toContain("onVariantChangeFailed(error)")
    // The two swallow-everything catches this unit removed must not come back.
    expect(source).not.toMatch(/onModelSelect[\s\S]{0,900}\.catch\(\(\) => \{\}\)/)
    expect(source).not.toMatch(/onVariantSelect[\s\S]{0,900}\.catch\(\(\) => \{\}\)/)
  })

  test("does nothing once the footer has moved on", () => {
    const surface = ui(A)
    applyModelChangeFailure(surface, B, A, new Error("late failure"))
    expect(surface.calls).toEqual([])
  })

  test("does nothing once the footer is gone", () => {
    // Tearing down is not the moment to write a notice into a terminal that is closing.
    const surface = { ...ui(B), gone: true }
    applyModelChangeFailure(surface, B, A, new Error("boom"))
    expect(surface.calls).toEqual([])
  })

  test("describes a structured failure rather than rendering it as an object", () => {
    const surface = ui(B)
    applyModelChangeFailure(surface, B, A, { message: "EACCES: permission denied" })
    const notice = surface.calls.find((c) => c.startsWith("notice:"))
    expect(notice).toContain("EACCES: permission denied")
    expect(notice).not.toContain("[object Object]")
  })
})
