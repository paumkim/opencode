/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { json, mount, wait } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

const sessionID = "ses_hydrate_fail"
const directory = "/tmp/opencode/packages/opencode"
const session = {
  id: sessionID,
  title: "hydration failure",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory,
}
const message = (id: string, created: number) => ({
  id,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: directory, root: directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, completed: created + 1 },
})
const part = (messageID: string, id: string, text: string) => ({
  id,
  sessionID,
  messageID,
  type: "text" as const,
  text,
})

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

/** Seeds a session with two live messages, each carrying a part. */
async function seed(emit: Awaited<ReturnType<typeof mount>>["emit"], sync: Awaited<ReturnType<typeof mount>>["sync"]) {
  for (const info of [message("msg_a", 1), message("msg_b", 2)]) {
    emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    emit(
      global({
        id: `evt_part_${info.id}`,
        type: "message.part.updated",
        properties: { sessionID, time: 2, part: part(info.id, `prt_${info.id}`, `text for ${info.id}`) },
      }),
    )
  }
  await wait(() => (sync.data.message[sessionID]?.length ?? 0) === 2)
  await wait(() => sync.data.part.msg_a?.length === 1)
}

/**
 * The hydration reads for `session.messages`, `session.todo` and
 * `session.diff` carried no `throwOnError`, unlike the `session.get` sibling in
 * the same `Promise.all`. The generated client resolves a non-2xx as
 * `{ data: undefined, error }`, so all three fell through to `?? []`.
 *
 * For `messages` that is data loss rather than an empty state: the merge keeps
 * only what arrived through the live event tracker, so a failed read dropped
 * every message loaded earlier and the `removed` loop deleted their parts on the
 * way out. A server blip mid-session shortened the transcript — the most
 * user-visible form of the silent-failure class this suite has been closing.
 */
test("a failed hydration read leaves the transcript, todos and diff intact", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const override: FetchHandler = (url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    // Every sibling read fails; `session.get` succeeds.
    if (url.pathname === `/session/${sessionID}/message`) {
      return json({ name: "InstanceLoadError", data: { message: "message read failed" } }, { status: 500 })
    }
    if (url.pathname === `/session/${sessionID}/todo`) {
      return json({ name: "InstanceLoadError", data: { message: "todo read failed" } }, { status: 500 })
    }
    if (url.pathname === `/session/${sessionID}/diff`) {
      return json({ name: "InstanceLoadError", data: { message: "diff read failed" } }, { status: 500 })
    }
    return undefined
  }

  const { app, emit, sync } = await mount(override, tmp.path)
  try {
    await seed(emit, sync)
    const before = sync.data.message[sessionID].map((item) => item.id)

    await sync.session.sync(sessionID)

    expect(sync.data.message[sessionID].map((item) => item.id)).toEqual(before)
    expect(sync.data.part.msg_a?.[0]).toMatchObject({ type: "text", text: "text for msg_a" })
    expect(sync.data.part.msg_b?.[0]).toMatchObject({ type: "text", text: "text for msg_b" })
  } finally {
    app.renderer.destroy()
  }
})

test("a successful hydration read still replaces the transcript", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const override: FetchHandler = (url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      return json([{ info: message("msg_c", 3), parts: [part("msg_c", "prt_msg_c", "from server")] }])
    }
    if (url.pathname === `/session/${sessionID}/todo`) return json([])
    if (url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }

  const { app, emit, sync } = await mount(override, tmp.path)
  try {
    await seed(emit, sync)
    await sync.session.sync(sessionID)

    // The server is the source of truth on a successful read, so msg_c appears.
    expect(sync.data.message[sessionID]?.map((item) => item.id)).toEqual(["msg_c"])
  } finally {
    app.renderer.destroy()
  }
})
