export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  // `maxChars` is a CHARACTER budget derived from terminal width, so it is
  // measured and cut in code points. `String.prototype.slice` counts UTF-16 code
  // units, so an emoji is two of them: a unit-indexed cut keeps about half the
  // characters the bound allows, and it can land between the halves of a pair.
  // That is not cosmetic — a lone surrogate serializes to a `\udXXX` escape that
  // a renderer reads back as U+FFFD, so the preview would show a replacement
  // glyph in place of the last character. `truncateToCodePoints` in `@/goal/schema.ts`
  // and `truncateToolOutput` in `@/session/message-v2` correct the same thing for
  // text sent to a model.
  const chars = [...output]
  if (chars.length <= maxChars && output.split("\n").length <= maxLines) {
    return { output, overflow: false }
  }

  const lines = output.split("\n")
  const preview = lines.slice(0, maxLines).join("\n")
  if ([...preview].length > maxChars) {
    return {
      output: [...preview].slice(0, Math.max(0, maxChars - 1)).join("") + "…",
      overflow: true,
    }
  }

  return { output: lines.slice(0, maxLines).concat("…").join("\n"), overflow: true }
}
