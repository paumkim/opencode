import path from "path"
import * as Process from "./process"

/**
 * Escape a value for interpolation inside a single-quoted PowerShell string.
 *
 * A single quote is PowerShell's string delimiter, so a lone `'` closes the
 * string early and everything after it is parsed as code. Inside single quotes
 * the only escape is a doubled quote.
 */
export function psQuote(value: string) {
  return value.replaceAll("'", "''")
}

/**
 * Build the `Expand-Archive` command used to unpack an LSP binary on Windows.
 *
 * `-LiteralPath`, not `-Path`: `-Path` treats `[` and `]` as wildcard character
 * classes, so a directory containing brackets can match a different archive, or
 * fail with a path that does not exist. `-LiteralPath` takes the string as-is.
 *
 * Both paths are `psQuote`d because they are interpolated into a string that
 * PowerShell parses. They are not constants: they are built from the user's cache
 * directory (`Global.Path.bin`) and, for clangd, from `asset.name` taken verbatim
 * out of a GitHub releases response, so a `'` in either reaches here.
 */
export function windowsExpandArchiveCommand(zipPath: string, destDir: string) {
  // $global:ProgressPreference suppresses PowerShell's blue progress bar popup
  return `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(destDir)}' -Force`
}

function failure(label: string, result: Process.Result) {
  const stderr = result.stderr.toString("utf8").trim()
  const stdout = result.stdout.toString("utf8").trim()
  return new Error(stderr || stdout || `${label} failed with code ${result.code}`)
}

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    const result = await Process.run([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsExpandArchiveCommand(path.resolve(zipPath), path.resolve(destDir)),
    ])
    // `Process.run` only rejects when the spawn itself fails; a command that runs
    // and exits non-zero resolves with `code` set. Discarding that let every
    // caller see a successful extraction of an archive that was never unpacked,
    // leaving the LSP binary missing with no error anywhere.
    if (result.code !== 0) throw failure("Expand-Archive", result)
    return
  }

  const result = await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
  if (result.code !== 0) throw failure("unzip", result)
}

export * as Archive from "./archive"
