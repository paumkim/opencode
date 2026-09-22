export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && output.length <= maxChars) {
    return { output, overflow: false }
  }

  const preview = lines.slice(0, maxLines).join("\n")
  if (preview.length > maxChars) {
    return {
      output: preview.slice(0, Math.max(0, maxChars - 1)) + "…",
      overflow: true,
    }
  }

  return { output: lines.slice(0, maxLines).concat("…").join("\n"), overflow: true }
}
