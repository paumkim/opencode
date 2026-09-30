export * as SessionSecrets from "./secrets"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable, MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID, SessionID } from "./schema"
import { NotFoundError } from "@/storage/storage"

// ---------------------------------------------------------------------------
// Detection
//
// Every shape here is one a real agent produces: `cat .env` puts an assignment
// in a tool result, a user pastes a key into a prompt, a curl command with the
// key inline lands in a bash tool's input. A transcript is persistent and is
// re-sent to the provider on every later turn, so a secret in one is a secret
// handed to a third party, and the record outlives the session.
//
// Precision is the whole design. A scanner that cries wolf on commit shas and
// version strings gets switched off after the first run, and a scanner nobody
// runs catches nothing, so the generic rule is deliberately narrow and the
// fixed-shape rules below it are what actually fire on real leaks.
// ---------------------------------------------------------------------------

export type Kind =
  | "private-key"
  | "aws-access-key"
  | "anthropic-key"
  | "openai-key"
  | "github-token"
  | "slack-token"
  | "google-api-key"
  | "jwt"
  | "url-credentials"
  | "assigned-secret"

export const KINDS: readonly Kind[] = [
  "private-key",
  "aws-access-key",
  "anthropic-key",
  "openai-key",
  "github-token",
  "slack-token",
  "google-api-key",
  "jwt",
  "url-credentials",
  "assigned-secret",
]

export const Detection = Schema.Struct({
  kind: Schema.Literals(KINDS),
  /** Character offset in the scanned text. */
  start: Schema.Finite,
  /** One past the last character of the secret. Never includes it. */
  end: Schema.Finite,
  /** What the line was doing: `API_KEY`, a tool name, a command. No content. */
  subject: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionSecretDetection" })
export type Detection = Schema.Schema.Type<typeof Detection>

type Rule = { readonly kind: Kind; readonly pattern: RegExp }

const RULES: readonly Rule[] = [
  { kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Ordered before the OpenAI rule so a provider prefix is not read as a plain
  // `sk-` key and reported under the wrong vendor.
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]{1,64}:[^/\s:@]{1,128}@/g },
]

/**
 * `NAME=value` and `name: value` where NAME says the value is a secret. The
 * two spellings are separate because they occur in different files: the first
 * is what an `env` dump looks like, the second is what a config file or a
 * `printenv` transcript looks like.
 */
const ENV_ASSIGNMENT =
  /([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|PRIVATE_KEY))[ \t]*=[ \t]*("?)([^\s"'\n]{8,})/g
const NAMED_ASSIGNMENT =
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token)[ \t]*[:=][ \t]*("?)([^\s"'\n,;]{8,})/gi

/**
 * Values that look like secrets and are not. A rule that fires on these turns
 * the whole scan into noise, so they are excluded before anything is reported.
 */
const PLACEHOLDER =
  /^(?:x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,}|<[^>]*>|\$\{[^}]*\}|%[a-z_]+%|\{\{?[^}]*\}?\}|(?:your|my|the|some|another)[-_ ][a-z0-9_-]+|change[-_]?me|replace[-_]?me|example|sample|dummy|placeholder|redacted|secret|password|passwd|token|apikey|api[_-]?key|none|null|nil|undefined|todo|tbd|fixme|foobar|foo|bar|baz|abc123|12345678|0123456789|deadbeef|cafebabe|test|testing|dev|local|xxx+)$/i

/**
 * Values that are only structure: a path, a source file, a port, a hex string.
 *
 * A rule that excluded lowercase-with-dashes would look reasonable and be
 * wrong, because that is exactly what a passphrase looks like - so it is not
 * here. What is here is shape, not vocabulary.
 */
const NOT_A_SECRET =
  /^(?:[.~]|\/|[a-z]:[\\/])|(?:\.(?:js|mjs|cjs|ts|tsx|json|jsonc|yaml|yml|toml|ini|conf|md|txt|lock|env|py|go|rs|java|rb|sh|html|css|sql)(?:\b|$))|(?:\/(?:src|lib|dist|build|node_modules|test|tests|docs|vendor|target)\/)|(?:^\d{1,5}(?:\.\d{1,5}){0,3}$)|(?:^[0-9a-fA-F]{16,}$)|(?:#[0-9a-fA-F]{3,8}$)/

/**
 * A reference to something else rather than a value: `result.secret`,
 * `auth.key`, `process.env.OPENAI_API_KEY`. These are what a generic
 * `name = value` rule matches most often, because an agent reading source
 * produces far more of them than it produces leaked credentials, and a report
 * full of them is a report nobody reads.
 */
/**
 * A dotted path: `local.goal-mode.server`, `anthropic.messages.create`. A
 * constant whose name ends in `_KEY` is often assigned one of these, and
 * reading a constant's value out of a file is indistinguishable here from
 * reading a key. A credential containing dots is already covered by the
 * fixed-shape rules above.
 */
const DOTTED_PATH = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/

const REFERENCE = /^(?:[A-Za-z_$][\w$]*)(?:(?:\.|->)[A-Za-z_$][\w$]*)+$/

/**
 * Whether a literal is shaped like a credential rather than like a word.
 *
 * Real leaks overwhelmingly contain both letters and digits, and a value with
 * neither is a phrase - a passphrase, a test fixture, a constant name - so a
 * digitless value has to be long before it counts. This is what keeps
 * `apiKey: "fixture-openai-key"` out of a report while leaving
 * `STRIPE_KEY=sk_live_4eC39Hq…` in it.
 */
function looksOpaque(value: string): boolean {
  if (value.length < 12) return false
  if (REFERENCE.test(value)) return false
  if (DOTTED_PATH.test(value)) return false
  const hasLetter = /[A-Za-z]/.test(value)
  const hasDigit = /\d/.test(value)
  if (!hasLetter && !hasDigit) return false
  if (hasLetter && hasDigit) return true
  // No digits: only a long value earns the right to be called opaque.
  return value.length >= 20
}

function isNoise(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true
  if (NOT_A_SECRET.test(value)) return true
  if (!looksOpaque(value)) return true
  // A single repeated character is a redaction someone already did, not a key.
  if (new Set(value).size <= 2) return true
  return false
}

/**
 * The name in front of a value, when there is one: the `API_KEY` of
 * `API_KEY=...`, so a report can say which setting leaked without saying what
 * its value was. A `://` or `@` inside the match means the name would be part of
 * a URL, which is a worse label than none.
 */
function subjectAt(text: string, start: number, matched: string): string | undefined {
  if (matched.includes("://") || matched.includes("@")) return undefined
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  const before = text.slice(lineStart, start)
  const name = before.match(/([A-Za-z0-9_.-]{3,})[ \t]*[:=]?[ \t]*$/)
  return name?.[1]
}

function collect(text: string, rule: Rule): Detection[] {
  const found: Detection[] = []
  rule.pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = rule.pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      rule.pattern.lastIndex += 1
      continue
    }
    const subject = subjectAt(text, match.index, match[0])
    found.push({
      kind: rule.kind,
      start: match.index,
      end: match.index + match[0].length,
      ...(subject ? { subject } : {}),
    })
  }
  return found
}

/**
 * Every credential-shaped string in `text`, ordered and non-overlapping. The
 * fixed-shape rules are gathered first and the generic assignment rule is
 * skipped where it would re-report the same characters, so one key is one
 * finding rather than two.
 */
export function detect(text: string): Detection[] {
  if (!text) return []
  const found = RULES.flatMap((rule) => collect(text, rule))

  for (const pattern of [ENV_ASSIGNMENT, NAMED_ASSIGNMENT]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      // The two spellings group differently - the env form has a name before the
      // value, the named form does not - so the value is the last group of
      // whichever rule matched rather than a fixed index.
      const value = match[match.length - 1]
      if (!value) continue
      // The env form names the variable; the named form already carries the name
      // in the text, and `match[1]` there is the opening quote.
      // What comes before the value, with the separator and any opening quote
      // trimmed, so the report can name the setting without naming its value.
      const before = match[0].slice(0, match[0].indexOf(value)).replace(/[^A-Za-z0-9_.-]+$/, "")
      const name = pattern === ENV_ASSIGNMENT ? match[1] : before || undefined
      const start = match.index + match[0].indexOf(value)
      if (isNoise(value)) continue
      // Already reported by a fixed-shape rule, which names the vendor better.
      if (found.some((item) => start < item.end && item.start < start + value.length)) continue
      found.push({ kind: "assigned-secret", start, end: start + value.length, subject: name })
    }
  }

  return found.sort((a, b) => a.start - b.start || a.end - b.end)
}

export const marker = (kind: Kind) => `[redacted:${kind}]`

/**
 * The text with every detected secret replaced. The replacement carries the
 * kind and nothing else - not a prefix, not a suffix, not a length - so a
 * redacted transcript is safe to paste into a bug report, which is the only
 * reason anyone redacts one.
 */
export function redact(text: string, findings: readonly Detection[] = detect(text)): string {
  if (findings.length === 0) return text
  const characters = [...text]
  let result = ""
  let at = 0
  for (const finding of findings) {
    const from = [...text.slice(0, finding.start)].length
    const to = [...text.slice(0, finding.end)].length
    if (from < at) continue
    result += characters.slice(at, from).join("")
    result += marker(finding.kind)
    at = to
  }
  return result + characters.slice(at).join("")
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** A detection, plus enough to find it again in the conversation. */
export interface Finding {
  readonly kind: Kind
  /** The setting it came from, when there was one. Never any part of the value. */
  readonly subject?: string
  /** `text`, or the tool that produced the output with `tool-output`/`tool-input`. */
  readonly source: string
  readonly role: string
  readonly partID: PartID
  readonly messageID: MessageID
}

export const Report = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  findings: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(KINDS),
      subject: Schema.optional(Schema.String),
      source: Schema.String,
      role: Schema.String,
      partID: PartID,
      messageID: MessageID,
    }),
  ),
  /** The transcript with every finding replaced. Present only when asked for. */
  redacted: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionSecretsReport" })
export type Report = Schema.Schema.Type<typeof Report>

export interface Interface {
  readonly scan: (input: {
    sessionID: SessionID
    /** Produce the redacted transcript alongside the findings. */
    redacted?: boolean
  }) => Effect.Effect<Report, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSecrets") {}

const role = sql<string>`json_extract(${MessageTable.data}, '$.role')`
const partType = sql<string>`json_extract(${PartTable.data}, '$.type')`
const body = sql<string>`json_extract(${PartTable.data}, '$.text')`
const toolName = sql<string>`json_extract(${PartTable.data}, '$.tool')`
const toolOutput = sql<string>`json_extract(${PartTable.data}, '$.state.output')`
const toolInput = sql<string>`json_extract(${PartTable.data}, '$.state.input')`

/** Only the part kinds that can hold a secret. */
const partFilter = sql`(${partType} = 'text' or ${partType} = 'tool')`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const scan: Interface["scan"] = Effect.fn("SessionSecrets.scan")(function* (input) {
      const session = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })

      const rows = yield* db
        .select({
          partID: PartTable.id,
          messageID: PartTable.message_id,
          role,
          partType,
          body,
          toolName,
          toolOutput,
          toolInput,
        })
        .from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(and(eq(PartTable.session_id, input.sessionID), partFilter))
        .orderBy(asc(MessageTable.time_created), asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)

      const findings: Finding[] = []
      const texts: { part: { partID: PartID; messageID: MessageID; role: string; source: string }; text: string }[] = []

      for (const row of rows) {
        const where = {
          partID: row.partID,
          messageID: row.messageID,
          role: row.role ?? "user",
          source: row.partType === "tool" ? (row.toolName ?? "tool") : "text",
        }
        // A tool's own output and the arguments it was called with are separate
        // strings in the same part, and a secret in either one is in the
        // transcript: `cat .env` puts it in the output, a curl with the key
        // inline puts it in the input.
        const candidates: [string, string | null][] = [
          ["text", row.body],
          ["tool-output", row.toolOutput],
          ["tool-input", row.toolInput],
        ]
        for (const [source, text] of candidates) {
          if (!text) continue
          const at = { ...where, source: source === "text" ? where.source : `${where.source} ${source}` }
          texts.push({ part: at, text })
          for (const finding of detect(text)) {
            findings.push({
              kind: finding.kind,
              ...(finding.subject ? { subject: finding.subject } : {}),
              source: at.source,
              role: at.role,
              partID: at.partID,
              messageID: at.messageID,
            })
          }
        }
      }

      return {
        sessionID: session.id,
        title: session.title,
        findings,
        ...(input.redacted
          ? { redacted: texts.map((item) => `[${item.part.source}] ${redact(item.text)}`).join("\n\n") }
          : {}),
      }
    })

    return Service.of({ scan })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
