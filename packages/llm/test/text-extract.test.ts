import { describe, expect, test } from "bun:test"
import { TextToolCall } from "../src/protocols/utils/text-tool-call"
import { TextReasoning } from "../src/protocols/utils/text-reasoning"

describe("TextToolCall", () => {
  test("extracts dots_function_call envelopes (screenshot format)", () => {
    const text =
      "Let me list the directory.\n" +
      "dots_function_call\n" +
      'invoke name="bash">\n' +
      'parameter name="command">ls -la\n' +
      "/invoke\n" +
      "/dots_function_call\n" +
      "Done."

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0].name).toBe("bash")
    expect(result![0].input.command).toBe("ls -la")
    expect(TextToolCall.strip(text)).toBe("Let me list the directory.\nDone.")
  })

  test("extracts multiple envelopes", () => {
    const text =
      "dots_function_call\n" +
      'invoke name="read">\n' +
      'parameter name="path">/a\n' +
      "/invoke\n" +
      "/dots_function_call\n" +
      "dots_function_call\n" +
      'invoke name="write">\n' +
      'parameter name="path">/b\n' +
      "/invoke\n" +
      "/dots_function_call"

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(2)
    expect(result![0].name).toBe("read")
    expect(result![1].name).toBe("write")
  })

  test("extracts bare invoke blocks outside any envelope", () => {
    const text =
      'invoke name="bash">\n' +
      'parameter name="command">echo hi\n' +
      "/invoke"

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0].name).toBe("bash")
    expect(result![0].input.command).toBe("echo hi")
  })

  test("extracts tool_call JSON envelopes (qwen / deepseek gateway)", () => {
    const text =
      "I'll run the command.\n" +
      '<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>\n' +
      "Done."

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0].name).toBe("bash")
    expect(result![0].input.command).toBe("ls -la")
    expect(TextToolCall.strip(text)).toBe("I'll run the command.\nDone.")
  })

  test("extracts multiple tool_call JSON envelopes", () => {
    const text =
      '<tool_call>{"name":"read","arguments":{"path":"/a"}}</tool_call>' +
      '<tool_call>{"name":"write","arguments":{"path":"/b"}}</tool_call>'

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(2)
    expect(result![0].name).toBe("read")
    expect(result![1].name).toBe("write")
    expect(result![0].input.path).toBe("/a")
    expect(result![1].input.path).toBe("/b")
  })

  test("extracts function=Name parameter=Key legacy envelopes", () => {
    const text =
      ['<function name="bash">', '<parameter name="command">ls -la'].join("\n") + "\n"

    const result = TextToolCall.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0].name).toBe("bash")
    expect(result![0].input.command).toBe("ls -la")
  })

  test("returns undefined when no envelope present", () => {
    expect(TextToolCall.parse("just text")).toBeUndefined()
  })
})

describe("TextReasoning", () => {
  test("extracts thinking envelopes", () => {
    const text =
      "thinking\nI need to think about this.\n/thinking\nThe answer is 42."

    const result = TextReasoning.parse(text)
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0].text).toContain("I need to think")
    expect(TextReasoning.strip(text)).toBe("The answer is 42.")
  })

  test("returns undefined when no envelope present", () => {
    expect(TextReasoning.parse("just text")).toBeUndefined()
  })
})