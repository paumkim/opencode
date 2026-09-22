#!/usr/bin/env bash
# Guard-only preflight for forward-only binary rebuilds. Never builds; exits non-zero on danger.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "GUARD FAIL: $1" >&2; exit 1; }

# 1. Must be on dev branch with locked commit present
BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "dev" ]] || fail "not on dev (got $BRANCH) - checkout dev first"
git rev-parse --verify -q working-tree-locked-2026-09-18 >/dev/null || fail "lock tag missing - working tree not locked in"
git rev-parse --verify -q e37b90cf8 >/dev/null || fail "lock commit e37b90cf8 missing"

# 2. No large artifact dirs tracked (would hang future commits)
git ls-files | grep -E '^models/|system-one-lite/models|ghostty-terminal/zig/ghostty/' && fail "large artifact tracked - check .gitignore" || true

# 3. Console critical files must exist (improvements not reverted)
for f in \
  packages/console/core/src/billing.ts \
  packages/console/core/src/stripe-accounting.ts \
  packages/console/core/src/usage.ts \
  packages/core/src/installation/version.ts \
  packages/core/src/installation/internal-version.ts \
  packages/opencode/script/build.ts ; do
  [[ -f "$f" ]] || fail "missing $f - tree reverted?"
done
grep -q "invoicePaymentError" packages/console/core/src/billing.ts || fail "billing hardening missing (invoicePaymentError)"
grep -q "readPackageVersion" packages/core/src/installation/version.ts || fail "version fallback missing (readPackageVersion)"
grep -q "PINNED_VERSION" packages/core/src/installation/version.ts || fail "version pin missing (PINNED 1.18.32)"
[[ -f packages/tui/src/util/version-stamp.ts ]] || fail "version stamp missing (version-stamp.ts reverted?)"
grep -q "formatVersionStamp" packages/tui/src/util/version-stamp.ts || fail "version stamp logic missing (formatVersionStamp)"
grep -q "formatVersionStamp" packages/tui/src/plugin/adapters.tsx || fail "provider-aware app.version missing (adapters.tsx reverted?)"
[[ -f packages/tui/src/util/provider-versions.ts ]] || fail "provider versions missing (provider-versions.ts reverted?)"
grep -q "ensureProviderVersionsFresh" packages/tui/src/util/provider-versions.ts || fail "daily refresh missing (ensureProviderVersionsFresh)"
grep -q "ensureProviderVersionsFresh" packages/tui/src/app.tsx || fail "boot refresh hook missing (app.tsx reverted?)"
grep -q "isKiloProvider" packages/tui/src/util/version-stamp.ts || fail "kilo support missing (isKiloProvider)"

# 4. Tracked tree must be clean (untracked ghostty/.gitmodules ignored on purpose)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "GUARD WARN: dirty tracked tree - commit with --no-verify or stash before rebuild"
  git status --short --untracked-files=no | head -n 20
  exit 2
fi

# 5. Bundle backup must exist
[[ -f /tmp/opencode-working-tree-locked-2026-09-18.bundle ]] || fail "bundle backup missing in /tmp"

echo "GUARD PASS: tree locked, console improvements present, safe to rebuild with:"
echo "  bun run --cwd packages/opencode script/build.ts -- --single"
echo "Never: git reset --hard, git clean -fdx, fresh clone without bundle restore."
