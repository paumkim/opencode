import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { errorMessage } from "../util/error"
import { appendText, readText, writeTextAtomic } from "../util/persistence"
import { useToast } from "../ui/toast"
import type { PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StashEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const toast = useToast()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")

    /**
     * Every write below used to end in `.catch(() => {})` while the in-memory store was updated
     * first, so a failed write left the UI listing a stash that was never saved and was gone on the
     * next launch. The user was told nothing. Stashes are work they deliberately set aside, and
     * the list they see is the only record that it existed, so the store and the file have to be
     * kept in step: persist, then show it.
     */
    const persist = (reason: string) => {
      const body = store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : ""
      return writeTextAtomic(stashPath, body).catch((error) => {
        toast.show({ variant: "error", title: `Could not save your ${reason}`, message: errorMessage(error) })
      })
    }

    onMount(async () => {
      // A missing file is a first run and an empty stash is the right answer. A file that could not
      // be *read* is not: the entries are still there, and answering "" tells the user they are
      // gone. They are also about to be overwritten by the self-heal write below.
      const text = await readText(stashPath).catch((error) => {
        if (!isMissingFile(error)) {
          toast.show({ variant: "error", title: "Could not read your stashes", message: errorMessage(error) })
        }
        return ""
      })
      const lines = parsePromptStash(text)
      setStore("entries", lines)
      if (lines.length > 0) await persist("stashes")
    })

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) return persist("stashes")
        // Appending is the common case and is one line against an existing file, so it does not
        // rewrite the ones already there. It still reports rather than dropping the new entry.
        return appendText(stashPath, JSON.stringify(stash) + "\n").catch((error) => {
          toast.show({ variant: "error", title: "Could not save your stash", message: errorMessage(error) })
        })
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        void persist("stashes")
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        void persist("stashes")
      },
    }
  },
})

/** `Bun.file().text()` on a path that does not exist is the one failure that is not a failure. */
function isMissingFile(error: unknown) {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}
