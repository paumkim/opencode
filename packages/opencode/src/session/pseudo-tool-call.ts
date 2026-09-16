export interface PseudoToolCall {
  name: string
  input: Record<string, unknown>
}

const XML_CALL = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call\s*>/gi
const BRACKET_CALL = /\[tool_call\s*:\s*([\w-]+)([^\]]*)\]/gi
const FUNCTION_TAG = /<function\b[^=]*=\s*["']?([\w-]+)["']?[^>]*>/i
const PARAM_TAG = /<parameter\b[^>]*?(?:name\s*=\s*["']?([\w-]+)["']?|= *["']?([\w-]+)["']?)[^>]*>([\s\S]*?)<\/parameter\s*>/gi
const KV_PAIR = /([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,]+)/g

function parseParams(body: string): Record<string, unknown> {
  const trimmed = body.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {}
  const input: Record<string, unknown> = {}
  for (const m of trimmed.matchAll(PARAM_TAG)) input[m[1] ?? m[2]] = m[3].trim()
  if (Object.keys(input).length) return input
  KV_PAIR.lastIndex = 0
  for (const m of trimmed.matchAll(KV_PAIR)) input[m[1]] = m[2].replace(/^["']|["']$/g, "")
  return input
}

// Allowlist of tool IDs known to the registry (see src/tool/registry.ts and
// src/tool/*.ts). Parsed pseudo-calls with any other name are NOT executed —
// they are left as plain text. This blocks parser injection where model output
// (or pasted third-party content echoed by the model) smuggles an arbitrary
// <tool_call name="..."> that would otherwise run as a real tool part.
// NOTE: keep in sync with the builtin tool IDs in src/tool/registry.ts.
export const KNOWN_TOOL_CALLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "task",
  "todowrite",
  // Common aliases models emit — map to the canonical tools above.
  "todo",
  "list",
  "ls",
  "webfetch",
  "websearch",
  "skill",
  "lsp",
  "apply_patch",
  "question",
  "plan_exit",
  "compact",
  "invalid",
  "execute",
  "agents",
])

export function isKnownToolCall(name: string): boolean {
  return KNOWN_TOOL_CALLS.has(name)
}

export function parsePseudoToolCalls(text: string): PseudoToolCall[] {
  const out: PseudoToolCall[] = []
  XML_CALL.lastIndex = 0
  for (const m of text.matchAll(XML_CALL)) {
    const nameAttr = /name\s*=\s*["']?([\w-]+)["']?/i.exec(m[1])?.[1]
    const name = nameAttr ?? FUNCTION_TAG.exec(m[2])?.[1]
    if (!name) continue
    out.push({ name, input: parseParams(m[2].replace(FUNCTION_TAG, "")) })
  }
  BRACKET_CALL.lastIndex = 0
  for (const m of text.matchAll(BRACKET_CALL)) {
    const input = parseParams(m[2])
    if (!Object.keys(input).length && m[2].trim()) input.path = m[2].trim().replace(/^for\s+/i, "")
    out.push({ name: m[1], input })
  }
  return out
}

export function stripPseudoToolCalls(text: string): string {
  // Only strip markup for known tools — unknown names stay visible as text
  // so a rejected injection attempt is auditable instead of silently dropped.
  const stripped = text
    .replace(XML_CALL, (m, attrs: string, body: string) => {
      const nameAttr = /name\s*=\s*["']?([\w-]+)["']?/i.exec(attrs)?.[1]
      const name = nameAttr ?? FUNCTION_TAG.exec(body)?.[1]
      return name && isKnownToolCall(name) ? "" : m
    })
    .replace(BRACKET_CALL, (m, name: string) => (isKnownToolCall(name) ? "" : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return stripped
}

export * as PseudoToolCall from "./pseudo-tool-call"
