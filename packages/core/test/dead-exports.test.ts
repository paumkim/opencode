import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// An exported function nothing calls is invisible: the module still typechecks, the suite still
// passes, and the code only looks like a capability. That is how `Shell.killTree` survived -- it was
// MOVED into `shell.ts` by f2cf60737 ("canonicalize pty service") while the pty service that used it
// was being rewritten to call `session.process.kill()` instead, and the move left the function behind
// with no callers. It is not harmless: it kills a process GROUP (`process.kill(-pid)`), which only
// works for a process spawned detached as a group leader, and the pty service spawns with
// `detached: false`. A future caller reaching for it would get a broken primitive that also took
// `ChildProcess` and `child_process.spawn` imports with it.
//
// This does not police dead code in general -- only these two narrow cases, both of which were
// reachable by a mechanical mistake rather than by intent:
//
//   1. An exported function or const in `core/src` that no other file in the repo mentions by name.
//   2. A `src` file with no importer outside its own directory. `src/plugin/layer-map.example.ts` is
//      an example and is exempt, as are files whose only importers are other `src` siblings that
//      exist purely to be a barrel for them.
// test/ lives one level under the package, and the package one level under the repo root.
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..")
//   `layer-map.example.ts` is a documentation example, so its exports are illustrative by design.
//   The platform variants are wired up as CONDITIONAL package exports, not imports:
//   `package.json` maps `"bun" -> ./src/pty/pty.bun.ts`, `"node" -> ./src/pty/pty.node.ts` and
//   `"node" -> ./src/database/sqlite.node.ts`, so no source file ever names them.
//   `data-migration.sql.ts` declares the `data_migration` table, which a real migration CREATES and
//   which `schema.gen.ts` therefore contains -- but nothing reads or writes it at run time (the
//   migration runner keeps its own `migration` table). Deleting it is a schema question, not a
//   dead-code one, so it is called out here rather than removed.
const EXEMPT_FILES = new Set([
  path.join("src", "plugin", "layer-map.example.ts"),
  path.join("src", "pty", "pty.bun.ts"),
  path.join("src", "pty", "pty.node.ts"),
  path.join("src", "database", "sqlite.node.ts"),
  path.join("src", "database", "sqlite.bun.ts"),
  path.join("src", "data-migration.sql.ts"),
])
// `index.ts` re-exports a namespace (`export * as X from "./x"`); the sibling is its only "importer"
// and that is by design.
const BARRELS = /^index\.ts$/

type SourceFile = { readonly absolute: string; readonly relative: string }

async function walk(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name)
      if (!entry.isDirectory()) return Promise.resolve([full])
      // Dependencies are vendored under packages/*/node_modules by bun; they are not repo source and
      // scanning them is both slow and wrong -- an import there is not a consumer of this repo.
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        return Promise.resolve<string[]>([])
      }
      // A directory can be unreadable (permissions) or vanish mid-walk; a guard test that throws on
      // an unrelated tree is worse than one that skips it, since the failure would be a false alarm
      // about dead code.
      return walk(full).catch(() => [] as string[])
    }),
  )
  return nested.flat()
}

const PACKAGE_ROOT = path.join(import.meta.dirname, "..")

async function sources(): Promise<SourceFile[]> {
  const files = (await walk(path.join(PACKAGE_ROOT, "src"))).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
  )
  return files.map((absolute) => ({ absolute, relative: path.relative(PACKAGE_ROOT, absolute) }))
}

/**
 * Every TypeScript file in the repo outside core, concatenated. The scope is the whole workspace on
 * purpose: these packages are consumed by siblings, so `JsonError` in `core/src/v1/config/error.ts`
 * is used by `packages/opencode` and a core-only scan would report it as dead.
 */
async function corpus() {
  const files: string[] = []
  for (const entry of await fs.readdir(path.join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const sub of ["src", "test", "script", "spec"]) {
      const root = path.join(REPO_ROOT, "packages", entry.name, sub)
      if (
        !(await fs
          .stat(root)
          .then((s) => s.isDirectory())
          .catch(() => false))
      )
        continue
      files.push(...(await walk(root)))
    }
  }
  // `.tsx` counts: 147 of them under packages/app alone, and they import core just as `.ts` files do.
  // A `.ts`-only corpus makes every core symbol that only the UI reaches look unreferenced.
  const ts = files.filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
  const parts = await Promise.all(ts.map((file) => fs.readFile(file, "utf8")))
  const text = parts.join("\n")
  // How many times each identifier appears in the corpus, counted in ONE pass. Two things fall out
  // of counting rather than collecting a Set:
  //   - The corpus includes the file being checked, so a Set membership test is always true for a
  //     declaration -- the guard would have passed for any newly added dead export. A count of 1 means
  //     "only the declaration itself", which is the condition that matters.
  //   - A per-name regex over the corpus is O(names x corpus) and times this test out on a repo this
  //     size; one pass into a Map is linear and every lookup after it is O(1).
  const counts = new Map<string, number>()
  for (const name of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return { count: ts.length, text, counts }
}

const DECLARATION = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm

// A module's name is its basename with the extension removed, and the extension a specifier carries is
// not necessarily the one the file has on disk. TypeScript sources here are written both ways: most
// import `./shell`, but ESM-style `./values.js` is equally valid and is what `packages/codemode` uses
// throughout. Stripping only ".ts" makes such a specifier read as the module name "values.js", so an
// imported module looks like an orphan -- a false failure that would blame an import rather than the
// guard. Every extension either side can be written is removed on both sides.
const EXTENSION = /\.[cm]?[jt]sx?$/
const moduleName = (specifier: string) => path.basename(specifier).replace(EXTENSION, "")

describe("no dead exports in core", () => {
  test("every exported function or const in core/src is referenced somewhere", async () => {
    const { count, counts } = await corpus()
    expect(count).toBeGreaterThan(0)

    // A name mentioned only by its own declaration cannot be called by anything: not another module,
    // not a test, not a sibling package.
    const unreferenced: string[] = []
    for (const file of await sources()) {
      if (EXEMPT_FILES.has(file.relative)) continue
      const source = await fs.readFile(file.absolute, "utf8")
      for (const match of source.matchAll(DECLARATION)) {
        const name = match[1]!
        if ((counts.get(name) ?? 0) <= 1) unreferenced.push(`${name} in ${file.relative}`)
      }
    }
    expect(unreferenced).toEqual([])
  })

  test("every core/src module is imported by something other than its own directory", async () => {
    const { text, count } = await corpus()
    expect(count).toBeGreaterThan(0)

    // One pass for every import specifier in the repo. Each specifier's basename is a module some
    // file imports; a core module whose basename is absent was never imported by anything. Matching
    // per file instead would be a regex per module over the whole corpus and times the test out.
    const imported = new Set<string>()
    // Both forms: a static `from "./x"` and a dynamic `import("./x")`. The migration registry loads
    // its steps with `import(...)`, so matching only the first form reports every migration as an
    // orphan.
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*"([^"]+)"/g)) {
      imported.add(moduleName(match[1]!))
    }

    const orphans: string[] = []
    for (const file of await sources()) {
      if (EXEMPT_FILES.has(file.relative)) continue
      if (BARRELS.test(path.basename(file.absolute))) continue

      if (!imported.has(moduleName(file.absolute))) orphans.push(file.relative)
    }
    expect(orphans).toEqual([])
  })
})
