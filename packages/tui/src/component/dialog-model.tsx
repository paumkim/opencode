import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { TextAttributes } from "@opentui/core"
import {
  MODEL_SEARCH_KEYS,
  formatContext,
  formatModelFooter,
  formatPrice,
  groupRank,
  isFreeModel,
  matchesModelFilter,
  modelTags,
  parseModelQuery,
  smartCategory,
} from "../util/model-categories"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)
  const wide = createMemo(() => dimensions().width >= 108)
  const [preview, setPreview] = createSignal<{
    title: string
    description?: string
    providerID?: string
    releaseDate?: string | number
    reasoning?: boolean
    toolcall?: boolean
    context?: number
    isFree?: boolean
    cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  }>()

  const lookup = (providerID: string, modelID: string) => {
    const provider = sync.data.provider.find((x) => x.id === providerID)
    const model = provider?.models[modelID]
    if (!provider || !model) return
    return {
      title: model.name ?? modelID,
      description: provider.name,
      providerID: provider.id,
      releaseDate: model.release_date,
      reasoning: model.capabilities.reasoning,
      toolcall: model.capabilities.toolcall,
      context: model.limit.context,
      isFree: isFreeModel(model),
      cost: model.cost,
    }
  }

  createEffect(() => {
    dialog.setSize(wide() ? "xlarge" : "large")
  })

  createEffect(() => {
    const current = local.model.current()
    if (!current) return
    const next = lookup(current.providerID, current.modelID)
    if (!next) return
    setPreview(next)
  })

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        const free = isFreeModel(model)
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            providerName: provider.name,
            category,
            providerID: provider.id,
            modelID: model.id,
            family: model.family,
            tags: modelTags(model, provider),
            isFree: free,
            reasoning: model.capabilities.reasoning,
            toolcall: model.capabilities.toolcall,
            context: model.limit.context,
            cost: model.cost,
            releaseDate: model.release_date,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: formatModelFooter(model),
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const free = isFreeModel(info)
            return {
              value: { providerID: provider.id, modelID: model },
              title: info.name ?? model,
              releaseDate: info.release_date,
              description: provider.name,
              providerName: provider.name,
              category: props.providerID ? undefined : connected() ? smartCategory(info, provider) : undefined,
              providerID: provider.id,
              modelID: model,
              family: info.family,
              tags: modelTags(info, provider),
              isFree: free,
              reasoning: info.capabilities.reasoning,
              toolcall: info.capabilities.toolcall,
              context: info.limit.context,
              cost: info.cost,
              disabled: provider.id === "opencode" && model.includes("-nano"),
              footer: formatModelFooter(info),
              onSelect() {
                onSelect(provider.id, model)
              },
            }
          }),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) =>
            props.providerID !== undefined ? sortModelOptions(options, true) : options,
        ),
      ),
    )

    const allProviderOptions =
      props.providerID !== undefined || !connected() ? providerOptions : sortModelOptions(providerOptions, false)

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      const filter = parseModelQuery(needle)
      const prefiltered = allProviderOptions.filter((option) => matchesModelFilter(option, filter))
      if (!filter.search) {
        return [
          ...sortModelOptions(prefiltered, false),
          ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
        ]
      }
      const scored = fuzzysort.go(filter.search, prefiltered, { keys: [...MODEL_SEARCH_KEYS] })
      const ranked = [...scored]
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          const aFree = a.obj.isFree || (a.obj.footer ?? "").startsWith("Free") ? 0 : 1
          const bFree = b.obj.isFree || (b.obj.footer ?? "").startsWith("Free") ? 0 : 1
          if (aFree !== bFree) return aFree - bFree
          return (b.obj.context ?? 0) - (a.obj.context ?? 0)
        })
        .map((x) => x.obj)
      return [...ranked, ...fuzzysort.go(filter.search, popularProviders, { keys: ["title"] }).map((x) => x.obj)]
    }

    return [...favoriteOptions, ...recentOptions, ...allProviderOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  /** Label/value row in the detail panel — label left-aligned, value right-aligned. */
  function Field(props: { label: string; children: JSX.Element }) {
    return (
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted} flexShrink={0}>
          {props.label}
        </text>
        <box flexShrink={0} paddingLeft={2}>
          {props.children}
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="row">
      <box flexGrow={1} flexShrink={1}>
        <DialogSelect<ReturnType<typeof options>[number]["value"]>
          options={options()}
          actions={[
            {
              command: "model.dialog.provider",
              title: connected() ? "Connect provider" : "View all providers",
              onTrigger() {
                dialog.replace(() => <DialogProvider />)
              },
            },
            {
              command: "model.dialog.favorite",
              title: "Favorite",
              hidden: !connected(),
              onTrigger: (option) => {
                local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
              },
            },
          ]}
          onFilter={setQuery}
          onMove={(option) => {
            if (typeof option.value === "string") {
              setPreview(undefined)
              return
            }
            const o = option as any
            setPreview({
              title: o.title,
              description: o.description,
              providerID: o.providerID,
              releaseDate: o.releaseDate,
              reasoning: o.reasoning,
              toolcall: o.toolcall,
              context: o.context,
              isFree: o.isFree,
              cost: o.cost,
            })
          }}
          skipFilter={true}
          title={title()}
          current={local.model.current()}
        />
      </box>
      <Show when={wide() && preview()}>
        {(item) => {
          const p = item()!
          const cost = p.cost
          const ctx = p.context
          const free = p.isFree
          const input = cost?.input
          const output = cost?.output
          const cacheRead = cost?.cache?.read
          const cacheWrite = cost?.cache?.write
          return (
            <box
              width={Math.max(32, Math.floor(dimensions().width * 0.30))}
              flexShrink={0}
              border={["left"]}
              borderColor={theme.borderSubtle}
              backgroundColor={theme.backgroundPanel}
              paddingTop={1}
              gap={1}
            >
              <scrollbox maxHeight={Math.floor(dimensions().height / 2) - 3} scrollbarOptions={{ visible: false }}>
                <box paddingLeft={2} paddingRight={2} gap={0} flexDirection="column">
                  <box gap={1} flexDirection="column" paddingBottom={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                      {p.title}
                    </text>
                    <text fg={theme.textMuted}>{p.description ?? p.providerID}</text>
                  </box>

                  <box gap={0} flexDirection="column">
                    <Field label="Released">
                      <text fg={theme.text}>{formatDate(p.releaseDate)}</text>
                    </Field>
                    <Field label="Reasoning">
                      <text fg={p.reasoning ? theme.text : theme.textMuted}>
                        {p.reasoning ? "Yes" : "No"}
                      </text>
                    </Field>
                    <Field label="Tools">
                      <text fg={p.toolcall ? theme.text : theme.textMuted}>
                        {p.toolcall ? "Yes" : "No"}
                      </text>
                    </Field>
                    <Field label="Context">
                      <text fg={theme.text}>{ctx ? formatContext(ctx) : "—"}</text>
                    </Field>
                  </box>

                  <box height={1} />

                  <box gap={0} flexDirection="column">
                    <text fg={theme.textMuted} attributes={TextAttributes.BOLD} paddingBottom={1}>
                      Pricing
                    </text>
                    {free ? (
                      <text fg={theme.text}>Free</text>
                    ) : (
                      <box gap={0} flexDirection="column">
                        {typeof input === "number" && input > 0 && (
                          <Field label="Input">
                            <text fg={theme.text}>${formatPrice(input)}/M</text>
                          </Field>
                        )}
                        {typeof output === "number" && output > 0 && (
                          <Field label="Output">
                            <text fg={theme.text}>${formatPrice(output)}/M</text>
                          </Field>
                        )}
                        {typeof cacheRead === "number" && cacheRead > 0 && (
                          <Field label="Cache read">
                            <text fg={theme.textMuted}>${formatPrice(cacheRead)}/M</text>
                          </Field>
                        )}
                        {typeof cacheWrite === "number" && cacheWrite > 0 && (
                          <Field label="Cache write">
                            <text fg={theme.textMuted}>${formatPrice(cacheWrite)}/M</text>
                          </Field>
                        )}
                      </box>
                    )}
                  </box>
                </box>
              </scrollbox>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

export function sortModelOptions<
  T extends {
    footer?: string
    releaseDate: string | number
    title: string
    category?: string
    context?: number
    isFree?: boolean
  },
>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => groupRank(option.category),
    (option) => (option.isFree ?? (option.footer ?? "").startsWith("Free") ? 0 : 1),
    [(option) => option.context ?? 0, "desc"],
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}

function formatDate(input: string | number | undefined): string {
  if (!input) return "—"
  const num = typeof input === "string" ? Number(input) : input
  if (!Number.isFinite(num)) return String(input)
  const date = new Date(num * 1000)
  if (Number.isNaN(date.getTime())) return String(input)
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}
