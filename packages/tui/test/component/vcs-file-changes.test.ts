import { describe, expect, test } from "bun:test"
import { readWorkspaceFileChanges } from "../../src/component/dialog-workspace-file-changes"

type Client = Parameters<typeof readWorkspaceFileChanges>[0]

const client = (status: Client["vcs"]["status"]) => ({ vcs: { status } }) as Client

// The response shape the generated client actually produces: a union, not a
// rejection. A non-2xx comes back as `{ data: undefined, error }`.
describe("readWorkspaceFileChanges", () => {
  test("reports changed files", async () => {
    const files = [{ file: "a.ts", additions: 1, deletions: 0, status: "modified" as const }]
    const result = await readWorkspaceFileChanges(
      client(async () => ({ data: files, error: undefined })),
      { directory: "/repo" },
    )
    expect(result).toEqual({ ok: true, data: files })
  })

  test("an empty working tree is a success, not a failure", async () => {
    const result = await readWorkspaceFileChanges(
      client(async () => ({ data: [], error: undefined })),
      {
        directory: "/repo",
      },
    )
    expect(result).toEqual({ ok: true, data: [] })
  })

  // This is the bug. The client does not reject on a 500 — it returns
  // `{ data: undefined, error }` — so every caller that tested only
  // `data?.length` read this as "no changes" and skipped the prompt, quietly
  // leaving uncommitted work behind. The `.catch(() => undefined)` that used to
  // sit beside those calls never fired for this case; it only saw transport
  // failures.
  test("a VcsReadError is a failure, never an empty change list", async () => {
    const result = await readWorkspaceFileChanges(
      client(async () => ({
        data: undefined,
        error: {
          name: "VcsReadError",
          data: { message: "fatal: not a git repository (or any of the parent directories): .git", command: ["git"] },
        },
      })),
      { directory: "/not-a-repo" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("not a git repository")
  })

  test("a transport failure is a failure too", async () => {
    const result = await readWorkspaceFileChanges(
      client(async () => {
        throw new Error("connection refused")
      }),
      { directory: "/repo" },
    )
    expect(result).toEqual({ ok: false, reason: "connection refused" })
  })

  test("passes the workspace through instead of assuming a directory", async () => {
    const seen: unknown[] = []
    await readWorkspaceFileChanges(
      client(async (query) => {
        seen.push(query)
        return { data: [], error: undefined }
      }),
      { workspace: "wsp_1" },
    )
    expect(seen).toEqual([{ workspace: "wsp_1" }])
  })

  // The structural guarantee, pinned. The old call sites read
  // `status?.data?.length`, which is exactly the expression that turned a
  // VcsReadError into "clean tree". On this union `data` does not exist without
  // first narrowing `ok`, so that expression no longer compiles — meaning the
  // bug cannot come back as an ignored return value.
  test("data is unreachable until the failure case is handled", async () => {
    const result = await readWorkspaceFileChanges(
      client(async () => ({ data: [], error: undefined })),
      {},
    )
    // @ts-expect-error `data` lives only on the ok branch, so reading it without
    // narrowing `ok` is a compile error. If the union ever loosens, this
    // directive becomes unused and the typecheck fails.
    expect(result.data.length).toBe(0)
  })
})
