import { createMemo, createResource, onMount, Show } from "solid-js"
import type { SessionSearchHit } from "@opencode-ai/sdk/v2"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { createDebouncedSignal } from "../../util/signal"

export interface SearchTarget {
  readonly sessionID: string
  readonly messageID: string
}

/**
 * The server matches a literal substring, so an empty or whitespace-only filter
 * is never sent: `SessionSearch.search` would answer it with an empty list, and
 * the row of "no results" is more honest than a spinner that resolves to nothing.
 */
export function createSearchQuery(input: { filter: string; sessionID?: string; all?: boolean }) {
  const q = input.filter.trim()
  if (!q) return undefined
  return {
    q,
    ...(input.sessionID ? { session: input.sessionID } : {}),
    ...(input.all ? { all: "true" as const } : {}),
  }
}

export type SearchQuery = NonNullable<ReturnType<typeof createSearchQuery>>

export async function loadSearchResults<T>(
  query: SearchQuery | undefined,
  search: (query: SearchQuery) => Promise<{ data?: T[] }>,
): Promise<T[] | undefined> {
  if (!query) return undefined
  const result = await search(query).catch(() => undefined)
  return result?.data
}

/**
 * One row per matching message part, newest conversation first. The snippet is
 * the title because it is the only text that tells the two hits apart; the
 * session title and role go in the gutter so a hit in another conversation is
 * not mistaken for one in this one.
 */
export function searchHitsToOptions<T extends SessionSearchHit>(
  hits: readonly T[],
): DialogSelectOption<SearchTarget>[] {
  return hits.map((hit) => ({
    title: hit.snippet.replace(/\s+/g, " ").trim(),
    value: { sessionID: hit.sessionID, messageID: hit.messageID },
    description: hit.matches > 1 ? `${hit.matches} matches` : undefined,
    footer: hit.sessionTitle,
    category: hit.role,
    truncateTitle: true,
  }))
}

export function DialogSearch(props: {
  /** Restrict to one conversation. Omitted for the cross-session search. */
  sessionID?: string
  /** Search every project rather than the current one. */
  all?: boolean
  onSelect: (target: SearchTarget) => void
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [filter, setFilter] = createDebouncedSignal("", 200)

  onMount(() => {
    dialog.setSize("large")
  })

  const [results] = createResource(
    () => createSearchQuery({ filter: filter(), sessionID: props.sessionID, all: props.all }),
    (query) =>
      loadSearchResults(query, (input) => sdk.client.session.search({ ...input, limit: "50" }, { throwOnError: true })),
  )

  const options = createMemo(() => searchHitsToOptions(results() ?? []))

  return (
    <DialogSelect
      title={props.sessionID ? "Search this conversation" : "Search all sessions"}
      placeholder="Type to search every message"
      skipFilter
      options={options()}
      onFilter={(query) => setFilter(query)}
      onSelect={(option) => props.onSelect(option.value)}
      emptyView={
        <Show
          when={filter().trim()}
          fallback={<text fg={theme.textMuted}>Search looks inside every message you have sent or received.</text>}
        >
          <text fg={theme.textMuted}>No messages match {JSON.stringify(filter().trim())}.</text>
        </Show>
      }
    />
  )
}
