#!/usr/bin/env bash
# crew.sh — launch and supervise goal-driven opencode agent windows.
#
# WHY THIS IS IN THE REPO
#   Running unattended agents used to mean hand-writing a bootstrap prompt per
#   window and launching ghostty by hand. Those prompts went stale the moment the
#   agent committed, and living in /tmp they were lost on reboot — once
#   mid-command. Living here, the launcher moves with the project, is versioned
#   with it, and is reachable from any session as the `/crew` command.
#
# NOTHING IS HARDCODED
#   Projects come from a JSON registry (see resolve_config), so moving a checkout
#   is a one-line config edit, not a code change. No path in this file assumes
#   where anything lives.
#
# USAGE
#   crew.sh doctor              preflight checks, no side effects
#   crew.sh start [N]              launch N windows round-robin over the registry
#   crew.sh start [N] <project>    launch N windows on one project PATH (not a label)
#   crew.sh status              every agent window it can see
#   crew.sh stop [name...]      stop named windows, or all of them
#   crew.sh logs <name> [lines] tail a window's launch log
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# script/ sits one level below the repo root, so a single "..". Two would climb out of the
# project entirely and silently resolve a config that does not exist.
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
STATE="${AGENT_CREW_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-crew}"
OPENCODE_BIN="${CREW_OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
# The source tree, when it is right here. A crew started from a checkout runs the
# same code the operator is editing, which is the whole point of a per-project crew.
DEV_PKG="$REPO_ROOT/packages/opencode"
# The hard memory ceiling for ONE crew window, enforced by a cgroup on the whole window.
#
# This is a guard, not advice. The bootstrap prompt already told every window to cap its test runs,
# and a window ignored it and ran a bare `bun test` that took all 31GB out from under the machine -
# hard enough to lose the session and kill both crew windows with it. The term repo had already
# learned this lesson the same way: its own test-capped.sh carries a comment about the freeze, and
# states the conclusion plainly - "prose does not survive an unattended agent". So the cap is applied
# to the WINDOW rather than to any command in it: whatever the agent runs, including something no
# prompt anticipated, the cgroup stops it at the ceiling instead of the machine running out of memory
# under both crews at once.
#
# 10G leaves room for two windows on a 31GB machine with the desktop and the operator's own work.
# Override per-machine with CREW_MEMORY_MAX.
CREW_MEMORY_MAX="${CREW_MEMORY_MAX:-10G}"

mkdir -p "$STATE/run" "$STATE/logs" "$STATE/prompts"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Resolve the argv that actually starts an agent TUI, once, for every caller.
#
# A compiled opencode can exist, answer `--version`, and still be unable to open a
# window: the single-file build embeds the OpenTUI native library, and a build
# missing it dies at startup with a `/$bunfs/root/libopentui-*.so` loader error
# that `--version` never reaches. So "the file is there" is not a working
# opencode, and doctor reporting one while every window dies is the trap.
#
# Preference order: an explicit override, then the source tree, then the compiled
# binary. The source tree is preferred because it is the thing that is known to
# work and to match the checkout the operator is running.
resolve_opencode() {
  if [ -n "${CREW_OPENCODE_CMD:-}" ]; then
    # shellcheck disable=SC2206 # deliberate word-splitting: this is argv
    OPENCODE_CMD=($CREW_OPENCODE_CMD)
  elif [ -f "$DEV_PKG/src/index.ts" ]; then
    OPENCODE_CMD=(bun run --cwd "$DEV_PKG" --conditions=browser src/index.ts)
  elif [ -x "$OPENCODE_BIN" ]; then
    OPENCODE_CMD=("$OPENCODE_BIN")
  else
    die "no usable opencode: set CREW_OPENCODE_CMD, or have $DEV_PKG/src/index.ts, or $OPENCODE_BIN"
  fi
}

# The single place a window is put on screen.
#
# The display is inherited rather than pinned. Hardcoding DISPLAY/WAYLAND_DISPLAY
# here is what could put a window on a display the operator was not looking at,
# and a window they cannot see is indistinguishable from a crew that never started.
# Every caller goes through here so the env and the argv cannot drift apart again.
#
# `setsid` was here to detach the window from the launching shell, and on this
# desktop it did the opposite of what the comment above warns about: the crew ran
# fine and was invisible. A Wayland compositor presents a window in the session
# that creates it, and `setsid` moves the process into a brand new session with
# no controlling terminal and no activation token, so the window was created
# where nothing could surface it. Verified on KDE Plasma: `setsid nohup ghostty`
# produced a running ghostty process that never appeared, while a plain
# `nohup ghostty` from the same shell appeared immediately. So the window stays
# in the operator's own session - `nohup` and the redirected log still keep the
# launching shell from blocking, and `stop` still works, because it signals the
# pid this function returns.
launch_window() {
  local name="$1" dir="$2" prompt="$3" logf="$4"
  nohup ghostty --title="agent-$name" \
    -e "${WINDOW_CMD[@]}" "$dir" --auto --prompt "$prompt" \
    > "$logf" 2>&1 < /dev/null &
  echo $!
}

# Build the argv that runs INSIDE the window: the agent TUI, wrapped in a cgroup memory cap.
#
# Resolved once, here, so the cap cannot be applied by one caller and skipped by another - the same
# reason launch_window is the single place a window is created.
#
# `--scope` is used rather than a transient unit because it inherits the window's TTY, and a
# transient unit would detach the TUI from its terminal. Two failure modes are handled explicitly
# and LOUDLY, because a guard that silently does not apply is worse than no guard: if systemd-run is
# missing, or there is no user systemd session to put a scope in, the window still starts but the
# operator is told in the same breath that nothing is capping it.
build_window_cmd() {
  local probe
  if ! command -v systemd-run >/dev/null 2>&1; then
    warn "systemd-run not found: crew windows will be UNCAPPED and can exhaust machine memory"
    WINDOW_CMD=("${OPENCODE_CMD[@]}")
    return 0
  fi
  if ! probe="$(systemd-run --user --scope --quiet true 2>&1)"; then
    warn "no user systemd session ($probe): crew windows will be UNCAPPED and can exhaust machine memory"
    WINDOW_CMD=("${OPENCODE_CMD[@]}")
    return 0
  fi
  WINDOW_CMD=(systemd-run --user --scope -p "MemoryMax=$CREW_MEMORY_MAX" -p MemorySwapMax=0 -- "${OPENCODE_CMD[@]}")
}

# Registry, in precedence order. Creates a commented template rather than guessing.
resolve_config() {
  local candidates=()
  [ -n "${CREW_CONFIG:-}" ] && candidates+=("$CREW_CONFIG")
  candidates+=("$REPO_ROOT/crew.json" "$HOME/.config/opencode/crew.json")
  local c
  for c in "${candidates[@]}"; do
    [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  # Nothing configured: leave a template where it is obvious and stop.
  local tpl="$REPO_ROOT/crew.json"
  cat > "$tpl" <<'EOF'
{
  // Each project gets its own windows, and each window is told to stay inside it.
  // Add, remove, or repoint entries freely — nothing else needs editing.
  "projects": [
    { "path": "/absolute/path/to/project", "label": "project" }
  ]
}
EOF
  printf '%s' "$tpl"
}

CONFIG="$(resolve_config)"
command -v jq >/dev/null 2>&1 || die "jq is required to read $CONFIG"

read_projects() {
  # Whole-line `//` comments are allowed, because this file is meant to be edited by hand and the
  # invariants (stay inside your own project, don't guess paths) are worth writing down. Only
  # full-line comments are stripped, so a `//` inside a path or string is left alone.
  sed 's|^[[:space:]]*//.*$||' "$CONFIG" | jq -r '.projects[]? | "\(.path)\t\(.label // (.path | split("/") | last))"' 2>/dev/null
}
label_for() { local want="$1" p l; while IFS=$'\t' read -r p l; do [ "$p" = "$want" ] && { printf '%s' "$l"; return; }; done < <(read_projects); basename "$want"; }

pid_of() { [ -f "$STATE/run/$1.pid" ] && cat "$STATE/run/$1.pid" 2>/dev/null; }

# Every opencode agent window on the machine, whoever started it. `comm` is the
# discriminator: the ghostty wrapper and the shell launcher carry the same argv as
# the real binary, so matching on arguments double-counts every window.
#
# Scoped to CONFIGURED PROJECTS on purpose. The user's own interactive session is
# also an `opencode` process, and a bare `stop` must never reach it.
adopted() {
  local pid cwd comm want
  for pid in $(pgrep -x opencode 2>/dev/null); do
    comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || continue
    [ "$comm" = "opencode" ] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || continue
    while IFS=$'\t' read -r want _; do
      [ "$want" = "$cwd" ] && { printf '%s\t%s\n' "$pid" "$cwd"; break; }
    done < <(read_projects)
  done | sort -u -k1,1
}

# The bootstrap prompt, generated from the repository's REAL state right now.
# It deliberately does NOT enumerate the agent's whole backlog: git log is the
# contract, and the prompt only has to point at it. That is what keeps it from
# going stale the moment the agent commits.
write_prompt() {
  local dir="$1" label="$2" out="$3"
  # A caller-supplied prompt replaces the generated one. A display or smoke test needs a window
  # that does something specific and small, and the rule against hand-writing per-window prompts
  # exists because a hand-written one goes stale against real repo state - which is not a risk for
  # a prompt that only creates a goal and stops. Going through `start` still means the env, the
  # pid file and the startup liveness check are the same ones a real crew uses.
  if [ -n "${CREW_PROMPT_OVERRIDE:-}" ]; then
    printf '%s\n' "$CREW_PROMPT_OVERRIDE" > "$out"
    return 0
  fi
  local branch head recent
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  head="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  recent="$(git -C "$dir" log --oneline -12 2>/dev/null | sed 's/^/    /')"

  cat > "$out" <<EOF
Use autonomous-dev on this authorized objective: keep improving the $label codebase on
branch \`$branch\`, making real verified fixes and committing each finished unit.

This window is one of several running unattended against the same machine, and the
user is away, so it must keep moving on its own.

FIRST ACTION, before any other work: run \`git log --oneline -40\` and
\`git status --porcelain\` in $dir, and reconstruct from those two commands what is
already finished. The block below is orientation, not the contract — it was true at
launch and you will add to it. Do NOT redo, re-verify, or re-investigate committed
work. State at launch:

  branch: $branch
  HEAD:   $head
$recent

Then create the goal:
1. Call get_goal().
2. If there is no active goal, call create_goal with:
   - objective: "Improve the $label codebase on $branch: each turn take the highest-value unfinished change, and when a vein of similar work runs dry, deliberately pick a different kind."
   - title: "Improve $label"
   - max_no_progress_turns: 8
   - max_prompt_failures: 5
   The raised tolerances are REQUIRED. The defaults self-pause an unattended run
   on the first quiet stretch or transient provider failure.
   The title is REQUIRED. It is the few-word label the session status bar shows;
   without it the bar falls back to the objective and runs a truncated line of
   text across the panel. The objective stays one short sentence on purpose - it
   is re-read on every continuation, and the backlog it used to carry is
   rediscovered from git log anyway.

   That last clause of the objective is load-bearing, not decoration. The
   previous wording ("keep the codebase healthy") was open enough that a crew
   spent six hours and 40 commits inside a single vein - every one of them a
   real, verified fix, so no amount of reviewing the commits would have shown
   the problem. Quality per commit was never the failure; coverage across kinds
   of work was. An unattended agent with no human to redirect it will keep
   finding instances of whatever it started with, because the cheapest next
   task is always the one next to the last. So the instruction to switch kinds
   when a vein runs dry lives in the objective, which is the one text re-read
   on every continuation, rather than in a prompt paragraph that is read once
   and then only remembered in fragments.
3. Call get_goal() again and confirm status is "active" before implementing.

Then loop, one bounded deliverable at a time:
- Use todowrite; keep exactly one item in progress.
- Prefer direct execution. Delegate only a single bounded unit; a subagent must
  never activate its own goal.
- Minimal edits, then run the relevant tests.
- When one unit is done AND verified: call record_goal_completion with a short
  description, then commit it on \`$branch\`.
- If you notice yourself re-doing, re-verifying, or re-fixing something already in
  git log: STOP and pick a different unfinished item. That is a loop, it counts as
  no progress, and it will pause the goal.
- When the objective is genuinely covered, close with update_goal and real evidence.
  Otherwise keep working.

HARD RULE — MEMORY. This machine is shared and finite, and it has run out of
memory and lost unattended sessions before — recently: a window ran a bare
\`bun test\` and took all 31GB with it, losing both crew windows and the session.
- The window itself is already capped at ${CREW_MEMORY_MAX} by a cgroup, so a runaway
  run is killed at the ceiling instead of the machine dying under you. Treat
  hitting that cap as a BUG IN YOUR COMMAND, not as the machine being slow.
- NEVER run a whole test suite. Scope to specific files.
- NEVER run \`bun test\` bare. Run tests through the project's own capped wrapper,
  which exists in BOTH project trees:
      script/test-capped.sh bun test <file> [--timeout 60000]
  It applies the cgroup cap itself. If that file is missing, fall back to:
      systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 -- <command>
- Never raise concurrency. Never use \`ulimit -v\` under Bun — it caps address space
  rather than resident memory and kills the process outright.
- Watch RSS on long runs (\`ps -o rss\`) and abort past ~6GB.

BOUNDARY. Other agents are running against other paths at the same time. Stay
inside $dir. Do not touch another project's tree and do not run another project's
tests.

HAZARD: in some repos the test suite has historically MUTATED the working tree
(checkout, commit, revert, force-move the branch), destroying uncommitted work.
Commit before running a suite, prefer individual files, and re-check
\`git rev-parse --abbrev-ref HEAD\` afterwards.

Constraints: commit to \`$branch\`. Do NOT push, force-push, reset, revert, or clean.
Do NOT delete files other than a test fixture you created yourself. No network
installs, deployments, or purchases. Never commit secrets.
EOF
}

doctor() {
  local ok=0 found=0 path label dirty branch
  log "crew doctor  (config: $CONFIG)"
  # Report the command that will really be launched. Checking that some opencode
  # file exists and answering --version is not the same question as "will a window
  # open", and conflating the two is what let a broken build pass preflight.
  if resolve_opencode 2>/dev/null; then
    log "  opencode: ${OPENCODE_CMD[*]}"
  else
    warn "no usable opencode (set CREW_OPENCODE_CMD)"; ok=1
  fi
  command -v ghostty >/dev/null 2>&1 && log "  ghostty: $(command -v ghostty)" \
                                   || { warn "ghostty not on PATH"; ok=1; }
  log "  display: DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"
  # Report the memory cap, and say plainly when there is none. A crew that cannot exhaust the
  # machine is a safety property, and a safety property the operator cannot see is one they have to
  # take on trust - which is how a window ran a bare `bun test` into an OOM that killed both windows.
  if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet true >/dev/null 2>&1; then
    log "  memory cap: $CREW_MEMORY_MAX per window (cgroup, enforced)"
  else
    warn "  memory cap: NONE - windows can exhaust machine memory (no user systemd scope available)"
  fi
  command -v free >/dev/null 2>&1 && log "  memory: $(free -g | awk '/^Mem:/{print $7"GB available of "$2"GB"}')"
  while IFS=$'\t' read -r path label; do
    [ -z "$path" ] && continue
    if [ ! -d "$path/.git" ]; then warn "  [$label] not a git repo: $path"; ok=1; continue; fi
    dirty="$(git -C "$path" status --porcelain | wc -l)"
    branch="$(git -C "$path" rev-parse --abbrev-ref HEAD)"
    log "  [$label] $path @ $branch, $dirty uncommitted"
    [ "$dirty" -gt 0 ] && warn "    [$label] has uncommitted work — an agent may be mid-flight, or may have died"
    found=1
  done < <(read_projects)
  # An empty registry must be loud. It otherwise reads as "everything is fine" while launching
  # nothing, which is the worst possible failure for an unattended run.
  [ "${found:-0}" -eq 0 ] && { warn "  no projects configured in $CONFIG"; ok=1; }
  [ "$ok" -eq 0 ] && log "  preflight: OK" || warn "  preflight: issues above"
  return $ok
}

start() {
  local want="${1:-1}" only="${2:-}" n name dir label pid arr=()
  resolve_opencode
  # The memory cap wraps the resolved argv, so it has to be built after `resolve_opencode` and
  # before the first `launch_window` - otherwise the window starts uncapped and the guard is a lie.
  build_window_cmd
  doctor >/dev/null 2>&1 || warn "preflight reported issues; continuing anyway"
  if [ -n "$only" ]; then
    [ -d "$only/.git" ] || die "not a git repo: $only"
    arr=("$only")
  else
    mapfile -t arr < <(read_projects | cut -f1)
    [ "${#arr[@]}" -gt 0 ] || die "no projects configured in $CONFIG"
  fi
  # Two windows on ONE working tree will clobber each other's edits and each other's test runs.
  # Observed directly: three agents on one repo left half-finished work everywhere and burned
  # quota going nowhere. So more windows than projects is refused unless the caller insists,
  # because the round-robin would otherwise quietly create that collision.
  if [ "$want" -gt "${#arr[@]}" ] && [ "${CREW_ALLOW_COLLISION:-0}" != "1" ]; then
    die "$want windows over ${#arr[@]} project(s) means two windows editing one working tree.
     That reliably clobbers work. Add more projects to $CONFIG, start fewer windows, or set
     CREW_ALLOW_COLLISION=1 if you really mean it."
  fi
  for (( n=0; n<want; n++ )); do
    dir="${arr[$(( n % ${#arr[@]} ))]}"
    label="$(label_for "$dir")"
    name="crew-$label-$n"
    if [ -f "$STATE/run/$name.pid" ] && kill -0 "$(cat "$STATE/run/$name.pid")" 2>/dev/null; then
      warn "$name already running; skipping"; continue
    fi
    write_prompt "$dir" "$label" "$STATE/prompts/$name.md"
    pid="$(launch_window "$name" "$dir" "$(cat "$STATE/prompts/$name.md")" "$STATE/logs/$name.log")"
    echo "$pid" > "$STATE/run/$name.pid"
    # A window that dies during startup is indistinguishable from one that opened
    # off-screen, and both read as "nothing happened". Give the TUI a moment to
    # fail, then say so here instead of leaving the operator to guess.
    sleep 3
    if kill -0 "$pid" 2>/dev/null; then
      log "  started $name -> $dir ($label) pid=$pid"
    else
      warn "$name exited during startup — see 'crew.sh logs $name 40'"
    fi
  done
  log "crew launched. 'crew.sh status' to check, 'crew.sh stop' to halt."
}

status() {
  log "crew status"
  local any=0 name pid f
  for f in "$STATE/run"/*.pid; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .pid)"; pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      log "  RUNNING  $name  pid=$pid  up $(( $(date +%s) - $(stat -c %Y "$f") ))s"; any=1
    else
      log "  DEAD     $name  pid=$pid  (stale; 'crew.sh stop $name' clears it)"
    fi
  done
  local apid acwd
  while IFS=$'\t' read -r apid acwd; do
    log "  RUNNING  (adopted)  pid=$apid  cwd=$acwd"; any=1
  done < <(adopted)
  [ "$any" -eq 0 ] && log "  nothing running"
}

stop() {
  local names=("$@") name pid apid acwd stopped=0
  if [ "${#names[@]}" -gt 0 ]; then
    for name in "${names[@]}"; do
      pid="$(pid_of "$name")"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null; log "  TERM $name (pid=$pid)"; stopped=1
      else log "  $name not running"; fi
      rm -f "$STATE/run/$name.pid"
    done
    return 0
  fi
  # No names: stop every window this tool started, then every agent window it can see.
  for f in "$STATE/run"/*.pid; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .pid)"; pid="$(cat "$f")"
    kill -0 "$pid" 2>/dev/null && { kill -TERM "$pid" 2>/dev/null; log "  TERM $name (pid=$pid)"; stopped=1; }
    rm -f "$f"
  done
  while IFS=$'\t' read -r apid acwd; do
    kill -TERM "$apid" 2>/dev/null; log "  TERM (adopted) pid=$apid cwd=$acwd"; stopped=1
  done < <(adopted)
  [ "$stopped" -eq 0 ] && log "nothing to stop"
}

case "${1:-}" in
  start)  shift; start "${1:-1}" "${2:-}" ;;
  status) status ;;
  stop)   shift; stop "$@" ;;
  logs)   shift; [ -n "${1:-}" ] || die "usage: crew.sh logs <name> [lines]"; tail -n "${2:-40}" "$STATE/logs/$1.log" 2>/dev/null || die "no log for $1" ;;
  doctor) doctor ;;
  ""|-h|--help|help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (try: crew.sh help)" ;;
esac
