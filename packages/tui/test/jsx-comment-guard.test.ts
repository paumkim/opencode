import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/**
 * A `//` comment written as a bare JSX child is not a comment.
 *
 * In JSX child position a bare `//` line is text content, so Solid inserts it as
 * a text node whose parent is whatever box happens to enclose it. OpenTUI
 * refuses that: `Orphan text error: ... must have a <text> as a parent`. It
 * surfaces only when the branch actually renders, which is why the whole test
 * suite was green while the TUI crashed on the last message of a real session.
 *
 * This parses the sources rather than grepping them, so it does not fire on a
 * `//` inside a string, a URL, or a regular comment in normal code.
 */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".jsx")) out.push(full)
  }
  return out
}

/** A JSX text child that is written like a comment rather than like content. */
function commentLike(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")
}

test("no JSX child in the TUI is a bare comment", () => {
  const offenders: string[] = []
  for (const file of sources("src")) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const walk = (node: ts.Node) => {
      if (ts.isJsxText(node) && commentLike(node.text)) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
        offenders.push(`${file}:${line + 1}: ${node.text.trim().slice(0, 60).replace(/\n/g, " ")}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(parsed)
  }
  // Wrap the comment in `{/* ... */}`, or move it above the element it describes.
  expect(offenders).toEqual([])
})

test("the check still recognises a comment when one is introduced", () => {
  // Without this, a broken parser that found nothing would make the test above
  // pass for the wrong reason.
  const broken = `
    const x = (
      <box>
        // this is a comment in the wrong place
        <text>hello</text>
      </box>
    )
  `
  const parsed = ts.createSourceFile("broken.tsx", broken, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node) && commentLike(node.text)) found.push(node.text.trim())
    ts.forEachChild(node, walk)
  }
  walk(parsed)
  expect(found).toEqual(["// this is a comment in the wrong place"])
})
