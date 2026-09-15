# Typecheck Fixes — Handoff

## Status
Pre-existing failures in `bun typecheck` / `turbo typecheck`.  
Not caused by the `--debug` flag commit (`b14bde00b`).  
Blocking pre-push hook on `dev`.

## Failing packages

### 1. `@opencode-ai/codemode` (2 errors)

**File:** `packages/codemode/src/interpreter-helpers.ts`

| Line | Error | Suggested fix |
|------|-------|---------------|
| 7:66 | `TS2307: Cannot find module './types.js'` | Verify `./types.js` exists and is included in `tsconfig.json` / build. If it is generated, ensure the generator runs before typecheck or add a declaration shim. |
| 293:29 | `TS2731: Implicit conversion of a 'symbol' to a 'string'` | Wrap the symbol expression in `String(...)` or call `.toString()` explicitly. |

### 2. `@opencode-ai/app` (5 errors)

**File:** `packages/app/src/context/global-sync/event-reducer.ts`
- **Line 384:12** — `TS2322: Type 'string' is not assignable to type '"agent" | "compaction" | ... | "tool"'`
  - Fix: Narrow the value to the union before assignment, or cast with `as const` / `satisfies`.

**File:** `packages/app/src/context/server-session.ts`
- **Line 1228:14** — Same `TS2322` as above.
  - Fix: Same narrowing approach.

**File:** `packages/app/src/context/server-session.test.ts`
- **Line 133:20** — `TS18048: 'options' is possibly 'undefined'`
  - Fix: Add a guard `if (!options) return` or provide a default value before use.

**File:** `packages/app/src/pages/layout.tsx`
- **Line 2192:101** — `TS2339: Property 'length' does not exist on type 'Iterable<[string, Provider]>'`
  - Fix: Convert to array first: `Array.from(providers).length` or spread `[...providers].length`.

**File:** `packages/app/src/pages/new-session/new-session-view.tsx`
- **Line 109:24** — Same `TS2339` as above.
  - Fix: Same array conversion.

**File:** `packages/app/src/pages/session/composer/session-composer-controls.ts`
- **Line 48:32** — Same `TS2339` as above.
  - Fix: Same array conversion.

## Notes
- `@opencode-ai/desktop` mirrors the `app` errors because it references `../app/...` paths.
- The `turbo` run itself crashes with `SIGSEGV` after reporting errors; that is a secondary infrastructure issue, not a TS error.
- These are all **type-level** issues; runtime behavior may be unaffected.

## Suggested work order
1. Fix `codemode` first — only 2 errors and likely quick.
2. Fix `app` event-reducer / server-session union narrowing.
3. Fix `app` test undefined guard.
4. Fix `app` pages `Iterable.length` issues.

## Verification
```bash
cd /home/pauk/Projects/opencode
bun typecheck
```
