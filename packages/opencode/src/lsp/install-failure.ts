import { errorMessage } from "@/util/error"

/**
 * Records that a language server could not be installed, and says why.
 *
 * Every install path here ends in a bare `return` on failure, and that return is indistinguishable
 * from "this language is not handled here": `getClients` filters on `server.root(...)` returning
 * truthy, so a JDTLS download that 404s and a Kotlin install whose zip will not extract both read as
 * "no Java in this project". The user opens a `.java` file, gets no diagnostics, no hover and no
 * completions, and the server has no record that it ever tried - so the one thing that would explain
 * it (it downloaded, and the download failed) is the one thing that was thrown away.
 *
 * This is the same defect as the diagnostics pull reading as a clean file, one step earlier: a
 * missing measurement presented as a definitive answer. The message names the server and the stage,
 * because "JDTLS is unavailable" and "the JDTLS tarball would not extract" call for different fixes.
 *
 * Routed through `console.error` rather than the effect log because these paths run before any
 * instance is established, where there is no log context to attach to.
 */
export function serverInstallFailed(server: string, stage: string, detail: unknown) {
  console.error(`[lsp] ${server} is unavailable: ${stage} failed - ${errorMessage(detail)}`)
}

/**
 * The reason a fetch could not be used, or `undefined` when it can. A download that returns a non-2xx
 * and one that returns no body are both "the fetch did not work", and both used to return silently.
 */
export function downloadRefusal(response: { ok: boolean; status?: number; body?: unknown }) {
  // A 2xx with no body is still a failed download: there is nothing to write. The old check was
  // `!response.ok || !response.body`, so this case was lumped in with the non-2xx one and reported
  // as a status, when what actually went wrong was an empty response.
  if (!response.ok || !response.body) {
    if (response.ok) return "HTTP 200, and the response had no body"
    const status = typeof response.status === "number" ? `HTTP ${response.status}` : "no response status"
    return `${status}${response.body ? "" : ", and the response had no body"}`
  }
  return undefined
}

/**
 * Resolves `sourcekit-lsp` through `xcrun --find`, reporting when that lookup fails.
 *
 * The failure was a bare `return`, and `spawn` returning undefined is what `getClients` reads as
 * "this language is not handled here" - so an Xcode install that xcrun cannot resolve looked exactly
 * like a Mac without Swift, and the user got no diagnostics on a `.swift` file with nothing on record
 * explaining why. The stage is named because "sourcekit-lsp is unavailable" and "xcrun could not find
 * it" are different problems: the first usually means no toolchain, the second a broken Xcode
 * selection.
 *
 * `lookup` is a parameter so this is reachable from a test on any platform - it shells out to xcrun,
 * which exists only on macOS.
 */
export async function locateViaXcrun(
  lookup: (args: string[]) => Promise<{ code: number; text: string; stderr: Uint8Array }>,
) {
  const located = await lookup(["xcrun", "--find", "sourcekit-lsp"])
  if (located.code !== 0) {
    serverInstallFailed(
      "sourcekit-lsp",
      "locating the binary with xcrun",
      Buffer.from(located.stderr).toString("utf8").trim() || `xcrun --find exited ${located.code}`,
    )
    return undefined
  }
  const bin = located.text.trim()
  // An empty result is a failure too: xcrun can exit 0 having printed nothing, and `spawn("")` would
  // be a far worse outcome than an absent server.
  if (!bin) {
    serverInstallFailed("sourcekit-lsp", "locating the binary with xcrun", "xcrun exited 0 with no output")
    return undefined
  }
  return bin
}

/**
 * Reports a package-manager install that failed, and describes what the tool actually said.
 *
 * The four `spawn` paths that shell out to `go install`, `gem install` and `dotnet tool install` all
 * set `stderr: "pipe"` and then never read it, returning on a non-zero exit with the reason still
 * sitting in the pipe. `spawn` returning undefined is what `getClients` reads as "this language is
 * not handled here", so a Go module that would not resolve because of a proxy, a missing compiler, or
 * a `dotnet` SDK too old for a `--prerelease` package all read as "no Go in this project" - and the
 * tool's own diagnosis, which it printed in full specifically so somebody could act on it, was thrown
 * away.
 *
 * The exit code is kept alongside the output because the two say different things: a `1` with
 * "unable to resolve module" is a network or proxy problem, and a `1` with "requires .NET 8" is a
 * toolchain problem. Neither is visible from the other.
 *
 * `stdout` and `stderr` are included because which stream a tool uses for its diagnosis is not
 * consistent: `go install` writes to stderr, some `dotnet` output lands on stdout, and reporting only
 * one of them is how the other half of the explanation gets lost.
 */
export function packageInstallFailed(server: string, command: string, exit: number, out: unknown, err: unknown) {
  // Only the empty ones are dropped. My first version also compared each extracted string against
  // `errorMessage(text)` to catch "[object Object]", and that comparison is always false for a real
  // message - `errorMessage` returns a string unchanged - so it filtered out every message the tool
  // had actually printed. The guard belongs in `asText`, not in a filter over its output.
  const detail = [asText(err), asText(out)].filter((text) => text.length > 0).join(" | ")
  serverInstallFailed(server, `installing with \`${command}\``, detail || `exited ${exit}`)
}

function asText(value: unknown) {
  if (value === undefined || value === null) return ""
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim()
  if (typeof value === "string") return value.trim()
  return errorMessage(value)
}
