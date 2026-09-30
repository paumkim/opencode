import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { Session as SessionNs } from "@/session/session"
import { SessionSecrets } from "../../src/session/secrets"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, SessionSecrets.node, SessionProjector.node])))

// Synthetic credentials. Nothing here is a real key, and the shapes are the
// ones that matter: a scanner is only worth running if it fires on these.
const ANTHROPIC = "sk-ant-api03-" + "A".repeat(95)
const OPENAI = "sk-" + "b".repeat(48)
const GITHUB = "ghp_" + "c".repeat(36)
const AWS = "AKIA" + "D".repeat(16)
const STRIPE = "sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc"
const SLACK = "xoxb-1234567890-abcdefghijkl"
const GOOGLE = "AIza" + "E".repeat(35)
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." +
  "doXjF8X4K9m2Lpz7Qr5vT1wYc6bN3aS0dFgHj"

describe("sessionSecrets.detect", () => {
  test("names a provider key by its vendor rather than by its prefix", () => {
    const found = SessionSecrets.detect(`here it is: ${ANTHROPIC}`)
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe("anthropic-key")
  })

  test("finds each fixed shape", () => {
    for (const [value, kind] of [
      [ANTHROPIC, "anthropic-key"],
      [OPENAI, "openai-key"],
      [GITHUB, "github-token"],
      [AWS, "aws-access-key"],
      [SLACK, "slack-token"],
      [GOOGLE, "google-api-key"],
      [JWT, "jwt"],
    ] as const) {
      const found = SessionSecrets.detect(`prefix ${value} suffix`)
      expect(found.map((item) => item.kind)).toEqual([kind])
    }
  })

  test("finds a private key header, which is the part that always survives", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"
    expect(SessionSecrets.detect(pem).map((item) => item.kind)).toEqual(["private-key"])
  })

  test("finds credentials embedded in a URL", () => {
    const found = SessionSecrets.detect("psql postgres://admin:hunter2hunter2@db.internal:5432/app")
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe("url-credentials")
    // The label must not be a fragment of the URL, which would leak part of it.
    expect(found[0].subject).toBeUndefined()
  })

  test("finds an env assignment, which is what `cat .env` produces", () => {
    const found = SessionSecrets.detect("DATABASE_URL=postgres://localhost\nSTRIPE_SECRET_KEY=" + STRIPE)
    expect(found.map((item) => [item.kind, item.subject])).toEqual([["assigned-secret", "STRIPE_SECRET_KEY"]])
  })

  test("finds a named assignment in either spelling", () => {
    expect(SessionSecrets.detect('api_key = "s3cr3tvalue123"').map((item) => item.subject)).toEqual(["api_key"])
    expect(SessionSecrets.detect("password: correct-horse-battery").map((item) => item.subject)).toEqual(["password"])
  })

  test("reports the offset of the secret, not of the line", () => {
    const found = SessionSecrets.detect("noise\nAPI_KEY=abcdefgh12345678\n")
    expect(found[0].start).toBe("noise\nAPI_KEY=".length)
    expect(found[0].end).toBe(found[0].start + "abcdefgh12345678".length)
  })

  test("reports one finding for one key, not one per rule", () => {
    // `sk-ant-` also matches the plain `sk-` shape, and a double report would
    // make the count meaningless.
    expect(SessionSecrets.detect(ANTHROPIC)).toHaveLength(1)
  })

  test("does not re-report an assignment whose value a fixed rule already named", () => {
    expect(SessionSecrets.detect(`GITHUB_TOKEN=${GITHUB}`)).toHaveLength(1)
  })

  test("orders findings by position", () => {
    const found = SessionSecrets.detect(`first ${AWS} then ${GITHUB}`)
    expect(found.map((item) => item.kind)).toEqual(["aws-access-key", "github-token"])
    expect(found[0].start).toBeLessThan(found[1].start)
  })

  test("finds several in one dump, as an env file or a log would hold", () => {
    const dump = [
      "NODE_ENV=production",
      `ANTHROPIC_API_KEY=${ANTHROPIC}`,
      "PORT=3000",
      `GITHUB_TOKEN=${GITHUB}`,
      "DEBUG=false",
    ].join("\n")
    expect(SessionSecrets.detect(dump)).toHaveLength(2)
  })

  test("says nothing about empty text", () => {
    expect(SessionSecrets.detect("")).toEqual([])
  })
})

describe("sessionSecrets.detect precision", () => {
  // Every line here is something a real repository contains. A scanner that
  // flags these is switched off after one run and catches nothing ever again.
  const benign: [string, string][] = [
    ["a placeholder key", "API_KEY=your-api-key-here"],
    ["an env reference", "API_KEY=${STRIPE_KEY}"],
    ["a changeme", "SECRET=changeme"],
    ["an example value", "password: example"],
    ["a redaction already done", "token=xxxxxxxxxxxxxxxx"],
    ["a file path", "SECRET_KEY=./config/secrets.local.yaml"],
    ["a source file", "API_KEY=src/lib/keys.ts"],
    ["a port", "DATABASE_PASSWORD=5432"],
    ["a git sha", "commit 0123456789abcdef0123456789abcdef01234567"],
    ["a uuid", "id 123e4567-e89b-12d3-a456-426614174000"],
    ["a package name", "npm install @anthropic-ai/sdk"],
    ["a version", "version = 1.2.3"],
    ["prose about a key", "the api key is stored in the vault and rotated monthly"],
    ["a variable reference", "const apiKey = process.env.API_KEY"],
    ["an md5-shaped hash of a file", "checksum: d41d8cd98f00b204e9800998ecf8427e"],
    ["a colour", "color: #ff8800"],
  ]

  for (const [what, line] of benign) {
    test(`does not flag ${what}`, () => {
      expect(SessionSecrets.detect(line)).toEqual([])
    })
  }

  // The generic rule judges the VALUE, not the name. Every line below is a
  // secret-named variable in a real codebase, and every one of them is a
  // reference to something else or a phrase, not a credential.
  test("does not flag a short word on a secret-named variable", () => {
    expect(SessionSecrets.detect("TOKEN=notsecret")).toEqual([])
  })

  test("does not flag a reference to a field as a secret", () => {
    for (const line of [
      "const apiKey = auth.key",
      "set: { secret: result.secret }",
      "apiKey: process.env.OPENAI_API_KEY",
      "x-apiKey: context.credentials.token",
    ]) {
      expect(SessionSecrets.detect(line)).toEqual([])
    }
  })

  test("does not flag a test fixture or a constant name", () => {
    for (const line of [
      'apiKey: "fixture-openai-key"',
      'export const GOAL_METADATA_KEY = "goal-metadata"',
      // A constant whose name ends in KEY, assigned a dotted config path. This
      // is what reading a real source file produces, and it is indistinguishable
      // from a leak without judging the value rather than the name.
      'export const CONFIG_KEY = "local.goal-mode.server"',
    ]) {
      expect(SessionSecrets.detect(line)).toEqual([])
    }
  })

  test("does not flag a sk- that is too short to be a key", () => {
    expect(SessionSecrets.detect("sk-shortvalue")).toEqual([])
  })

  test("does not flag a path that merely contains the word secret", () => {
    expect(SessionSecrets.detect("open src/secrets/manager.ts")).toEqual([])
  })
})

describe("sessionSecrets.redact", () => {
  test("removes the secret and leaves the sentence readable", () => {
    const line = `ANTHROPIC_API_KEY=${ANTHROPIC}\nPORT=3000`
    // The vendor rule names the key better than the generic assignment rule
    // would, so the marker is the vendor's and the assignment is not reported
    // a second time.
    const redacted = SessionSecrets.redact(line)
    expect(redacted).toBe("ANTHROPIC_API_KEY=[redacted:anthropic-key]\nPORT=3000")
  })

  test("keeps no part of the secret, which is the only reason to redact at all", () => {
    const redacted = SessionSecrets.redact(`here is ${AWS} and here is ${GITHUB}`)
    for (const secret of [AWS, GITHUB]) {
      expect(redacted).not.toContain(secret)
      // Not a prefix, not a suffix, not the length. Four characters is the
      // threshold: a one- or two-character fragment is a letter, and the
      // replacement marker contains plenty of those.
      for (let i = 4; i < secret.length; i++) {
        expect(redacted.includes(secret.slice(0, i))).toBe(false)
        expect(redacted.includes(secret.slice(-i))).toBe(false)
      }
    }
  })

  test("is idempotent, so redacting twice is the same as once", () => {
    const once = SessionSecrets.redact(`KEY=${OPENAI}`)
    expect(SessionSecrets.redact(once)).toBe(once)
  })

  test("leaves text with nothing in it alone", () => {
    expect(SessionSecrets.redact("nothing to see")).toBe("nothing to see")
  })

  test("redacts several findings across a document", () => {
    const text = `a ${AWS} b ${GITHUB} c`
    const redacted = SessionSecrets.redact(text)
    expect(redacted).toContain("[redacted:aws-access-key]")
    expect(redacted).toContain("[redacted:github-token]")
    expect(redacted).not.toContain(AWS)
    expect(redacted).not.toContain(GITHUB)
  })

  test("keeps a multi-line document intact around the redaction", () => {
    const text = ["before", `key=${OPENAI}`, "after"].join("\n")
    expect(SessionSecrets.redact(text)).toBe(["before", "key=[redacted:openai-key]", "after"].join("\n"))
  })

  test("does not break on a secret that contains astral characters around it", () => {
    const text = `👍 ${AWS} 👍`
    const redacted = SessionSecrets.redact(text)
    expect(redacted).toBe("👍 [redacted:aws-access-key] 👍")
    expect(Buffer.from(redacted, "utf8").toString("utf8")).toBe(redacted)
  })

  test("accepts findings that were computed elsewhere, so one pass serves both", () => {
    const text = `KEY=${OPENAI}`
    expect(SessionSecrets.redact(text, SessionSecrets.detect(text))).toBe("KEY=[redacted:openai-key]")
  })
})

// ---------------------------------------------------------------------------
// The scan over a real conversation
// ---------------------------------------------------------------------------

/** A message with one text part, the shape a prompt or an answer takes. */
const say = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("test") },
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    } as unknown as SessionV1.TextPart)
    return id
  })

/** A tool part, which is where `cat .env` and an inline curl header land. */
const ran = (sessionID: SessionID, tool: string, input: unknown, output: string) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("test") },
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "tool",
      callID: "call_" + id,
      tool,
      state: {
        status: "completed",
        input: input as Record<string, unknown>,
        output,
        title: tool,
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    } as unknown as SessionV1.ToolPart)
    return id
  })

describe("sessionSecrets.scan", () => {
  it.instance(
    "finds a secret a tool printed, and names the tool it came from",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "leaky" })
        yield* ran(created.id, "bash", { command: "cat .env" }, `STRIPE_KEY=${STRIPE}`)

        const report = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id }))
        expect(report.title).toBe("leaky")
        expect(report.findings).toHaveLength(1)
        expect(report.findings[0]).toMatchObject({
          kind: "assigned-secret",
          subject: "STRIPE_KEY",
          source: "bash tool-output",
        })
      }),
    { git: true },
  )

  it.instance(
    "finds a secret in the arguments a tool was called with",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "inline" })
        yield* ran(created.id, "bash", { command: `curl -H "authorization: ${AWS}" https://api.example.com` }, "ok")

        const report = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id }))
        expect(report.findings).toHaveLength(1)
        expect(report.findings[0].source).toBe("bash tool-input")
      }),
    { git: true },
  )

  it.instance(
    "finds a secret the user pasted into a prompt",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "pasted" })
        yield* say(created.id, `it says here: ${GITHUB} — is that right?`)

        const report = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id }))
        expect(report.findings).toHaveLength(1)
        expect(report.findings[0]).toMatchObject({ kind: "github-token", source: "text", role: "user" })
      }),
    { git: true },
  )

  it.instance(
    "says nothing about a conversation with no credentials in it",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "clean" })
        yield* say(created.id, "please refactor the parser and run the tests")
        yield* ran(created.id, "grep", { pattern: "TODO" }, "src/a.ts:12: // TODO: revisit")

        const report = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id }))
        expect(report.findings).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "produces a redacted transcript that no longer contains the secret",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({ title: "redact me" })
        yield* say(created.id, `the key is ${AWS}`)
        yield* ran(created.id, "bash", { command: "cat .env" }, `STRIPE_KEY=${STRIPE}`)

        const plain = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id }))
        expect(plain.redacted).toBeUndefined()

        const redacted = yield* SessionSecrets.Service.use((svc) => svc.scan({ sessionID: created.id, redacted: true }))
        expect(redacted.redacted).toContain("[redacted:aws-access-key]")
        expect(redacted.redacted).toContain("[redacted:assigned-secret]")
        expect(redacted.redacted).not.toContain(AWS)
        expect(redacted.redacted).not.toContain(STRIPE)
        // The surrounding conversation is still there, which is the point.
        expect(redacted.redacted).toContain("the key is")
      }),
    { git: true },
  )

  it.instance(
    "fails for a session that does not exist rather than reporting it clean",
    () =>
      Effect.gen(function* () {
        const exit = yield* SessionSecrets.Service.use((svc) =>
          svc.scan({ sessionID: SessionID.make("ses_missing_secrets") }),
        ).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    { git: true },
  )
})
