import { errorMessage } from "./error"

/**
 * The outcome of reading a remote value that has a meaningful "nothing there"
 * state: success with data, success with nothing, or a failure to read at all.
 *
 * The generated SDK client returns `{ data, error }` instead of rejecting on a
 * non-2xx, so `data` is absent both when the value is genuinely empty *and*
 * when the server could not be read. Callers that collapse the two report an
 * unreachable server as "you have no MCP servers", "no LSP servers", "no
 * custom commands" — claims the user then acts on.
 */
export type Read<T> = { ok: true; data: T } | { ok: false; reason: string }

/**
 * Runs a generated-client read and separates a failed read from an empty one.
 *
 * `empty` is the value a successful read with no entries produces, so the
 * success branch always carries a real `T` and callers never re-implement the
 * `?? []` that erased the failure.
 */
export async function readRemote<T>(run: () => Promise<{ data?: T; error?: unknown }>, empty: T): Promise<Read<T>> {
  let result: { data?: T; error?: unknown }
  try {
    result = await run()
  } catch (error) {
    // Transport-level failure: the request never got an HTTP response. The
    // generated client only rejects for these, never for a typed error.
    return { ok: false, reason: errorMessage(error) }
  }
  // `error` is checked for presence, not truthiness: a falsy-but-present error
  // is still a response the server declined to answer.
  if (result.error !== undefined && result.error !== null) return { ok: false, reason: errorMessage(result.error) }
  return { ok: true, data: result.data ?? empty }
}
