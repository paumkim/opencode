import { errorMessage } from "../../util/error"

export type PromptDelivery = "prompt" | "command" | "shell"

const TITLES: Record<PromptDelivery, string> = {
  prompt: "Failed to send prompt",
  command: "Failed to send command",
  shell: "Failed to send shell command",
}

/**
 * Hands a prompt, command or shell invocation to whichever transport is live,
 * reporting whatever went wrong. Returns false only when the message provably
 * did not leave the machine.
 *
 * The two transports fail differently, which is why this exists rather than an
 * inline check at each call site:
 *
 *   - The shared-workspace socket knows synchronously. `send` returns false
 *     when the socket was not open, and the socket reconnects on route
 *     changes, so there is a real window where a typed message is dropped.
 *   - The HTTP transport cannot know synchronously — the request is already in
 *     flight — so a failure there is reported from the catch and the message is
 *     treated as delivered. The prompt input has already been cleared by then
 *     and is recoverable from the editor history, which is why the asymmetry is
 *     worth stating rather than papering over.
 */
export function deliverPrompt(input: {
  kind: PromptDelivery
  /** The shared-workspace socket. Returns false when it dropped the message. */
  shared?: () => boolean
  /** The HTTP transport. Its failures are reported asynchronously. */
  http?: () => Promise<unknown>
  report: (title: string, message: string) => void
}): boolean {
  if (input.shared) return input.shared()
  if (input.http) {
    void Promise.resolve(input.http()).catch((error) => {
      input.report(TITLES[input.kind], errorMessage(error))
    })
  }
  return true
}
