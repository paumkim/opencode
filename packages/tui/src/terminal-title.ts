import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { isDefaultTitle } from "./util/session"

export namespace TerminalTitle {
  export type Data = {
    session: readonly Pick<Session, "id" | "parentID" | "title">[]
    session_status: Record<string, Pick<SessionStatus, "type"> | undefined>
    permission: Record<string, readonly unknown[] | undefined>
    question: Record<string, readonly unknown[] | undefined>
  }

  export type Indicator = "none" | "working" | "attention" | "finished"

  const prefixes = { none: "", working: "[~] ", attention: "[!] ", finished: "[done] " }

  export function session(input: { id: string; data: Data; observed: ReadonlySet<string> }) {
    const info = input.data.session.find((item) => item.id === input.id)
    if (!info) return { title: "OpenCode", id: input.id, active: false, indicator: "none" as const }

    // Match Kilo's one-level family: viewing a child shares its parent's activity.
    const id = info.parentID ?? info.id
    const ids = [id, ...input.data.session.filter((item) => item.parentID === id).map((item) => item.id)]
    const indicator: Indicator = ids.some(
      (id) => (input.data.permission[id]?.length ?? 0) > 0 || (input.data.question[id]?.length ?? 0) > 0,
    )
      ? "attention"
      : ids.some((id) => {
            const status = input.data.session_status[id]?.type
            return status === "busy" || status === "retry"
          })
        ? "working"
        : input.observed.has(id)
          ? "finished"
          : "none"
    const title = info.title.length > 40 ? info.title.slice(0, 37) + "…" : info.title
    const base = isDefaultTitle(info.title) ? "OpenCode" : `OC | ${title}`
    return {
      title: prefixes[indicator] + base,
      id,
      active: indicator === "working" || indicator === "attention",
      indicator,
    }
  }
}
