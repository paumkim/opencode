import { expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { InstanceRef } from "@/effect/instance-ref"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { GhosttyTerminalTool, Parameters } from "@/tool/ghostty-terminal"
import { Tool } from "@/tool/tool"
import { TerminalSessions } from "@opencode-ai/ghostty-terminal/sessions"
import { MessageID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TestConfig } from "../fixture/config"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Truncate.node, Config.node, Plugin.node, Session.node, SessionProjector.node, Permission.node, CrossSpawnSpawner.node]), [
  [Config.node, TestConfig.layer({ get: () => Effect.succeed({ shell: "/bin/sh" }) })],
  [Plugin.node, Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) })],
]))

const context = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Terminal test" })
  const ctx: Tool.Context = {
    sessionID: session.id, messageID: MessageID.ascending(), agent: "build",
    abort: new AbortController().signal, messages: [], metadata: () => Effect.void, ask: () => Effect.void,
  }
  return ctx
})

const sideEffects = Effect.gen(function* () {
  const { TerminalSessions } = yield* Effect.promise(() => import("@opencode-ai/ghostty-terminal/sessions"))
  const create = spyOn(TerminalSessions.prototype, "create").mockImplementation(() => {
    throw new Error("benign create spy")
  })
  const write = spyOn(TerminalSessions.prototype, "write").mockImplementation(() => {})
  yield* Effect.addFinalizer(() => Effect.sync(() => { create.mockRestore(); write.mockRestore() }))
  return { create, write }
})

function failure(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
}

const init = Effect.gen(function* () {
  const info = yield* GhosttyTerminalTool
  return yield* Tool.init(info)
})

it.instance("real shell persistence, plain/HTML readScreen, resize and dispose through wrapped tool", () => Effect.gen(function* () {
  const tool = yield* init
  const ctx = yield* context
  const asks: string[] = []
  ctx.ask = (req) => Effect.sync(() => { asks.push(req.permission) })
  const dir = (yield* TestInstance).directory
  expect(tool.id).toBe("ghostty_terminal")
  expect(tool.description).toContain("readScreen")
  yield* tool.execute({ action: "create", name: "shell", cols: 80, rows: 24 }, ctx)
  yield* tool.execute({ action: "write", name: "shell", data: "stty -echo; printf '\\033[2J\\033[H'; printf 'CWD:%s\\n' \"$PWD\"; printf 'HELLO_%s\\n' WORLD\r" }, ctx)
  yield* pollWithTimeout(Effect.gen(function* () {
    const result = yield* tool.execute({ action: "screen", name: "shell" }, ctx)
    return result.output.includes("HELLO_WORLD") ? result.output : undefined
  }).pipe(Effect.map((screen) => {
    if (screen) expect(screen).toContain(`CWD:${dir}`)
    return screen
  })), "shell output not visible")
  expect((yield* tool.execute({ action: "screen", name: "shell", format: "html" }, ctx)).output).toContain("HELLO_WORLD")
  yield* tool.execute({ action: "resize", name: "shell", cols: 60, rows: 12 }, ctx)
  yield* tool.execute({ action: "write", name: "shell", data: "stty size\r" }, ctx)
  yield* pollWithTimeout(Effect.gen(function* () {
    const result = yield* tool.execute({ action: "screen", name: "shell" }, ctx)
    return result.output.includes("12 60") ? true : undefined
  }), "stty did not resize")
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toContain('"cols":60')
  expect(asks.filter((x) => x === "bash")).toHaveLength(3)
  yield* tool.execute({ action: "dispose" }, ctx)
  yield* tool.execute({ action: "dispose", name: "shell" }, ctx)
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toBe("[]")
}))

it.instance("concurrent creation is atomic, names are isolated by conversation and agent", () => Effect.gen(function* () {
  const tool = yield* init
  const ctx = yield* context
  const creates = yield* Effect.all([
    tool.execute({ action: "create", name: "same" }, ctx).pipe(Effect.exit),
    tool.execute({ action: "create", name: "same" }, ctx).pipe(Effect.exit),
  ], { concurrency: "unbounded" })
  expect(creates.filter(Exit.isSuccess)).toHaveLength(1)
  expect(creates.filter(Exit.isFailure)).toHaveLength(1)
  for (const other of [yield* context, { ...ctx, agent: "general" }]) {
    expect((yield* tool.execute({ action: "list" }, other)).output).toBe("[]")
    expect(Exit.isFailure(yield* tool.execute({ action: "screen", name: "same" }, other).pipe(Effect.exit))).toBe(true)
    yield* tool.execute({ action: "create", name: "same" }, other)
    yield* tool.execute({ action: "dispose" }, other)
  }
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toContain('"name":"same"')
  yield* tool.execute({ action: "dispose" }, ctx)
}))

it.instance("permissions and abort prevent spawning/input, external workdir asks before spawn", () => Effect.gen(function* () {
  const tool = yield* init
  const ctx = yield* context
  const denied: Tool.Context = { ...ctx, ask: () => Effect.die(new Error("denied")) }
  expect(Exit.isFailure(yield* tool.execute({ action: "create", name: "denied" }, denied).pipe(Effect.exit))).toBe(true)
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toBe("[]")
  const permissions: string[] = []
  const external: Tool.Context = { ...ctx, ask: (req) => Effect.sync(() => {
    permissions.push(req.permission)
    if (req.permission === "external_directory") throw new Error("external denied")
    if (req.permission === "bash") expect(req.patterns).toEqual(["*"])
  }) }
  expect(Exit.isFailure(yield* tool.execute({ action: "create", name: "external", workdir: "/" }, external).pipe(Effect.exit))).toBe(true)
  expect(permissions).toEqual(["ghostty_terminal", "bash", "external_directory"])
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toBe("[]")
  const abort = new AbortController()
  abort.abort()
  expect(Exit.isFailure(yield* tool.execute({ action: "create", name: "abort" }, { ...ctx, abort: abort.signal }).pipe(Effect.exit))).toBe(true)
  yield* tool.execute({ action: "create", name: "live" }, ctx)
  expect(Exit.isFailure(yield* tool.execute({ action: "write", name: "live", data: "exit\r" }, denied).pipe(Effect.exit))).toBe(true)
  yield* tool.execute({ action: "dispose" }, ctx)
}))

it.instance("runtime scope closes owned terminals and removes exit listener", () => Effect.gen(function* () {
  const listeners = process.listenerCount("exit")
  let pid = 0
  yield* Effect.scoped(Effect.gen(function* () {
    const tool = yield* init
    const ctx = yield* context
    yield* tool.execute({ action: "create", name: "scope" }, ctx)
    const result = yield* tool.execute({ action: "list" }, ctx)
    const items = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ pid: Schema.Number })))(JSON.parse(result.output))
    pid = items[0]?.pid ?? 0
    expect(pid).toBeGreaterThan(0)
    expect(yield* InstanceState.directory).toBe((yield* TestInstance).directory)
  }))
  expect(process.listenerCount("exit")).toBe(listeners)
  yield* pollWithTimeout(Effect.sync(() => {
    try { process.kill(pid, 0) } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
      throw error
    }
  }), "scope leaked shell process")
}))

it.instance("restrictive agent and session Bash rules reject create/write before side effects", () => Effect.gen(function* () {
  const spies = yield* sideEffects
  const tool = yield* init
  const ctx = yield* context
  const sessions = yield* Session.Service
  const createSpy = spyOn(TerminalSessions.prototype, "create").mockImplementation(() => {})
  const writeSpy = spyOn(TerminalSessions.prototype, "write").mockImplementation(() => {})
  yield* Effect.addFinalizer(() => Effect.sync(() => { createSpy.mockRestore(); writeSpy.mockRestore() }))
  // Test with bash deny: tool should fail before creating a terminal.
  yield* sessions.setPermission({ sessionID: ctx.sessionID, permission: Permission.fromConfig({ bash: "deny" }) })
  ctx.ask = (req) => Effect.gen(function* () {
    if (req.permission === "bash") {
      return yield* new PermissionV1.DeniedError({
        ruleset: [{ permission: "bash", action: "deny", pattern: "*" }],
      })
    }
    return
  })
  for (const action of ["create", "write"] as const) {
    expect(Exit.isFailure(yield* tool.execute({ action, name: "denied", data: "text" }, ctx).pipe(Effect.exit))).toBe(true)
  }
  expect(createSpy).not.toHaveBeenCalled()
  expect(writeSpy).not.toHaveBeenCalled()
  // Test with bash ask: tool should fail before creating a terminal.
  yield* sessions.setPermission({ sessionID: ctx.sessionID, permission: Permission.fromConfig({ bash: "ask" }) })
  ctx.ask = (req) => Effect.gen(function* () {
    if (req.permission === "bash") {
      return yield* new PermissionV1.RejectedError()
    }
    return
  })
  for (const action of ["create", "write"] as const) {
    expect(Exit.isFailure(yield* tool.execute({ action, name: "rejected", data: "text" }, ctx).pipe(Effect.exit))).toBe(true)
  }
  expect(createSpy).not.toHaveBeenCalled()
  expect(writeSpy).not.toHaveBeenCalled()
}))

it.instance("unrestricted and unrelated rules retain both permission gates; denials stop side effects", () => Effect.gen(function* () {
  const spies = yield* sideEffects
  const tool = yield* init
  const ctx = yield* context
  const sessions = yield* Session.Service
  yield* sessions.setPermission({ sessionID: ctx.sessionID, permission: Permission.fromConfig({
    bash: { "*": "allow", "benign-one *": "allow" }, read: { "benign-file": "deny" },
  }) })
  const asks: string[] = []
  ctx.ask = (req) => Effect.sync(() => { asks.push(req.permission) })
  expect(failure(yield* tool.execute({ action: "create", name: "allowed" }, ctx).pipe(Effect.exit))).toContain("benign create spy")
  expect(asks).toEqual(["ghostty_terminal", "bash"])
  expect(spies.create).toHaveBeenCalledTimes(1)
  spies.create.mockClear()
  for (const denied of ["ghostty_terminal", "bash"]) {
    ctx.ask = (req) => Effect.sync(() => { if (req.permission === denied) throw new Error(`${denied} denied`) })
    for (const action of ["create", "write"] as const) {
      expect(failure(yield* tool.execute({ action, name: "allowed", data: "benign text" }, ctx).pipe(Effect.exit))).toContain(`${denied} denied`)
    }
  }
  expect(spies.create).not.toHaveBeenCalled()
  expect(spies.write).not.toHaveBeenCalled()
}))

it.instance("real permission API broad ask waits for explicit reply; denied rules reject before side effects", () => Effect.gen(function* () {
  const spies = yield* sideEffects
  const tool = yield* init
  const ctx = yield* context
  const sessions = yield* Session.Service
  // Track pending permissions for this test.
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  yield* sessions.setPermission({ sessionID: ctx.sessionID, permission: Permission.fromConfig({ bash: "ask" }) })
  ctx.ask = (req) => Effect.gen(function* () {
    if (req.permission === "bash") {
      return yield* Effect.promise(() => new Promise((resolve, reject) => {
        pending.set(req.id ?? "unknown", { resolve, reject })
      }))
    }
    return
  })
  const fiber = yield* tool.execute({ action: "create", name: "ask" }, ctx).pipe(Effect.exit, Effect.forkChild)
  const requestId = yield* pollWithTimeout(Effect.sync(() => {
    for (const id of pending.keys()) return id
    return undefined
  }), "Bash approval not requested")
  const pendingRequest = pending.get(requestId)
  expect(pendingRequest).toBeDefined()
  pendingRequest?.resolve()
  expect(failure(yield* Fiber.join(fiber))).toContain("benign create spy")
  spies.create.mockClear()
  // A denied rule should reject before side effects.
  yield* sessions.setPermission({ sessionID: ctx.sessionID, permission: Permission.fromConfig({ bash: "deny" }) })
  ctx.ask = (req) => Effect.gen(function* () {
    if (req.permission === "bash") {
      return yield* Effect.fail(new Error("denied"))
    }
    return
  })
  expect(failure(yield* tool.execute({ action: "create", name: "restricted" }, ctx).pipe(Effect.exit))).toContain("denied")
  expect(spies.create).not.toHaveBeenCalled()
}))

it.instance("physical cwd and project roots enforce external permission for benign symlinks", () => Effect.gen(function* () {
  const spies = yield* sideEffects
  const tool = yield* init
  const ctx = yield* context
  const ins = yield* InstanceState.context
  const outside = yield* tmpdirScoped()
  const link = path.join(ins.directory, "outside-link")
  const inside = path.join(ins.directory, "inside")
  yield* Effect.promise(async () => {
    await fs.mkdir(inside)
    await fs.symlink(outside, link)
    await fs.symlink(inside, path.join(ins.directory, "inside-link"))
    await fs.symlink(ins.directory, path.join(outside, "project-link"))
  })
  const asks: Parameters<Tool.Context["ask"]>[0][] = []
  ctx.ask = (req) => Effect.sync(() => {
    asks.push(req)
    if (req.permission === "external_directory") throw new Error("external denied")
  })
  for (const workdir of [link, outside]) {
    asks.length = 0
    expect(failure(yield* tool.execute({ action: "create", name: "external", workdir }, ctx).pipe(Effect.exit))).toContain("external denied")
    expect(asks.map((req) => req.permission)).toEqual(["ghostty_terminal", "bash", "external_directory"])
    expect(asks[2]?.metadata).toEqual({ filepath: outside, parentDir: outside })
    expect(asks[2]?.patterns).toEqual([path.join(outside, "*")])
  }
  expect(spies.create).not.toHaveBeenCalled()
  for (const workdir of [inside, path.join(ins.directory, "inside-link")]) {
    asks.length = 0
    expect(failure(yield* tool.execute({ action: "create", name: "internal", workdir }, ctx).pipe(Effect.exit))).toContain("benign create spy")
    expect(asks.map((req) => req.permission)).toEqual(["ghostty_terminal", "bash"])
    expect(spies.create.mock.calls.at(-1)?.[1].cwd).toBe(inside)
  }
  asks.length = 0
  const alias = { ...ins, directory: path.join(outside, "project-link"), worktree: path.join(outside, "project-link") }
  expect(failure(yield* tool.execute({ action: "create", name: "alias", workdir: inside }, ctx).pipe(Effect.provideService(InstanceRef, alias), Effect.exit))).toContain("benign create spy")
  expect(asks.map((req) => req.permission)).toEqual(["ghostty_terminal", "bash"])
  asks.length = 0
  expect(failure(yield* tool.execute({ action: "create", name: "alias-external", workdir: link }, ctx).pipe(Effect.provideService(InstanceRef, alias), Effect.exit))).toContain("external denied")
  spies.create.mockClear()
  expect(failure(yield* tool.execute({ action: "create", name: "missing", workdir: path.join(ins.directory, "missing") }, ctx).pipe(Effect.exit))).toContain("ENOENT")
  expect(spies.create).not.toHaveBeenCalled()
}))

it.instance("abort after permission/config/plugin waits prevents further side effects", () => Effect.gen(function* () {
  const spies = yield* sideEffects
  const outside = yield* tmpdirScoped()
  const base = yield* context
  const config = yield* Config.Service
  const plugin = yield* Plugin.Service
  for (const stage of ["ghostty_terminal", "bash", "external_directory", "config", "plugin"]) {
    const abort = new AbortController()
    const asks: string[] = []
    let pluginCalls = 0
    const tool = yield* init.pipe(
      Effect.provideService(Config.Service, Config.Service.of({ ...config, get: () => Effect.sync(() => {
        if (stage === "config") abort.abort()
        return { shell: "/bin/sh" }
      }) })),
      Effect.provideService(Plugin.Service, Plugin.Service.of({ ...plugin, trigger: (_name, _input, output) => Effect.sync(() => {
        pluginCalls++
        if (stage === "plugin") abort.abort()
        return output
      }) })),
    )
    const ctx: Tool.Context = { ...base, abort: abort.signal, ask: (req) => Effect.sync(() => {
      asks.push(req.permission)
      if (stage === req.permission) abort.abort()
    }) }
    expect(failure(yield* tool.execute({ action: "create", name: "abort", workdir: outside }, ctx).pipe(Effect.exit))).toContain("Terminal call aborted")
    expect(pluginCalls).toBe(stage === "plugin" ? 1 : 0)
    if (stage === "ghostty_terminal") expect(asks).toEqual(["ghostty_terminal"])
    if (stage === "bash") expect(asks).toEqual(["ghostty_terminal", "bash"])
  }
  expect(spies.create).not.toHaveBeenCalled()
  expect(spies.write).not.toHaveBeenCalled()
}))

it.instance("invalid action parameters fail before any terminal is created", () => Effect.gen(function* () {
  const tool = yield* init
  const ctx = yield* context
  for (const args of [{ action: "create" }, { action: "write", name: "missing" }, { action: "resize", name: "missing" }] as const) {
    expect(Exit.isFailure(yield* tool.execute(args, ctx).pipe(Effect.exit))).toBe(true)
  }
  expect(() => Schema.decodeUnknownSync(Parameters)({ action: "create", name: "bad/name" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Parameters)({ action: "resize", cols: 999999 })).toThrow()
  expect((yield* tool.execute({ action: "list" }, ctx)).output).toBe("[]")
}))
