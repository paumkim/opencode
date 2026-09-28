import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { Global } from "@opencode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

// Generous enough to cover every instruction file reachable from a normal
// worktree, small enough that the cache cannot grow without bound.
const INSTRUCTION_CACHE_LIMIT = 512

// `config.instructions` is merged from the project's own `opencode.json`, so its size is chosen
// by whoever wrote that file, not by the user running opencode. Both halves of that config can
// name an arbitrarily large source, and each contributes verbatim to the system prompt on every
// turn, so both are bounded here. The cache limit above bounds how many are retained, not how
// large any one of them is.
const MAX_INSTRUCTION_BYTES = 256 * 1024
const TRUNCATION_MARKER = "\n\n[opencode: instruction truncated]"

/**
 * Reads one instruction file, serving a previously cached result when there is one.
 *
 * A failed read is deliberately *not* cached. It used to be: every failure was caught into `""` and
 * that empty string was written into the cache, so one permissions error, half-written file or
 * transient IO fault removed that instruction from the agent's context for the rest of the
 * instance. Nothing distinguishes "this project has no such file" from "we could not read it", so
 * the model proceeds as though the project has no rules and says so with confidence. Leaving the
 * failure uncached means the next turn retries, and `onFailure` records why instead of dropping it.
 *
 * A *successful* read of an empty file is cached, because there the empty result is the truth.
 */
export const readInstructionFile = Effect.fnUntraced(function* <E>(
  state: { readonly cache: Map<string, string> },
  filepath: string,
  read: Effect.Effect<string, E>,
  onFailure: (filepath: string, error: E) => Effect.Effect<void>,
) {
  const cached = state.cache.get(filepath)
  if (cached !== undefined) return cached
  const outcome = yield* read.pipe(
    Effect.map((content) => ({ content, failed: false })),
    Effect.catch((error) =>
      onFailure(filepath, error).pipe(Effect.andThen(() => Effect.succeed({ content: "", failed: true }))),
    ),
  )
  if (outcome.failed) return ""
  // Bound the cache. Keys are instruction-file paths discovered by walking
  // up from the working directory, so a long-lived instance that visits many
  // worktrees, temporary directories, or generated paths would otherwise
  // retain a file's full contents for every path it has ever seen. Insertion
  // order makes the oldest key the first eviction candidate, which keeps the
  // hot ancestor-chain entries that every turn re-reads.
  if (state.cache.size >= INSTRUCTION_CACHE_LIMIT) {
    const oldest = state.cache.keys().next()
    if (!oldest.done) state.cache.delete(oldest.value)
  }
  state.cache.set(filepath, outcome.content)
  return outcome.content
})

/**
 * Decode at most `MAX_INSTRUCTION_BYTES`, cutting on a UTF-8 sequence boundary.
 *
 * A byte slice can land inside a multi-byte character, and a non-fatal `TextDecoder` answers that
 * with U+FFFD, so a hard cut would corrupt the last character of every oversized file. Stepping
 * back at most a few bytes is bounded by the longest UTF-8 sequence.
 */
const decodeInstruction = (bytes: Uint8Array, truncated = false) => {
  const limit = Math.min(bytes.byteLength, MAX_INSTRUCTION_BYTES)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let end = limit; end > 0; end--) {
    try {
      const text = decoder.decode(bytes.subarray(0, end))
      // A cut can also land on a multi-byte boundary, so `end < limit` alone under-reports it.
      return truncated || end < bytes.byteLength ? text + TRUNCATION_MARKER : text
    } catch {
      // `end` fell inside a multi-byte sequence.
    }
  }
  return ""
}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // Cache instruction file contents keyed by path.
          cache: new Map<string, string>(),
        }),
      ),
    )

    // A failed walk is indistinguishable from "no instruction file anywhere up the tree" once it
    // resolves to `[]`, and the agent has no way to tell it is running without the project's rules.
    // The turn still proceeds, but the reason is recorded rather than dropped.
    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      const walk = !Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? fs.globUp(instruction, ctx.directory, ctx.worktree)
        : fs.globUp(instruction, global.config, global.config)
      return yield* walk.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to search for instruction file", {
            instruction,
            error: errorMessage(error),
          }).pipe(Effect.andThen(() => Effect.succeed([] as string[]))),
        ),
      )
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      const s = yield* InstanceState.get(state)
      return yield* readInstructionFile(
        s,
        filepath,
        fs.readFile(filepath).pipe(Effect.map((bytes) => decodeInstruction(bytes))),
        (file, error) =>
          Effect.logWarning("failed to read instruction file", { filepath: file, error: errorMessage(error) }),
      )
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      // `res.arrayBuffer` would pull the whole body, so the cap below is on the bytes read and
      // not merely on the text kept: `Stream.takeWhile` ends the subscription as soon as the
      // chunk that crossed the cap has been seen, so an oversized or endless response is not
      // drained into memory just to be thrown away.
      const chunks: Uint8Array[] = []
      let size = 0
      let crossed = false
      yield* res.stream.pipe(
        Stream.map((chunk: Uint8Array) => {
          const room = MAX_INSTRUCTION_BYTES - size
          const piece = chunk.byteLength >= room ? chunk.subarray(0, Math.max(room, 0)) : chunk
          size += piece.byteLength
          if (piece.byteLength < chunk.byteLength) crossed = true
          return piece
        }),
        Stream.takeWhile(() => !crossed),
        Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))),
        Effect.catch(() => Effect.void),
      )
      if (chunks.length === 0) return ""
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const bytes = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
      // `crossed` means the response held more than the cap, so the cut has to be announced even
      // though the buffer handed to the decode is exactly the cap.
      return decodeInstruction(bytes, crossed)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
