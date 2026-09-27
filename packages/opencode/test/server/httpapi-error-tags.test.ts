import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// An `httpApiStatus`-annotated error class is the wire contract: the effect httpapi encoder keys the
// HTTP status off the annotation, and `_tag` is what a client discriminates on. So a tag declared
// twice is not a harmless duplicate -- and it is not a *compile* error either, because the two
// declarations are independent classes.
//
// The hazard, from 31b290d21: `httpapi/errors.ts` and `protocol/src/errors.ts` each declared a
// `ProviderNotFoundError` with the same tag, the same fields, and the same `{ httpApiStatus: 404 }`.
// The class a route actually throws is the protocol one, because
// `packages/server/src/handlers/provider.ts` imports from `@opencode-ai/protocol/errors`. Nothing
// failed. An import resolving to the other copy still typechecked, still produced the right `_tag`,
// and still produced a 404 -- the error only becomes observable at a `catchTag`/`isInstance`, where
// it shows up as a match that does not match. Nine more classes were in the same position.
//
// Duplication is not automatically wrong, though: four tags (`InvalidRequestError`,
// `PermissionNotFoundError`, `PtyNotFoundError`, `QuestionNotFoundError`) are declared on both sides
// and genuinely consumed from both. So the rule is not "no shared tag". The rule is the actual
// defect: a class nothing imports. A declaration no route can throw is dead weight, and when a
// same-tag twin exists it is worse than dead weight -- it is a trap for the next import.
//
// Reachability is per-class, not per-module. `handlers/pty.ts` does `import * as ApiError`, which
// makes every member reachable, so a side with any namespace import is not disqualifying on its own;
// the named imports are what count.
const PACKAGE_ROOT = path.join(import.meta.dirname, "..", "..")
const SOURCES = ["src/server/routes/instance/httpapi/errors.ts", path.join("..", "protocol", "src", "errors.ts")]

// A class body is parsed by splitting on `export class` boundaries and then reading the first quoted
// string in the chunk. A single regex over the whole file is wrong twice over: a lazy `[\s\S]*?`
// between the class name and its tag can run past the end of a class whose tag appears in a
// different call shape (`Schema.ErrorClass<T>("Tag", ...)` has no `>()(` to stop at) and adopt the
// NEXT class's tag. Splitting first makes each chunk independently parseable, which is the only
// way to read both forms.
function declaredClasses(source: string) {
  const found: { name: string; tag: string }[] = []
  for (const chunk of source.split(/(?=export class )/)) {
    const match = chunk.match(/^export class (\w+)[\s\S]*?\(\s*\n?\s*"([^"]+)"/)
    if (match) found.push({ name: match[1], tag: match[2] })
  }
  return found
}

async function importedNames(file: string) {
  const source = await fs.readFile(file, "utf8")
  const names = new Set<string>()
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue
    found.push(path.join(entry.parentPath ?? directory, entry.name))
  }
  return found
}

describe("httpapi error classes", () => {
  test("every declared error class is imported somewhere", async () => {
    const orphaned: string[] = []
    for (const relative of SOURCES) {
      const file = path.join(PACKAGE_ROOT, relative)
      const declaration = path.dirname(file)
      const source = await fs.readFile(file, "utf8")

      // Anything outside this file, in the same package, may import from it.
      const consumers = new Set<string>()
      const searchRoots = [declaration, path.join(PACKAGE_ROOT, "src")]
      const seen = new Set<string>()
      for (const root of searchRoots) {
        for (const candidate of await typescriptFiles(root)) {
          if (candidate === file || seen.has(candidate)) continue
          seen.add(candidate)
          for (const name of await importedNames(candidate)) consumers.add(name)
        }
      }

      for (const { name, tag } of declaredClasses(source)) {
        if (!consumers.has(name)) orphaned.push(`${tag} (${name}) in ${path.basename(declaration)}`)
      }
    }
    expect(orphaned).toEqual([])
  })
})
