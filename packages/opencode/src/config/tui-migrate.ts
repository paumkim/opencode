import path from "path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { unique } from "remeda"
import { Option, Schema } from "effect"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { errorMessage } from "@/util/error"
import * as ConfigPaths from "@/config/paths"

const TUI_SCHEMA_URL = "https://opencode.ai/tui.json"

const decodeTheme = Schema.decodeUnknownOption(Schema.String)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeScrollSpeed = Schema.decodeUnknownOption(TuiConfig.ScrollSpeed)
const decodeScrollAcceleration = Schema.decodeUnknownOption(TuiConfig.ScrollAcceleration)
const decodeDiffStyle = Schema.decodeUnknownOption(TuiConfig.DiffStyle)

interface MigrateInput {
  cwd: string
  directories: string[]
}

/**
 * Migrates tui-specific keys (theme, keybinds, tui) from opencode.json files
 * into dedicated tui.json files. Migration is performed per-directory and
 * skips only locations where a tui.json already exists.
 *
 * Every step that can fail reports rather than returning a falsy sentinel, because each of these
 * failures is invisible and in two cases permanent. The migration is a one-way rewrite of the user's
 * own config: a read that fails means the theme and keybinds in that file are never carried over, and
 * a write that fails means the legacy keys stay in `opencode.json` while `tui.json` is never created -
 * so the next run tries again, but the user has no idea their settings are not migrating.
 *
 * The permanent case is the strip. Once `tui.json` exists, `targetExists` skips the directory
 * forever, so a strip that fails after a successful write leaves the legacy keys in `opencode.json`
 * permanently, duplicating the migrated values with no record that the cleanup was attempted.
 */
export async function migrateTuiConfig(input: MigrateInput) {
  return migrateFiles(
    await opencodeFiles(input),
    {
      readText: (file: string) => Filesystem.readText(file),
      exists: (file: string) => Filesystem.exists(file),
      write: (file: string, content: string) => Filesystem.write(file, content),
    },
    (message) => console.error(message),
  )
}

/**
 * The filesystem surface `migrateFiles` needs. Declared rather than picked from `Filesystem` because
 * `write` accepts a wider union there, and picking it would make the injected implementation have to
 * accept buffers it is never given.
 */
export interface MigrateFs {
  readText(file: string): Promise<string>
  exists(file: string): Promise<boolean>
  write(file: string, content: string): Promise<void>
}

/**
 * The per-file migration, over injected filesystem operations so the failure paths are reachable
 * from a test without arranging real permission or disk errors.
 */
export async function migrateFiles(files: readonly string[], fs: MigrateFs, report: (message: string) => void) {
  for (const file of files) {
    const source = await fs.readText(file).catch((error) => {
      report(`[config] could not read ${file} to migrate tui settings: ${errorMessage(error)}`)
      return undefined
    })
    if (!source) continue
    const errors: JsoncParseError[] = []
    const data = parseJsonc(source, errors, { allowTrailingComma: true })
    if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) {
      report(
        `[config] skipped migrating tui settings from ${file}: the file is not valid JSON, so its theme, keybinds and tui keys are still read from there and will never move to tui.json`,
      )
      continue
    }

    const theme = decodeTheme("theme" in data ? data.theme : undefined)
    const keybinds = decodeRecord("keybinds" in data ? data.keybinds : undefined)
    const legacyTui = decodeRecord("tui" in data ? data.tui : undefined)
    const extracted = {
      theme: Option.getOrUndefined(theme),
      keybinds: Option.getOrUndefined(keybinds),
      tui: Option.getOrUndefined(legacyTui),
    }
    const tui = extracted.tui ? normalizeTui(extracted.tui) : undefined
    if (extracted.theme === undefined && extracted.keybinds === undefined && !tui) continue

    const target = path.join(path.dirname(file), "tui.json")
    const targetExists = await fs.exists(target)
    if (targetExists) continue

    const payload: Record<string, unknown> = {
      $schema: TUI_SCHEMA_URL,
    }
    if (extracted.theme !== undefined) payload.theme = extracted.theme
    if (extracted.keybinds !== undefined) payload.keybinds = extracted.keybinds
    if (tui) Object.assign(payload, tui)

    const wrote = await fs.write(target, JSON.stringify(payload, null, 2)).then(
      () => true,
      (error) => {
        report(`[config] could not write ${target}: ${errorMessage(error)}`)
        return false
      },
    )
    if (!wrote) continue

    const stripped = await backupAndStripLegacy(file, source, fs, report)
    if (!stripped) continue
  }
}

function normalizeTui(data: Record<string, unknown>):
  | {
      scroll_speed: number | undefined
      scroll_acceleration: { enabled: boolean } | undefined
      diff_style: "auto" | "stacked" | undefined
    }
  | undefined {
  const parsed = {
    scroll_speed: Option.getOrUndefined(decodeScrollSpeed(data.scroll_speed)),
    scroll_acceleration: Option.getOrUndefined(decodeScrollAcceleration(data.scroll_acceleration)),
    diff_style: Option.getOrUndefined(decodeDiffStyle(data.diff_style)),
  }
  return parsed.scroll_speed === undefined &&
    parsed.diff_style === undefined &&
    parsed.scroll_acceleration === undefined
    ? undefined
    : parsed
}

async function backupAndStripLegacy(
  file: string,
  source: string,
  fs: Pick<MigrateFs, "exists" | "write">,
  report: (message: string) => void,
) {
  const backup = file + ".tui-migration.bak"
  const hasBackup = await fs.exists(backup)
  const backed = hasBackup
    ? true
    : await fs.write(backup, source).then(
        () => true,
        (error) => {
          // Refusing to strip without a backup is correct - the backup is what makes the rewrite
          // reversible - but it is also the one failure here that cannot be retried later, since
          // tui.json now exists and `targetExists` skips this directory from now on.
          report(
            `[config] could not write ${backup}, so the tui settings in ${file} were left in place. The migration will not retry: ${errorMessage(error)}`,
          )
          return false
        },
      )
  if (!backed) return false

  const text = ["theme", "keybinds", "tui"].reduce((acc, key) => {
    const edits = modify(acc, [key], undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    if (!edits.length) return acc
    return applyEdits(acc, edits)
  }, source)

  return fs.write(file, text).then(
    () => true,
    (error) => {
      report(
        `[config] wrote tui.json but could not remove the migrated keys from ${file}, so they are now duplicated in both files. The cleanup will not be retried: ${errorMessage(error)}`,
      )
      return false
    },
  )
}

async function opencodeFiles(input: { directories: string[]; cwd: string }) {
  const files = [
    ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
    ...(await Filesystem.findUp(["opencode.json", "opencode.jsonc"], input.cwd, undefined, { rootFirst: true })),
  ]
  for (const dir of unique(input.directories)) {
    files.push(...ConfigPaths.fileInDirectory(dir, "opencode"))
  }
  if (Flag.OPENCODE_CONFIG) files.push(Flag.OPENCODE_CONFIG)

  const existing = await Promise.all(
    unique(files).map(async (file) => {
      const ok = await Filesystem.exists(file)
      return ok ? file : undefined
    }),
  )
  return existing.filter((file): file is string => !!file)
}
