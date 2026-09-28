/**
 * Whether the follow-up queue may send its head right now.
 *
 * `working` is the Session's own busy state and is the only reason a queued
 * message waits. It has to come from the server: a submit used to latch the
 * Session busy on the client and the latch had no server-driven release on
 * protocol v2, so a queued message was accepted and never sent.
 */
export function followupDrainable(input: {
  readonly working: boolean
  readonly blocked: boolean
  readonly child: boolean
  readonly paused: boolean
  readonly failed: boolean
  readonly sending: boolean
}) {
  return !input.sending && !input.failed && !input.paused && !input.child && !input.blocked && !input.working
}
