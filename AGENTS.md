## HARD RULE: Never Exhaust System Memory

**Running the full `bun test` suite has crashed this machine by consuming all available RAM. It is forbidden.**

- **NEVER run the full test suite.** Not `bun test`, not `bun test test/`, not `bun run test`, not `bun run bench:test`, not `bun run script/bench-test-suite.ts`, and never anything that fans out across the whole `test/` tree. This applies to the orchestrator AND to every subagent.
- **Always scope test runs to specific files.** Pass explicit paths, e.g. `bun test test/tool/edit.test.ts`, or a narrow directory. If unsure which files are relevant, grep for them first and run only those.
- **Never raise test concurrency.** Do not add `--concurrent`, and do not raise Bun's default worker count. Leave concurrency at its default. A memory spike is the signal to run FEWER tests, not more.
- **Cap memory with a cgroup, never with `ulimit -v`.** Use:
  `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 -- <command>`
  This terminates the process cleanly at the cap. **`ulimit -v` is actively harmful for Bun commands** and must not be used here — see "Bun reserves address space" below. Verified: a 4G cgroup SIGTERMs typecheck cleanly, 6G lets it finish.
- **Watch RSS on long runs.** For stress or soak runs, sample `ps -o rss` periodically and abort if it crosses ~6GB. Prefer short, targeted runs repeated over one huge run.
- **When delegating**, state the memory rule in the task prompt explicitly. A subagent asked to "run the tests" will otherwise run the full suite and exhaust RAM.
- If a task appears to require the full suite, STOP and ask the user for permission first. The default answer is no.

### Bun reserves address space — why `ulimit -v` is the wrong tool

Measured on a live opencode process: `VmSize` 74.5 GB and `VmPeak` 135 GB, while `VmRSS` is only 65 MB. Essentially all of that is `VmData` (73.7 GB) of *reserved* address space — the JavaScriptCore GC arena plus per-thread malloc arenas — that is never committed to physical RAM.

Consequences, all learned the hard way on this machine:

- **`ulimit -v` caps address space, not resident memory.** Setting it below what Bun reserves makes the process die outright rather than throttle. `ulimit -v 4194304` (4G) crashed `bun run typecheck` with a goroutine stack trace; the identical command with no cap passes. It is not a memory cap, it is a way to break Bun.
- **To cap Bun, cap the cgroup** (`MemoryMax`), which bounds RSS regardless of how much address space is reserved.
- **Never judge capacity by VIRT or VmPeak.** Use `VmRSS` / `ps -o rss` only.

### Heavy tooling: typecheck and formatting

- **`tsgo --noEmit` peaks at ~1.95 GB RSS for a single package.** The root `bun typecheck` script is `bun turbo typecheck`, which fans out across ~33 packages **in parallel**. Unbounded that is many gigabytes at once, and it is the most likely way to stall this machine outside of the test suite.
- **Always cap turbo concurrency when typechecking the monorepo:**
  `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 -- bun turbo typecheck --concurrency=2`
  Verified: 33/33 tasks pass in ~17s. Raise the memory cap before raising the concurrency, never the other way round.
- **Prefer per-package typecheck** when you only touched one package: `cd packages/<pkg> && bun run typecheck`. One `tsgo` at ~2GB instead of a parallel fan-out.
- **Never use `bunx` for tooling you already have installed.** `bunx prettier` re-resolves the package, spawning an extra runtime and potentially hitting the network. Call the local binary instead:
  `node node_modules/prettier/bin/prettier.cjs --write <files>` — 0.4s versus seconds, and no extra process.
- **Do not run `prettier --write` on a whole pre-existing file** just to land a small change. Some files are not prettier-clean, so `--write` reformats hundreds of unrelated lines and buries the real diff. Use `--check` to verify, and only `--write` when you accept a whole-file reformat as part of the change.


## Language

- **Default language: US English.** All agents and subagents must communicate in US English (American English spelling, vocabulary, and phrasing) for all user-facing responses, summaries, documentation, and comments.
- When translating or localizing content, default to US English unless the user explicitly requests another variant.

## Silent Execution

Think internally. Execute without narrating. Do not announce what you are about to do, narrate steps, or ask preliminary questions during execution. Only communicate when:
- (a) A result or summary is ready
- (b) You are blocked or stuck
- (c) You need information from the user

During execution, use `+ Thought:` for internal reasoning and proceed directly to commands. No preamble, no rephrasing, no commentary between steps.

## Subagent Delegation Discipline

1. **One subagent at a time** — Never spawn multiple subagents in parallel for a single task. Break work into sequential, small, focused sub-tasks and delegate one at a time.

2. **Break down before delegating** — Before spawning a subagent, decompose the task into the smallest meaningful unit. The delegating agent must know exactly what it needs: the specific question, the exact file:line, the precise change. Do not hand off vague or broad requests.

3. **Subagents decompose too** — If a subagent receives a task that is still too large, it must break it down further and execute the smallest piece itself before delegating the next piece. No subagent should blindly forward a broad task downstream.

4. **Agents must be productive, not just delegators** — The orchestrating agent should do as much of the work as it can directly (analysis, planning, simple edits, reasoning). Only delegate what genuinely requires a subagent's tool surface. Avoid the "useless manager" anti-pattern where everything is handed off and the orchestrator contributes nothing.

5. **Clear task prompts** — Every subagent task prompt must include: (a) the objective in one sentence, (b) the exact steps or scope, (c) the expected output, and (d) how to verify success.

6. **No spam spawning** — If a task can be done in one focused subagent call, do that. Do not fan out into many subagents for what is fundamentally one job.

- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.
