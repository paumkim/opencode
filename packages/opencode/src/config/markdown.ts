import { Filesystem } from "@/util/filesystem"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export const fallbackSanitization = ConfigMarkdownCore.sanitize

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    return ConfigMarkdownCore.parse(template)
  } catch (err) {
    throw new FrontmatterError(
      {
        path: filePath,
        message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      },
      { cause: err },
    )
  }
}

// `parse` reports a frontmatter that does not parse as a typed `FrontmatterError` carrying the
// file and the YAML problem, and the CLI, the TUI, the web app, and the httpapi 400 mapping all
// render it. The agent/command loaders used to `.catch(() => undefined)` it away, so a malformed
// entry vanished with no diagnostic at all. A file we cannot read is a different problem -- it
// vanished between the glob and the read, or we may not open it -- and is not the user's mistake to
// fix, so that case stays skippable and only it returns undefined.
export async function parseEntry(filePath: string) {
  try {
    return await parse(filePath)
  } catch (err) {
    if (FrontmatterError.isInstance(err)) throw err
    return undefined
  }
}

export * as ConfigMarkdown from "./markdown"
