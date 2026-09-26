import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"

/**
 * Zod -> JSON Schema conversion shared by the plugin tool bridge and the core tools that still
 * declare their parameters with Zod. Plugin tools and the goal tools must present the exact same
 * schema to the model, so the conversion lives in one place.
 */
export function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

export function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

export function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

export function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

export function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

export function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry) =>
          !((entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"),
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

export function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type ZodArgs = Record<string, z.ZodType>

/**
 * Mirrors the plugin tool bridge: Zod args are validated with the Zod schema while the model is
 * handed the original JSON Schema.
 */
export function zodArgs(args: ZodArgs) {
  const schema = z.object(args)
  return {
    parameters: Schema.declare<unknown>((u): u is unknown => schema.safeParse(u).success),
    jsonSchema: zodJsonSchema(schema),
  }
}

export * as ToolZod from "./zod"
