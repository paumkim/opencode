/**
 * Decode the body of a `data:` URL into text.
 *
 * A non-base64 data URL is percent-encoded, and `decodeURIComponent` throws a
 * `URIError` on any `%` that does not introduce a valid escape. Real inputs hit
 * that constantly: "100% done", a pasted percent sign, a file whose contents were
 * never percent-encoded in the first place. The caller is an `Effect.fn`, so the
 * throw surfaces as a defect that takes down the whole prompt rather than one
 * attachment.
 *
 * A stray `%` is overwhelmingly a literal percent sign rather than a broken
 * escape, so a failed decode falls back to the raw body. That returns the text
 * the sender actually meant instead of killing the turn.
 */
export function decodeDataUrl(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) return ""

  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  if (head.includes(";base64")) return Buffer.from(body, "base64").toString("utf8")
  try {
    return decodeURIComponent(body)
  } catch {
    return body
  }
}
