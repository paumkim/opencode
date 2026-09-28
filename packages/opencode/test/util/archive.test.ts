import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { extractZip, psQuote, windowsExpandArchiveCommand } from "@/util/archive"

// `extractZip` interpolates two paths into a PowerShell `-Command` string, and
// neither is a constant: they are built from the user's cache directory, and for
// clangd the archive name comes verbatim out of a GitHub releases response.
describe("windowsExpandArchiveCommand", () => {
  test("quotes an ordinary path", () => {
    const cmd = windowsExpandArchiveCommand("C:\\Users\\u\\AppData\\Local\\bin\\rg.zip", "C:\\dest")
    expect(cmd).toContain("-LiteralPath 'C:\\Users\\u\\AppData\\Local\\bin\\rg.zip'")
    expect(cmd).toContain("-DestinationPath 'C:\\dest'")
  })

  // A lone quote closes the PowerShell string; the rest of the path is then
  // parsed as code. Doubling it is the only escape inside single quotes.
  test("doubles a single quote so a path cannot close the string", () => {
    const cmd = windowsExpandArchiveCommand("C:\\a';calc;'b.zip", "C:\\dest")
    expect(cmd).toContain("-LiteralPath 'C:\\a'';calc;''b.zip'")
    // Every quote in the command is now part of a balanced pair: 2 for
    // ProgressPreference, 6 for the literal path (the path holds two quotes of its
    // own, doubled to four, plus its two delimiters), 2 for the destination.
    // Before the fix the path's own two quotes were left bare, so the string
    // closed early and `calc;` ran as PowerShell.
    const quotes = cmd.match(/'/g) ?? []
    expect(quotes.length).toBe(10)
  })

  test("escapes a quote in the destination directory too", () => {
    const cmd = windowsExpandArchiveCommand("C:\\a.zip", "C:\\it's here")
    expect(cmd).toContain("-DestinationPath 'C:\\it''s here'")
  })

  // `-Path` treats [] as a wildcard character class, so a cache directory with
  // brackets could match a different archive or fail on a path that exists.
  test("uses -LiteralPath so brackets are not wildcards", () => {
    const cmd = windowsExpandArchiveCommand("C:\\a[1].zip", "C:\\d[2]")
    expect(cmd).toContain("-LiteralPath")
    expect(cmd).not.toMatch(/(?<!Literal)Expand-Archive -Path/)
  })

  test("keeps the progress preference suppression", () => {
    expect(windowsExpandArchiveCommand("C:\\a.zip", "C:\\d")).toContain(
      "$global:ProgressPreference = 'SilentlyContinue'",
    )
  })

  test("psQuote leaves ordinary text alone", () => {
    expect(psQuote("C:\\Users\\u\\bin")).toBe("C:\\Users\\u\\bin")
  })

  test("psQuote doubles every quote", () => {
    expect(psQuote("'''")).toBe("''''''")
  })
})

// `Process.run` rejects only when the spawn itself fails; a command that runs and
// exits non-zero resolves with `code` set. `extractZip` discarded that code, so
// every caller saw a successful extraction of an archive that was never unpacked,
// leaving the LSP binary missing with no error anywhere. All nine call sites do
// `.then(() => true).catch(() => false)`, so a throw here is what they expect.
describe("extractZip failure reporting", () => {
  test.skipIf(process.platform === "win32")("rejects when unzip cannot unpack the archive", async () => {
    // Not a zip file, so unzip runs and exits non-zero — the exact case that was
    // previously reported as success.
    const dir = await mkdtemp(path.join(tmpdir(), "archive-test-"))
    try {
      const bogus = path.join(dir, "not-a-zip.zip")
      await writeFile(bogus, "this is not a zip archive")
      await expect(extractZip(bogus, dir)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("rejects when the archive does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archive-test-"))
    try {
      await expect(extractZip(path.join(dir, "missing.zip"), dir)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
