import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { errorMessage } from "@/util/error"
import { readForRewrite } from "@/snapshot/index"

// `sync` merges the entries it wants to add with whatever is already in the repo's `info/exclude`
// and writes the result back. It read the current contents with a catch that answered `""` on
// failure, so a failed read became "the file was empty" and the user's existing exclude entries
// were replaced by opencode's list. A transient IO error or a lock and their entries were gone,
// with nothing reported. Deletion is not recoverable by retrying, so the read has to refuse to
// produce a body at all rather than produce the wrong one.
describe("Snapshot.readForRewrite", () => {
  const report = () => {
    const seen: unknown[] = []
    return { seen, onReport: (error: unknown) => Effect.sync(() => void seen.push(error)) }
  }

  test("returns the current contents when the read succeeds", async () => {
    const { seen, onReport } = report()
    const result = await Effect.runPromise(readForRewrite(Effect.succeed("secret.txt\n"), onReport))
    expect(result.text).toBe("secret.txt\n")
    expect(result.error).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("returns empty text for a genuinely empty file, which is a real answer", async () => {
    const { onReport } = report()
    const result = await Effect.runPromise(readForRewrite(Effect.succeed(""), onReport))
    expect(result.text).toBe("")
    expect(result.error).toBeUndefined()
  })

  test("withholds the contents when the read fails, so the caller cannot write over them", async () => {
    const { seen, onReport } = report()
    const result = await Effect.runPromise(readForRewrite(Effect.fail(new Error("EACCES")), onReport))
    // The regression: this came back as `""`, indistinguishable from an empty file, and the caller
    // went on to write it.
    expect(result.text).toBeUndefined()
    expect(result.error).toBeDefined()
    expect(seen).toHaveLength(1)
  })

  test("reports the reason the read failed instead of dropping it", async () => {
    const { seen, onReport } = report()
    await Effect.runPromise(readForRewrite(Effect.fail(new Error("ETXTBSY")), onReport))
    expect((seen[0] as Error).message).toBe("ETXTBSY")
  })

  test("renders a non-Error failure reason rather than as {}", async () => {
    const { seen, onReport } = report()
    await Effect.runPromise(readForRewrite(Effect.fail({ code: "EACCES" }), onReport))
    expect(seen).toHaveLength(1)
    // The trap this guards: a plain-object reason must not stringify into a useless "{}".
    expect(errorMessage(seen[0])).not.toBe("{}")
  })

  test("distinguishes an absent file from a failed read, which is why it takes the read effect", async () => {
    // `excludes()` already returns undefined when the file does not exist, and that case must keep
    // writing an empty body. Only a read that *failed* withholds.
    const absent = await Effect.runPromise(readForRewrite(Effect.succeed(""), report().onReport))
    const failed = await Effect.runPromise(readForRewrite(Effect.fail(new Error("boom")), report().onReport))
    expect(absent.text).toBe("")
    expect(failed.text).toBeUndefined()
  })
})
