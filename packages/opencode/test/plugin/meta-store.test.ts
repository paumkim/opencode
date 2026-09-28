import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { readPluginStore } from "@/plugin/meta"

const { PluginMeta } = await import("../../src/plugin/meta")

afterEach(() => {
  delete process.env.OPENCODE_PLUGIN_META_FILE
})

/** Writes a plugin file and returns its spec, which `touch` needs. */
async function pluginFile(dir: string, name: string) {
  const file = path.join(dir, `${name}.ts`)
  await Bun.write(file, "export default async () => ({})\n")
  return { file, spec: `file://${file}` }
}

describe("readPluginStore", () => {
  test("an absent store is an empty store, which is a genuine first run", async () => {
    await using tmp = await tmpdir<{ file: string }>({
      init: async (dir) => ({ file: path.join(dir, "plugin-meta.json") }),
    })
    // ENOENT is the one failure that means "nothing written yet", and it must stay forgiving or no
    // first run would work.
    expect(await readPluginStore(tmp.extra.file)).toEqual({})
  })

  test("a read that fails for any other reason is reported instead of read as empty", async () => {
    // The regression. `readJson(file).catch(() => ({}) as Store)` made a failed read
    // indistinguishable from a first run, and every writer reads first and writes the result back -
    // so a transient failure meant the next write replaced the store with a partial one.
    await using tmp = await tmpdir<{ file: string }>({
      init: async (dir) => {
        // A directory where the store file should be: reads fail with EISDIR, not ENOENT.
        const file = path.join(dir, "plugin-meta.json")
        await fs.mkdir(file)
        return { file }
      },
    })
    await expect(readPluginStore(tmp.extra.file)).rejects.toThrow(/Failed to read the plugin metadata store/)
  })

  test("the failure names the file and says why the write would be refused", async () => {
    await using tmp = await tmpdir<{ file: string }>({
      init: async (dir) => {
        const file = path.join(dir, "plugin-meta.json")
        await fs.mkdir(file)
        return { file }
      },
    })
    // The message has to explain the consequence, not just the error: a reader who only sees
    // "EISDIR" cannot tell why an unrelated-looking failure refused to continue.
    await expect(readPluginStore(tmp.extra.file)).rejects.toThrow(/permanently lose the plugins it recorded/)
  })

  test("a store that is not an object is reported rather than treated as empty", async () => {
    // A different failure with the same consequence: an array or a bare string in that file would be
    // overwritten just as thoroughly, and the write is the destructive part.
    await using tmp = await tmpdir<{ file: string }>({
      init: async (dir) => {
        const file = path.join(dir, "plugin-meta.json")
        await Bun.write(file, "[1, 2, 3]")
        return { file }
      },
    })
    await expect(readPluginStore(tmp.extra.file)).rejects.toThrow(/is not an object \(it is an array\)/)
  })

  test("a null store is reported", async () => {
    await using tmp = await tmpdir<{ file: string }>({
      init: async (dir) => {
        const file = path.join(dir, "plugin-meta.json")
        await Bun.write(file, "null")
        return { file }
      },
    })
    await expect(readPluginStore(tmp.extra.file)).rejects.toThrow(/it is null/)
  })
})

describe("plugin.meta with an unreadable store", () => {
  test("touching a plugin refuses rather than replacing the store with a partial one", async () => {
    // The end-to-end consequence. Two plugins are recorded, the store becomes unreadable, and a
    // third is touched. The old code would have written `{ third: ... }` and lost the other two -
    // silently, since `touch` returns the entry it just made and reports no problem at all.
    await using tmp = await tmpdir<{ one: string; two: string; three: string; dir: string }>({
      init: async (dir) => {
        const one = await pluginFile(dir, "one")
        const two = await pluginFile(dir, "two")
        const three = await pluginFile(dir, "three")
        return { one: one.spec, two: two.spec, three: three.spec, dir }
      },
    })
    const store = path.join(tmp.extra.dir, "plugin-meta.json")
    process.env.OPENCODE_PLUGIN_META_FILE = store

    await PluginMeta.touch(tmp.extra.one, tmp.extra.one, "demo.one")
    await PluginMeta.touch(tmp.extra.two, tmp.extra.two, "demo.two")
    expect(Object.keys(await readPluginStore(store)).sort()).toEqual(["demo.one", "demo.two"])

    // Make the store unreadable in a way that is not "absent": a directory of that name.
    await fs.rm(store)
    await fs.mkdir(store)

    // Refuses, rather than reporting the new plugin as if the store were fine.
    await expect(PluginMeta.touch(tmp.extra.three, tmp.extra.three, "demo.three")).rejects.toThrow(
      /Failed to read the plugin metadata store/,
    )
  })

  test("setTheme on an unreadable store refuses instead of writing an empty store", async () => {
    // Same shape, and worse in one respect: `setTheme` returns early when the entry is missing, so
    // the old code wrote `{}` for a store it had merely failed to read, discarding every other
    // plugin's themes as a side effect of saving one theme.
    await using tmp = await tmpdir<{ one: string; dir: string }>({
      init: async (dir) => {
        const one = await pluginFile(dir, "one")
        return { one: one.spec, dir }
      },
    })
    const store = path.join(tmp.extra.dir, "plugin-meta.json")
    process.env.OPENCODE_PLUGIN_META_FILE = store

    await PluginMeta.touch(tmp.extra.one, tmp.extra.one, "demo.one")
    await PluginMeta.setTheme("demo.one", "dark", { colors: { primary: "#fff" } } as never)

    await fs.rm(store)
    await fs.mkdir(store)

    await expect(PluginMeta.setTheme("demo.one", "light", { colors: { primary: "#000" } } as never)).rejects.toThrow(
      /Failed to read the plugin metadata store/,
    )
  })
})
