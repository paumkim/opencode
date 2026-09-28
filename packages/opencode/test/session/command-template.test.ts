import { describe, expect, it } from "bun:test"
import { applyCommandTemplate } from "../../src/session/prompt"

// A custom command's template is filled with what the user typed on the command
// line, and that text is sent to the model as the prompt. The substitutions must
// be literal: the arguments are user input, and `$` is ordinary in them.
//
// The bug: the `$ARGUMENTS` substitution passed its replacement as a *string*,
// which `String.prototype.replaceAll` treats as a `$-pattern`. So `$&` was
// replaced by the matched text, ``$` `` by everything before it, `$'` by
// everything after it, and `$$` by a single `$`. The worst of those splice the
// template's own instruction text into the middle of the user's arguments, and
// `$'` duplicated the whole template. The model then received a prompt that
// differed from what the user wrote, with no error anywhere.
describe("applyCommandTemplate", () => {
  const TEMPLATE = "Review $ARGUMENTS carefully. Do not touch unrelated files."

  // Each of these is a real corruption of the prompt, not a formatting nit.
  const mangled: [label: string, argumentsText: string, expected: string][] = [
    ["$&", "file $&.ts", "Review file $&.ts carefully. Do not touch unrelated files."],
    ["$$", "a $$ b", "Review a $$ b carefully. Do not touch unrelated files."],
    ["$`", "dir $`/x", "Review dir $`/x carefully. Do not touch unrelated files."],
    ["$'", "tail $'y", "Review tail $'y carefully. Do not touch unrelated files."],
    ["a lone dollar", "cost $5", "Review cost $5 carefully. Do not touch unrelated files."],
  ]

  for (const [label, argumentsText, expected] of mangled) {
    it(`substitutes ${label} in $ARGUMENTS verbatim`, () => {
      expect(applyCommandTemplate(TEMPLATE, argumentsText)).toBe(expected)
    })
  }

  // A user legitimately searching for the literal placeholder text must still get
  // it, rather than having it swallowed as a match.
  it("passes a literal $ARGUMENTS in the arguments through unchanged", () => {
    expect(applyCommandTemplate("Look for: $ARGUMENTS", "the text $ARGUMENTS")).toBe("Look for: the text $ARGUMENTS")
  })

  it("takes the raw argument string for $ARGUMENTS, including quotes", () => {
    expect(applyCommandTemplate("Say: $ARGUMENTS", 'he said "hi" now')).toBe('Say: he said "hi" now')
  })

  // Positional placeholders went through a replacer function already, so they
  // were never broken. Pin them anyway, and pin the `$`-bearing case, since a
  // future refactor that unifies the two substitution sites is exactly when a
  // string replacement would get reintroduced.
  // A lone `$1` is the highest-numbered placeholder, so it takes the whole rest of
  // the arguments. That is why "Read $1 now" yields both files, not one.
  it("gives a lone $1 the whole argument string", () => {
    expect(applyCommandTemplate("Read $1 now", "a.txt b.txt")).toBe("Read a.txt b.txt now")
  })

  it("gives the highest of several placeholders the remainder", () => {
    expect(applyCommandTemplate("$1 to $2", "from here to there")).toBe("from to here to there")
  })

  it("gives the highest placeholder the rest of the arguments", () => {
    expect(applyCommandTemplate("Read $1 of", "one two three")).toBe("Read one two three of")
  })

  it("keeps a trailing $1 literal when the arguments carry $ sequences", () => {
    expect(applyCommandTemplate("Read $1", "a$&b")).toBe("Read a$&b")
  })

  it("keeps a backtick anchor literal in the highest placeholder", () => {
    expect(applyCommandTemplate("Read $2", "x $` y")).toBe("Read $` y")
  })

  it("substitutes an empty string for a placeholder with no argument", () => {
    expect(applyCommandTemplate("Read $1 done", "")).toBe("Read  done")
  })

  // Quoting keeps an argument together, but the lone $1 still takes the rest, so
  // the unquoted trailing word is included.
  it("keeps a quoted argument together as one argument", () => {
    expect(applyCommandTemplate("Read $1", '"two words" three')).toBe("Read two words three")
  })

  it("keeps an [Image N] token as one argument", () => {
    expect(applyCommandTemplate("Look $1 here", "[Image 1] tail")).toBe("Look [Image 1] tail here")
  })

  it("appends the arguments when the template has no placeholder", () => {
    expect(applyCommandTemplate("Do the thing", "extra detail")).toBe("Do the thing\n\nextra detail")
  })

  it("leaves a placeholder-free template alone when the arguments are blank", () => {
    expect(applyCommandTemplate("Do the thing", "   ")).toBe("Do the thing")
  })

  it("does not append the arguments a second time when $ARGUMENTS is present", () => {
    expect(applyCommandTemplate("Use $ARGUMENTS", "x")).toBe("Use x")
  })
})
