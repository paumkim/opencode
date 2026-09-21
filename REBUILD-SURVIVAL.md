# Rebuild Survival — working tree locked 2026-09-18

This tree is locked in commit `e37b90cf8` + tag `working-tree-locked-2026-09-18`.
Bundle backup: `/tmp/opencode-working-tree-locked-2026-09-18.bundle` (321M, HEAD only).
Restore: `git bundle verify /tmp/...bundle && git fetch /tmp/...bundle HEAD:restored-lock`.

## Why rebuilds looked like reverts

1. **90+ files uncommitted** — any `git reset --hard`, `checkout`, `pull`, `clean -fdx` wipes them.
   Fixed by committing 158 files in e37b90cf8.
2. **Dynamic preview version** — `packages/script/src/index.ts` generates `0.0.0-dev-YYYYMMDDHHMM`
   on dev branch, baked as `OPENCODE_VERSION`. Looks like a revert, isn't.
   Improvement kept: `packages/core/src/installation/version.ts:readPackageVersion()` falls back
   to `package.json` (1.18.30) instead of hardcoded `local`.
3. **`git add -A` hangs** — 11G `models/`, 447M ghostty checkout. Fixed via `.gitignore`. Never `add -A` without ignores.
4. **Console confusion** — console is `packages/console/*` (SST/vite), not in opencode binary.
   Rebuilding opencode binary never updates console deploy. Deploy console separately:
   `bun run --cwd packages/console/app build` / `sst deploy`.

## Safe rebuild (forward-only)

```bash
./script/guard-binary-build.sh  # must print GUARD PASS
bun run --cwd packages/opencode script/build.ts -- --single
./packages/opencode/dist/opencode-linux-x64/bin/opencode --version
```

Never: `rm -rf dist` manually (build does it), `git clean -fdx`, fresh clone, `bun install`
at root without `--cwd`, or `submodule update --init` (fetches 447M ghostty).

## Console version pin

- `packages/console/app/package.json`, `core/package.json`: `1.18.30` (keep in sync)
- Billing hardening in `packages/console/core/src/billing.ts:invoicePaymentError`,
  `grantCredit(tx)`, `redeemCoupon(tx)`, `receiptUrl` PII guard.
- Migrations: `20260917121347_stripe_event_idempotency`, `20260917123950_stripe_financial_operations`.
- If console looks reverted after opencode rebuild — expected, they are separate artifacts.

## Left untracked on purpose

- `.gitmodules` + `packages/ghostty-terminal/zig/ghostty/` (447M) — init only when needed
- `models/`, `INTERNAL_VERSION` — local weights/state
