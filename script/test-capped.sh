#!/usr/bin/env bash
# Runs a command under a hard cgroup memory cap.
#
# The sibling term repo froze this machine the same way: an agent ran a wide test run straight
# through `bun test`, nothing enforced the cap, and the box ran out of memory hard enough to lose
# the session and kill every crew window with it. Its wrapper says the conclusion plainly - "prose
# does not survive an unattended agent" - and this tree had no equivalent at all, so the only thing
# standing between a crew window and a frozen machine was a sentence in a bootstrap prompt. That
# sentence is not a guard. This file is.
#
# `ulimit -v` is deliberately NOT used: it caps address space rather than resident memory, and
# Bun reserves tens of GB of address space while using a fraction of that in RSS, so a low
# `ulimit -v` kills the process outright instead of throttling it. A cgroup bounds RSS directly
# and terminates cleanly at the cap.
#
# This is a second line of defence, not the first. `script/crew.sh` caps the whole window, so a
# runaway run is stopped even if it never comes through here. This exists for work started by hand,
# and it is the piece that survives when nobody is watching.
#
# Override with OPENCODE_TEST_MEMORY_MAX (e.g. "10G") when a single legitimate job needs more.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: test-capped.sh <command> [args...]" >&2
  exit 2
fi

MEMORY_MAX="${OPENCODE_TEST_MEMORY_MAX:-6G}"

if ! command -v systemd-run >/dev/null 2>&1; then
  echo "[test-capped] systemd-run not found; running UNCAPPED ($*)" >&2
  exec "$@"
fi

# `--scope` needs a running user systemd session. Probe it cheaply rather than letting the real
# run fail with a confusing cgroup error.
if ! systemd-run --user --scope --quiet true >/dev/null 2>&1; then
  echo "[test-capped] no user systemd session; running UNCAPPED ($*)" >&2
  echo "[test-capped] this can exhaust machine memory - prefer: systemd-run --user --scope -p MemoryMax=$MEMORY_MAX -p MemorySwapMax=0 -- $*" >&2
  exec "$@"
fi

exec systemd-run --user --scope -p "MemoryMax=$MEMORY_MAX" -p MemorySwapMax=0 -- "$@"
