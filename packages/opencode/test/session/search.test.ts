import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSearch } from "../../src/session/search"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionSearch.node, SessionProjector.node])),
)

/**
 * Writes a conversation into the database the same way the prompt path does, so
 * the search has to read real rows rather than a stubbed shape.
 */
const userMessage = (id: MessageID, sessionID: SessionID) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  }) as unknown as SessionV1.Info

// `Assistant` is a separate arm of the message union and requires a parent,
// a provider, a path, and a cost block, so it cannot borrow `User`'s shape.
const assistantMessage = (id: MessageID, sessionID: SessionID, parentID: MessageID) =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: "test",
    providerID: "test",
    mode: "",
    agent: "test",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as SessionV1.Info

/**
 * Writes a conversation into the database the same way the prompt path does, so
 * the search reads real rows rather than a stubbed shape.
 */
const seed = Effect.fn("Test.seed")(function* (input: {
  sessionID: SessionID
  messages: { role: "user" | "assistant"; text: string; synthetic?: boolean }[]
}) {
  const session = yield* SessionNs.Service
  let last: MessageID | undefined
  for (const message of input.messages) {
    const id = MessageID.ascending()
    const info =
      message.role === "assistant" && last
        ? assistantMessage(id, input.sessionID, last)
        : userMessage(id, input.sessionID)
    last = id
    yield* session.updateMessage(info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: id,
      type: "text",
      text: message.text,
      ...(message.synthetic ? { synthetic: true } : {}),
    } as unknown as SessionV1.Part)
  }
})

describe("sessionSearch.locate", () => {
  test("finds every non-overlapping match", () => {
    expect(SessionSearch.locate("abcabc", "abc")).toEqual([0, 3])
  })

  test("folds case unless asked not to", () => {
    expect(SessionSearch.locate("Hello World", "world")).toEqual([6])
    expect(SessionSearch.locate("Hello World", "world", true)).toEqual([])
    expect(SessionSearch.locate("Hello World", "Hello", true)).toEqual([0])
  })

  test("counts code points, not UTF-16 units", () => {
    // A surrogate pair is one character, so the match starts at code point 2 —
    // a UTF-16 index would have said 3.
    expect(SessionSearch.locate("👍 target", "target")).toEqual([2])
    expect("👍 target".indexOf("target")).toBe(3)
  })

  test("returns nothing for an empty query", () => {
    expect(SessionSearch.locate("abc", "")).toEqual([])
  })
})

describe("sessionSearch.snippet", () => {
  test("returns undefined when the query is absent", () => {
    expect(SessionSearch.snippet({ text: "hello", query: "zzz" })).toBeUndefined()
  })

  test("centres the window on the hit and marks both cut edges", () => {
    const text = "x".repeat(500) + "needle" + "y".repeat(500)
    const result = SessionSearch.snippet({ text, query: "needle", radius: 10 })!
    expect(result.text).toBe("…xxxxxxxxxxneedleyyyyyyyyyy…")
    expect(result.start).toBe(490)
    expect(result.matches).toBe(1)
  })

  test("does not mark an edge the window reaches", () => {
    const result = SessionSearch.snippet({ text: "needle tail", query: "needle", radius: 40 })!
    expect(result.text).toBe("needle tail")
    expect(result.start).toBe(0)
  })

  test("never cuts a surrogate pair in half", () => {
    // Every cut edge lands next to a two-unit emoji, so a UTF-16 slice would
    // leave a lone surrogate here.
    const text = "👍".repeat(400) + "needle" + "👍".repeat(400)
    const result = SessionSearch.snippet({ text, query: "needle", radius: 3 })!
    expect(result.text).toBe("…👍👍👍needle👍👍👍…")
    // 397 emoji at two UTF-16 units each: the offset is a byte-for-the-consumer
    // string index, not the 397 code-point index the window was cut on.
    expect(result.start).toBe(794)
    expect(text.slice(result.start, result.start + result.text.length - 2)).toContain("needle")
    // Round-tripping proves the window is still well-formed text.
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text)
  })

  test("reports every occurrence in the part", () => {
    const result = SessionSearch.snippet({ text: "a b a b a", query: "a b" })!
    expect(result.matches).toBe(2)
  })

  test("honours caseSensitive", () => {
    expect(SessionSearch.snippet({ text: "Needle", query: "needle" })).toBeDefined()
    expect(SessionSearch.snippet({ text: "Needle", query: "needle", caseSensitive: true })).toBeUndefined()
  })
})

describe("sessionSearch.search", () => {
  it.instance("finds a phrase inside a message and reports where it is", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "deploy notes" })
      yield* seed({
        sessionID: created.id,
        messages: [
          { role: "user", text: "how do I rotate the database password?" },
          { role: "assistant", text: "run the rotation job" },
        ],
      })
      const search = yield* SessionSearch.Service
      const hits = yield* search.search({ query: "rotate the database" })
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({
        sessionID: created.id,
        role: "user",
        matches: 1,
        snippet: "how do I rotate the database password?",
        snippetStart: 0,
      })
    }),
  )

  it.instance("finds a value inside what a tool printed, which is most of a transcript", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "build" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: { command: "cat build.log" },
          output: "TypeError: brokenImgs is not defined\n    at TopBar",
          title: "cat build.log",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      const hits = yield* search.search({ query: "brokenImgs" })
      // The agent printed this in front of the user. A search that cannot find
      // it says the tool never ran, which is worse than saying nothing.
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toContain("brokenImgs")
    }),
  )

  it.instance("finds a value inside a tool's error text too", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "failing" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "error",
          input: { command: "rm -rf /" },
          error: "permission denied by the sandbox",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      const hits = yield* search.search({ query: "sandbox" })
      expect(hits).toHaveLength(1)
    }),
  )

  it.instance("finds a value inside what the model reasoned about", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "thinking" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "reasoning",
        text: "the retry budget is exhausted, so the loop guard should trip",
        time: { start: 0, end: 1 },
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "loop guard" })).toHaveLength(1)
    }),
  )

  it.instance("finds the contents of a file the user attached, not its metadata envelope", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "attached" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      // A FilePart has no top-level `text`; the contents sit inside the
      // `{value,start,end}` envelope at `source.text`, the same shape
      // `FilePartSource` declares.
      const contents = "const a = 1\nconst b = 2\nthrow new Error('boom')"
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "file",
        mime: "text/plain",
        filename: "boom.ts",
        url: "file:///repo/boom.ts",
        source: { type: "file", path: "boom.ts", text: { value: contents, start: 0, end: contents.length } },
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      const hits = yield* search.search({ query: "boom" })
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toContain("throw new Error('boom')")
      expect(hits[0].snippet).not.toContain('"value"')
    }),
  )

  it.instance("matches a query that spans two lines of a file", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "multiline" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      const contents = "const a = 1\nconst b = 2\nthrow new Error('boom')"
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "file",
        mime: "text/plain",
        filename: "boom.ts",
        url: "file:///repo/boom.ts",
        source: { type: "file", path: "boom.ts", text: { value: contents, start: 0, end: contents.length } },
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      // Two lines copied out of the file, newline and all. Reading the envelope
      // instead of the contents serialized the newlines to `\n`, so the search
      // string could not line up with the stored one and this found nothing.
      const hits = yield* search.search({ query: "const b = 2\nthrow" })
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toContain("\n")
    }),
  )

  it.instance("still does not match a part that carries no text at all", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "steps" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage(userMessage(messageID, created.id))
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "step-start",
      } as unknown as SessionV1.Part)

      const search = yield* SessionSearch.Service
      // Every part kind is now a candidate, so the ones with no body must be
      // filtered out rather than surfacing as empty hits.
      expect(yield* search.search({ query: "anything" })).toEqual([])
    }),
  )

  it.instance("is case-insensitive by default and exact with caseSensitive", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "case" })
      yield* seed({
        sessionID: created.id,
        messages: [{ role: "user", text: "Token REFRESH failed" }],
      })
      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "token refresh" })).toHaveLength(1)
      expect(yield* search.search({ query: "token refresh", caseSensitive: true })).toHaveLength(0)
      expect(yield* search.search({ query: "Token REFRESH", caseSensitive: true })).toHaveLength(1)
    }),
  )

  it.instance("treats a LIKE wildcard in the query as a literal", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "wildcards" })
      yield* seed({
        sessionID: created.id,
        messages: [
          { role: "user", text: "coverage is at 50% today" },
          { role: "assistant", text: "unrelated note" },
        ],
      })
      const search = yield* SessionSearch.Service
      const hits = yield* search.search({ query: "50%" })
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toBe("coverage is at 50% today")
    }),
  )

  it.instance("hides injected text unless it is asked for", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "reminders" })
      yield* seed({
        sessionID: created.id,
        messages: [
          { role: "user", text: "please refactor the parser" },
          { role: "assistant", text: "refactor the parser now", synthetic: true },
        ],
      })
      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "refactor the parser" })).toHaveLength(1)
      expect(yield* search.search({ query: "refactor the parser", synthetic: true })).toHaveLength(2)
    }),
  )

  it.instance("scopes to one session when asked", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const first = yield* session.create({ title: "first" })
      const second = yield* session.create({ title: "second" })
      yield* seed({
        sessionID: first.id,
        messages: [{ role: "user", text: "shared marker" }],
      })
      yield* seed({
        sessionID: second.id,
        messages: [{ role: "user", text: "shared marker again" }],
      })
      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "shared marker" })).toHaveLength(2)
      const scoped = yield* search.search({ query: "shared marker", sessionID: first.id })
      expect(scoped).toHaveLength(1)
      expect(scoped[0].sessionID).toBe(first.id)
    }),
  )

  it.instance("honours the limit and orders hits by the most recent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "ordered" })
      yield* seed({
        sessionID: created.id,
        messages: [
          { role: "user", text: "needle one" },
          { role: "assistant", text: "needle two" },
          { role: "user", text: "needle three" },
        ],
      })
      const search = yield* SessionSearch.Service
      // A burst of parts can share a millisecond, and their ids are monotonic,
      // so the id tiebreak is what makes this order total rather than a
      // preference SQLite may or may not honour.
      const all = yield* search.search({ query: "needle" })
      expect(all.map((hit) => hit.snippet)).toEqual(["needle three", "needle two", "needle one"])

      const hits = yield* search.search({ query: "needle", limit: 2 })
      expect(hits).toHaveLength(2)
      expect(hits.map((hit) => hit.snippet)).toEqual(["needle three", "needle two"])
    }),
  )

  it.instance("returns nothing for a blank query rather than matching every part", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "blank" })
      yield* seed({
        sessionID: created.id,
        messages: [{ role: "user", text: "anything at all" }],
      })
      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "   " })).toEqual([])
    }),
  )

  it.instance("returns nothing when the text is absent", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "quiet" })
      yield* seed({ sessionID: created.id, messages: [{ role: "user", text: "hello" }] })
      const search = yield* SessionSearch.Service
      expect(yield* search.search({ query: "goodbye" })).toEqual([])
    }),
  )
})
