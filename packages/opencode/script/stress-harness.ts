#!/usr/bin/env bun
// Stress + benchmark harness for the headless `opencode serve` HTTP server.
//
// Boots one fully isolated server (own HOME, XDG dirs, sqlite file, config
// content), hammers it with concurrent traffic, and prints stability numbers as
// machine-parseable `METRIC <name>|<value>` lines so runs can be diffed over
// time. This is a measurement tool, not an assertion suite: server-side errors
// are counted and reported, and only a failed boot is a hard failure (exit 2).
//
// Usage:
//   bun run stress
//   bun run stress --scenarios boot,session-fanout --sessions 200
//   bun run stress --messages 1000 --sse 16 --concurrency 40 --out /tmp/stress.txt
// Env equivalents: STRESS_SCENARIOS, STRESS_SESSIONS, STRESS_MESSAGES,
// STRESS_SSE, STRESS_SHELLS, STRESS_CONCURRENCY, STRESS_OUT.
//
// Phases (see PHASES below for what each one probes):
//   boot               time to listening + healthy
//   session-fanout     concurrent POST /session throughput
//   session-list-scan  GET /session cost curve as the table grows
//   message-storm      concurrent prompt_async write pressure + drain time
//   read-amplification GET /session/{id}/message with no limit, per size
//   sse-slow-reader    server RSS while M /event readers never drain
//   shell-probe        POST /session/{id}/shell (getCurrentShell path)
//   teardown           DELETE sample + list-after-delete
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const HOSTNAME = "127.0.0.1"
const REQUEST_TIMEOUT_MS = 60_000
const BOOT_TIMEOUT_MS = 120_000
const DRAIN_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 250
const LISTEN_RE = /listening on (http:\/\/([^\s:/]+):(\d+))/
const SESSION_LIST_CHECKPOINTS = [50, 200, 1000]
// `Session.list` reads `input.limit ?? 100`, so a huge limit is how you ask for
// every row. (limit=0 is NOT that: it becomes SQL `LIMIT 0`.)
const UNBOUNDED_LIMIT = 1_000_000
const READ_AMPLIFICATION_SIZES = [10, 100, 500, 1000]
// The provider catalog is disabled in the child env, so `Provider.defaultModel()`
// dies with ProviderNoProvidersError. Passing an explicit model ref on every
// prompt/shell payload keeps the measurement on the storage path instead of the
// LLM path, and `noReply` skips the assistant turn for the same reason.
const FAKE_MODEL = { providerID: "opencode", modelID: "stress-fake-model" }
const SHELL_AGENT = "build"
const SHELL_COMMAND = "echo stress-shell"
const PROMPT_PAYLOAD = { parts: [{ type: "text", text: "stress message" }], noReply: true, model: FAKE_MODEL }
const MAX_RECORDED_ERRORS = 10

const SCENARIOS = [
  "boot",
  "session-fanout",
  "session-list-scan",
  "message-storm",
  "read-amplification",
  "sse-slow-reader",
  "shell-probe",
  "teardown",
] as const
type Scenario = (typeof SCENARIOS)[number]

type Options = {
  readonly scenarios: Scenario[]
  readonly sessions: number
  readonly messages: number
  readonly sse: number
  readonly shells: number
  readonly concurrency: number
  readonly out?: string
}

type Server = {
  readonly proc: Bun.Subprocess
  readonly pid: number
  readonly port: number
  readonly base: string
  readonly directory: string
  readonly root: string
}

type Call = {
  readonly status: number
  readonly ms: number
  readonly bytes: number
  readonly text: string
  readonly json: unknown
  readonly headers: Headers
}

type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }

const report: string[] = []
const metrics: string[] = []
const recorded: string[] = []
const sessions: string[] = []
let server: Server | undefined
let outFile: string | undefined
// Tracked separately from `server`: a boot that fails after mkdtemp or after
// spawn must still get its temp dir removed and its child killed.
let tempRoot: string | undefined
let childProc: Bun.Subprocess | undefined
let totalErrors = 0
let totalSucceeded = 0
let cleanedUp = false

// --- output -----------------------------------------------------------------

function log(message: string) {
  console.error(`[stress] ${message}`)
}

function say(line = "") {
  report.push(line)
  console.log(line)
}

function table(rows: [string, string][]) {
  const width = rows.reduce((widest, [label]) => Math.max(widest, label.length), 0)
  for (const [label, value] of rows) say(`  ${label.padEnd(width)}  ${value}`)
}

function number(value: number) {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "nan"
}

function metric(name: string, value: number | string) {
  metrics.push(`METRIC ${name}|${typeof value === "number" ? number(value) : value}`)
}

function ms(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a"
}

function bytes(value: number) {
  return Number.isFinite(value) ? `${(value / 1024).toFixed(1)}KiB` : "n/a"
}

function note(errors: number) {
  return errors === 0 ? "0" : `${errors} (see stderr)`
}

function recordError(context: string, detail: string) {
  if (recorded.length < MAX_RECORDED_ERRORS) recorded.push(`${context}: ${detail}`)
  else if (recorded.length === MAX_RECORDED_ERRORS) recorded.push("...truncated")
}

// --- options ----------------------------------------------------------------

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg || !arg.startsWith("--")) continue
    const equals = arg.indexOf("=")
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next)
      index++
      continue
    }
    flags.set(arg.slice(2), "true")
  }
  const numeric = (name: string, fallback: number) => {
    const raw = flags.get(name) ?? Bun.env[`STRESS_${name.toUpperCase()}`]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive number (got ${raw})`)
    return value
  }
  const requested = (flags.get("scenarios") ?? Bun.env.STRESS_SCENARIOS ?? SCENARIOS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const unknown = requested.filter((name) => !SCENARIOS.includes(name as Scenario))
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(", ")}; known: ${SCENARIOS.join(", ")}`)
  return {
    scenarios: SCENARIOS.filter((name) => requested.includes(name)),
    sessions: numeric("sessions", 200),
    messages: numeric("messages", 400),
    sse: numeric("sse", 8),
    shells: numeric("shells", 50),
    concurrency: numeric("concurrency", 20),
    out: flags.get("out") ?? Bun.env.STRESS_OUT,
  }
}

// --- concurrency + stats ----------------------------------------------------

async function pool(count: number, limit: number, worker: (index: number) => Promise<void>) {
  let next = 0
  const width = Math.max(1, Math.min(limit, count))
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (true) {
        const index = next++
        if (index >= count) return
        await worker(index)
      }
    }),
  )
}

// Nearest-rank percentile over a sorted copy: no interpolation, no averaging of
// ranks that do not exist, so p99 of 12 samples is a sample we actually took.
function percentile(values: number[], p: number) {
  if (values.length === 0) return Number.NaN
  const sorted = values.toSorted((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN
}

function spread(latencies: number[]) {
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length === 0 ? Number.NaN : Math.max(...latencies),
  }
}

type Hammered = {
  readonly succeeded: number
  readonly failed: number
  readonly latencies: number[]
  readonly seconds: number
  readonly throughput: number
}

// Fire `count` requests with bounded concurrency, recording per-request latency
// and classifying transport errors and HTTP >= 400 alike as failures.
async function hammer(
  label: string,
  count: number,
  concurrency: number,
  request: (index: number) => Promise<Call>,
): Promise<Hammered> {
  const latencies: number[] = []
  let succeeded = 0
  let failed = 0
  const started = performance.now()
  await pool(count, concurrency, async (index) => {
    const context = `${label}#${index}`
    let response: Call
    try {
      response = await request(index)
    } catch (error) {
      failed++
      totalErrors++
      recordError(context, error instanceof Error ? error.message : String(error))
      return
    }
    if (response.status >= 400) {
      failed++
      totalErrors++
      recordError(context, `HTTP ${response.status} ${response.text.slice(0, 200)}`)
      return
    }
    succeeded++
    latencies.push(response.ms)
  })
  const seconds = (performance.now() - started) / 1000
  return { succeeded, failed, latencies, seconds, throughput: seconds > 0 ? succeeded / seconds : 0 }
}

function reportHammered(label: string, result: Hammered) {
  const stats = spread(result.latencies)
  say()
  table([
    [`${label} ok`, String(result.succeeded)],
    [`${label} failed`, String(result.failed)],
    [`${label} p50`, ms(stats.p50)],
    [`${label} p95`, ms(stats.p95)],
    [`${label} p99`, ms(stats.p99)],
    [`${label} max`, ms(stats.max)],
    [`${label} wall`, `${result.seconds.toFixed(2)}s`],
    [`${label} throughput`, `${result.throughput.toFixed(1)}/s`],
  ])
}

function metricSpread(prefix: string, latencies: number[]) {
  const stats = spread(latencies)
  metric(`${prefix}_p50_ms`, stats.p50)
  metric(`${prefix}_p95_ms`, stats.p95)
  metric(`${prefix}_p99_ms`, stats.p99)
  metric(`${prefix}_max_ms`, stats.max)
}

// --- http -------------------------------------------------------------------

async function call(
  method: string,
  endpoint: string,
  body?: unknown,
  options: { readonly timeoutMs?: number } = {},
): Promise<Call> {
  if (!server) throw new Error("server is not booted")
  const started = performance.now()
  const response = await fetch(server.base + endpoint, {
    method,
    headers: {
      "x-opencode-directory": server.directory,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return {
    status: response.status,
    ms: performance.now() - started,
    bytes: Buffer.byteLength(text),
    text,
    json,
    headers: response.headers,
  }
}

async function attempt<A>(context: string, run: () => Promise<A>): Promise<Outcome<A>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    totalErrors++
    recordError(context, error instanceof Error ? error.message : String(error))
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function createSession(label: string) {
  const response = await call("POST", "/session", { title: label })
  const id = (response.json as { id?: string } | undefined)?.id
  if (response.status >= 400 || typeof id !== "string") {
    totalErrors++
    recordError(`create:${label}`, `HTTP ${response.status} ${response.text.slice(0, 200)}`)
    return undefined
  }
  sessions.push(id)
  return id
}

async function countMessages(sessionID: string) {
  let total = 0
  let before: string | undefined
  for (let page = 0; page < 1_000; page++) {
    const query = new URLSearchParams({ limit: "100" })
    if (before) query.set("before", before)
    const response = await call("GET", `/session/${sessionID}/message?${query}`)
    if (response.status !== 200) throw new Error(`listing messages failed with HTTP ${response.status}`)
    total += Array.isArray(response.json) ? response.json.length : 0
    before = response.headers.get("x-next-cursor") ?? undefined
    if (!before) return total
  }
  return total
}

// prompt_async returns 204 before the message lands, so "settled" is measured by
// the message count going quiet rather than by the POST returning.
async function waitForMessages(sessionID: string, expected: number) {
  const started = performance.now()
  let count = 0
  let last = -1
  let stable = 0
  while (performance.now() - started < DRAIN_TIMEOUT_MS) {
    count = await countMessages(sessionID)
    stable = count === last ? stable + 1 : 0
    last = count
    if (count >= expected || stable >= 3) break
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  return { count, ms: performance.now() - started }
}

function rssMb() {
  if (!server) return Number.NaN
  try {
    const status = fs.readFileSync(`/proc/${server.pid}/status`, "utf8")
    return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? Number.NaN) / 1024
  } catch {
    return Number.NaN
  }
}

function rssSampler() {
  let peak = rssMb()
  let samples = 0
  const read = () => {
    const value = rssMb()
    if (!Number.isFinite(value)) return
    samples++
    if (!Number.isFinite(peak) || value > peak) peak = value
  }
  // 100ms: the whole phase can be over in two seconds, and a 250ms tick sampled
  // 4 points across the entire storm, which is not a peak.
  const timer = setInterval(read, 100)
  return { stop: () => clearInterval(timer), read, peak: () => peak, samples: () => samples }
}

// --- phases -----------------------------------------------------------------

async function phaseBoot() {
  const started = performance.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-stress-"))
  tempRoot = root
  const directory = path.join(root, "project")
  const home = path.join(root, "home")
  fs.mkdirSync(directory, { recursive: true })
  for (const name of ["data", "config", "state", "cache"]) fs.mkdirSync(path.join(home, name), { recursive: true })
  const git = Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory, stdout: "ignore", stderr: "ignore" })
  if (git.exitCode !== 0) log("git init failed; sessions will be recorded against the global project")

  const proc = Bun.spawn(["bun", "run", "./src/index.ts", "serve", "--port", "0", "--hostname", HOSTNAME], {
    cwd: PACKAGE_DIR,
    env: {
      ...Bun.env,
      OPENCODE_TEST_HOME: home,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_DB: path.join(root, "stress.db"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "opencode/stress-fake-model", permission: "allow" }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  childProc = proc

  const port = await waitForPort(proc)
  server = { proc, pid: proc.pid, port, base: `http://${HOSTNAME}:${port}`, directory, root }
  log(`server pid ${proc.pid} listening on ${server.base}`)

  const healthy = await waitForHealth()
  if (!healthy) throw new Error("server never reported healthy at /global/health")
  const elapsed = performance.now() - started
  metric("stress_boot_ms", elapsed)
  metric("stress_boot_port", port)
  metric("stress_boot_pid", proc.pid)
  metric("stress_boot_healthy", 1)
  table([
    ["pid", String(proc.pid)],
    ["base", server.base],
    ["directory", directory],
    ["time to ready", ms(elapsed)],
  ])
}

async function waitForPort(proc: Bun.Subprocess) {
  const stream = proc.stdout
  // Bun types stdout as `number | ReadableStream | undefined` (a raw fd when
  // piped to a descriptor); we asked for "pipe", so anything else is a bug here.
  if (!stream || typeof stream === "number") throw new Error("child stdout was not piped")
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => settle(new Error(`server never printed the listening line within ${BOOT_TIMEOUT_MS}ms`)),
      BOOT_TIMEOUT_MS,
    )
    let done = false
    const settle = (error?: Error, port?: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(port ?? 0)
    }
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    // Keep draining stdout for the rest of the run: a full pipe would block the
    // server's own writes, which is exactly the kind of wedge we are measuring.
    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          let newline = pending.indexOf("\n")
          while (newline !== -1) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (line) log(`server: ${line}`)
            const match = LISTEN_RE.exec(line)
            if (match?.[3]) settle(undefined, Number(match[3]))
            newline = pending.indexOf("\n")
          }
        }
        settle(new Error("server stdout closed before the listening line"))
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })()
    void proc.exited.then((code) => settle(new Error(`server exited with code ${code} before the listening line`)))
  })
}

async function waitForHealth() {
  const deadline = performance.now() + REQUEST_TIMEOUT_MS
  while (performance.now() < deadline) {
    try {
      const response = await call("GET", "/global/health", undefined, { timeoutMs: 5_000 })
      const body = response.json as { healthy?: unknown } | undefined
      if (response.status === 200 && body?.healthy === true) return true
    } catch {
      // server socket not accepting yet; retry until the deadline
    }
    await Bun.sleep(100)
  }
  return false
}

async function phaseSessionFanout(options: Options) {
  const result = await hammer("session-fanout", options.sessions, options.concurrency, async () => {
    const response = await call("POST", "/session", { title: "stress-fanout" })
    const id = (response.json as { id?: string } | undefined)?.id
    if (response.status < 400 && typeof id === "string") sessions.push(id)
    return response
  })
  totalSucceeded += result.succeeded
  metric("stress_sessions_created", result.succeeded)
  metric("stress_sessions_errors", result.failed)
  metric("stress_session_create_throughput_per_sec", result.throughput)
  metricSpread("stress_session_create", result.latencies)
  reportHammered("session-fanout", result)
}

async function phaseSessionListScan(options: Options) {
  const rows: [string, string][] = []
  for (const checkpoint of SESSION_LIST_CHECKPOINTS) {
    const missing = checkpoint - sessions.length
    if (missing > 0) {
      const filled = await hammer(`session-list-scan/fill(${missing})`, missing, options.concurrency, async () => {
        const response = await call("POST", "/session", { title: "stress-scan" })
        const id = (response.json as { id?: string } | undefined)?.id
        if (response.status < 400 && typeof id === "string") sessions.push(id)
        return response
      })
      totalSucceeded += filled.succeeded
      log(`filled to ${sessions.length} sessions (+${filled.succeeded}, ${filled.failed} failed)`)
    }
    const result = await attempt(`list(${checkpoint})`, () => call("GET", "/session"))
    if (!result.ok) {
      metric(`stress_list_latency_sessions${checkpoint}`, Number.NaN)
      rows.push([`@${checkpoint} sessions`, `error: ${result.error}`])
      continue
    }
    const listed = (result.value.json as unknown[] | undefined)?.length ?? 0
    // The default page is capped at 100, so it hides the full-scan + filesort on
    // `time_updated` (unindexed). The same call with an unbounded limit pays that
    // cost in full and is where the curve actually shows up.
    const full = await attempt(`list-all(${checkpoint})`, () => call("GET", `/session?limit=${UNBOUNDED_LIMIT}`))
    const all = full.ok ? ((full.value.json as unknown[] | undefined)?.length ?? 0) : Number.NaN
    metric(`stress_list_latency_sessions${checkpoint}`, result.value.ms)
    metric(`stress_list_bytes_sessions${checkpoint}`, result.value.bytes)
    metric(`stress_list_returned_sessions${checkpoint}`, listed)
    metric(`stress_list_full_latency_sessions${checkpoint}`, full.ok ? full.value.ms : Number.NaN)
    metric(`stress_list_full_bytes_sessions${checkpoint}`, full.ok ? full.value.bytes : Number.NaN)
    metric(`stress_list_full_returned_sessions${checkpoint}`, all)
    rows.push([
      // Labelled by the real row count: an earlier phase may already have blown
      // past the checkpoint, and "checkpoint 50 with 200 rows" is a lie.
      `@${sessions.length} sessions`,
      `${ms(result.value.ms)} (${listed} rows, ${bytes(result.value.bytes)})  ` +
        `unbounded: ${full.ok ? `${ms(full.value.ms)} (${all} rows, ${bytes(full.value.bytes)})` : `error: ${full.error}`}`,
    ])
  }
  say()
  table(rows)
}

async function phaseMessageStorm(options: Options) {
  const session = await createSession("stress-storm")
  if (!session) throw new Error("could not create a session for the storm")
  const result = await hammer("message-storm", options.messages, Math.max(25, options.concurrency), () =>
    call("POST", `/session/${session}/prompt_async`, PROMPT_PAYLOAD),
  )
  totalSucceeded += result.succeeded
  const drained = await waitForMessages(session, result.succeeded)
  metric("stress_message_posted", result.succeeded)
  metric("stress_message_errors", result.failed)
  metric("stress_messages_settled", drained.count)
  metric("stress_message_drain_ms", drained.ms)
  metricSpread("stress_message", result.latencies)
  reportHammered("message-storm", result)
  table([
    ["drain time", ms(drained.ms)],
    ["messages settled", `${drained.count}/${result.succeeded}`],
  ])
}

async function phaseReadAmplification(options: Options) {
  const session = await createSession("stress-read")
  if (!session) throw new Error("could not create a session for read amplification")
  const rows: [string, string][] = []
  let filled = 0
  for (const target of READ_AMPLIFICATION_SIZES) {
    const missing = target - filled
    if (missing > 0) {
      const posted = await hammer("read-amp/fill", missing, Math.max(25, options.concurrency), () =>
        call("POST", `/session/${session}/prompt_async`, PROMPT_PAYLOAD),
      )
      totalSucceeded += posted.succeeded
      const drained = await waitForMessages(session, filled + posted.succeeded)
      filled = drained.count
    }
    const count = Math.max(filled, target)
    // No `limit` param: the handler pages the whole session into one array.
    const result = await attempt(`read(${target})`, () => call("GET", `/session/${session}/message`))
    if (!result.ok) {
      metric(`stress_read_${target}ms`, Number.NaN)
      rows.push([`${count} messages`, `error: ${result.error}`])
      continue
    }
    const items = (result.value.json as unknown[] | undefined)?.length ?? 0
    metric(`stress_read_${target}ms`, result.value.ms)
    metric(`stress_read_${target}bytes`, result.value.bytes)
    metric(`stress_read_${target}messages`, items)
    rows.push([`${count} messages`, `${ms(result.value.ms)}  ${bytes(result.value.bytes)}  items=${items}`])
  }
  say()
  table(rows)
}

async function phaseSseSlowReader(options: Options) {
  if (!server) throw new Error("server is not booted")
  const controllers: AbortController[] = []
  const held: Response[] = []
  const sampler = rssSampler()
  let start = Number.NaN
  let peak = Number.NaN
  let end = Number.NaN
  let posted = 0
  let openMs = Number.NaN
  try {
    const openedAt = performance.now()
    for (let index = 0; index < options.sse; index++) {
      const controller = new AbortController()
      controllers.push(controller)
      // Deliberately never read response.body — that is the entire probe. The
      // per-subscriber Queue.unbounded in handlers/event.ts keeps accepting, so a
      // non-draining reader should show up as server RSS growth.
      const response = await fetch(`${server.base}/event`, {
        headers: { "x-opencode-directory": server.directory, accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (response.status !== 200) throw new Error(`SSE connect failed with HTTP ${response.status}`)
      held.push(response)
    }
    openMs = performance.now() - openedAt
    log(`${options.sse} event streams open (bodies undrained)`)
    start = rssMb()

    const session = await createSession("stress-sse")
    if (!session) throw new Error("could not create a session for the sse storm")
    const storm = Math.max(50, Math.round(options.messages / 4))
    const result = await hammer("sse-slow-reader", storm, Math.max(25, options.concurrency), () =>
      call("POST", `/session/${session}/prompt_async`, PROMPT_PAYLOAD),
    )
    totalSucceeded += result.succeeded
    posted = result.succeeded
    await waitForMessages(session, result.succeeded)
    sampler.read()
    peak = sampler.peak()
    end = rssMb()
    metric("stress_sse_connections", options.sse)
    metric("stress_sse_open_ms", openMs)
    metric("stress_sse_events_posted", posted)
    metric("stress_sse_errors", result.failed)
  } finally {
    for (const controller of controllers) controller.abort()
    sampler.stop()
    held.length = 0
  }
  metric("stress_rss_start_mb", start)
  metric("stress_rss_peak_mb", peak)
  metric("stress_rss_end_mb", end)
  metric("stress_rss_growth_mb", Number.isFinite(start) && Number.isFinite(end) ? end - start : Number.NaN)
  metric("stress_rss_samples", sampler.samples())
  say()
  table([
    ["sse connections", String(options.sse)],
    ["open time", ms(openMs)],
    ["events posted", String(posted)],
    ["rss start", Number.isFinite(start) ? `${start.toFixed(1)}MiB` : "n/a"],
    ["rss peak", Number.isFinite(peak) ? `${peak.toFixed(1)}MiB` : "n/a"],
    ["rss end", Number.isFinite(end) ? `${end.toFixed(1)}MiB` : "n/a"],
    ["rss growth", Number.isFinite(start) && Number.isFinite(end) ? `${(end - start).toFixed(1)}MiB` : "n/a"],
  ])
}

async function phaseShellProbe(options: Options) {
  // One session per in-flight worker: a session rejects a second shell with
  // SessionBusyError, which would measure queueing instead of getCurrentShell.
  const width = Math.max(1, Math.min(options.concurrency, options.shells))
  const workers: string[] = []
  for (let index = 0; index < width; index++) {
    const session = await createSession("stress-shell")
    if (session) workers.push(session)
  }
  if (workers.length === 0) throw new Error("could not create sessions for the shell probe")
  const result = await hammer("shell-probe", options.shells, width, (index) => {
    const session = workers[index % workers.length] as string
    return call("POST", `/session/${session}/shell`, { agent: SHELL_AGENT, command: SHELL_COMMAND, model: FAKE_MODEL })
  })
  totalSucceeded += result.succeeded
  metric("stress_shell_ok", result.succeeded)
  metric("stress_shell_errors", result.failed)
  metricSpread("stress_shell", result.latencies)
  reportHammered("shell-probe", result)
}

async function phaseTeardown(options: Options) {
  const width = Math.min(50, sessions.length)
  const doomed = sessions.slice(0, width)
  const deleted = await hammer("teardown/delete", doomed.length, options.concurrency, (index) =>
    call("DELETE", `/session/${doomed[index]}`),
  )
  totalSucceeded += deleted.succeeded
  // Archived sessions drop out of GET /session via `isNull(time_archived)`, so
  // archiving a *disjoint* second sample (the first one is deleted by now) shows
  // what that filter costs on the same table.
  const archivedSample = sessions.slice(width, width * 2)
  const archived = await hammer("teardown/archive", archivedSample.length, options.concurrency, (index) =>
    call("PATCH", `/session/${archivedSample[index]}`, { time: { archived: Date.now() } }),
  )
  const list = await attempt("teardown/list", () => call("GET", "/session"))
  const remaining = list.ok ? ((list.value.json as unknown[] | undefined)?.length ?? 0) : Number.NaN
  metric("stress_teardown_deleted", deleted.succeeded)
  metric("stress_teardown_delete_errors", deleted.failed)
  metric("stress_teardown_archived", archived.succeeded)
  metricSpread("stress_teardown_delete", deleted.latencies)
  metric("stress_teardown_list_ms", list.ok ? list.value.ms : Number.NaN)
  metric("stress_teardown_sessions_returned", remaining)
  reportHammered("teardown/delete", deleted)
  say()
  table([
    ["archived", `${archived.succeeded} ok, ${archived.failed} failed`],
    ["list after teardown", list.ok ? ms(list.value.ms) : `error: ${list.error}`],
    ["sessions returned", Number.isFinite(remaining) ? String(remaining) : "n/a"],
  ])
}

const PHASES: Record<Scenario, (options: Options) => Promise<void>> = {
  boot: phaseBoot,
  "session-fanout": phaseSessionFanout,
  "session-list-scan": phaseSessionListScan,
  "message-storm": phaseMessageStorm,
  "read-amplification": phaseReadAmplification,
  "sse-slow-reader": phaseSseSlowReader,
  "shell-probe": phaseShellProbe,
  teardown: phaseTeardown,
}

// --- cleanup ----------------------------------------------------------------

function descendants(pid: number) {
  const found: number[] = []
  let frontier = [pid]
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: number[] = []
    let entries: string[] = []
    try {
      entries = fs.readdirSync("/proc")
    } catch {
      return found
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      if (frontier.includes(Number(entry))) continue
      let parent = 0
      try {
        parent = Number(/^PPid:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/${entry}/status`, "utf8"))?.[1] ?? 0)
      } catch {
        continue
      }
      if (frontier.includes(parent)) {
        found.push(Number(entry))
        next.push(Number(entry))
      }
    }
    frontier = next
  }
  return found
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  const proc = childProc
  if (proc && proc.exitCode === null) {
    // SIGKILL, not the default SIGTERM: Effect's shutdown is not the thing
    // under test and a wedged child would hang the harness.
    for (const pid of [proc.pid, ...descendants(proc.pid)]) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
  if (tempRoot) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {}
  }
}

process.on("exit", cleanup)
process.on("SIGINT", () => {
  log("interrupted")
  cleanup()
  process.exit(130)
})
process.on("SIGTERM", () => {
  log("terminated")
  cleanup()
  process.exit(143)
})

// --- main -------------------------------------------------------------------

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const options = parseOptions(Bun.argv.slice(2))
  outFile = options.out
  if (options.scenarios.length === 0) throw new Error("--scenarios selected no known phase")
  const needsServer = options.scenarios.some((name) => name !== "boot")
  const plan: Scenario[] =
    needsServer && !options.scenarios.includes("boot") ? ["boot", ...options.scenarios] : [...options.scenarios]

  say("opencode serve stress harness")
  say(
    `phases: ${plan.join(", ")} | sessions=${options.sessions} messages=${options.messages} sse=${options.sse} shells=${options.shells} concurrency=${options.concurrency}`,
  )

  const started = performance.now()
  const failures: string[] = []
  let bootFailed = false
  for (const [index, name] of plan.entries()) {
    const implied = name === "boot" && !options.scenarios.includes("boot")
    log(`phase ${index + 1}/${plan.length} ${name}${implied ? " (implied)" : ""} starting`)
    const phaseStarted = performance.now()
    try {
      await PHASES[name](options)
    } catch (error) {
      // One broken phase must not cost us the rest of the run: this is a
      // measurement tool, and a partial report is still a report.
      failures.push(`${name}: ${describeError(error)}`)
      log(`phase ${name} FAILED: ${describeError(error)}`)
      if (name === "boot") bootFailed = true
    }
    log(`phase ${name} finished in ${(performance.now() - phaseStarted).toFixed(0)}ms`)
  }

  metric("stress_total_errors", totalErrors)
  metric("stress_total_requests_ok", totalSucceeded)
  metric("stress_phases_failed", failures.length)
  metric("stress_wall_ms", performance.now() - started)
  metric("stress_boot_failed", bootFailed ? 1 : 0)

  say()
  say("### summary")
  table([
    ["wall clock", ms(performance.now() - started)],
    ["requests ok", String(totalSucceeded)],
    ["errors", note(totalErrors)],
    ["phases failed", failures.length === 0 ? "0" : failures.join(" | ")],
  ])
  if (recorded.length > 0) {
    say()
    say("first errors:")
    for (const entry of recorded) say(`  ${entry}`)
  }
  say()
  say("### metrics")
  for (const entry of metrics) say(entry)
  if (outFile) {
    fs.writeFileSync(outFile, `${report.join("\n")}\n`)
    log(`report written to ${outFile}`)
  }

  if (bootFailed) {
    say("METRIC stress_result|boot-failed")
    if (outFile) fs.appendFileSync(outFile, "METRIC stress_result|boot-failed\n")
    return 2
  }
  return 0
}

process.exitCode = await main().catch((error) => {
  const detail = `METRIC stress_result|harness-error ${describeError(error)}`
  say()
  say(detail)
  log(describeError(error))
  if (outFile) fs.appendFileSync(outFile, `${detail}\n`)
  return 2
})
cleanup()
