import path from "path"
import { fileURLToPath } from "url"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { errorMessage } from "@/util/error"
import { Flock } from "@opencode-ai/core/util/flock"

import { parsePluginSpecifier, pluginSource } from "./shared"

type Source = "file" | "npm"

export type Theme = {
  src: string
  dest: string
  mtime?: number
  size?: number
}

export type Entry = {
  id: string
  source: Source
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
  themes?: Record<string, Theme>
}

export type State = "first" | "updated" | "same"

export type Touch = {
  spec: string
  target: string
  id: string
}

type Store = Record<string, Entry>
type Core = Omit<Entry, "first_time" | "last_time" | "time_changed" | "load_count" | "fingerprint" | "themes">
type Row = Touch & { core: Core }

function storePath() {
  return Flag.OPENCODE_PLUGIN_META_FILE ?? path.join(Global.Path.state, "plugin-meta.json")
}

function lock(file: string) {
  return `plugin-meta:${file}`
}

function fileTarget(spec: string, target: string) {
  if (spec.startsWith("file://")) return fileURLToPath(spec)
  if (target.startsWith("file://")) return fileURLToPath(target)
  return
}

async function modifiedAt(file: string) {
  const stat = await Filesystem.statAsync(file)
  if (!stat) return
  const mtime = stat.mtimeMs
  return Math.floor(typeof mtime === "bigint" ? Number(mtime) : mtime)
}

function resolvedTarget(target: string) {
  if (target.startsWith("file://")) return fileURLToPath(target)
  return target
}

async function npmVersion(target: string) {
  const resolved = resolvedTarget(target)
  const stat = await Filesystem.statAsync(resolved)
  const dir = stat?.isDirectory() ? resolved : path.dirname(resolved)
  return Filesystem.readJson<{ version?: string }>(path.join(dir, "package.json"))
    .then((item) => item.version)
    .catch(() => undefined)
}

async function entryCore(item: Touch): Promise<Core> {
  const spec = item.spec
  const target = item.target
  const source = pluginSource(spec)
  if (source === "file") {
    const file = fileTarget(spec, target)
    return {
      id: item.id,
      source,
      spec,
      target,
      modified: file ? await modifiedAt(file) : undefined,
    }
  }

  return {
    id: item.id,
    source,
    spec,
    target,
    requested: parsePluginSpecifier(spec).version,
    version: await npmVersion(target),
  }
}

function fingerprint(value: Core) {
  if (value.source === "file") return [value.target, value.modified ?? ""].join("|")
  return [value.target, value.requested ?? "", value.version ?? ""].join("|")
}

/**
 * Reads the plugin metadata store, distinguishing "not written yet" from "could not be read".
 *
 * The old version was `readJson(file).catch(() => ({}) as Store)`, which made a failed read
 * indistinguishable from a first run - and that matters because every writer reads first and writes
 * the result back. `touchMany` would take the empty store, add only the plugins in the current batch,
 * and write that out, so one transient failure (a file locked by another process, a partial write
 * from a killed process) permanently erased the recorded metadata of every plugin not in that batch:
 * install times, fingerprints, and user-picked themes. Silent, unrecoverable data loss caused by a
 * read that was merely expected to be recoverable.
 *
 * So a read that fails for any reason other than ENOENT throws. ENOENT is the genuine first-run case
 * and still yields an empty store. A read that SUCCEEDS but does not contain an object is a
 * different problem again - a corrupt or foreign file - and is reported too, since writing over it
 * would destroy whatever it holds.
 *
 * Exported so both halves are testable: `readJson` is the only thing that has to be substituted, and
 * a real filesystem makes a transient read failure awkward to arrange.
 */
export async function readPluginStore(file: string) {
  let raw: unknown
  try {
    raw = await Filesystem.readJson(file)
  } catch (error) {
    if (isMissingFile(error)) return {} as Store
    throw new Error(
      `Failed to read the plugin metadata store at ${file}. Refusing to continue, because the next write would overwrite it with a partial store and permanently lose the plugins it recorded: ${errorMessage(error)}`,
    )
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `The plugin metadata store at ${file} is not an object${Array.isArray(raw) ? " (it is an array)" : ` (it is ${raw === null ? "null" : typeof raw})`}. Refusing to continue, because the next write would overwrite it.`,
    )
  }
  return raw as Store
}

/** The one read failure that means "nothing has been written yet". */
function isMissingFile(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT"
}

const read = readPluginStore

async function row(item: Touch): Promise<Row> {
  return {
    ...item,
    core: await entryCore(item),
  }
}

function next(prev: Entry | undefined, core: Core, now: number): { state: State; entry: Entry } {
  const entry: Entry = {
    ...core,
    first_time: prev?.first_time ?? now,
    last_time: now,
    time_changed: prev?.time_changed ?? now,
    load_count: (prev?.load_count ?? 0) + 1,
    fingerprint: fingerprint(core),
    themes: prev?.themes,
  }
  const state: State = !prev ? "first" : prev.fingerprint === entry.fingerprint ? "same" : "updated"
  if (state === "updated") entry.time_changed = now
  return {
    state,
    entry,
  }
}

export async function touchMany(items: Touch[]): Promise<Array<{ state: State; entry: Entry }>> {
  if (!items.length) return []
  const file = storePath()
  const rows = await Promise.all(items.map((item) => row(item)))

  return Flock.withLock(lock(file), async () => {
    const store = await read(file)
    const now = Date.now()
    const out: Array<{ state: State; entry: Entry }> = []
    for (const item of rows) {
      const hit = next(store[item.id], item.core, now)
      store[item.id] = hit.entry
      out.push(hit)
    }
    await Filesystem.writeJson(file, store)
    return out
  })
}

export async function touch(spec: string, target: string, id: string): Promise<{ state: State; entry: Entry }> {
  return touchMany([{ spec, target, id }]).then((item) => {
    const hit = item[0]
    if (hit) return hit
    throw new Error("Failed to touch plugin metadata.")
  })
}

export async function setTheme(id: string, name: string, theme: Theme): Promise<void> {
  const file = storePath()
  await Flock.withLock(lock(file), async () => {
    const store = await read(file)
    const entry = store[id]
    if (!entry) return
    entry.themes = {
      ...entry.themes,
      [name]: theme,
    }
    await Filesystem.writeJson(file, store)
  })
}

export async function list(): Promise<Store> {
  const file = storePath()
  return Flock.withLock(lock(file), async () => read(file))
}

export * as PluginMeta from "./meta"
