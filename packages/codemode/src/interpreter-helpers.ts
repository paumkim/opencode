import { parse } from "acorn"
import { Cause, Effect, Exit, Fiber, Schema, Semaphore } from "effect"
import { DiagnosticCategory, ModuleKind, ScriptTarget, flattenDiagnosticMessageText, transpileModule } from "typescript"
import { copyIn, copyOut, isBlockedMember, ToolReference, ToolRuntime, ToolRuntimeError, type HostTools, type SafeObject, type Services } from "./tool-runtime.js"
import { ToolError } from "./tool-error.js"
import { isSandboxValue, SandboxDate, SandboxMap, SandboxPromise, SandboxRegExp, SandboxSet } from "./values.js"
import type { DiagnosticKind, Diagnostic, ExecutionLimits } from "./codemode.js"

export type ResolvedExecutionLimits = { readonly timeoutMs: number | undefined; readonly maxToolCalls: number | undefined; readonly maxOutputBytes: number | undefined }


export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

export type Binding = {
  mutable: boolean
  value: unknown
  // Absent means initialized. `false` marks a parameter binding seeded into its scope but not
  // yet bound, so a default that forward-references a later parameter sees a TDZ error (as in JS)
  // rather than silently resolving to an outer binding of the same name.
  initialized?: boolean
}

export type StatementResult =
  | { kind: "none" }
  | { kind: "value"; value: unknown }
  | { kind: "return"; value: unknown }
  | { kind: "break" }
  | { kind: "continue" }

export type MemberReference = {
  target: SafeObject | Array<unknown>
  key: string | number
}

export class CodeModeFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
  ) {}
}

export class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

export class ComputedValue {
  constructor(readonly value: unknown) {}
}

export class PromiseNamespace {}

export type PromiseMethodName = "all" | "allSettled" | "race" | "resolve" | "reject"

export class PromiseMethodReference {
  constructor(readonly name: PromiseMethodName) {}
}

// A built-in global namespace (`Object`, `Math`, `JSON`, `Array`, ...); members resolve to a
// GlobalMethodReference, except known constants (e.g. `Math.PI`) which resolve to a value.
export type GlobalNamespaceName = "Object" | "Math" | "JSON" | "Array" | "console" | "Date" | "RegExp" | "Map" | "Set"

export class GlobalNamespace {
  constructor(readonly name: GlobalNamespaceName) {}
}

export class GlobalMethodReference {
  constructor(
    readonly namespace: GlobalNamespaceName | "Number" | "String",
    readonly name: string,
  ) {}
}

export class CoercionFunction {
  constructor(readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat") {}
}

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class ErrorConstructorReference {
  constructor(readonly name: string) {}
}

// Non-enumerable so spread/copyOut preserve the plain `{ name, message }` data shape.
const ErrorBrand: unique symbol = Symbol("codemode.error")

const brandError = (errorValue: SafeObject, name: string): SafeObject => {
  Object.defineProperty(errorValue, ErrorBrand, { value: name })
  return errorValue
}

export const createErrorValue = (name: string, message: string): SafeObject =>
  brandError(Object.assign(Object.create(null) as SafeObject, { name, message }), name)

const errorBrandName = (value: unknown): string | undefined =>
  value !== null && typeof value === "object"
    ? ((value as Record<PropertyKey, unknown>)[ErrorBrand] as string | undefined)
    : undefined



export const arrayMethods = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "includes",
  "join",
  "reduce",
  "reduceRight",
  "flatMap",
  "forEach",
  "sort",
  "toSorted",
  "slice",
  "concat",
  "indexOf",
  "lastIndexOf",
  "at",
  "flat",
  "reverse",
  "toReversed",
  "with",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "copyWithin",
  "keys",
  "values",
  "entries",
])

export const mathConstants = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"])

export const numberMethods = new Set(["toFixed", "toPrecision", "toExponential", "toString"])

export const stringMethods = new Set([
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "split",
  "slice",
  "substring",
  "substr",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "replace",
  "replaceAll",
  "repeat",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "at",
  "concat",
  "toString",
  "match",
  "matchAll",
  "search",
  "localeCompare",
  "normalize",
])

export const numberConstants = new Set(["MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "MAX_VALUE", "MIN_VALUE", "EPSILON"])

export const numberStatics = new Set(["isInteger", "isFinite", "isNaN", "isSafeInteger", "parseInt", "parseFloat"])

export const stringStatics = new Set(["fromCharCode", "fromCodePoint"])

export const consoleMethods = new Set(["log", "info", "debug", "warn", "error", "dir", "table"])

export const promiseStatics = new Set<PromiseMethodName>(["all", "allSettled", "race", "resolve", "reject"])

export const errorConstructors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
])

export const valueConstructors = new Set(["Date", "RegExp", "Map", "Set"])

export const dateMethods = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
])
export const dateStatics = new Set(["now", "parse", "UTC"])

export const regexpMethods = new Set(["test", "exec", "toString"])
// Read-only host regex fields surfaced as plain values.
export const regexpProperties = new Set([
  "source",
  "flags",
  "lastIndex",
  "global",
  "ignoreCase",
  "multiline",
  "sticky",
  "unicode",
  "dotAll",
])

export const mapMethods = new Set(["get", "set", "has", "delete", "clear", "forEach", "keys", "values", "entries"])
export const setMethods = new Set(["add", "has", "delete", "clear", "forEach", "keys", "values", "entries"])

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit")

export const supportedSyntaxMessage =
  "Supported orchestration syntax: tools.* calls (they return promises - resolve them with await), data literals, destructuring, optional chaining, template literals, conditionals, switch, loops (incl. for...of and for...in over object/array/tools keys), arrow functions, spread, try/catch, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods (incl. match/matchAll/replace/split with regular expressions), Date/RegExp/Map/Set, Object/Math/JSON helpers, captured console.log/warn/error/dir/table, and Promise.all/allSettled/race/resolve/reject over arrays mixing promises and plain values for parallel tool calls (promise chaining with .then/.catch is not supported - use await with try/catch)."

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported in CodeMode. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
  )

/** How many eagerly forked tool calls may run at once. Fixed; not a configurable knob. */
export const TOOL_CALL_CONCURRENCY = 8

/** Console formatting recursion ceiling; deeper values render as "...". Fixed; not a knob. */
export const MAX_CONSOLE_DEPTH = 32

export const validateLimit = <Value extends number | undefined>(
  name: keyof ExecutionLimits,
  value: Value,
  minimum: number,
): Value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${String(name)} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

// No limit has a default: absent means no timeout / unlimited calls / no output truncation -
// budgets are host policy, not library policy. A host without its own output bounding should
// pass maxOutputBytes explicitly, or oversized results flood model context.
export const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
})

export class InterpreterRuntimeError extends Error {
  readonly node?: AstNode
  /**
   * The constructor name a program observes when it catches this failure (`caught.name`, and
   * the brand behind `caught instanceof SyntaxError` etc.). "Error" unless the failing
   * operation names a standard type in real JS - e.g. JSON.parse and invalid regex patterns
   * throw SyntaxError, an unknown identifier is a ReferenceError, a bad normalize form is a
   * RangeError.
   */
  errorName: string = "Error"

  constructor(
    message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = "ExecutionFailure",
    readonly suggestions?: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = "InterpreterRuntimeError"

    if (node) {
      this.node = node
    }
  }

  as(errorName: string): this {
    this.errorName = errorName
    return this
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const asNode = (value: unknown, context: string): AstNode => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`)
  }

  return value as AstNode
}

export const getArray = (node: AstNode, key: string): Array<unknown> => {
  const value = node[key]
  if (!Array.isArray(value)) {
    throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node)
  }

  return value
}

export const getString = (node: AstNode, key: string): string => {
  const value = node[key]
  if (typeof value !== "string") {
    throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node)
  }

  return value
}

export const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key]
  if (typeof value !== "boolean") {
    throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node)
  }

  return value
}

export const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  if (value === undefined || value === null) {
    return undefined
  }

  return asNode(value, key)
}

export const getNode = (node: AstNode, key: string): AstNode => {
  const value = node[key]
  return asNode(value, key)
}

export const parseProgram = (code: string): ProgramNode => {
  const transpiled = transpileModule(`async function __codemode__() {\n${code}\n}`, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
    },
  })
  const diagnostic = transpiled.diagnostics?.find((item) => item.category === DiagnosticCategory.Error)

  if (diagnostic) {
    throw new InterpreterRuntimeError(
      `Failed to parse TypeScript: ${flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      undefined,
      "ParseError",
    )
  }

  const bodyStart = transpiled.outputText.indexOf("{") + 1
  const bodyEnd = transpiled.outputText.lastIndexOf("}")
  const executableCode = transpiled.outputText.slice(bodyStart, bodyEnd)
  const parsed = parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as unknown

  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.")
  }

  return parsed as ProgramNode
}

export const formatLocation = (node?: AstNode): string => {
  if (!node || !node.loc) {
    return ""
  }

  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}

export const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

export const publicErrorMessage = (message: string): string =>
  message.replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'`]+/g, "<redacted-path>")

export const normalizeError = (error: unknown): Diagnostic => {
  if (error instanceof InterpreterRuntimeError) {
    return {
      kind: error.kind,
      message: `${error.message}${formatLocation(error.node)}`,
      ...(error.node?.loc ? { location: sourceLocation(error.node) } : {}),
      ...(error.suggestions ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof ToolRuntimeError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.suggestions && error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof ToolError) {
    return { kind: "ToolFailure", message: publicErrorMessage(error.message) }
  }

  if (error instanceof ProgramThrow) {
    const value = error.value
    let message: string
    if (containsRuntimeReference(value)) {
      // A thrown tool/function reference must not leak its internal structure.
      message = "a non-data value"
    } else if (typeof value === "string") {
      message = value
    } else if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { message?: unknown }).message === "string"
    ) {
      message = (value as { message: string }).message
    } else {
      try {
        message = JSON.stringify(copyOut(value)) ?? String(value)
      } catch {
        message = String(value)
      }
    }
    return { kind: "ExecutionFailure", message: `Uncaught: ${message}` }
  }

  if (error instanceof RangeError && /call stack|recursion/i.test(error.message)) {
    return {
      kind: "ExecutionFailure",
      message: "Execution exceeded the maximum nesting depth.",
    }
  }

  if (error instanceof Error) {
    return {
      kind: error.name === "SyntaxError" ? "ParseError" : "ExecutionFailure",
      message: publicErrorMessage(error.message),
    }
  }

  // A non-Error thrown by a host tool (raw string / number / Symbol) still routes through
  // path redaction so filesystem paths can never leak through the catch-all branch.
  return {
    kind: "ExecutionFailure",
    message: publicErrorMessage(String(error)),
  }
}

// Shared by catch bindings, Promise.allSettled rejection reasons, and Promise.race losers.
export const caughtErrorValue = (thrown: unknown): unknown => {
  if (thrown instanceof ProgramThrow) return thrown.value
  if (thrown instanceof InterpreterRuntimeError) return createErrorValue(thrown.errorName, thrown.message)
  const name = thrown instanceof Error && errorConstructors.has(thrown.name) ? thrown.name : "Error"
  return createErrorValue(name, normalizeError(thrown).message)
}

export const boundedData = (value: unknown, label: string): unknown => copyIn(value, label, true)

export const isRuntimeReference = (value: unknown): boolean =>
  value instanceof CodeModeFunction ||
  value instanceof ToolReference ||
  value instanceof IntrinsicReference ||
  value instanceof GlobalNamespace ||
  value instanceof GlobalMethodReference ||
  value instanceof PromiseNamespace ||
  value instanceof PromiseMethodReference ||
  value instanceof SandboxPromise ||
  value instanceof CoercionFunction ||
  value instanceof ErrorConstructorReference ||
  isSandboxValue(value)

export const containsRuntimeReference = (value: unknown, seen = new Set<object>()): boolean => {
  if (isRuntimeReference(value)) return true
  if (value === null || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  const contains = Array.isArray(value)
    ? value.some((item) => containsRuntimeReference(item, seen))
    : Object.values(value).some((item) => containsRuntimeReference(item, seen))
  seen.delete(value)
  return contains
}

// Like containsRuntimeReference, but sandbox value types (Date/RegExp/Map/Set) count as data:
// operators and switch treat them as ordinary object operands (identity equality, ToPrimitive
// coercion) rather than rejecting them as opaque interpreter machinery.
export const containsOpaqueReference = (value: unknown, seen = new Set<object>()): boolean => {
  if (isSandboxValue(value)) return false
  if (isRuntimeReference(value)) return true
  if (value === null || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  const contains = Array.isArray(value)
    ? value.some((item) => containsOpaqueReference(item, seen))
    : Object.values(value).some((item) => containsOpaqueReference(item, seen))
  seen.delete(value)
  return contains
}

// `typeof` never throws in JS; map every interpreter value to its JS-visible category.
// A SandboxPromise falls through to the final `typeof value` and reports "object", exactly
// like a real JS promise.
export const typeofValue = (value: unknown): string => {
  if (
    value instanceof CodeModeFunction ||
    value instanceof CoercionFunction ||
    value instanceof IntrinsicReference ||
    value instanceof GlobalMethodReference ||
    value instanceof PromiseMethodReference ||
    value instanceof PromiseNamespace ||
    value instanceof ErrorConstructorReference
  )
    return "function"
  if (value instanceof ToolReference) return value.path.length > 0 ? "function" : "object"
  if (value instanceof GlobalNamespace) {
    return value.name === "Math" || value.name === "JSON" || value.name === "console" ? "object" : "function"
  }
  return typeof value
}

// `x instanceof C` against the constructors CodeMode knows. Like `typeof`, it observes any
// left-hand value (opaque references included) without coercing it. Error checks use the
// error brand: `instanceof Error` accepts every branded error; a specific error type matches
// its own brand only (as in JS, where TypeError instances are also Error instances).
export const instanceofValue = (lhs: unknown, rhs: unknown, node: AstNode): boolean => {
  if (rhs instanceof ErrorConstructorReference) {
    const brand = errorBrandName(lhs)
    return brand !== undefined && (rhs.name === "Error" || brand === rhs.name)
  }
  if (rhs instanceof GlobalNamespace) {
    switch (rhs.name) {
      case "Date":
        return lhs instanceof SandboxDate
      case "RegExp":
        return lhs instanceof SandboxRegExp
      case "Map":
        return lhs instanceof SandboxMap
      case "Set":
        return lhs instanceof SandboxSet
      case "Array":
        return Array.isArray(lhs)
      case "Object":
        return lhs !== null && (typeof lhs === "object" || typeofValue(lhs) === "function")
    }
  }
  if (rhs instanceof PromiseNamespace) return lhs instanceof SandboxPromise
  // Number/String/Boolean wrap primitives in JS; no boxed values exist in CodeMode, so
  // `x instanceof Number` is always false - exactly what it is for primitives in JS.
  if (rhs instanceof CoercionFunction && (rhs.name === "Number" || rhs.name === "String" || rhs.name === "Boolean")) {
    return false
  }
  throw new InterpreterRuntimeError(
    "The right-hand side of 'instanceof' must be a constructor CodeMode knows: Error (or a specific error type like TypeError), Date, RegExp, Map, Set, Array, Object, or Promise.",
    node,
  )
}

// A regex engine failure message without the engine's own "Invalid regular expression:"
// prefix, so composed diagnostics read as one sentence instead of stuttering the phrase.
export const regexFailureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression:\s*/i, "")

export const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.'

// A string method's pattern argument as a host regex: a sandbox regex passes its own host
// instance through (so `g` lastIndex semantics follow the spec across calls); a string becomes
// a pattern, exactly as String.prototype.match/matchAll/search do (`extraFlags` adds matchAll's
// implicit `g`). Invalid patterns fail as catchable program errors that say what was wrong
// with the pattern and how to fix it.
export const toHostRegex = (arg: unknown, method: string, node: AstNode, extraFlags = ""): RegExp => {
  if (arg instanceof SandboxRegExp) return arg.regex
  if (typeof arg === "string") {
    try {
      return new RegExp(arg, extraFlags)
    } catch (error) {
      throw new InterpreterRuntimeError(
        `String.${method} received the string ${JSON.stringify(arg)}, which is not a valid regular expression pattern (${regexFailureReason(error)}). ${escapeRegexHint}`,
        node,
      ).as("SyntaxError")
    }
  }
  throw new InterpreterRuntimeError(
    `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${arg === null ? "null" : typeof arg}.`,
    node,
  )
}

// A host match result as a sandbox value: a plain array of the full match and captures, with
// `index` and named `groups` attached as own array properties (readable, and dropped at data
// boundaries exactly like JSON.stringify drops them in JS). `input` is omitted - it duplicates
// the whole subject string per match.
export const matchToValue = (match: RegExpMatchArray): Array<unknown> => {
  const result: Array<unknown> = Array.from(match, (group) => group)
  if (match.index !== undefined) (result as Record<string, unknown> & Array<unknown>).index = match.index
  if (match.groups) {
    const groups: SafeObject = Object.create(null) as SafeObject
    for (const [key, group] of Object.entries(match.groups)) {
      if (!isBlockedMember(key)) groups[key] = group
    }
    ;(result as Record<string, unknown> & Array<unknown>).groups = groups
  }
  return result
}

export const invokeStringMethod = (value: string, name: string, args: Array<unknown>, node: AstNode): unknown => {
  const str = (index: number): string => {
    const arg = args[index]
    if (typeof arg !== "string")
      throw new InterpreterRuntimeError(`String.${name} expects argument ${index + 1} to be a string.`, node)
    return arg
  }
  const num = (index: number): number => {
    const arg = args[index]
    if (typeof arg !== "number")
      throw new InterpreterRuntimeError(`String.${name} expects argument ${index + 1} to be a number.`, node)
    return arg
  }
  const optNum = (index: number): number | undefined => (args[index] === undefined ? undefined : num(index))
  const optStr = (index: number): string | undefined => (args[index] === undefined ? undefined : str(index))

  let result: unknown
  switch (name) {
    case "toLowerCase":
      result = value.toLowerCase()
      break
    case "toUpperCase":
      result = value.toUpperCase()
      break
    case "trim":
      result = value.trim()
      break
    // trimLeft/trimRight are the legacy aliases of trimStart/trimEnd, kept because models write them.
    case "trimStart":
    case "trimLeft":
      result = value.trimStart()
      break
    case "trimEnd":
    case "trimRight":
      result = value.trimEnd()
      break
    // Locale/options arguments are ignored: comparison runs with the host default locale, and
    // the common use is a sort comparator where any consistent order works.
    case "localeCompare":
      result = value.localeCompare(str(0))
      break
    case "normalize": {
      const form = optStr(0)
      try {
        result = value.normalize(form)
      } catch {
        throw new InterpreterRuntimeError(
          `String.normalize expects the form "NFC", "NFD", "NFKC", or "NFKD" (got ${JSON.stringify(form)}).`,
          node,
        ).as("RangeError")
      }
      break
    }
    case "split": {
      if (args.length === 0) {
        result = [value]
        break
      }
      if (args[0] instanceof SandboxRegExp) {
        result = value.split((args[0]).regex, optNum(1))
        break
      }
      const requestedLimit = optNum(1)
      result = value.split(str(0), requestedLimit === undefined ? undefined : requestedLimit >>> 0)
      break
    }
    case "slice":
      result = value.slice(optNum(0), optNum(1))
      break
    case "includes":
      result = value.includes(str(0), optNum(1))
      break
    case "startsWith":
      result = value.startsWith(str(0), optNum(1))
      break
    case "endsWith":
      result = value.endsWith(str(0), optNum(1))
      break
    case "indexOf":
      result = value.indexOf(str(0), optNum(1))
      break
    case "lastIndexOf":
      result = value.lastIndexOf(str(0), optNum(1))
      break
    case "replace":
    case "replaceAll": {
      if (args[0] instanceof CodeModeFunction || args[1] instanceof CodeModeFunction) {
        throw new InterpreterRuntimeError(
          `String.${name} does not support function replacers in CodeMode; use match/matchAll and rebuild the string instead.`,
          node,
          "UnsupportedSyntax",
          [supportedSyntaxMessage],
        )
      }
      if (args[0] instanceof SandboxRegExp) {
        const pattern = (args[0]).regex
        const replacement = str(1)
        if (name === "replaceAll" && !pattern.global) {
          throw new InterpreterRuntimeError(
            `String.replaceAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.replace to replace only the first match.`,
            node,
          )
        }
        result = name === "replace" ? value.replace(pattern, replacement) : value.replaceAll(pattern, replacement)
        break
      }
      if (name === "replace") {
        result = value.replace(str(0), str(1))
        break
      }
      result = value.replaceAll(str(0), str(1))
      break
    }
    case "match": {
      const pattern = toHostRegex(args[0], name, node)
      const matched = value.match(pattern)
      if (matched === null) return null
      // A global match is a plain array of matched strings; a non-global match carries
      // index/groups own properties, so bypass the copying data checkpoint to keep them.
      if (pattern.global) return boundedData(matched, "String.match result")
      return matchToValue(matched)
    }
    case "matchAll": {
      const pattern = toHostRegex(args[0], name, node, "g")
      if (!pattern.global) {
        throw new InterpreterRuntimeError(
          `String.matchAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.match for a single match.`,
          node,
        )
      }
      // Materialized as an array (not an iterator); each entry is a match array with
      // index/groups own properties. Match count is bounded by the subject length.
      return Array.from(value.matchAll(pattern), matchToValue)
    }
    case "search": {
      result = value.search(toHostRegex(args[0], name, node))
      break
    }
    case "repeat": {
      const count = num(0)
      if (!Number.isFinite(count) || count < 0)
        throw new InterpreterRuntimeError("String.repeat expects a finite non-negative count.", node)
      result = value.repeat(count)
      break
    }
    case "padStart":
      result = value.padStart(num(0), optStr(1))
      break
    case "padEnd":
      result = value.padEnd(num(0), optStr(1))
      break
    case "charAt":
      result = value.charAt(optNum(0) ?? 0)
      break
    case "at":
      result = value.at(optNum(0) ?? 0)
      break
    case "substring":
      result = value.substring(optNum(0) ?? 0, optNum(1))
      break
    case "substr":
      result = value.substr(optNum(0) ?? 0, optNum(1))
      break
    // JS charCodeAt returns NaN out of range; NaN flows as an ordinary in-sandbox value
    // (normalized to null only at the data boundary - see copyOut), so return it as-is.
    case "charCodeAt":
      result = value.charCodeAt(optNum(0) ?? 0)
      break
    case "codePointAt":
      result = value.codePointAt(optNum(0) ?? 0)
      break
    case "toString":
      result = value
      break
    case "concat": {
      result = value.concat(...args.map((_, index) => str(index)))
      break
    }
    default:
      throw new InterpreterRuntimeError(`String method '${name}' is not available in CodeMode.`, node)
  }
  return boundedData(result, `String.${name} result`)
}

export const invokeNumberMethod = (value: number, name: string, args: Array<unknown>, node: AstNode): unknown => {
  const optNum = (index: number): number | undefined => {
    const arg = args[index]
    if (arg === undefined) return undefined
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`Number.${name} expects a number argument.`, node)
    return arg
  }
  let result: unknown
  switch (name) {
    case "toFixed":
      result = value.toFixed(optNum(0))
      break
    case "toExponential":
      result = value.toExponential(optNum(0))
      break
    case "toPrecision": {
      const digits = optNum(0)
      result = digits === undefined ? value.toString() : value.toPrecision(digits)
      break
    }
    case "toString": {
      const radix = optNum(0)
      if (radix !== undefined && (radix < 2 || radix > 36)) {
        throw new InterpreterRuntimeError("Number.toString radix must be between 2 and 36.", node)
      }
      result = value.toString(radix)
      break
    }
    default:
      throw new InterpreterRuntimeError(`Number method '${name}' is not available in CodeMode.`, node)
  }
  return boundedData(result, `Number.${name} result`)
}

// JavaScript's String(...) without tripping over CodeMode's null-prototype data objects.
export const coerceToString = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  // Sandbox values stringify deterministically: Date as ISO (not the host's locale/timezone
  // toString), RegExp as its literal form, Map/Set with their JS Object.prototype tags.
  if (value instanceof SandboxDate)
    return Number.isFinite(value.time) ? new Date(value.time).toISOString() : "Invalid Date"
  if (value instanceof SandboxRegExp) return `/${value.regex.source}/${value.regex.flags}`
  if (value instanceof SandboxMap) return "[object Map]"
  if (value instanceof SandboxSet) return "[object Set]"
  if (typeof value === "object") {
    return Array.isArray(value)
      ? value.map((item) => (item === null || item === undefined ? "" : coerceToString(item))).join(",")
      : "[object Object]"
  }
  return String(value)
}

/** Compound assignment operators (`x op= y`), each applying the binary operator `op`. */
export const compoundOperators = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>="])

export const coerceToNumber = (value: unknown): number => {
  if (value instanceof SandboxDate) return value.time
  if (isSandboxValue(value)) return Number.NaN
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Number.NaN : Number(value)
}

export const invokeCoercion = (ref: CoercionFunction, args: Array<unknown>, node: AstNode): unknown => {
  // Sandbox values coerce before the data checkpoint (which would JSON-serialize them):
  // Number(date) is its time value, String(date) its ISO form, Boolean(x) is true.
  const raw = args[0]
  if (isSandboxValue(raw)) {
    if (ref.name === "Boolean") return true
    if (ref.name === "Number") return coerceToNumber(raw)
    if (ref.name === "String") return coerceToString(raw)
    if (ref.name === "parseInt") return parseInt(coerceToString(raw))
    return parseFloat(coerceToString(raw))
  }
  const value = boundedData(args[0], `${ref.name} input`)
  if (ref.name === "Number") return coerceToNumber(value)
  if (ref.name === "Boolean") return Boolean(value)
  if (ref.name === "parseInt") {
    const radix = args[1]
    if (radix !== undefined && typeof radix !== "number")
      throw new InterpreterRuntimeError("parseInt expects a numeric radix.", node)
    return parseInt(coerceToString(value), radix)
  }
  if (ref.name === "parseFloat") return parseFloat(coerceToString(value))
  return coerceToString(value)
}

export const invokeObjectMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  const requireObject = (): Record<string, unknown> => {
    const value = boundedData(args[0], `Object.${name} input`)
    // Sandbox values (Date/RegExp/Map/Set) have no own enumerable properties in JS, so the
    // Object.* helpers see them as empty objects - never their interpreter internals.
    if (isSandboxValue(value)) return {}
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new InterpreterRuntimeError(`Object.${name} expects a data object.`, node)
    }
    return value as Record<string, unknown>
  }
  const guardedSet = (out: Record<string, unknown>, key: string, item: unknown): void => {
    if (isBlockedMember(key)) throw new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node)
    out[key] = item
  }
  switch (name) {
    case "keys": {
      // Object.keys(array) yields index strings (["0", "1", ...]) exactly as in JS; objects
      // yield their own enumerable keys. (Tool references never reach here - the interpreter
      // resolves them against the host tool tree first.)
      const value = boundedData(args[0], "Object.keys input")
      if (isSandboxValue(value)) return []
      if (Array.isArray(value)) return Object.keys(value)
      if (value === null || typeof value !== "object") {
        throw new InterpreterRuntimeError("Object.keys expects a data object or array.", node)
      }
      return Object.keys(value)
    }
    case "values":
      return Object.values(requireObject())
    case "entries":
      return Object.entries(requireObject()).map(([key, item]) => [key, item])
    case "hasOwn":
      return Object.hasOwn(requireObject(), String(args[1]))
    case "assign": {
      const out: Record<string, unknown> = Object.create(null)
      for (const source of args) {
        if (source === null || source === undefined) continue
        const value = boundedData(source, "Object.assign input")
        // A sandbox value source contributes nothing (no own enumerable properties in JS).
        if (isSandboxValue(value)) continue
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw new InterpreterRuntimeError("Object.assign expects data objects.", node)
        for (const [key, item] of Object.entries(value)) guardedSet(out, key, item)
      }
      return out
    }
    case "fromEntries": {
      // A Map is the idiomatic fromEntries source; use its entries directly (the data
      // checkpoint would serialize a Map to {}).
      if (args[0] instanceof SandboxMap) {
        const out: Record<string, unknown> = Object.create(null)
        for (const [key, item] of (args[0]).map.entries()) guardedSet(out, coerceToString(key), item)
        return out
      }
      const pairs = boundedData(args[0], "Object.fromEntries input")
      if (!Array.isArray(pairs))
        throw new InterpreterRuntimeError("Object.fromEntries expects an array of [key, value] pairs.", node)
      const out: Record<string, unknown> = Object.create(null)
      for (const pair of pairs) {
        if (!Array.isArray(pair))
          throw new InterpreterRuntimeError("Object.fromEntries expects [key, value] pairs.", node)
        guardedSet(out, String(pair[0]), pair[1])
      }
      return out
    }
    default:
      throw new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node)
  }
}

export const invokeMathMethod = (name: string, args: Array<unknown>, node: AstNode): number => {
  const nums = args.map((arg) => {
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node)
    return arg
  })
  const [a = Number.NaN, b = Number.NaN] = nums
  switch (name) {
    case "max":
      return Math.max(...nums)
    case "min":
      return Math.min(...nums)
    case "abs":
      return Math.abs(a)
    case "floor":
      return Math.floor(a)
    case "ceil":
      return Math.ceil(a)
    case "round":
      return Math.round(a)
    case "trunc":
      return Math.trunc(a)
    case "sign":
      return Math.sign(a)
    case "sqrt":
      return Math.sqrt(a)
    case "cbrt":
      return Math.cbrt(a)
    case "pow":
      return Math.pow(a, b)
    case "hypot":
      return Math.hypot(...nums)
    case "log":
      return Math.log(a)
    case "log2":
      return Math.log2(a)
    case "log10":
      return Math.log10(a)
    case "exp":
      return Math.exp(a)
    default:
      throw new InterpreterRuntimeError(`Math.${name} is not available in CodeMode.`, node)
  }
}

export const invokeJsonMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    case "stringify": {
      const replacer = args[1]
      if (Array.isArray(replacer) || replacer instanceof CodeModeFunction) {
        throw new InterpreterRuntimeError(
          "JSON.stringify replacers are not supported in CodeMode.",
          node,
          "UnsupportedSyntax",
          [supportedSyntaxMessage],
        )
      }
      const space = args[2]
      const indent = typeof space === "number" || typeof space === "string" ? space : undefined
      // copyIn first so only Data Values serialize, never a CodeModeFunction/ToolReference.
      return JSON.stringify(copyOut(copyIn(args[0], "JSON.stringify value")), null, indent)
    }
    case "parse": {
      const text = args[0]
      if (typeof text !== "string") throw new InterpreterRuntimeError("JSON.parse expects a string.", node)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        // The engine reason is derived from the program-supplied string (token/position), so
        // it is safe to surface - and the position is exactly what a model needs to fix it.
        throw new InterpreterRuntimeError(
          `JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          node,
        ).as("SyntaxError")
      }
      return copyIn(parsed, "JSON.parse result")
    }
    default:
      throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node)
  }
}

export const invokeArrayStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    case "isArray":
      return Array.isArray(args[0])
    case "of":
      return [...args]
    case "from": {
      if (args.length > 1) {
        throw new InterpreterRuntimeError(
          "Array.from(...) does not support a map function in CodeMode; call .map() on the result instead.",
          node,
          "UnsupportedSyntax",
          [supportedSyntaxMessage],
        )
      }
      // Map/Set materialize directly (the data checkpoint would serialize them to {}).
      if (args[0] instanceof SandboxMap)
        return Array.from((args[0]).map.entries(), ([key, item]) => [key, item])
      if (args[0] instanceof SandboxSet) return Array.from((args[0]).set.values())
      const source = boundedData(args[0], "Array.from input")
      if (typeof source === "string") return Array.from(source)
      if (Array.isArray(source)) return [...source]
      if (
        source !== null &&
        typeof source === "object" &&
        typeof (source as { length?: unknown }).length === "number"
      ) {
        return Array.from(source as ArrayLike<unknown>)
      }
      throw new InterpreterRuntimeError("Array.from expects an array, string, Map, Set, or array-like value.", node)
    }
    default:
      throw new InterpreterRuntimeError(`Array.${name} is not available in CodeMode.`, node)
  }
}

export const invokeNumberStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  const value = args[0]
  switch (name) {
    case "isInteger":
      return Number.isInteger(value)
    case "isFinite":
      return Number.isFinite(value)
    case "isNaN":
      return Number.isNaN(value)
    case "isSafeInteger":
      return Number.isSafeInteger(value)
    case "parseInt": {
      const radix = args[1]
      if (radix !== undefined && typeof radix !== "number")
        throw new InterpreterRuntimeError("Number.parseInt expects a numeric radix.", node)
      return parseInt(coerceToString(value), radix)
    }
    case "parseFloat":
      return parseFloat(coerceToString(value))
    default:
      throw new InterpreterRuntimeError(`Number.${name} is not available in CodeMode.`, node)
  }
}

export const invokeStringStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  const codes = args.map((arg) => {
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`String.${name} expects number arguments.`, node)
    return arg
  })
  switch (name) {
    case "fromCharCode":
      return String.fromCharCode(...codes)
    case "fromCodePoint":
      return String.fromCodePoint(...codes)
    default:
      throw new InterpreterRuntimeError(`String.${name} is not available in CodeMode.`, node)
  }
}

export const invokeDateStatic = (name: string, args: Array<unknown>, node: AstNode): number => {
  switch (name) {
    case "now":
      return Date.now()
    case "parse":
      return Date.parse(coerceToString(args[0]))
    case "UTC": {
      const parts = args.map((arg) => coerceToNumber(arg))
      return Date.UTC(...(parts as Parameters<typeof Date.UTC>))
    }
    default:
      throw new InterpreterRuntimeError(`Date.${name} is not available in CodeMode.`, node)
  }
}

export const invokeDateMethod = (value: SandboxDate, name: string, node: AstNode): unknown => {
  const hosted = new Date(value.time)
  switch (name) {
    case "getTime":
    case "valueOf":
      return value.time
    case "toISOString": {
      if (!Number.isFinite(value.time)) throw new InterpreterRuntimeError("Invalid time value.", node)
      return hosted.toISOString()
    }
    // toJSON of an invalid date is null in JS (never a throw); toString stays ISO for
    // determinism across host timezones/locales.
    case "toJSON":
      return Number.isFinite(value.time) ? hosted.toISOString() : null
    case "toString":
      return coerceToString(value)
    case "getFullYear":
      return hosted.getFullYear()
    case "getMonth":
      return hosted.getMonth()
    case "getDate":
      return hosted.getDate()
    case "getDay":
      return hosted.getDay()
    case "getHours":
      return hosted.getHours()
    case "getMinutes":
      return hosted.getMinutes()
    case "getSeconds":
      return hosted.getSeconds()
    case "getMilliseconds":
      return hosted.getMilliseconds()
    case "getUTCFullYear":
      return hosted.getUTCFullYear()
    case "getUTCMonth":
      return hosted.getUTCMonth()
    case "getUTCDate":
      return hosted.getUTCDate()
    case "getUTCDay":
      return hosted.getUTCDay()
    case "getUTCHours":
      return hosted.getUTCHours()
    case "getUTCMinutes":
      return hosted.getUTCMinutes()
    case "getUTCSeconds":
      return hosted.getUTCSeconds()
    case "getUTCMilliseconds":
      return hosted.getUTCMilliseconds()
    case "getTimezoneOffset":
      return hosted.getTimezoneOffset()
    default:
      throw new InterpreterRuntimeError(`Date method '${name}' is not available in CodeMode.`, node)
  }
}

export const invokeRegExpMethod = (value: SandboxRegExp, name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    // test/exec run on the sandbox regex's own host instance, so `g`-flag lastIndex advances
    // across calls per the spec.
    case "test":
      return value.regex.test(coerceToString(args[0]))
    case "exec": {
      const matched = value.regex.exec(coerceToString(args[0]))
      if (matched === null) return null
      return matchToValue(matched)
    }
    case "toString":
      return coerceToString(value)
    default:
      throw new InterpreterRuntimeError(`RegExp method '${name}' is not available in CodeMode.`, node)
  }
}

export const invokeGlobalMethod = (ref: GlobalMethodReference, args: Array<unknown>, node: AstNode): unknown => {
  if (ref.namespace === "console")
    throw new InterpreterRuntimeError(`console.${ref.name} is not available in CodeMode.`, node)
  if (ref.namespace === "Object") return invokeObjectMethod(ref.name, args, node)
  if (ref.namespace === "Math") return invokeMathMethod(ref.name, args, node)
  if (ref.namespace === "Array") return invokeArrayStatic(ref.name, args, node)
  if (ref.namespace === "Number") return invokeNumberStatic(ref.name, args, node)
  if (ref.namespace === "String") return invokeStringStatic(ref.name, args, node)
  if (ref.namespace === "Date") {
    if (!dateStatics.has(ref.name))
      throw new InterpreterRuntimeError(`Date.${ref.name} is not available in CodeMode.`, node)
    return invokeDateStatic(ref.name, args, node)
  }
  if (ref.namespace === "RegExp" || ref.namespace === "Map" || ref.namespace === "Set") {
    throw new InterpreterRuntimeError(`${ref.namespace}.${ref.name} is not available in CodeMode.`, node)
  }
  return invokeJsonMethod(ref.name, args, node)
}

// Iterable spread sources: arrays, strings (code points), Maps (entry pairs), and Sets (values).
export const spreadItems = (spread: unknown): Array<unknown> | undefined => {
  if (Array.isArray(spread)) return spread
  if (typeof spread === "string") return Array.from(spread)
  if (spread instanceof SandboxMap)
    return Array.from(spread.map.entries(), ([key, item]): Array<unknown> => [key, item])
  if (spread instanceof SandboxSet) return Array.from(spread.set.values())
  return undefined
}

// Every identifier a parameter pattern binds, used to seed TDZ slots before defaults run.
export const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<string> => {
  switch (pattern.type) {
    case "Identifier":
      out.push(getString(pattern, "name"))
      break
    case "AssignmentPattern":
      collectPatternNames(getNode(pattern, "left"), out)
      break
    case "RestElement":
      collectPatternNames(getNode(pattern, "argument"), out)
      break
    case "ArrayPattern":
      for (const element of getArray(pattern, "elements")) {
        if (element !== null) collectPatternNames(asNode(element, "elements"), out)
      }
      break
    case "ObjectPattern":
      for (const property of getArray(pattern, "properties")) {
        const prop = asNode(property, "properties")
        collectPatternNames(prop.type === "RestElement" ? getNode(prop, "argument") : getNode(prop, "value"), out)
      }
      break
  }
  return out
}

