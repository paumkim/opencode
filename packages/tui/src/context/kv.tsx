import { createSignal, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTuiPaths } from "./runtime"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const paths = useTuiPaths()
    void Global.Path.state
    const file = path.join(paths.state, "kv.json")
    const lock = `tui-kv:${file}`
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    // Whether the existing file was actually loaded. A failed read leaves `store` as the empty object
    // `createStore()` produced, which is indistinguishable from a store that is genuinely empty - and
    // the first `set` then snapshots that empty object and writes it over the file, erasing every key
    // the user had. That is silent, permanent, and happens on any transient error: one permission
    // problem or full disk at startup costs the whole file the first time anything is written.
    //
    // So writes are refused until a read has succeeded. `ready` still flips, because the UI must not
    // hang waiting; what changes is that `set` reports the refusal instead of destroying the file.
    let loaded = false

    Flock.withLock(lock, () => readJson<Record<string, unknown>>(file))
      .then((x) => {
        setStore(x)
        loaded = true
      })
      .catch((error) => {
        // A missing file is a first run, not a failure, and `Bun.file().json()` rejects with ENOENT
        // for it rather than returning undefined. Treating that as a failure would disable every
        // write on a clean install - a far worse bug than the one being fixed - and the distinction has
        // to be made here rather than in `persistence.readJson`, which is shared with the model store
        // and the session store and where "absent" means something different for each.
        if (isMissingFile(error)) {
          setStore({})
          loaded = true
          return
        }
        console.error("Failed to read KV state; writes are disabled until it can be read", { error })
      })
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        if (!loaded) {
          // Not `loaded` means the file on disk holds real data this session never saw. Applying the
          // change in memory and dropping the write would make the UI disagree with the file, so the
          // safest thing is to refuse both and say why - a user who knows their layout is not being
          // saved can act, where a silent no-op looks identical to a bug they will report again.
          console.error(
            `Refusing to write ${key}: ${file} could not be read, so writing it would erase its existing contents`,
          )
          return
        }
        setStore(key, value)
        const snapshot = structuredClone(unwrap(store))
        write = write
          .then(() => Flock.withLock(lock, () => writeJsonAtomic(file, snapshot)))
          .catch((error) => {
            console.error("Failed to write KV state", { error })
          })
      },
    }
    return result
  },
})

/**
 * True when the file simply is not there.
 *
 * `Bun.file(...).json()` rejects with ENOENT rather than resolving `undefined`, so "no state yet" and
 * "the state could not be read" arrive as the same kind of rejection and have to be told apart here.
 */
function isMissingFile(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT"
}
