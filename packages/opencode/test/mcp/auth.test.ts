import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { McpAuth } from "../../src/mcp/auth"

function authFile() {
  let raw: string | undefined
  let activeWrites = 0
  let sawOverlap = false

  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return FSUtil.Service.of({
        ...fs,
        readJson: (file) => {
          if (!file.endsWith("mcp-auth.json")) return fs.readJson(file)
          const content = raw
          return content === undefined
            ? Effect.fail(
                new PlatformError(
                  new SystemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: file,
                  }),
                ),
              )
            : Effect.try({
                try: () => JSON.parse(content),
                catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
              })
        },
        writeJson: (file, value, mode) =>
          file.endsWith("mcp-auth.json")
            ? Effect.promise(async () => {
                activeWrites++
                sawOverlap = sawOverlap || activeWrites > 1
                raw = ""
                await sleep(10)
                const next = JSON.stringify(value, null, 2)
                raw = sawOverlap ? `${next}\n}` : next
                activeWrites--
              })
            : fs.writeJson(file, value, mode),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))

  const readRaw = (): string => {
    if (raw === undefined) throw new Error("mcp-auth.json missing")
    return raw
  }

  return { fsLayer, raw: readRaw, setRaw: (value: string) => (raw = value) }
}

function authService(fsLayer: Layer.Layer<FSUtil.Service>) {
  return McpAuth.Service.use((auth) => Effect.succeed(auth)).pipe(
    Effect.provide(AppNodeBuilder.build(McpAuth.node, [[FSUtil.node, fsLayer]])),
  )
}

test("returns an empty store when the auth file is missing", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.fsLayer)
      expect(yield* auth.all()).toEqual({})
    }),
  )
})

test("rejects malformed auth data without overwriting the file", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.fsLayer)
      const original = '{ "broken": true'
      file.setRaw(original)

      const result = yield* Effect.exit(auth.all())

      expect(result._tag).toBe("Failure")
      expect(file.raw()).toBe(original)
    }),
  )
})

test("serializes concurrent auth file updates across service instances", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* authService(file.fsLayer)
      const second = yield* authService(file.fsLayer)

      yield* Effect.all(
        [
          first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
          second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
        ],
        { concurrency: "unbounded" },
      )

      const entry = yield* first.get("posthog")
      expect(entry?.tokens?.accessToken).toBe("access-token")
      expect(entry?.clientInfo?.clientId).toBe("client-id")
      expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
      expect(() => JSON.parse(file.raw())).not.toThrow()
    }),
  )
})
