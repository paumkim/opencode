import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { Session as SessionNs } from "@/session/session"
import { SessionUsage } from "../../src/session/usage"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, SessionUsage.node, SessionProjector.node])))

const turn = (over: Partial<SessionUsage.Untotalled> = {}): SessionUsage.Turn =>
  SessionUsage.withTotal({
    messageID: MessageID.ascending(),
    time: Date.now(),
    duration: 1_000,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    agent: "build",
    input: 1_000,
    output: 200,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    ...over,
  })

const ids = (findings: readonly SessionUsage.Finding[]) => findings.map((item) => item.id)

describe("sessionUsage.summarize", () => {
  test("adds up every column", () => {
    const totals = SessionUsage.summarize([
      turn({ input: 100, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 1, cost: 0.5 }),
      turn({ input: 200, output: 20, reasoning: 0, cacheRead: 150, cacheWrite: 2, cost: 0.25 }),
    ])
    expect(totals).toEqual({
      turns: 2,
      input: 300,
      output: 30,
      reasoning: 5,
      cacheRead: 200,
      cacheWrite: 3,
      cost: 0.75,
      // Cache reads are a share of all input, not of the non-cached remainder:
      // 200 of 500, which is the number that reflects what was actually served
      // from cache.
      cacheHitRate: 0.4,
      peakInput: 200,
    })
  })

  test("an empty conversation is all zeros rather than a division by zero", () => {
    expect(SessionUsage.summarize([])).toEqual({
      turns: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      cacheHitRate: 0,
      peakInput: 0,
    })
  })

  test("counts every part in a turn's total", () => {
    expect(SessionUsage.totalOf({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toBe(15)
  })
})

describe("sessionUsage.format", () => {
  const free = { cost: 0 }

  test("shows a dash for a free session rather than $0.00 on every row", () => {
    expect(SessionUsage.formatCost(0, free)).toBe("—")
  })

  test("keeps enough digits to distinguish two nearly free turns", () => {
    expect(SessionUsage.formatCost(0.000012, { cost: 1 })).toBe("$0.000012")
  })

  test("drops to cents once the numbers are worth reading", () => {
    expect(SessionUsage.formatCost(12.345, { cost: 20 })).toBe("$12.35")
    expect(SessionUsage.formatCost(0.1234, { cost: 20 })).toBe("$0.1234")
  })

  test("abbreviates only above a thousand", () => {
    expect(SessionUsage.formatTokens(999)).toBe("999")
    expect(SessionUsage.formatTokens(1_500)).toBe("1.5k")
    expect(SessionUsage.formatTokens(2_400_000)).toBe("2.4M")
  })
})

describe("sessionUsage.analyze", () => {
  test("says nothing about an empty or single small turn", () => {
    expect(SessionUsage.analyze([])).toEqual([])
    expect(SessionUsage.analyze([turn({ input: 500 })])).toEqual([])
  })

  test("names a cache that is barely being used on a large context", () => {
    const findings = SessionUsage.analyze([turn({ input: 60_000 }), turn({ input: 65_000 })])
    expect(ids(findings)).toContain("usage.cache-miss")
    expect(findings.find((item) => item.id === "usage.cache-miss")!.detail).toContain("65.0k")
  })

  test("stays quiet about the cache on a small conversation", () => {
    // The same 0% hit rate is normal when the whole prompt fits in one cheap
    // request, and saying so there is noise.
    expect(ids(SessionUsage.analyze([turn({ input: 2_000 }), turn({ input: 2_100 })]))).not.toContain(
      "usage.cache-miss",
    )
  })

  test("stays quiet when the cache is doing its job", () => {
    const findings = SessionUsage.analyze([
      turn({ input: 1_000, cacheRead: 60_000 }),
      turn({ input: 1_100, cacheRead: 70_000 }),
    ])
    expect(ids(findings)).not.toContain("usage.cache-miss")
  })

  test("names the turn that carries the session", () => {
    const findings = SessionUsage.analyze([
      turn({ cost: 0.01 }),
      turn({ cost: 0.01 }),
      turn({ modelID: "opus", output: 8_000, cost: 1.9 }),
    ])
    const dominant = findings.find((item) => item.id === "usage.turn-dominates")!
    expect(dominant.title).toContain("99%")
    expect(dominant.detail).toContain("opus")
  })

  test("does not name a dominant turn when the spend is even", () => {
    expect(ids(SessionUsage.analyze([turn({ cost: 1 }), turn({ cost: 1 })]))).not.toContain("usage.turn-dominates")
  })

  test("does not name a dominant turn in a conversation that cost nothing", () => {
    expect(ids(SessionUsage.analyze([turn({ cost: 0 }), turn({ cost: 0 })]))).not.toContain("usage.turn-dominates")
  })

  test("separates reasoning from answer when reasoning dominates", () => {
    const findings = SessionUsage.analyze([turn({ output: 100, reasoning: 9_000 })])
    expect(ids(findings)).toContain("usage.reasoning-heavy")
  })

  test("calls a single reasoning-heavy turn reasoning-heavy", () => {
    // Unlike a dominant turn, this is not a statement about the distribution: one
    // turn that spent twenty thousand tokens thinking and ten answering is the
    // fact, and it holds whatever else the session did.
    expect(ids(SessionUsage.analyze([turn({ output: 10_000, reasoning: 20_000 })]))).toContain("usage.reasoning-heavy")
  })

  test("does not call a session reasoning-heavy when the answer is the larger half", () => {
    expect(ids(SessionUsage.analyze([turn({ output: 20_000, reasoning: 10_000 })]))).not.toContain(
      "usage.reasoning-heavy",
    )
  })

  test("names a context that only ever grows", () => {
    const findings = SessionUsage.analyze([
      turn({ input: 2_000 }),
      turn({ input: 3_000 }),
      turn({ input: 5_000 }),
      turn({ input: 9_000 }),
    ])
    expect(ids(findings)).toContain("usage.context-growth")
  })

  test("does not name growth on a short or a shrinking conversation", () => {
    expect(ids(SessionUsage.analyze([turn({ input: 2_000 }), turn({ input: 9_000 })]))).not.toContain(
      "usage.context-growth",
    )
    expect(
      ids(
        SessionUsage.analyze([
          turn({ input: 9_000 }),
          turn({ input: 3_000 }),
          turn({ input: 2_000 }),
          turn({ input: 1_000 }),
        ]),
      ),
    ).not.toContain("usage.context-growth")
  })
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const assistantMessage = (input: {
  sessionID: SessionID
  parentID: MessageID
  time: number
  completed?: number
  modelID?: string
  providerID?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; read: number; write: number }
}) =>
  ({
    id: input.parentID,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: input.time, ...(input.completed ? { completed: input.completed } : {}) },
    parentID: input.parentID,
    modelID: input.modelID ?? "claude-sonnet-4-5",
    providerID: input.providerID ?? "anthropic",
    mode: "",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: input.cost,
    tokens: {
      total: input.tokens.input + input.tokens.output + input.tokens.reasoning + input.tokens.read + input.tokens.write,
      input: input.tokens.input,
      output: input.tokens.output,
      reasoning: input.tokens.reasoning,
      cache: { read: input.tokens.read, write: input.tokens.write },
    },
  }) as unknown as SessionV1.Info

/** Writes a user prompt then the assistant turn that answered it. */
const exchange = (
  sessionID: SessionID,
  prompt: { id: MessageID; time: number },
  reply: {
    time: number
    completed?: number
    cost: number
    tokens: { input: number; output: number; reasoning: number; read: number; write: number }
    modelID?: string
  },
) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    yield* session.updateMessage({
      id: prompt.id,
      sessionID,
      role: "user",
      time: { created: prompt.time },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet-4-5") },
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: prompt.id,
      type: "text",
      text: "hello",
    } as unknown as SessionV1.Part)
    yield* session.updateMessage(
      assistantMessage({
        sessionID,
        parentID: prompt.id,
        time: reply.time,
        completed: reply.completed,
        cost: reply.cost,
        tokens: reply.tokens,
        ...(reply.modelID ? { modelID: reply.modelID } : {}),
      }),
    )
  })

describe("sessionUsage.report", () => {
  it.instance(
    "reports one row per assistant turn and nothing for the prompts around them",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "usage" })
        const at = Date.now()
        yield* exchange(
          created.id,
          { id: MessageID.ascending(), time: at },
          {
            time: at + 100,
            completed: at + 900,
            cost: 0.25,
            tokens: { input: 1_500, output: 300, reasoning: 100, read: 40_000, write: 0 },
          },
        )

        const report = yield* SessionUsage.Service.use((svc) => svc.report({ sessionID: created.id }))
        expect(report.title).toBe("usage")
        expect(report.turns).toHaveLength(1)
        expect(report.turns[0]).toMatchObject({
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          agent: "build",
          input: 1_500,
          output: 300,
          reasoning: 100,
          cacheRead: 40_000,
          cost: 0.25,
          total: 41_900,
          duration: 800,
        })
        expect(report.totals).toMatchObject({ turns: 1, cost: 0.25, cacheRead: 40_000 })
      }),
    { git: true },
  )

  it.instance(
    "keeps a still-running turn, with no duration rather than a zero one",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "running" })
        const at = Date.now()
        yield* exchange(
          created.id,
          { id: MessageID.ascending(), time: at },
          { time: at + 10, cost: 0, tokens: { input: 10, output: 0, reasoning: 0, read: 0, write: 0 } },
        )

        const report = yield* SessionUsage.Service.use((svc) => svc.report({ sessionID: created.id }))
        expect(report.turns).toHaveLength(1)
        expect("duration" in report.turns[0]).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "reports the newest N turns when the conversation is longer than the window",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "long" })
        const at = Date.now()
        for (let i = 0; i < 4; i++) {
          yield* exchange(
            created.id,
            { id: MessageID.ascending(), time: at + i * 100 },
            {
              time: at + i * 100 + 10,
              cost: i / 100,
              tokens: { input: 1_000 + i, output: 100, reasoning: 0, read: 0, write: 0 },
            },
          )
        }

        const all = yield* SessionUsage.Service.use((svc) => svc.report({ sessionID: created.id }))
        expect(all.turns).toHaveLength(4)

        const tail = yield* SessionUsage.Service.use((svc) => svc.report({ sessionID: created.id, limit: 2 }))
        expect(tail.turns).toHaveLength(2)
        expect(tail.turns.at(-1)!.cost).toBe(0.03)
        expect(tail.totals.turns).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "fails for a session that does not exist rather than reporting nothing",
    () =>
      Effect.gen(function* () {
        const exit = yield* SessionUsage.Service.use((svc) =>
          svc.report({ sessionID: SessionID.make("ses_missing_usage") }),
        ).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    { git: true },
  )
})
