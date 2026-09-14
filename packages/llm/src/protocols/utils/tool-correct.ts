import type { JsonSchema } from "../../schema"
import { ProviderShared } from "../shared"

/**
 * Result of attempting to repair one tool call's arguments against its
 * declared schema. The harness never trusts the model's raw JSON: when the
 * arguments fail schema validation, it tries to recover instead of failing
 * the turn.
 *
 * - `ok` — the value decoded cleanly, no repair needed.
 * - `repaired` — the raw JSON was invalid, but a repair heuristic produced a
 *   value that decodes. The caller should log this and proceed.
 * - `failed` — the value could not be repaired. The harness surfaces this as a
 *   tool error so the model can self-correct on the next turn.
 */
export interface CorrectResult {
  readonly ok: boolean
  readonly repaired: boolean
  readonly input: Record<string, unknown>
  readonly message?: string
}

/**
 * Coerce a parsed tool-call input against a JSON Schema. The repair set is
 * deliberately narrow and conservative — it only fixes the failure modes that
 * models actually produce, never restructures valid input:
 *
 * - missing required keys → filled with `undefined` so schema decode can report
 *   them by name instead of the harness dying on a bare error.
 * - `null` where a scalar is expected → dropped (most schemas treat absent as
 *   acceptable; `null` rarely is).
 * - stringified JSON inside a string field → parsed once, when the result
 *   still validates. Some gateways double-encode arguments.
 * - extra unknown keys → preserved untouched (schemas with
 *   `additionalProperties: false` reject them explicitly).
 *
 * Anything outside this set is reported as a failure so the model gets a
 * useful error rather than a silently-wrong tool execution.
 */
export const correctToolInput = (
  raw: unknown,
  schema: JsonSchema | undefined,
): CorrectResult => {
  if (!ProviderShared.isRecord(raw)) return fail("Tool arguments were not a JSON object")
  const input: Record<string, unknown> = { ...raw }
  const repaired: string[] = []

  const properties = ProviderShared.isRecord(schema?.properties) ? schema.properties : undefined
  const required = Array.isArray(schema?.required) ? schema.required : undefined

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (!(key in input)) {
        if (required?.includes(key)) {
          input[key] = undefined
          repaired.push(`missing required key "${key}"`)
        }
        continue
      }
      const prop = ProviderShared.isRecord(value) ? value : undefined
      const type = typeof prop?.type === "string" ? prop.type : undefined

      if (input[key] === null && type !== "null" && type !== "undefined") {
        delete input[key]
        if (required?.includes(key)) input[key] = undefined
        repaired.push(`null where "${key}" expects ${type ?? "a value"}`)
        continue
      }

      if (type === "string" && typeof input[key] === "string") {
        const coerced = tryParseJson(input[key] as string)
        if (coerced !== undefined && coerced !== input[key]) {
          // Some gateways double-encode arguments: a string field holds a JSON
          // object. Merge its keys into the input rather than replacing the
          // field with an object, so the schema still sees the expected shape.
          const candidate = ProviderShared.isRecord(coerced)
            ? { ...input, ...coerced }
            : { ...input, [key]: coerced }
          if (decodes(candidate, schema)) {
            for (const [k, v] of Object.entries(candidate)) input[k] = v
            repaired.push(`stringified JSON in "${key}"`)
          }
        }
      }
    }
  }

  if (!decodes(input, schema)) {
    return fail(`Tool arguments did not validate: ${repaired.length ? repaired.join(", ") : "no repair applied"}`)
  }
  return { ok: true, repaired: repaired.length > 0, input, message: repaired.length ? repaired.join("; ") : undefined }
}

const tryParseJson = (value: string): unknown => {
  const trimmed = value.trim()
  if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const decodes = (value: unknown, schema: JsonSchema | undefined): boolean => {
  if (schema === undefined) return true
  // Validate structurally rather than with Schema.Json, which rejects
  // `undefined` keys and unknown keywords. An object-shaped schema accepts
  // any record; scalar schemas accept matching primitives.
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    return ProviderShared.isRecord(value)
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string"
    case "number":
    case "integer":
      return typeof value === "number"
    case "boolean":
      return typeof value === "boolean"
    case "array":
      return Array.isArray(value)
    case "null":
      return value === null
    default:
      return true
  }
}

const fail = (message: string): CorrectResult => ({ ok: false, repaired: false, input: {}, message })

export * as ToolCorrector from "./tool-correct"