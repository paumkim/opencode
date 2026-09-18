import type { RGBA } from "@opentui/core"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

// Presentation-only wire fields. Catalog selection and ordering belong to packages/news.
export type HomeRelease = Readonly<{
  id: string
  title: string
  provider: string
  model: string
  releaseDate: string
}>

export async function loadHomeNews(
  client: Pick<ReturnType<typeof createOpencodeClient>, "request">,
  signal: AbortSignal,
) {
  const result = await client.request<{ 200: readonly HomeRelease[] }, unknown, true>({
    method: "GET",
    url: "/news",
    signal,
    parseAs: "json",
    throwOnError: true,
  })
  if (
    !Array.isArray(result.data) ||
    !result.data.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.model === "string" &&
        typeof item.provider === "string" &&
        typeof item.releaseDate === "string",
    )
  )
    throw new Error("Invalid news response")
  return result.data
}

export function HomeNews(props: {
  load: (signal: AbortSignal) => Promise<readonly HomeRelease[]>
  color: RGBA | string
  maxWidth: number
}) {
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => Math.max(0, Math.min(props.maxWidth, dimensions().width - 4)))
  const rows = createMemo(() => {
    if (width() < 36 || dimensions().height < 24) return 0
    if (width() < 60) return 1
    return Math.min(3, 1 + Math.floor((dimensions().height - 24) / 3))
  })
  const [items, setItems] = createSignal<readonly HomeRelease[]>([])
  const [status, setStatus] = createSignal<"loading" | "ready" | "offline">("loading")
  let refresh: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let disposed = false

  async function load() {
    const ctrl = new AbortController()
    request = ctrl
    timeout = setTimeout(() => ctrl.abort(), 8000)
    await props.load(ctrl.signal).then(
      (data) => {
        if (disposed) return
        setItems(data)
        setStatus("ready")
      },
      () => {
        if (!disposed) setStatus("offline")
      },
    )
    clearTimeout(timeout)
    if (!disposed) refresh = setTimeout(load, 5 * 60 * 1000)
  }

  onMount(() => void load())
  onCleanup(() => {
    disposed = true
    clearTimeout(refresh)
    clearTimeout(timeout)
    request?.abort()
  })

  return (
    <Show when={rows() > 0}>
      <box width={width()} flexShrink={0} marginTop={1}>
        <text fg={props.color} wrapMode="none" truncate>
          Model releases{status() === "offline" && items().length > 0 ? " · offline (cached)" : ""}
        </text>
        <Show
          when={items().length > 0}
          fallback={
            <text fg={props.color} wrapMode="none" truncate>
              {status() === "loading"
                ? "Loading releases…"
                : status() === "offline"
                  ? "Release news unavailable · retrying later"
                  : "No recent model releases"}
            </text>
          }
        >
          <For each={items().slice(0, rows())}>
            {(item) => (
              <box flexDirection="row" height={1} gap={1}>
                <text fg={props.color} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                  {item.title || item.model}
                </text>
                <text fg={props.color} width={Math.floor(width() / 4)} flexShrink={0} wrapMode="none" truncate>
                  {item.provider}
                </text>
                <text fg={props.color} width={10} flexShrink={0} wrapMode="none" truncate>
                  {item.releaseDate.slice(0, 10)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}
