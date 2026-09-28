import { describe, expect, test } from "bun:test"
import { fillWorktreePath } from "@/command"

// `/init` interpolated the worktree path into its template with a *string*
// replacement, which `String.prototype.replace` reads as a `$-pattern`. `$` is a
// legal character in a directory name, so the path the user actually opened was
// not the path the model was told about -- with no error anywhere.
//
// Measured on the old implementation, with a template of
// "If `AGENTS.md` already exists at `${path}`, improve it in place.":
//
//   /dev/x$&y  ->  ...at `/dev/x${path}y`, ...   (placeholder echoed back as data)
//   /dev/x$$y  ->  ...at `/dev/x$y`, ...          (silently shortened)
//   /dev/x$'y  ->  ...at `/dev/x`, ...improve it in place."y, ...
//                   (the template's own instructions spliced in mid-path)
//
// `$1` and a bare `$name` are *not* affected: a string pattern has no capture
// groups, and `$` not followed by a recognised token is left alone. Only the four
// forms above are real, so only those are asserted as fixes.
describe("fillWorktreePath", () => {
  const template = "If `AGENTS.md` already exists at `${path}`, improve it in place."

  test("fills the placeholder", () => {
    expect(fillWorktreePath(template, "/home/u/dev/x")).toBe(
      "If `AGENTS.md` already exists at `/home/u/dev/x`, improve it in place.",
    )
  })

  test("inserts $& literally", () => {
    expect(fillWorktreePath(template, "/dev/x$&y")).toBe(
      "If `AGENTS.md` already exists at `/dev/x$&y`, improve it in place.",
    )
  })

  test("inserts $$ literally", () => {
    expect(fillWorktreePath(template, "/dev/x$$y")).toBe(
      "If `AGENTS.md` already exists at `/dev/x$$y`, improve it in place.",
    )
  })

  // `$'` is the text *after* the match, which here is the remainder of the
  // prompt's own instructions, so they were duplicated into the middle of the path.
  test("inserts $' literally instead of splicing the rest of the template", () => {
    const filled = fillWorktreePath(template, "/dev/x$'y")
    expect(filled).toBe("If `AGENTS.md` already exists at `/dev/x$'y`, improve it in place.")
    expect(filled).not.toContain('in place."y')
  })

  // `` $` `` is the text *before* the match.
  test("inserts $` literally instead of splicing the front of the template", () => {
    expect(fillWorktreePath(template, "/dev/x$`y")).toBe(
      "If `AGENTS.md` already exists at `/dev/x$`y`, improve it in place.",
    )
  })

  // `replace` only filled the first occurrence, so a template mentioning the
  // path twice sent the model one real path and one raw `${path}`.
  test("fills every occurrence", () => {
    expect(fillWorktreePath("${path} and ${path}", "/dev/x")).toBe("/dev/x and /dev/x")
  })

  test("leaves a template without the placeholder untouched", () => {
    expect(fillWorktreePath("Input: $ARGUMENTS", "/dev/x$&y")).toBe("Input: $ARGUMENTS")
  })

  test("does not treat a longer placeholder name as the path", () => {
    expect(fillWorktreePath("${pathology} ${path}", "/dev/x")).toBe("${pathology} /dev/x")
  })
})
