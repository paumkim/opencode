import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"
import { errorMessage } from "@/util/error"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

/**
 * Forwards a proxied asset body, recording the cause if the upstream stream fails.
 *
 * A failed body used to be replaced with an empty stream, which is a false success rather than a
 * visible error: `proxyResponseHeaders` strips content-length, so the browser sees a clean
 * end-of-stream on a 200 and gets a half-written JS or CSS bundle. It reports "Unexpected end of
 * input" with no indication that the server failed, and nothing was logged here, so the only
 * evidence of the cause was a browser console message naming a line in a file the user did not
 * write.
 *
 * The status cannot be changed once streaming has started, so the record is the part that can be
 * honest: the reason is reported with the path and status that produced it, which is the difference
 * between "app.opencode.ai/assets/index.js failed: socket hang up" and an unexplained parse error.
 */
export function proxiedAssetStream<E>(stream: Stream.Stream<Uint8Array, E>, path: string, status: number) {
  return stream.pipe(
    Stream.tapCause((cause) =>
      Effect.logWarning("failed to stream proxied asset", {
        path,
        status,
        error: errorMessage(Cause.squash(cause)),
      }),
    ),
    Stream.catchCause(() => Stream.empty),
  )
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    // A failed upstream body used to be replaced with an empty stream, which is a false success
    // rather than a visible error: `proxyResponseHeaders` strips content-length, so the browser
    // sees a clean end-of-stream on a 200 and gets a half-written JS or CSS bundle. It reports
    // "Unexpected end of input" with no indication that the server failed, and nothing was logged
    // here, so the only evidence of the cause was a browser console message naming a line in a
    // file the user did not write.
    //
    // The status cannot be changed once streaming has started, so the record is what we can
    // honestly offer. The reason is reported with the path and status that produced it, which is
    // the difference between a report of "app.opencode.ai/assets/index.js failed: socket hang up"
    // and an unexplained parse error.
    const body = proxiedAssetStream(response.stream, path, response.status)
    return HttpServerResponse.stream(body, {
      status: response.status,
      headers,
    })
  })
}
