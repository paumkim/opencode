# opencode database guide

## HARD RULE: Never Exhaust System Memory

**Running the full `bun test` suite has crashed this machine by consuming all available RAM. It is forbidden.**

- **NEVER run the full test suite.** Not `bun test`, not `bun test test/`, not `bun run test`, not `bun run bench:test`, not `bun run script/bench-test-suite.ts`, and nothing else that fans out across the whole `test/` tree. This applies to the orchestrator AND to every subagent.
- **Always scope to specific files:** `bun test test/tool/edit.test.ts`, or one narrow directory. Grep for the relevant paths first, then run only those.
- **Never raise concurrency.** No `--concurrent`, and do not raise Bun's default worker count. A memory spike means run FEWER tests, not more.
- **Cap memory with a cgroup, never `ulimit -v`:** `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 -- bun test <specific-file>`. `ulimit -v` is actively harmful under Bun — it caps *address space*, and Bun reserves ~74GB of it while using ~65MB RSS, so a `ulimit -v` below that kills the process outright (`ulimit -v 4194304` crashed `bun run typecheck`; the same command uncapped passes).
- **Watch RSS** during stress/soak runs and abort past ~6GB. Prefer short targeted runs over one huge run.
- **State this rule in every subagent prompt** that involves tests. A subagent told to "run the tests" will otherwise run the whole suite and exhaust RAM.
- If a task seems to need the full suite, STOP and ask the user first. Default answer is no.

### Heavy tooling in this package

- **`tsgo --noEmit` peaks at ~1.95 GB RSS per package.** Never run the root `bun typecheck` (which is `bun turbo typecheck` across ~33 packages in parallel) uncapped:
  `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 -- bun turbo typecheck --concurrency=2`
  Verified 33/33 pass in ~17s.
- When you only touched this package, prefer `bun run typecheck` from `packages/opencode` — one `tsgo` at ~2GB beats a parallel fan-out.
- **Use the local prettier, not `bunx`:** `node ../../node_modules/prettier/bin/prettier.cjs --write <files>`. `bunx` re-resolves the package and spawns extra processes for no reason.
- Prefer `prettier --check` over `--write` on pre-existing files; several are not prettier-clean (e.g. `src/session/processor.ts`) and `--write` will bury your change under ~230 lines of unrelated reformatting.

## Database

- **Schema**: opencode storage entrypoint is `src/storage/schema.ts`, which re-exports Drizzle tables from `@opencode-ai/core` (`packages/core/src/**/*.sql.ts`, e.g. `src/database/schema.sql.ts`).
- **Migrations**: database migrations live in `packages/core` and are applied by core.

## Development server

- Running `bun dev` (shorthand for `bun run ./src/index.ts`, see the `dev` script in `package.json`) from `packages/opencode` starts the live interactive TUI. Do not run it as a blocking foreground command when you need to inspect the result.
- Use the `ghostty_terminal` tool instead of `tmux`: `create` a named terminal running `bun dev`, then `write` input and `screen` to inspect the TUI viewport.
- Prefer `ghostty_terminal create/write/screen` over `tmux send-keys` / `tmux capture-pane` polling: it is the default fast path for interactive, TUI, and persistent process work.
- Dispose the named terminal when done.

# Module shape

Do not use `export namespace Foo { ... }` for module organization. It is not
standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript
runner. Use flat top-level exports combined with a self-reexport at the bottom
of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the
same file — they remain inaccessible to consumers (they are not projected by
`export * as`) but are usable by the file's own code.

## When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for
the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

## Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`,
`src/config/`), keep each sibling as its own file with its own self-reexport,
and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to
evaluate every sibling, which defeats tree-shaking and slows module load.

# opencode Effect rules

Use these rules when writing or migrating Effect code.

See `specs/effect/migration.md` for the compact pattern reference and examples.

## Core

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects and `Effect.fnUntraced` for internal helpers.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators as extra arguments, so avoid unnecessary outer `.pipe()` wrappers.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)` when you need a `Date`.

## Module conventions

- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

## Schemas and errors

- Use `Schema.Class` for multi-field data.
- Use branded schemas (`Schema.brand`) for single-value types.
- Use `Schema.TaggedErrorClass` for typed errors.
- Use `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Runtime vs InstanceState

- Use `makeRuntime` (from `src/effect/run-service.ts`) for all services. It returns `{ runSync, runPromiseExit, runPromise, runFork, runCallback }` backed by a shared `memoMap` that deduplicates layers.
- Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory or per-project state that needs per-instance cleanup. It uses `ScopedCache` keyed by directory — each open project gets its own state, automatically cleaned up on disposal.
- If two open directories should not share one copy of the service, it needs `InstanceState`.
- Do the work directly in the `InstanceState.make` closure — `ScopedCache` handles run-once semantics. Don't add fibers, `ensure()` callbacks, or `started` flags on top.
- Use `Effect.addFinalizer` or `Effect.acquireRelease` inside the `InstanceState.make` closure for cleanup (subscriptions, process teardown, etc.).
- Use `Effect.forkScoped` inside the closure for background stream consumers — the fiber is interrupted when the instance is disposed.
- To make a service's `init()` non-blocking, fork `InstanceState.get(state)` at the `init()` call site (e.g. `Effect.forkIn(scope)`), not by forking work inside the `InstanceState.make` closure. Forking inside the closure leaves state incomplete for other methods that read it.
- `src/project/bootstrap.ts` awaits every service `init()` via `Effect.forEach` with unbounded concurrency (each service self-manages slow work via `Effect.forkScoped` against its per-instance state scope), so keep `init()` methods synchronous internally; the caller controls concurrency.

## Effect v4 beta API

- `Effect.fork` and `Effect.forkDaemon` do not exist. Use `Effect.forkIn(scope)` to fork a fiber into a specific scope.

## Preferred Effect services

- In effectified services, prefer yielding existing Effect services over dropping down to ad hoc platform APIs.
- Prefer `FileSystem.FileSystem` instead of raw `fs/promises` for effectful file I/O.
- Prefer `ChildProcessSpawner.ChildProcessSpawner` with `ChildProcess.make(...)` instead of custom process wrappers.
- Prefer `HttpClient.HttpClient` instead of raw `fetch`.
- Prefer `Path.Path`, `Config`, `Clock`, and `DateTime` when those concerns are already inside Effect code.
- For background loops or scheduled tasks, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.

## Effect.cached for deduplication

Use `Effect.cached` when multiple concurrent callers should share a single in-flight computation rather than storing `Fiber | undefined` or `Promise | undefined` manually. See `specs/effect/migration.md` for the full pattern.

## Callback boundaries

Use `EffectBridge` for native or external callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, plugin callbacks, etc.) that need to re-enter Effect services with instance/workspace context.

Plain async code should pass explicit context or stay inside an Effect fiber; do not add ambient instance context shims.

## Tool call failures

If tool calls fail repeatedly: stop and verify the call actually has arguments — empty/missing arguments (not content size) are the likely cause. Do not keep retrying; diagnose first.
