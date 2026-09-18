/**
 * GBNF Grammar builder for llama.cpp constrained generation
 * Converts Zod schemas to GBNF grammars via JSON Schema
 * Format matches llama.cpp's json_schema_to_grammar.py output
 */

import { z } from "zod";
import type { Question } from "./types.js";

/**
 * Convert Zod schema to JSON Schema (using zod-to-json-schema approach)
 */
function zodToJsonSchema(schema: z.ZodSchema): any {
  const def = schema._def as any;
  const typeName = def.typeName;

  switch (typeName) {
    case "ZodString": {
      const checks = def.checks || [];
      const enums = checks.filter((c: any) => c.kind === "enum").flatMap((c: any) => c.values);
      if (enums.length > 0) {
        return { type: "string", enum: enums };
      }
      return { type: "string" };
    }

    case "ZodNumber": {
      const checks = def.checks || [];
      const isInt = checks.some((c: any) => c.kind === "int");
      const result: any = isInt ? { type: "integer" } : { type: "number" };
      for (const c of checks) {
        if (c.kind === "min") result.minimum = c.value;
        if (c.kind === "max") result.maximum = c.value;
        if (c.kind === "multipleOf") result.multipleOf = c.value;
      }
      return result;
    }

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodSchema);
        // Check if optional
        const valDef = (value as z.ZodSchema)._def as any;
        if (valDef.typeName !== "ZodOptional") {
          required.push(key);
        }
      }
      return { type: "object", properties, required };
    }

    case "ZodArray": {
      const element = def.type;
      return { type: "array", items: zodToJsonSchema(element) };
    }

    case "ZodOptional": {
      return zodToJsonSchema(def.innerType);
    }

    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType);
      return { anyOf: [inner, { type: "null" }] };
    }

    case "ZodUnion": {
      return { anyOf: def.options.map((opt: z.ZodSchema) => zodToJsonSchema(opt)) };
    }

    case "ZodEnum": {
      return { type: "string", enum: def.values };
    }

    case "ZodLiteral": {
      return { const: def.value };
    }

    default:
      return { type: "string" };
  }
}

/**
 * Build a constrained integer GBNF rule for a given min/max range.
 * Returns the rule string; caller pushes it to their rules array.
 */
function buildConstrainedInt(s: any, name: string): string {
  const min = s.minimum ?? -Infinity;
  const max = s.maximum ?? Infinity;
  const safeName = name.replace(/_/g, "-");

  // Small range: enumerate all values
  if (max - min <= 10 && Number.isInteger(min) && Number.isInteger(max)) {
    const values: string[] = [];
    for (let i = min; i <= max; i++) values.push(String(i));
    return `${safeName} ::= (${values.join(" | ")})`;
  }

  // 0-100 range (common for percentages/estimates)
  if (min === 0 && max === 100) {
    return `${safeName} ::= "0" | [1-9] | [1-9][0-9] | "100"`;
  }

  // Fallback: use base integer rule
  return "integer";
}

/**
 * Build a constrained number GBNF rule for a given min/max range.
 * Returns the rule string; caller pushes it to their rules array.
 */
function buildConstrainedNumber(s: any, name: string): string {
  const min = s.minimum ?? -Infinity;
  const max = s.maximum ?? Infinity;
  const safeName = name.replace(/_/g, "-");

  // 0-1 range (common for confidence/probability)
  if (min === 0 && max === 1) {
    return `${safeName} ::= "0" ("." [0-9]+)? | "1" ("." [0]+)?`;
  }

  // 0-100 range with optional decimals
  if (min === 0 && max === 100) {
    return `${safeName} ::= "0" ("." [0-9]+)? | [1-9][0-9]? ("." [0-9]+)? | "100" ("." [0]+)?`;
  }

  // Fallback: use base number rule
  return "number";
}

/**
 * Convert JSON Schema to GBNF grammar
 * Matches llama.cpp's json_schema_to_grammar.py output format
 */
export function jsonSchemaToGbnf(schema: any, ruleName = "root"): string {
  const rules: string[] = [];
  const visited = new Set<string>();

  // Track property order for root rule
  const propertyOrder: string[] = [];

  function build(s: any, name: string): string {
    const safeName = name.replace(/_/g, "-");
    const key = JSON.stringify(s);
    // Don't cache primitive types - they should always return the shared rule name
    const isPrimitive = s.type === "boolean" || s.type === "integer" || s.type === "number";
    if (!isPrimitive && visited.has(key)) return safeName;
    if (!isPrimitive) visited.add(key);

    const type = s.type;
    const anyOf = s.anyOf;

    if (anyOf) {
      const optionNames = anyOf.map((opt: any, i: number) => build(opt, `${safeName}_opt${i}`));
      const rule = `${safeName} ::= ${optionNames.join(" | ")}`;
      rules.push(rule);
      return safeName;
    }

    switch (type) {
      case "string": {
        if (s.enum) {
          // Enum values must include quotes in the grammar to match JSON string literals
          // Use parentheses like json_schema_to_grammar.py
          const enumName = name.replace(/[^a-zA-Z0-9_-]/g, "").replace(/_/g, "-");
          const enumValues = s.enum.map((v: string) => `"\\"${escapeString(v)}\\""`).join(" | ");
          const enumRule = `${enumName} ::= (${enumValues})`;
          rules.push(enumRule);
          return enumName;
        }
        if (s.const !== undefined) {
          const litRule = `${name.replace(/_/g, "-")} ::= ${JSON.stringify(s.const)}`;
          rules.push(litRule);
          return name;
        }
        // Unconstrained string - create a specific rule for this field (not generic "string")
        // This prevents the generic string rule from overriding enum constraints
        const stringRuleName = `${name.replace(/_/g, "-")}_string`;
        if (!rules.some(r => r.startsWith(`${stringRuleName} ::=`))) {
          rules.push(`${stringRuleName} ::= '"' ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* '"'`);
        }
        return stringRuleName;
      }

      case "integer": {
        if (s.minimum !== undefined || s.maximum !== undefined) {
          const rule = buildConstrainedInt(s, name);
          if (rule !== "integer") {
            rules.push(rule);
            return safeName;
          }
        }
        return "integer";
      }

      case "number": {
        if (s.minimum !== undefined || s.maximum !== undefined) {
          const rule = buildConstrainedNumber(s, name);
          if (rule !== "number") {
            rules.push(rule);
            return safeName;
          }
        }
        return "number";
      }

      case "boolean":
        // Boolean rule added at the end
        return "boolean";

      case "object": {
        const props = s.properties || {};
        const required = new Set(s.required || []);

        // Build key-value rules for each property (matching json_schema_to_grammar.py format)
        const kvRules: string[] = [];
        for (const [key, value] of Object.entries(props)) {
          propertyOrder.push(key);
          const fieldName = `${safeName}_${key}`;
          const fieldRule = build(value, fieldName);
          // Use parent name + key for unique kv rule names (avoids collisions in nested objects)
          const kvName = `${safeName}-${key.replace(/_/g, "-")}-kv`;
          // key-value rule: "\"key\"" space ":" space value
          const kvRule = `${kvName} ::= "\\"${key}\\"" space ":" space ${fieldRule}`;
          rules.push(kvRule);
          kvRules.push(kvName);
        }

        // Root rule: concatenate kv rules with space and commas
        const rootParts = kvRules.map((kv, i) => {
          if (i === 0) return kv;
          return `"," space ${kv}`;
        });
        const objRule = `${safeName} ::= "{" space ${rootParts.join(" ")} space "}"`;
        rules.push(objRule);
        return safeName;
      }

      case "array": {
        const items = s.items || {};
        const itemName = `${safeName}_item`;
        const itemRule = build(items, itemName);
        const arrRule = `${safeName} ::= "[" space (${itemName} ("," space ${itemName})*)? space "]"`;
        rules.push(arrRule);
        return safeName;
      }

      default:
        return "string";
    }
  }

  const rootRef = build(schema, ruleName);

  // Add base rules at the end (matching json_schema_to_grammar.py order)
  const baseRules = `
integer ::= ("-"? integral-part)
integral-part ::= [0] | [1-9] [0-9]{0,15}
number ::= ("-"? integral-part) ("." [0-9]+)?
boolean ::= ("true" | "false" | "1" | "0")
space ::= | " " | "\\n"{1,2} [ \\t]{0,20}
`;

  return `${rules.join("\n")}\n${baseRules}\n`;
}

/**
 * Convert Zod schema to GBNF grammar
 */
export function zodToGbnf(schema: z.ZodSchema, ruleName = "root"): string {
  const jsonSchema = zodToJsonSchema(schema);
  return jsonSchemaToGbnf(jsonSchema, ruleName);
}

/**
 * Escape string for GBNF
 */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Build GBNF for a parallel prompt (multiple questions)
 * Uses the proven zodToGbnf path to stay in sync with schema validation.
 */
export function buildParallelGbnf(questions: Question[]): string {
  // Build a combined Zod object schema from all questions
  const shape: Record<string, z.ZodSchema> = {};
  for (const q of questions) {
    shape[q.key] = q.schema;
  }
  const combinedSchema = z.object(shape);

  // Use the single source of truth: Zod schema → GBNF
  return zodToGbnf(combinedSchema);
}

/**
 * Pre-built GBNF for common patterns
 */
export const GBNF = {
  /** Generic JSON object */
  JSON_OBJECT: `
string ::= '"' ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* '"'
integer ::= "-"? [0-9]+
number ::= "-"? [0-9]+ ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
boolean ::= "true" | "false"
null ::= "null"
value ::= object | array | string | number | boolean | null
array ::= "[" ws (value ("," ws value)*)? "]"
object ::= "{" ws (string ":" ws value ("," ws string ":" ws value)*)? "}"
ws ::= [ \\t\\n\\r]*
root ::= object
`,

  /** Issue triage classification - matches json_schema_to_grammar.py format */
  ISSUE_TRIAGE: `
string ::= '"' ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* '"'
integer ::= ("-"? integral-part)
integral-part ::= [0] | [1-9] [0-9]{0,15}
boolean ::= ("true" | "false" | "1" | "0")
space ::= | " " | "\\n"{1,2} [ \\t]{0,20}
category ::= ("\"bug\"" | "\"feature\"" | "\"question\"" | "\"docs\"" | "\"refactor\"")
category-kv ::= "\"category\"" space ":" space category
priority ::= ("\"P0\"" | "\"P1\"" | "\"P2\"" | "\"P3\"")
priority-kv ::= "\"priority\"" space ":" space priority
area ::= ("\"frontend\"" | "\"backend\"" | "\"cli\"" | "\"docs\"" | "\"infra\"" | "\"unknown\"")
area-kv ::= "\"area\"" space ":" space area
estimated-hours-kv ::= "\"estimated_hours\"" space ":" space integer
needs-design-review-kv ::= "\"needs_design_review\"" space ":" space boolean
root ::= "{" space category-kv "," space priority-kv "," space area-kv "," space estimated-hours-kv "," space needs-design-review-kv space "}"
`,

  /** Code review decision */
  CODE_REVIEW: `
string ::= '"' ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* '"'
boolean ::= ("true" | "false" | "1" | "0")
space ::= | " " | "\\n"{1,2} [ \\t]{0,20}
severity ::= ("\"none\"" | "\"low\"" | "\"medium\"" | "\"high\"" | "\"critical\"")
severity-kv ::= "\"severity\"" space ":" space severity
decision ::= ("\"approve\"" | "\"request_changes\"" | "\"block\"")
decision-kv ::= "\"decision\"" space ":" space decision
root ::= "{" space severity-kv "," space decision-kv space "}"
`,
  };

/**
 * Write GBNF to temp file and return path
 */
export async function writeGbnfFile(grammar: string): Promise<string> {
  const { tmpdir } = await import("os");
  const { writeFile, mkdtemp } = await import("fs/promises");
  const { join } = await import("path");

  const prefix = join(tmpdir(), "gbnf-");
  const dir = await mkdtemp(prefix);
  const filePath = join(dir, "grammar.gbnf");
  await writeFile(filePath, grammar);
  return filePath;
}

/**
 * Clean up temp GBNF file
 */
export async function cleanupGbnfFile(filePath: string): Promise<void> {
  const { unlink, rmdir } = await import("fs/promises");
  const { dirname } = await import("path");

  try {
    await unlink(filePath);
    await rmdir(dirname(filePath));
  } catch {
    // Ignore cleanup errors
  }
}