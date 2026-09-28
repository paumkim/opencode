import { afterEach, describe, expect, test } from "bun:test"
import { downloadRefusal, locateViaXcrun, packageInstallFailed, serverInstallFailed } from "@/lsp/install-failure"

let restore: (() => void) | undefined

function captureConsole() {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "))
  }
  restore = () => {
    console.error = original
  }
  return lines
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("serverInstallFailed", () => {
  test("names the server, the stage and the reason", async () => {
    // The regression. Every install path ended in a bare `return`, and `getClients` filters on
    // `server.root(...)` returning truthy - so a JDTLS download that 404s read as "no Java in this
    // project". The user opened a .java file, got no diagnostics and no completions, and the one
    // thing that would explain it was thrown away. Naming the server and the stage matters because
    // "JDTLS is unavailable" and "the tarball would not extract" call for different fixes.
    const lines = captureConsole()
    serverInstallFailed("jdtls", "downloading https://www.eclipse.org/x.tar.gz", "HTTP 404")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("jdtls")
    expect(lines[0]).toContain("downloading")
    expect(lines[0]).toContain("HTTP 404")
  })

  test("distinguishes two servers that are both unavailable", () => {
    const lines = captureConsole()
    serverInstallFailed("jdtls", "extracting the release archive", "tar exited 2")
    serverInstallFailed("kotlin-ls", "extracting the release archive", "invalid zip")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("jdtls")
    expect(lines[1]).toContain("kotlin-ls")
  })

  test("describes a structured failure rather than rendering it as an object", () => {
    const lines = captureConsole()
    serverInstallFailed("jdtls", "listing /plugins", { message: "EACCES: permission denied" })
    expect(lines[0]).toContain("EACCES: permission denied")
    expect(lines[0]).not.toContain("[object Object]")
  })
})

describe("downloadRefusal", () => {
  test("a non-2xx response is a refusal, naming the status", () => {
    // The two cases the bare `if (!download.ok || !download.body) return` collapsed: a 404 from a
    // moved URL and a proxy returning a 200 with no body. They look identical to the old code.
    expect(downloadRefusal({ ok: false, status: 404 })).toContain("HTTP 404")
    expect(downloadRefusal({ ok: false, status: 503 })).toContain("HTTP 503")
  })

  test("a 200 with no body is a refusal too, and says so", () => {
    const refusal = downloadRefusal({ ok: true, status: 200, body: undefined })
    expect(refusal).toContain("no body")
  })

  test("a failed fetch with no status is still a refusal", () => {
    expect(downloadRefusal({ ok: false })).toContain("no response status")
  })

  test("a successful download is not a refusal", () => {
    // The direction that must not regress: an ordinary successful install stays silent. Reporting
    // here would log a line for every language server that works.
    expect(downloadRefusal({ ok: true, status: 200, body: "stream" })).toBeUndefined()
  })
})

describe("locateViaXcrun", () => {
  // This drives the call site `SourceKit.spawn` uses, so reverting it to a bare `return` fails here.
  // The helper tests above do not: they call `serverInstallFailed` directly and so pass whether or
  // not anything calls it.
  test("a failed xcrun lookup is reported rather than read as no Swift toolchain", async () => {
    const lines = captureConsole()
    const bin = await locateViaXcrun(async () => ({
      code: 72,
      text: "",
      stderr: Buffer.from("xcrun: error: unable to find utility"),
    }))
    expect(bin).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("sourcekit-lsp")
    expect(lines[0]).toContain("unable to find utility")
  })

  test("a non-zero exit with no stderr still names the exit code", async () => {
    const lines = captureConsole()
    await locateViaXcrun(async () => ({ code: 1, text: "", stderr: Buffer.from("   ") }))
    expect(lines[0]).toContain("xcrun --find exited 1")
  })

  test("an exit code of 0 with no output is a failure, not an empty path", async () => {
    // xcrun can exit 0 having printed nothing. `spawn("")` would be far worse than an absent
    // server, and the old code would have passed the empty string straight through.
    const lines = captureConsole()
    const bin = await locateViaXcrun(async () => ({ code: 0, text: "\n  ", stderr: Buffer.from("") }))
    expect(bin).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("no output")
  })

  test("a successful lookup returns the path and reports nothing", async () => {
    // The direction that must not regress: a working Swift toolchain stays silent.
    const lines = captureConsole()
    const bin = await locateViaXcrun(async () => ({
      code: 0,
      text: "/usr/bin/sourcekit-lsp\n",
      stderr: Buffer.from(""),
    }))
    expect(bin).toBe("/usr/bin/sourcekit-lsp")
    expect(lines).toEqual([])
  })
})

describe("packageInstallFailed", () => {
  test("reports the tool's own diagnosis, which used to die in an unread pipe", async () => {
    // The regression. All four `spawn` paths set `stderr: "pipe"` and then never read it, returning
    // on a non-zero exit. `spawn` returning undefined is what `getClients` reads as "this language is
    // not handled here", so a Go module that would not resolve looked exactly like "no Go in this
    // project" - and `go install` had printed the reason in full, specifically to be acted on.
    const lines = captureConsole()
    packageInstallFailed(
      "gopls",
      "go install golang.org/x/tools/gopls@latest",
      1,
      Buffer.alloc(0),
      Buffer.from("go: module lookup disabled by GOFLAGS=-mod=vendor"),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("gopls")
    expect(lines[0]).toContain("go install")
    expect(lines[0]).toContain("module lookup disabled by GOFLAGS")
  })

  test("includes stdout as well, because tools disagree about which stream carries the reason", () => {
    // `go install` writes to stderr; some `dotnet` output lands on stdout. Reporting one stream only
    // is how the other half of the explanation gets lost.
    const lines = captureConsole()
    packageInstallFailed(
      "roslyn-language-server",
      "dotnet tool install --global roslyn-language-server --prerelease",
      1,
      Buffer.from("error : The tool package requires .NET 8"),
      Buffer.from(""),
    )
    expect(lines[0]).toContain("requires .NET 8")
  })

  test("still names the exit code when the tool said nothing useful", () => {
    // Some failures produce no output at all. "exited 1" plus the exit code is thinner, but it is
    // still the difference between a recorded attempt and no record.
    const lines = captureConsole()
    packageInstallFailed("ruby-lsp", "gem install rubocop --bindir <bin>", 137, Buffer.alloc(0), Buffer.alloc(0))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("exited 137")
    expect(lines[0]).toContain("ruby-lsp")
  })

  test("distinguishes a toolchain problem from a network one, which read identically before", () => {
    const lines = captureConsole()
    packageInstallFailed("gopls", "go install ...", 1, Buffer.alloc(0), Buffer.from("dial tcp: proxy refused"))
    packageInstallFailed(
      "gopls",
      "go install ...",
      1,
      Buffer.alloc(0),
      Buffer.from("build constraints exclude all Go files"),
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("proxy refused")
    expect(lines[1]).toContain("build constraints")
  })

  test("describes a structured failure rather than rendering it as an object", () => {
    const lines = captureConsole()
    packageInstallFailed("gopls", "go install ...", 1, undefined, { message: "EACCES: permission denied" })
    expect(lines[0]).toContain("EACCES: permission denied")
    expect(lines[0]).not.toContain("[object Object]")
  })
})
