import path from "path"
import { onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { errorMessage } from "../util/error"
import { appendText, readText, writeTextAtomic } from "../util/persistence"
import { useToast } from "../ui/toast"

type FrecencyEntry = { path: string; frequency: number; lastOpen: number }

export const MAX_FRECENCY_ENTRIES = 1000

export function parseFrecency(text: string) {
  const latest = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FrecencyEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is FrecencyEntry => line !== undefined)
    .reduce<Record<string, FrecencyEntry>>((result, entry) => {
      result[entry.path] = entry
      return result
    }, {})
  return Object.values(latest)
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES)
}

function calculateFrecency(entry?: { frequency: number; lastOpen: number }) {
  if (!entry) return 0
  return entry.frequency / (1 + (Date.now() - entry.lastOpen) / 86400000)
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const paths = useTuiPaths()
    const toast = useToast()
    const frecencyPath = path.join(paths.state, "frecency.jsonl")

    /**
     * Every write below used to end in `.catch(() => {})`, so a failed one left the suggestion
     * order quietly diverging from what is on disk with nothing on screen. The rewrite goes through
     * the atomic primitive: `writeText` is `Bun.write`, which truncates the target first, so a
     * failure part way through a trim would replace up to `MAX_FRECENCY_ENTRIES` - 1000 - good
     * entries with a partial file.
     */
    const persist = (entries: Record<string, { frequency: number; lastOpen: number }>, reason: string) => {
      const body = Object.entries(entries)
        .map(([entryPath, entry]) => JSON.stringify({ path: entryPath, ...entry }))
        .join("\n")
      const trailing = body.length > 0 ? "\n" : ""
      return writeTextAtomic(frecencyPath, body + trailing).catch((error) => {
        toast.show({ variant: "error", title: `Could not save your ${reason}`, message: errorMessage(error) })
      })
    }

    onMount(async () => {
      // A missing file is a first run and an empty store is the right answer. A file that could not
      // be *read* is not: the entries are still there, and loading an empty store makes every file
      // the user has opened look like one they have never opened.
      const text = await readText(frecencyPath).catch((error) => {
        if (!isMissingFile(error)) {
          toast.show({ variant: "error", title: "Could not read your file history", message: errorMessage(error) })
        }
        return ""
      })
      const lines = parseFrecency(text)
      const data = Object.fromEntries(
        lines.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
      )
      setStore("data", data)
      if (lines.length > 0) await persist(data, "file history")
    })

    const [store, setStore] = createStore({ data: {} as Record<string, { frequency: number; lastOpen: number }> })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(paths.cwd, filePath)
      const newEntry = { frequency: (store.data[absolutePath]?.frequency || 0) + 1, lastOpen: Date.now() }
      setStore("data", absolutePath, newEntry)
      // This fires on every file the user opens, so it is the common case: one line appended to a
      // file that is already there, leaving the existing entries alone. It still reports, because a
      // file whose usage is never recorded just stops being suggested.
      void appendText(frecencyPath, JSON.stringify({ path: absolutePath, ...newEntry }) + "\n").catch((error) => {
        toast.show({ variant: "error", title: "Could not record that file", message: errorMessage(error) })
      })

      if (Object.keys(store.data).length <= MAX_FRECENCY_ENTRIES) return
      const sorted = Object.entries(store.data)
        .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)
      const trimmed = Object.fromEntries(sorted)
      setStore("data", trimmed)
      void persist(trimmed, "file history")
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(paths.cwd, filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})

/** `Bun.file().text()` on a path that does not exist is the one failure that is not a failure. */
function isMissingFile(error: unknown) {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}
