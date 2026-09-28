import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Event, Message, OpencodeClient, Part, SessionMessageResponse, ToolPart } from "@opencode-ai/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import * as ACPService from "@/acp/service"
import { Directory } from "@/acp/directory"
import { ACPSession } from "@/acp/session"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type ToolSessionUpdateParams = SessionUpdateParams & {
  update: Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call" | "tool_call_update" }>
}
type GlobalEventEnvelope = {
  payload?: Event
}
type DeltaPartType = Extract<Part, { type: "text" | "reasoning" }>["type"]

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createEventStream() {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  const state = { closed: false }

  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (state.closed) return
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { push, close, stream }
}

function createHarness(
  messages: Record<string, SessionMessageResponse> = {},
  options: { report?: string[]; failUpdate?: (params: SessionUpdateParams) => boolean } = {},
) {
  const updates: SessionUpdateParams[] = []
  const calls = {
    eventSubscribe: 0,
    message: 0,
  }
  const events = createEventStream()
  const sdk = {
    global: {
      event: (options?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return Promise.resolve({ stream: events.stream(options?.signal) })
      },
    },
    session: {
      message: (input: { messageID: string }) => {
        calls.message++
        return Promise.resolve({ data: messages[input.messageID] })
      },
      get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
      messages: () => Promise.resolve({ data: [] }),
    },
  } as unknown as OpencodeClient
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      // Record first, then reject: the client was handed this update, it just refused it. A
      // failure that threw before recording would let a test pass for the wrong reason.
      updates.push(params)
      if (options.failUpdate?.(params)) return Promise.reject(new Error("connection closed"))
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const session = makeSessionService()
  const report = options.report
  const subscription = new ACPEvent.Subscription(
    { sdk, connection, session },
    report ? { report: (message) => report.push(message) } : undefined,
  )

  return { calls, connection, events, sdk, session, subscription, updates }
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string): Event {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}_${delta}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  }
}

function partUpdated(sessionID: string, messageID: string, partID: string, type: DeltaPartType): Event {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: Date.now(),
      part:
        type === "text"
          ? {
              id: partID,
              sessionID,
              messageID,
              type: "text",
              text: "",
            }
          : {
              id: partID,
              sessionID,
              messageID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
            },
    },
  }
}

function toolUpdated(part: ToolPart): Event {
  return {
    id: `evt_${part.sessionID}_${part.messageID}_${part.id}_${part.state.status}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      time: Date.now(),
      part,
    },
  }
}

function assistantMessage(sessionID: string, messageID: string, partID: string, type: DeltaPartType) {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      type === "text"
        ? {
            id: partID,
            sessionID,
            messageID,
            type: "text",
            text: "",
          }
        : {
            id: partID,
            sessionID,
            messageID,
            type: "reasoning",
            text: "",
            time: { start: Date.now() },
          },
    ],
  } satisfies SessionMessageResponse
}

function assistantToolMessage(part: ToolPart) {
  return {
    info: {
      id: part.messageID,
      sessionID: part.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  } satisfies SessionMessageResponse
}

function runningTool(
  sessionID: string,
  callID: string,
  output?: string,
  input: Record<string, unknown> = { cmd: "printf hello" },
) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "running",
      input,
      title: "bash",
      ...(output !== undefined ? { metadata: { output } } : {}),
      time: { start: Date.now() },
    },
  } satisfies ToolPart
}

function completedTool(
  sessionID: string,
  callID: string,
  output = "done",
  attachments: Extract<ToolPart["state"], { status: "completed" }>["attachments"] = [],
  options: {
    readonly tool?: string
    readonly input?: Record<string, unknown>
    readonly metadata?: Record<string, unknown>
  } = {},
) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: options.tool ?? "bash",
    state: {
      status: "completed",
      input: options.input ?? { cmd: "printf done" },
      output,
      title: "bash",
      metadata: options.metadata ?? { exit: 0 },
      time: { start: Date.now() - 1, end: Date.now() },
      ...(attachments.length ? { attachments } : {}),
    },
  } satisfies ToolPart
}

function errorTool(sessionID: string, callID: string) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "error",
      input: { cmd: "exit 1" },
      error: "failed hard",
      metadata: { exit: 1 },
      time: { start: Date.now() - 1, end: Date.now() },
    },
  } satisfies ToolPart
}

function toolUpdates(updates: SessionUpdateParams[]) {
  return updates.filter((item): item is ToolSessionUpdateParams => {
    return item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update"
  })
}

async function createKnownSession(
  session: ACPSession.Interface,
  sessionId: string,
  part: { messageId: string; partId: string; partType: Part["type"]; role?: Message["role"] },
) {
  await Effect.runPromise(session.create({ id: sessionId, cwd: "/workspace" }))
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId: part.messageId,
      partId: part.partId,
      partType: part.partType,
      role: part.role ?? "assistant",
    }),
  )
}

describe("acp event routing", () => {
  it("routes message.part.delta by sessionID without cross-session pollution", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", { messageId: "msg_b", partId: "part_b", partType: "text" })

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "hello"))

    expect(harness.updates.map((update) => update.sessionId)).toEqual(["ses_b"])
    expect(harness.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk")
  })

  it("keeps interleaved sessions isolated for text and reasoning deltas", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", {
      messageId: "msg_b",
      partId: "part_b",
      partType: "reasoning",
    })

    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "A1"))
    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "B1"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "A2"))
    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "B2"))

    expect(
      harness.updates.filter((update) => update.sessionId === "ses_a").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_message_chunk", "agent_message_chunk"])
    expect(
      harness.updates.filter((update) => update.sessionId === "ses_b").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_thought_chunk", "agent_thought_chunk"])
  })

  it("uses reasoning part ids as ACP thought message boundaries", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_reasoning", {
      messageId: "msg_reasoning",
      partId: "part_first",
      partType: "reasoning",
    })
    await Effect.runPromise(
      harness.session.recordPartMetadata({
        sessionId: "ses_reasoning",
        messageId: "msg_reasoning",
        partId: "part_second",
        partType: "reasoning",
        role: "assistant",
      }),
    )

    await harness.subscription.handle(textDelta("ses_reasoning", "msg_reasoning", "part_first", "First"))
    await harness.subscription.handle(textDelta("ses_reasoning", "msg_reasoning", "part_second", "Second"))

    expect(harness.updates.map((update) => update.update)).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "part_first",
        content: { type: "text", text: "First" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "part_second",
        content: { type: "text", text: "Second" },
      },
    ])
  })

  it("does not create extra subscriptions on repeated loadSession", async () => {
    const harness = createHarness()
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: harness.sdk,
      connection: harness.connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      session: harness.session,
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await pollUntil(() => harness.calls.eventSubscribe === 1, "event subscription did not start")
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(harness.calls.eventSubscribe).toBe(1)
    subscription?.stop()
    harness.events.close()
  })

  it("does not call sdk.session.message repeatedly when metadata is known", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })

    for (const delta of ["a", "b", "c", "d", "e"]) {
      await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", delta))
    }

    expect(harness.calls.message).toBe(0)
    expect(harness.updates).toHaveLength(5)
  })

  it("fetches unknown part metadata once and reuses it for later deltas", async () => {
    const harness = createHarness({
      msg_a: assistantMessage("ses_a", "msg_a", "part_a", "text"),
    })
    await Effect.runPromise(harness.session.create({ id: "ses_a", cwd: "/workspace" }))

    await harness.subscription.handle(partUpdated("ses_a", "msg_a", "part_a", "text"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "a"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "b"))

    expect(harness.calls.message).toBe(1)
    expect(harness.updates).toHaveLength(2)
  })

  it("replays loaded session messages sequentially and continues after update failures", async () => {
    const events = createEventStream()
    const updates: SessionUpdateParams[] = []
    const connection = {
      sessionUpdate: (params: SessionUpdateParams) => {
        if (params.update.sessionUpdate === "tool_call" && params.update.toolCallId === "call_slow") {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              updates.push(params)
              resolve()
            }, 20)
          })
        }

        if (params.update.sessionUpdate === "tool_call_update" && params.update.toolCallId === "call_slow") {
          return Promise.reject(new Error("replay send failed"))
        }

        updates.push(params)
        return Promise.resolve()
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: {
        global: {
          event: (options?: { signal?: AbortSignal }) => Promise.resolve({ stream: events.stream(options?.signal) }),
        },
        session: {
          get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
          messages: () =>
            Promise.resolve({
              data: [
                assistantToolMessage(completedTool("ses_loaded", "call_slow", "slow")),
                assistantToolMessage(completedTool("ses_loaded", "call_after", "after")),
              ],
            }),
        },
      } as unknown as OpencodeClient,
      connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(toolUpdates(updates).map((item) => item.update.toolCallId)).toEqual([
      "call_slow",
      "call_after",
      "call_after",
    ])
    subscription?.stop()
    events.close()
  })

  it("ignores unknown sessions and live user parts without user_message_chunk duplication", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_user", {
      messageId: "msg_user",
      partId: "part_user",
      partType: "text",
      role: "user",
    })

    await harness.subscription.handle(textDelta("ses_missing", "msg_missing", "part_missing", "ignored"))
    await harness.subscription.handle(partUpdated("ses_user", "msg_user", "part_live", "text"))
    await harness.subscription.handle(textDelta("ses_user", "msg_user", "part_user", "hello"))

    expect(harness.updates).toHaveLength(0)
  })

  it("exposes the shell command on the synthetic pending tool call", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_tool", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_tool", "call_1", "hello")))

    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
    ])
    expect(harness.updates[0]?.update).toMatchObject({
      status: "pending",
      toolCallId: "call_1",
      title: "printf hello",
      kind: "execute",
      locations: [{ path: "/workspace" }],
      rawInput: { cmd: "printf hello", cwd: "/workspace" },
    })
    expect(harness.updates[1]?.update).toMatchObject({ status: "in_progress", toolCallId: "call_1" })
  })

  it("includes available input in the synthetic pending tool call", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_pending_input", cwd: "/workspace" }))

    await harness.subscription.handle(
      toolUpdated({
        id: "part_call_read",
        sessionID: "ses_pending_input",
        messageID: "msg_call_read",
        type: "tool",
        callID: "call_read",
        tool: "read",
        state: {
          status: "running",
          input: { filePath: "/workspace/file.ts" },
          title: "Read file.ts",
          time: { start: Date.now() },
        },
      } satisfies ToolPart),
    )

    expect(harness.updates[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "call_read",
      status: "pending",
      title: "Read file.ts",
      kind: "read",
      rawInput: { filePath: "/workspace/file.ts" },
      locations: [{ path: "/workspace/file.ts" }],
    })
  })

  it("does not emit duplicate synthetic pending after a replayed running tool", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_replay", cwd: "/workspace" }))

    await harness.subscription.replayMessage(assistantToolMessage(runningTool("ses_replay", "call_replay", "first")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_replay", "call_replay", "second")))

    expect(toolUpdates(harness.updates).filter((item) => item.update.sessionUpdate === "tool_call")).toHaveLength(1)
    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ])
  })

  it("dedupes shell output snapshots while still sending status-only running updates", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_shell", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_shell", "call_shell", "same")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_shell", "call_shell", "same")))

    const updates = toolUpdates(harness.updates)
    expect(updates).toHaveLength(3)
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      content: [{ type: "content", content: { type: "text", text: "same" } }],
    })
    expect(updates[2]?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "in_progress" })
    expect("content" in updates[2].update).toBe(false)
  })

  it("clears shell snapshot marker when a tool returns to pending", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_pending", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_pending", "call_pending", "repeat")))
    await harness.subscription.handle(
      toolUpdated({
        id: "part_call_pending",
        sessionID: "ses_pending",
        messageID: "msg_call_pending",
        type: "tool",
        callID: "call_pending",
        tool: "bash",
        state: {
          status: "pending",
          input: { cmd: "printf repeat" },
          raw: '{"cmd":"printf repeat"}',
        },
      }),
    )
    await harness.subscription.handle(toolUpdated(runningTool("ses_pending", "call_pending", "repeat")))

    expect(
      toolUpdates(harness.updates)
        .filter((item) => item.update.sessionUpdate === "tool_call_update")
        .map((item) => ("content" in item.update ? item.update.content : undefined)),
    ).toEqual([
      [{ type: "content", content: { type: "text", text: "repeat" } }],
      [{ type: "content", content: { type: "text", text: "repeat" } }],
    ])
  })

  it("emits completed tool output and rawOutput", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_done", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(completedTool("ses_done", "call_done", "finished")))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_done",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "finished" } }],
      rawOutput: { output: "finished", metadata: { exit: 0 } },
    })
  })

  it("emits clean read display content and preserves rawOutput", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_read", cwd: "/workspace" }))
    const output = [
      "<path>/workspace/file.ts</path>",
      "<type>file</type>",
      "<content>",
      "1: import { value } from './value'",
      "2: export { value }",
      "",
      "(End of file - total 2 lines)",
      "</content>",
    ].join("\n")
    const metadata = {
      display: {
        type: "file",
        path: "/workspace/file.ts",
        text: "import { value } from './value'\nexport { value }",
        lineStart: 1,
        lineEnd: 2,
        totalLines: 2,
        truncated: false,
      },
    }

    await harness.subscription.handle(
      toolUpdated(
        completedTool("ses_read", "call_read", output, [], {
          tool: "read",
          input: { filePath: "/workspace/file.ts" },
          metadata,
        }),
      ),
    )

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_read",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "import { value } from './value'\nexport { value }" },
        },
      ],
      rawOutput: { output, metadata },
    })
  })

  it("emits error tool output", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_error", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(errorTool("ses_error", "call_error")))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_error",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "failed hard" } }],
      rawOutput: { error: "failed hard", metadata: { exit: 1 } },
    })
  })

  it("emits image attachments as ACP image content for live and replayed completed tool updates", async () => {
    const harness = createHarness()
    const image = Buffer.from("image-data").toString("base64")
    const attachment = {
      id: "file_image",
      sessionID: "ses_image",
      messageID: "msg_image",
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: `data:image/png;base64,${image}`,
    } as const
    await Effect.runPromise(harness.session.create({ id: "ses_image", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(completedTool("ses_image", "call_live", "live", [attachment])))
    await harness.subscription.replayMessage(
      assistantToolMessage(completedTool("ses_image", "call_replayed", "replayed", [attachment])),
    )

    expect(
      toolUpdates(harness.updates)
        .filter((item) => item.update.sessionUpdate === "tool_call_update" && item.update.status === "completed")
        .map((item) => ("content" in item.update ? item.update.content : [])),
    ).toEqual([
      [
        { type: "content", content: { type: "text", text: "live" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: image } },
      ],
      [
        { type: "content", content: { type: "text", text: "replayed" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: image } },
      ],
    ])
  })
})

function idleEvent(sessionID: string): Event {
  return {
    id: `evt_idle_${sessionID}`,
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  }
}

describe("acp event delivery failures", () => {
  it("reports a live event the client refused and keeps consuming the turn", async () => {
    // The regression: `consume()` ended in `.catch(() => {})`, the same swallow that
    // `replayFailures` was written to remove from the historical path. A client that dropped one
    // `sessionUpdate` mid-answer was handed a silent hole in the middle of the agent's text, and
    // nothing anywhere recorded that the hole existed.
    const report: string[] = []
    const harness = createHarness(
      {},
      {
        report,
        failUpdate: (params) => params.update.sessionUpdate === "agent_message_chunk",
      },
    )
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })

    harness.subscription.start()
    await pollUntil(() => harness.calls.eventSubscribe > 0, "subscription never connected")

    harness.events.push({ payload: textDelta("ses_a", "msg_a", "part_a", "A1") })
    harness.events.push({ payload: textDelta("ses_a", "msg_a", "part_a", "A2") })
    harness.events.push({ payload: idleEvent("ses_a") })

    // A tool update the client *can* accept, arriving after the refused delta. This is the half a
    // report alone cannot prove: a fix that threw out of the loop would also report, and the
    // client would silently lose the rest of the turn.
    await pollUntil(() => report.length > 0, "a refused update was not reported")
    await pollUntil(
      () => harness.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").length >= 2,
      "the subscription stopped consuming after a refused update",
    )

    // Names the part and the reason: the gap is a hole in the middle of text the user is reading,
    // so "something failed" is not enough to find it.
    expect(report.some((line) => line.includes("failed to deliver a text delta"))).toBe(true)
    expect(report.some((line) => line.includes("msg_a/part_a"))).toBe(true)
    expect(report.some((line) => line.includes("connection closed"))).toBe(true)

    // A count against the turn, reported at idle: a reader learns the transcript is incomplete
    // rather than guessing from a per-event line.
    await pollUntil(
      () => report.some((line) => line.includes("did not receive 2 update(s)")),
      "the turn's undelivered count was not reported at idle",
    )
    expect(report.some((line) => line.includes("ses_a"))).toBe(true)

    harness.subscription.stop()
  })

  it("does not report a turn where every event was delivered", async () => {
    // The other direction: a report that fires on the happy path is noise, and a test that only
    // covers the failure cannot tell a correct guard from an absent one.
    const report: string[] = []
    const harness = createHarness({}, { report })
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })

    harness.subscription.start()
    await pollUntil(() => harness.calls.eventSubscribe > 0, "subscription never connected")

    harness.events.push({ payload: textDelta("ses_a", "msg_a", "part_a", "A1") })
    harness.events.push({ payload: idleEvent("ses_a") })

    await pollUntil(
      () => harness.updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
      "the delta was never delivered",
    )
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(report).toEqual([])
    harness.subscription.stop()
  })

  it("names a refused tool part update and counts it against its session", async () => {
    // A tool part carries the user's view of progress. Losing one leaves a tool spinning forever
    // in the client, which is a different symptom from lost text and needs a different name.
    const report: string[] = []
    const harness = createHarness({}, { report, failUpdate: (params) => params.update.sessionUpdate === "tool_call" })
    await Effect.runPromise(harness.session.create({ id: "ses_tool", cwd: "/workspace" }))

    harness.subscription.start()
    await pollUntil(() => harness.calls.eventSubscribe > 0, "subscription never connected")

    harness.events.push({ payload: toolUpdated(runningTool("ses_tool", "call_1")) })
    await pollUntil(() => report.length > 0, "a refused tool update was not reported")

    expect(report.some((line) => line.includes("failed to deliver part part_call_1"))).toBe(true)
    expect(report.some((line) => line.includes("tool"))).toBe(true)
    expect(report.some((line) => line.includes("connection closed"))).toBe(true)

    harness.subscription.stop()
  })
})

describe("deliveryFailure", () => {
  it("describes each event type with the identity the client needs to find the gap", () => {
    // A pure-function test, because the message is the deliverable: a caller reading these lines
    // at 2am has to be able to work out what was lost without the source in front of them.
    const error = new Error("connection closed")
    expect(ACPEvent.deliveryFailure(textDelta("ses", "msg", "part", "x"), error)).toContain(
      "failed to deliver a text delta (msg/part)",
    )
    expect(ACPEvent.deliveryFailure(toolUpdated(runningTool("ses", "call")), error)).toContain(
      "failed to deliver part part_call (tool, msg_call)",
    )
    expect(ACPEvent.deliveryFailure(idleEvent("ses"), error)).toContain(
      "failed to deliver a session status update (idle)",
    )
    expect(ACPEvent.deliveryFailure(idleEvent("ses"), error)).toContain("connection closed")
  })
})
