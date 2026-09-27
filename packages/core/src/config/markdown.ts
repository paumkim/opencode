export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"
export function parse(content: string) {
  try {
    return read(content)
  } catch (error) {
    const sanitized = sanitize(content)
    // Only retry when `sanitize` actually changed something. When it changed nothing there is
    // nothing to repair, so let the real YAML error out instead of feeding the same string back in.
    if (sanitized === content) throw error
    return read(sanitized)
  }
}

// Pass an empty options object on every call, which opts out of gray-matter's cache entirely (it
// reads and writes `matter.cache` only when `options` is undefined). That cache is keyed by content
// and is populated BEFORE parsing -- gray-matter assigns `matter.cache[file.content] = file` and
// only then calls `parseMatter` -- so a call that throws still leaves the UNPARSED file sitting in
// the cache under that exact string, and the next read of it "succeeds" with `data: {}` and the
// whole original file, delimiters and all, as `content`.
//
// Every caller feeds `content` to the model as the prompt (`prompt: md.content.trim()`), so a
// malformed frontmatter used to cross from the configuration channel into the instruction channel
// with its settings silently discarded -- and it did so inconsistently, depending on whether
// something else in the process had already parsed that same string and poisoned its entry. Opting
// out makes `parse` a pure function of its input: nothing to replay, nothing to poison.
function read(content: string) {
  return matter(content, {})
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
