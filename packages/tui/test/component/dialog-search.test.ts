import { describe, expect, test } from "bun:test"
import type { SessionSearchHit } from "@opencode-ai/sdk/v2"
import { createSearchQuery, loadSearchResults, searchHitsToOptions } from "../../src/routes/session/dialog-search"

const hit = (over: Partial<SessionSearchHit> = {}): SessionSearchHit => ({
  sessionID: "ses_a",
  sessionTitle: "deploy notes",
  directory: "/repo",
  messageID: "msg_1",
  partID: "prt_1",
  role: "user",
  time: 1_700_000_000_000,
  matches: 1,
  snippet: "rotate the database password",
  snippetStart: 0,
  ...over,
})

describe("dialog search query", () => {
  test("sends nothing for a blank filter rather than asking for every message", () => {
    expect(createSearchQuery({ filter: "" })).toBeUndefined()
    expect(createSearchQuery({ filter: "   " })).toBeUndefined()
  })

  test("trims the filter, because the server matches a literal substring", () => {
    expect(createSearchQuery({ filter: "  deploy key  " })).toEqual({ q: "deploy key" })
  })

  test("scopes to a session when one is given", () => {
    expect(createSearchQuery({ filter: "x", sessionID: "ses_a" })).toEqual({ q: "x", session: "ses_a" })
  })

  test("asks for every project only when told to", () => {
    expect(createSearchQuery({ filter: "x", all: true })).toEqual({ q: "x", all: "true" })
    expect(createSearchQuery({ filter: "x" })).toEqual({ q: "x" })
  })
})

describe("dialog search results", () => {
  test("returns nothing without a query", async () => {
    expect(await loadSearchResults(undefined, async () => ({ data: [hit()] }))).toBeUndefined()
  })

  test("unwraps the response data", async () => {
    const query = createSearchQuery({ filter: "x" })
    expect(await loadSearchResults(query, async () => ({ data: [hit()] }))).toHaveLength(1)
  })

  test("a failed request reads as no results rather than taking the dialog down", async () => {
    const query = createSearchQuery({ filter: "x" })
    const result = await loadSearchResults(query, async () => {
      throw new Error("server gone")
    })
    expect(result).toBeUndefined()
  })
})

describe("dialog search rows", () => {
  test("carries the ids the jump needs", () => {
    const [option] = searchHitsToOptions([hit({ sessionID: "ses_a", messageID: "msg_1" })])
    expect(option.value).toEqual({ sessionID: "ses_a", messageID: "msg_1" })
  })

  test("uses the snippet as the title and the conversation as the footer", () => {
    const [option] = searchHitsToOptions([hit({ snippet: "the answer", sessionTitle: "deploy notes" })])
    expect(option.title).toBe("the answer")
    expect(option.footer).toBe("deploy notes")
  })

  test("collapses whitespace so a multi-line snippet stays on one row", () => {
    const [option] = searchHitsToOptions([hit({ snippet: "line one\n\nline   two\n" })])
    expect(option.title).toBe("line one line two")
  })

  test("reports the role, so a hit in an answer is distinguishable from a prompt", () => {
    expect(searchHitsToOptions([hit({ role: "assistant" })])[0].category).toBe("assistant")
  })

  test("counts repeated matches and stays quiet when there is only one", () => {
    expect(searchHitsToOptions([hit({ matches: 1 })])[0].description).toBeUndefined()
    expect(searchHitsToOptions([hit({ matches: 4 })])[0].description).toBe("4 matches")
  })

  test("keeps one row per hit so duplicates are visible rather than merged away", () => {
    expect(searchHitsToOptions([hit(), hit(), hit()])).toHaveLength(3)
  })
})
