import { errorMessage } from "./error"

/**
 * Runs a mutation against the generated client, reports a refusal to the user,
 * and returns whether the server actually accepted it.
 *
 * The client resolves a non-2xx as `{ data, error }` rather than rejecting, so
 * a refused mutation is indistinguishable from a successful one unless `error`
 * is inspected. `void client.revert(...)` followed by a state change is exactly
 * that mistake: `session.revert` answers 409 while a session is running, and the
 * UI would refill the prompt as though the conversation had been rewound — the
 * user would be handed text to resend against a transcript that never changed.
 *
 * The reporting lives here so a caller that forgets to branch still surfaces the
 * failure. The boolean is what lets a careful caller avoid the state change:
 * act on it only when the server agreed.
 */
export async function mutateRemote(
  run: () => Promise<{ data?: unknown; error?: unknown }>,
  report: (reason: string) => void,
): Promise<boolean> {
  let result: { data?: unknown; error?: unknown }
  try {
    result = await run()
  } catch (error) {
    // A transport failure rejects rather than resolving with an error, so it
    // has to be caught here or it escapes as an unhandled rejection.
    report(errorMessage(error))
    return false
  }
  if (result.error !== undefined && result.error !== null) {
    report(errorMessage(result.error))
    return false
  }
  return true
}
