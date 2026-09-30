import { describe, expect, test } from "bun:test"
import { SessionTimeline } from "../../src/session/timeline"
import { MessageID, PartID } from "../../src/session/schema"
import { Token } from "@opencode-ai/core/util/token"

let seq = 0
const row = (over: Partial<SessionTimeline.Row> = {}): SessionTimeline.Row => ({
  id: PartID.make(`prt_${++seq}`),
  messageID: MessageID.make("msg_1"),
  role: "assistant",
  type: "text",
  data: { type: "text", text: "" },
  time: seq,
  ...over,
})

const text = (text: string, over: Partial<SessionTimeline.Row> = {}) => row({ data: { type: "text", text }, ...over })

const tool = (tool: string, state: Record<string, unknown>, over: Partial<SessionTimeline.Row> = {}) =>
  row({ type: "tool", data: { type: "tool", tool, state }, ...over })

const complete = (input: unknown, output: string) => ({
  status: "completed",
  input,
  output,
  title: "done",
  metadata: {},
  time: { start: 0, end: 1 },
})

describe("sessionTimeline.measure", () => {
  test("sizes the text the model was sent, not the row that holds it", () => {
    const { tokens, bucket } = SessionTimeline.measure(text("x".repeat(400)))
    expect(tokens).toBe(100)
    expect(bucket).toBe("assistant")
  })

  test("separates who wrote the text", () => {
    expect(SessionTimeline.measure(text("hi", { role: "user" })).bucket).toBe("user")
    expect(SessionTimeline.measure(text("hi")).bucket).toBe("assistant")
  })

  test("separates the harness talking to itself from the agent talking", () => {
    // A reminder is context exactly like any other text, and the difference
    // between "the agent wrote this" and "the agent was told this" is the whole
    // reason to look.
    const reminder = row({ data: { type: "text", text: "remember to run the tests", synthetic: true } })
    expect(SessionTimeline.measure(reminder).bucket).toBe("synthetic")
    expect(SessionTimeline.measure(reminder).tokens).toBeGreaterThan(0)
  })

  test("counts reasoning as its own kind, not as the agent's answer", () => {
    const thinking = row({ type: "reasoning", data: { type: "reasoning", text: "y".repeat(200) } })
    expect(SessionTimeline.measure(thinking).bucket).toBe("reasoning")
  })

  test("counts what a tool returned", () => {
    const call = tool("bash", complete({ command: "ls" }, "z".repeat(1000)))
    expect(SessionTimeline.measure(call).bucket).toBe("tool-output")
    expect(SessionTimeline.measure(call).tokens).toBeGreaterThan(200)
  })

  test("counts a failed call's error text, and says so", () => {
    const call = tool("bash", { status: "error", input: { command: "rm -rf /" }, error: "permission denied" })
    const measured = SessionTimeline.measure(call)
    expect(measured.bucket).toBe("tool-error")
    expect(measured.label).toBe("bash (error)")
  })

  test("reports a tool's arguments on their own when it never returned output", () => {
    // Arguments are replayed verbatim every turn, so they are a permanent cost
    // in a way a large output is not.
    const call = tool("edit", { status: "pending", input: { content: "a".repeat(800) } })
    const measured = SessionTimeline.measure(call)
    expect(measured.bucket).toBe("tool-input")
    // 800 characters of content plus the JSON key around it, rounded by the
    // same 4-chars-per-token estimate the harness uses everywhere else.
    expect(measured.tokens).toBe(Token.estimate(`{"content":"${"a".repeat(800)}"}`))
  })

  test("counts an attached file's contents, not its mention", () => {
    const file = row({
      type: "file",
      data: { type: "file", filename: "big.ts", source: { type: "file", text: "b".repeat(4000) } },
    })
    const measured = SessionTimeline.measure(file)
    expect(measured.bucket).toBe("file")
    expect(measured.tokens).toBe(1000)
  })

  test("is zero for a part that carries no context of its own", () => {
    expect(SessionTimeline.measure(row({ type: "compaction", data: { type: "compaction" } })).tokens).toBe(0)
    expect(SessionTimeline.measure(row({ type: "step-start", data: { type: "step-start" } })).tokens).toBe(0)
  })

  test("survives a part whose stored data is not the shape it claims", () => {
    expect(SessionTimeline.measure(text(undefined as unknown as string)).tokens).toBe(0)
    expect(SessionTimeline.measure(row({ data: null })).tokens).toBe(0)
    expect(SessionTimeline.measure(row({ data: "nonsense" })).tokens).toBe(0)
  })
})

describe("sessionTimeline.previewOf", () => {
  test("takes the first line with something on it", () => {
    expect(SessionTimeline.previewOf("\n\n  the real line  \nsecond")).toBe("the real line")
  })

  test("truncates with an ellipsis rather than cutting mid-word silently", () => {
    const preview = SessionTimeline.previewOf("q".repeat(200))
    expect(preview).toHaveLength(72)
    expect(preview.endsWith("…")).toBe(true)
  })

  test("is empty for empty text", () => {
    expect(SessionTimeline.previewOf("")).toBe("")
    expect(SessionTimeline.previewOf("\n\n")).toBe("")
  })
})

describe("sessionTimeline.sharesOf", () => {
  test("largest bucket first, with a share that sums to one", () => {
    const shares = SessionTimeline.sharesOf([
      text("a".repeat(400)), // 100 assistant
      text("b".repeat(800), { role: "user" }), // 200 user
      // 103, not 100: the arguments a tool was called with are part of what it
      // cost the window, and a bucket that ignored them would be quietly wrong.
      tool("bash", complete({ command: "ls" }, "c".repeat(400))),
    ])
    expect(shares.map((share) => share.bucket)).toEqual(["user", "tool-output", "assistant"])
    expect(shares[0].tokens).toBe(200)
    expect(shares[0].share).toBeGreaterThan(0.49)
    expect(shares[0].share).toBeLessThan(0.51)
    expect(shares.reduce((total, share) => total + share.share, 0)).toBeCloseTo(1)
  })

  test("counts parts per bucket, not just tokens", () => {
    const shares = SessionTimeline.sharesOf([text("a".repeat(40)), text("b".repeat(40)), text("c".repeat(400))])
    const assistant = shares.find((share) => share.bucket === "assistant")
    expect(assistant?.parts).toBe(3)
  })

  test("drops parts that carry nothing, so a zero bucket cannot be reported", () => {
    expect(SessionTimeline.sharesOf([row({ type: "compaction", data: { type: "compaction" } })]).length).toBe(0)
  })

  test("has no share to divide when nothing was sent", () => {
    expect(SessionTimeline.sharesOf([])).toEqual([])
  })
})

describe("sessionTimeline.contributorsOf", () => {
  const rows = [
    text("a".repeat(400), { role: "user" }),
    tool("bash", complete({}, "b".repeat(2000))),
    text("c".repeat(800)),
  ]

  test("ranks the parts that actually cost context", () => {
    expect(SessionTimeline.contributorsOf(rows, 10)[0].label).toBe("bash")
  })

  test("honours the limit, keeping the largest", () => {
    const top = SessionTimeline.contributorsOf(rows, 2)
    expect(top).toHaveLength(2)
    expect(top[0].label).toBe("bash")
    expect(top[1].tokens).toBe(200)
  })

  test("carries the identifiers needed to go and look at the part", () => {
    const [top] = SessionTimeline.contributorsOf(rows, 1)
    expect(top.partID).toBe(rows[1].id)
    expect(top.messageID).toBe(rows[1].messageID)
  })

  test("previews the content, so a row is identifiable without opening it", () => {
    const call = tool("bash", complete({}, "permission denied for the user"))
    expect(SessionTimeline.contributorsOf([call], 1)[0].preview).toBe("permission denied for the user")
  })
})

describe("sessionTimeline.shapeOf", () => {
  // Each turn is its own message: the tool calls, reasoning and retry below all
  // belong to the one assistant turn that is counted as a single turn.
  const rows = [
    text("hi", { role: "user", time: 100, messageID: MessageID.make("msg_user_1") }),
    text("working", { time: 200, messageID: MessageID.make("msg_asst_1") }),
    row({
      type: "reasoning",
      data: { type: "reasoning", text: "think" },
      time: 210,
      messageID: MessageID.make("msg_asst_1"),
    }),
    tool("bash", complete({}, "ok"), { time: 220, messageID: MessageID.make("msg_asst_1") }),
    tool("bash", { status: "error", input: {}, error: "no" }, { time: 230, messageID: MessageID.make("msg_asst_1") }),
    tool("edit", complete({}, "done"), { time: 240, messageID: MessageID.make("msg_asst_1") }),
    row({ type: "compaction", data: { type: "compaction" }, time: 250, messageID: MessageID.make("msg_asst_1") }),
    row({ type: "retry", data: { type: "retry" }, time: 260, messageID: MessageID.make("msg_asst_1") }),
    text("again", { role: "user", time: 500, messageID: MessageID.make("msg_user_2") }),
  ]

  test("counts the conversation's shape", () => {
    const shape = SessionTimeline.shapeOf(
      rows,
      rows.map((row) => row.time),
    )
    expect(shape.user).toBe(2)
    expect(shape.assistant).toBe(1)
    expect(shape.tools).toBe(3)
    expect(shape.errors).toBe(1)
    expect(shape.reasoning).toBe(1)
    expect(shape.compactions).toBe(1)
    expect(shape.retries).toBe(1)
  })

  test("breaks tool calls down by name, most used first", () => {
    const shape = SessionTimeline.shapeOf(rows, [])
    expect(shape.toolsByName).toEqual([
      { tool: "bash", calls: 2, errors: 1 },
      { tool: "edit", calls: 1, errors: 0 },
    ])
  })

  test("takes the span from the first and last timestamp however they arrive", () => {
    expect(SessionTimeline.shapeOf(rows, [100, 500, 200]).duration).toBe(400)
    expect(SessionTimeline.shapeOf([], []).duration).toBe(0)
  })

  test("counts many parts of one turn as one turn", () => {
    // A reply made of a text part, a reasoning part and three tool calls is one
    // turn, and reading it as five is how a short conversation looks busy.
    const one = [
      text("a", { messageID: MessageID.make("msg_a") }),
      row({ type: "reasoning", data: { type: "reasoning", text: "b" }, messageID: MessageID.make("msg_a") }),
      tool("bash", complete({}, "c"), { messageID: MessageID.make("msg_a") }),
    ]
    const shape = SessionTimeline.shapeOf(one, [])
    expect(shape.assistant).toBe(1)
    expect(shape.tools).toBe(1)
  })

  test("is all zeroes for an empty session, not missing", () => {
    const shape = SessionTimeline.shapeOf([], [])
    expect(shape).toEqual(SessionTimeline.EMPTY_SHAPE)
  })
})

describe("sessionTimeline.analyze", () => {
  const base = {
    shares: [] as SessionTimeline.Share[],
    contributors: [] as SessionTimeline.Contributor[],
    shape: SessionTimeline.EMPTY_SHAPE,
    coverage: { measured: 0, estimated: 0, ratio: 0 } as SessionTimeline.Coverage,
  }

  const contributor = (over: Partial<SessionTimeline.Contributor> = {}): SessionTimeline.Contributor => ({
    partID: PartID.make("prt_big"),
    messageID: MessageID.make("msg_1"),
    role: "assistant",
    label: "bash",
    bucket: "tool-output",
    tokens: 900,
    share: 0.9,
    preview: "a very large dump of a file",
    ...over,
  })

  const ids = (over: { shares?: SessionTimeline.Share[]; contributors?: SessionTimeline.Contributor[] } = {}) =>
    SessionTimeline.analyze({
      ...base,
      shares: over.shares ?? [
        { bucket: "tool-output", tokens: 900, share: 0.9, parts: 1 },
        { bucket: "user", tokens: 100, share: 0.1, parts: 2 },
      ],
      contributors: over.contributors ?? [contributor()],
    }).map((finding) => finding.id)

  test("names the part carrying the window, because that is the answer", () => {
    const findings = SessionTimeline.analyze({
      ...base,
      shares: [
        { bucket: "tool-output", tokens: 900, share: 0.9, parts: 1 },
        { bucket: "user", tokens: 100, share: 0.1, parts: 2 },
      ],
      contributors: [contributor({ share: 0.9 })],
    })
    const dominant = findings.find((finding) => finding.id === "timeline.part-dominates")
    // 90% is alarming but not yet a warning; the warning is reserved for a part
    // that is most of the window, which is a different and rarer thing.
    expect(dominant?.severity).toBe("warn")
    // The identifiers and the preview are what make it actionable rather than a
    // statistic: the point is being able to go and look at the part.
    expect(dominant?.title).toContain("90%")
    expect(dominant?.detail).toContain("prt_big")
    expect(dominant?.detail).toContain("a very large dump of a file")
  })

  test("escalates when one part is most of the window", () => {
    const findings = SessionTimeline.analyze({
      ...base,
      shares: [{ bucket: "tool-output", tokens: 1000, share: 1, parts: 1 }],
      contributors: [contributor({ share: 1 })],
    })
    expect(findings.find((finding) => finding.id === "timeline.part-dominates")?.severity).toBe("warn")
  })

  test("says nothing about a part that is merely the largest of small ones", () => {
    // Six equal parts make the biggest a sixth of the window, and naming it
    // would be naming arithmetic.
    const shares = Array.from({ length: 6 }, () => ({
      bucket: "tool-output" as const,
      tokens: 100,
      share: 1 / 6,
      parts: 1,
    }))
    expect(ids({ shares, contributors: [contributor({ share: 1 / 6 })] })).not.toContain("timeline.part-dominates")
  })

  test("names a bucket that carries the window even when no single part does", () => {
    const shares = [
      { bucket: "tool-output" as const, tokens: 500, share: 0.6, parts: 20 },
      { bucket: "user" as const, tokens: 340, share: 0.4, parts: 4 },
    ]
    const findings = SessionTimeline.analyze({ ...base, shares, contributors: [] })
    const dominant = findings.find((finding) => finding.id === "timeline.bucket-dominates")
    expect(dominant?.title).toContain("what tools returned")
    expect(dominant?.detail).toContain("20 parts")
  })

  test("names a tool that keeps failing, once, not once per call", () => {
    const shape = {
      ...SessionTimeline.EMPTY_SHAPE,
      toolsByName: [
        { tool: "bash", calls: 6, errors: 5 },
        { tool: "edit", calls: 2, errors: 0 },
      ],
    }
    const failures = SessionTimeline.analyze({ ...base, shape }).filter((finding) =>
      finding.id.startsWith("timeline.tool-fails"),
    )
    expect(failures).toHaveLength(1)
    expect(failures[0].title).toBe("bash failed 5 of 6 times")
  })

  test("leaves a tool alone when half its calls succeeded", () => {
    const shape = { ...SessionTimeline.EMPTY_SHAPE, toolsByName: [{ tool: "bash", calls: 4, errors: 2 }] }
    expect(SessionTimeline.analyze({ ...base, shape }).map((finding) => finding.id)).not.toContain(
      "timeline.tool-fails.bash",
    )
  })

  test("leaves a lone failure alone, because one is not a pattern", () => {
    const shape = { ...SessionTimeline.EMPTY_SHAPE, toolsByName: [{ tool: "bash", calls: 2, errors: 1 }] }
    expect(SessionTimeline.analyze({ ...base, shape }).map((finding) => finding.id)).not.toContain(
      "timeline.tool-fails.bash",
    )
  })

  test("says so when the parts do not account for the window", () => {
    // A breakdown that stops at 40% without saying why is worse than none: it
    // reads as a complete answer to a question it only partly answers.
    const findings = SessionTimeline.analyze({
      ...base,
      coverage: { measured: 10_000, estimated: 3000, ratio: 0.3 },
    })
    const unaccounted = findings.find((finding) => finding.id === "timeline.unaccounted")
    expect(unaccounted?.title).toContain("30%")
    expect(unaccounted?.detail).toContain("10.0k")
    // The measured number is the whole window, cache reads included, so the
    // detail must not describe it as the input: on a cached conversation the
    // input is a small remainder and calling it that would be a false account.
    expect(unaccounted?.detail).toContain("was sent on the last turn")
    expect(unaccounted?.detail).not.toContain("as input")
    expect(unaccounted?.hint).toContain("system prompt")
  })

  test("says nothing about coverage when the parts do account for it", () => {
    expect(ids().map((id) => id)).not.toContain("timeline.unaccounted")
    expect(
      SessionTimeline.analyze({ ...base, coverage: { measured: 3000, estimated: 3000, ratio: 1 } })
        .map((finding) => finding.id)
        .filter((id) => id === "timeline.unaccounted"),
    ).toEqual([])
  })

  test("mentions a compaction, because it changes what the sizes mean", () => {
    const findings = SessionTimeline.analyze({
      ...base,
      shape: { ...SessionTimeline.EMPTY_SHAPE, compactions: 2 },
    })
    expect(findings.find((finding) => finding.id === "timeline.compacted")?.title).toContain("2 times")
  })

  test("has nothing to say about an empty session", () => {
    expect(SessionTimeline.analyze({ ...base })).toEqual([])
  })
})
