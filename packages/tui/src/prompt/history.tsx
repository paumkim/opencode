import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { errorMessage } from "../util/error"
import { appendText, readText, writeTextAtomic } from "../util/persistence"
import { useToast } from "../ui/toast"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const toast = useToast()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")

    /**
     * Every write below used to end in `.catch(() => {})` while the in-memory store was updated
     * first, so a failed write left the up-arrow listing prompts that were never persisted and
     * would be gone on the next launch. They go through the atomic primitive so a failure part way
     * through cannot replace the entries already on disk with a truncated file.
     */
    const persist = (reason: string) => {
      const body = store.history.map((line) => JSON.stringify(line)).join("\n") + "\n"
      return writeTextAtomic(historyPath, body).catch((error) => {
        toast.show({ variant: "error", title: `Could not save your ${reason}`, message: errorMessage(error) })
      })
    }

    onMount(async () => {
      // A missing file is a first run, and an empty history is the right answer. A file that could
      // not be *read* is not: the entries are still there, and answering "" tells the user they
      // are gone - and the self-heal rewrite below then overwrites them.
      const text = await readText(historyPath).catch((error) => {
        if (!isMissingFile(error)) {
          toast.show({ variant: "error", title: "Could not read your prompt history", message: errorMessage(error) })
        }
        return ""
      })
      const lines = parsePromptHistory(text)
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0) await persist("history")
    })

    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
          }),
        )

        if (trimmed) return persist("history")
        // Appending adds one line to a file that is already there, so it leaves the existing
        // entries alone rather than rewriting them - and it still reports rather than dropping the
        // new prompt, which is the entry the user is about to look for.
        return appendText(historyPath, JSON.stringify(entry) + "\n").catch((error) => {
          toast.show({ variant: "error", title: "Could not add that to your history", message: errorMessage(error) })
        })
      },
    }
  },
})

/** `Bun.file().text()` on a path that does not exist is the one failure that is not a failure. */
function isMissingFile(error: unknown) {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}
