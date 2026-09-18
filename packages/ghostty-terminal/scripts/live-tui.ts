import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { TerminalSessions } from "../src/sessions"
import { unloadLibrary } from "../src/ffi/bindings"

// Linux smoke harness: no prompt submission, credentials, user config, or runtime patches.
assert.equal(process.platform, "linux", "Owned PTY session cleanup currently requires Linux")
// Launch the actual opencode TUI entry directly (same as `bun run dev` from
// the repo root, which runs `bun run --cwd packages/opencode src/index.ts`).
const tuiDir = fileURLToPath(new URL("../../opencode/", import.meta.url))
const out = fileURLToPath(new URL(`../artifacts/ghostty-live-tui-${Date.now()}/`, import.meta.url))
const name = "ghostty-live-tui"
const input = "ghostty visual smoke - do not submit"
const sessions = new TerminalSessions()
const command = [process.execPath, "./src/index.ts", "--pure"]
const captures: object[] = []
const owned = new Map<number, string>()
let pid = 0
let server: ReturnType<typeof Bun.serve> | undefined
let timer: ReturnType<typeof setInterval> | undefined
let result = "failed"
let blocker: string | undefined
await mkdir(out, { recursive: true })
for (const dir of ["home", "config", "data", "cache", "state", "tmp"]) {
  await mkdir(`${out}isolated/${dir}`, { recursive: true })
}
const font = Bun.file("/usr/share/fonts/TTF/DejaVuSansMono.ttf")
assert(await font.exists(), "Fixed screenshot font missing: DejaVuSansMono.ttf")
const fontURL = `data:font/ttf;base64,${Buffer.from(await font.arrayBuffer()).toString("base64")}`
// TUI fidelity env: explicit values win; the rest passes through from the host
// so the agent sees exactly what the user sees (truecolor, UTF-8, term program).
const passthrough = ["TERM_PROGRAM", "COLORFGBG", "LC_ALL"] as const
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: `${out}isolated/home`,
  OPENCODE_TEST_HOME: `${out}isolated/home`,
  XDG_CONFIG_HOME: `${out}isolated/config`,
  XDG_DATA_HOME: `${out}isolated/data`,
  XDG_CACHE_HOME: `${out}isolated/cache`,
  XDG_STATE_HOME: `${out}isolated/state`,
  STATE_DIRECTORY: `${out}isolated/state`,
  TMPDIR: `${out}isolated/tmp`,
  TERM: process.env.TERM ?? "xterm-256color",
  COLORTERM: process.env.COLORTERM ?? "truecolor",
  LANG: process.env.LANG ?? "C.UTF-8",
  PWD: tuiDir,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [], autoupdate: false }),
}
for (const key of passthrough) {
  if (process.env[key] !== undefined) env[key] = process.env[key]!
}

function processes() {
  const proc = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,sid="], { stdout: "pipe", stderr: "pipe" })
  assert.equal(proc.exitCode, 0, "Cannot audit owned process tree")
  return proc.stdout.toString().trim().split("\n").map((line) => {
    const [id, parent, session] = line.trim().split(/\s+/).map(Number)
    return { id: id!, parent: parent!, session: session! }
  })
}
async function identity(id: number) {
  try {
    const stat = await Bun.file(`/proc/${id}/stat`).text()
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch { return undefined }
}
async function track() {
  const list = processes()
  const ids = new Set([pid, ...owned.keys()])
  for (let changed = true; changed;) {
    changed = false
    for (const proc of list) {
      if (proc.id === process.pid || ids.has(proc.id)) continue
      if (proc.session !== pid && !ids.has(proc.parent)) continue
      ids.add(proc.id)
      changed = true
    }
  }
  for (const id of ids) {
    const start = await identity(id)
    if (start && !owned.has(id)) owned.set(id, start)
  }
}
async function until(label: string, predicate: () => boolean, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert(!sessions.info(name).exited, `TUI exited while waiting for ${label}: ${sessions.screen(name)}`)
    assert(Date.now() < deadline, `Timed out waiting for ${label}: ${sessions.screen(name)}`)
    await Bun.sleep(100)
  }
  assert(!sessions.info(name).exited, `${label}: TUI must remain alive`)
}
async function capture(stage: string) {
  const info = sessions.info(name)
  assert(!info.exited, "Capture must occur with a persistent live child")
  const state = sessions.screenState(name)
  const plain = state.text
  const html = state.html
  const cursor = state.cursor
  assert(plain.trim().length > 100, `${stage}: empty/incomplete UI`)
  assert(html.includes("display: inline;") && html.includes("color:") && html.includes("background-color:"), `${stage}: missing native cell styling`)
  await Bun.write(`${out}${stage}.txt`, plain)
  // Cursor/alt-screen snapshot alongside the screenshots (best-effort VT parse).
  await Bun.write(`${out}${stage}.cursor.json`, JSON.stringify(cursor, null, 2))
  // Native Ghostty HTML is preserved verbatim; only the viewport/font wrapper is ours.
  await Bun.write(`${out}${stage}.html`, `<!doctype html><html lang="en"><meta charset="utf-8">
<title>OpenCode live TUI — ${stage}</title><style>
@font-face{font-family:SmokeMono;src:url('${fontURL}') format('truetype');font-weight:100 900}
*{box-sizing:border-box}html,body{margin:0;background:#0a0a0a;color:#eeeeee}
#screen{width:${info.cols * 10}px;height:${info.rows * 20}px;overflow:hidden;background:#0a0a0a}
#screen,#screen *{font-family:SmokeMono,monospace!important;font-size:16px;line-height:20px;letter-spacing:0.3671875px;font-variant-ligatures:none;font-synthesis:none}
</style><body><main id="screen" data-cols="${info.cols}" data-rows="${info.rows}" data-cell-width="10" data-cell-height="20">${html}</main></body></html>`)
  captures.push({ stage, ...info, cursor, capturedAt: new Date().toISOString(), plain: `${out}${stage}.txt`, html: `${out}${stage}.html`, cursorFile: `${out}${stage}.cursor.json` })
  return plain
}

try {
  const created = sessions.create(name, { cols: 120, rows: 40, cwd: tuiDir, env }, command[0]!, command.slice(1))
  pid = created.pid
  assert(processes().some((proc) => proc.id === pid && proc.session === pid), "PTY child must own a new OS session")
  await track()
  timer = setInterval(() => { void track().catch((error) => console.error("Process audit:", error)) }, 500)
  console.log(JSON.stringify({ checkpoint: name, command, cwd: tuiDir, pid, out }))
  await until("home UI or first-run provider dialog", () => {
    const text = sessions.screen(name)
    return text.includes("commands") && (text.includes("Ask anything") || text.includes("Connect a provider"))
  })
  // The isolated, credential-free first run opens onboarding; Escape only dismisses it.
  if (sessions.screen(name).includes("Connect a provider")) sessions.write(name, "\x1b")
  await until("full home prompt and command hints", () => {
    const text = sessions.screen(name)
    return text.includes("Ask anything") && text.includes("tab agents") && text.includes("ctrl+p commands")
  }, 10000)
  await Bun.sleep(1000)
  await capture("initial")
  assert(!/[\r\n\x1b]/.test(input), "Smoke input must never submit or invoke controls")
  sessions.write(name, input)
  await until("unsubmitted typed text", () => sessions.screen(name).includes(input), 10000)
  const before = await capture("input")
  const beforeColumn = before.split("\n").find((line) => line.includes(input))!.indexOf(input)
  sessions.resize(name, 100, 32)
  await until("TUI resize/recenter with input retained", () => {
    const text = sessions.screen(name)
    const line = text.split("\n").find((line) => line.includes(input))
    return !!line && line.indexOf(input) !== beforeColumn && text.includes("commands")
  }, 10000)
  const after = await capture("resized")
  assert.equal(sessions.info(name).cols, 100)
  assert.equal(sessions.info(name).rows, 32)
  assert(after.split("\n").every((line) => Bun.stringWidth(line) <= 100), "Screen exceeds resized columns")
  assert(after.split("\n").length <= 32, "Screen exceeds resized rows")
  result = "passed"
  if (process.argv.includes("--serve")) {
    const finished = Promise.withResolvers<void>()
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const route = new URL(request.url).pathname
        if (route === "/finish" && request.method === "POST") {
          finished.resolve()
          return new Response("Capture complete; disposing owned TUI")
        }
        if (request.method !== "GET" || !/^\/(initial|input|resized)\.(html|txt)$/.test(route)) {
          return new Response("Not found", { status: 404 })
        }
        return new Response(Bun.file(`${out}${route.slice(1)}`))
      },
    })
    const ready = { checkpoint: name, result, command, cwd: tuiDir, pid, out, url: server.url.toString(), captures }
    await Bun.write(`${out}ready.json`, JSON.stringify(ready, null, 2))
    console.log(JSON.stringify(ready))
    // A bounded hold keeps the same TUI alive during external browser capture.
    let hold: ReturnType<typeof setTimeout> | undefined
    await Promise.race([finished.promise, new Promise<void>((resolve) => { hold = setTimeout(resolve, 300000) })])
    clearTimeout(hold)
    assert(!sessions.info(name).exited, "TUI exited during browser capture hold")
  }
} catch (error) {
  result = "failed"
  blocker = error instanceof Error ? error.stack : String(error)
  if (sessions.list().length) {
    await Bun.write(`${out}failure.txt`, sessions.screen(name))
    await Bun.write(`${out}failure-native.html`, sessions.screen(name, "html"))
  }
  console.error(blocker)
  process.exitCode = 1
} finally {
  server?.stop(true)
  clearInterval(timer)
  if (pid) await track()
  // Only signal identities observed in this freshly-created PTY session/tree.
  for (const [id, start] of owned) {
    if (await identity(id) !== start) continue
    try { process.kill(id, "SIGTERM") } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
  await Bun.sleep(500)
  for (const [id, start] of owned) {
    if (await identity(id) !== start) continue
    try { process.kill(id, "SIGKILL") } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
  sessions.close()
  unloadLibrary()
  await Bun.sleep(500)
  const remaining = []
  for (const [id, start] of owned) {
    if (await identity(id) === start) remaining.push(id)
  }
  if (remaining.length) { result = "failed"; process.exitCode = 1 }
  const report = { checkpoint: name, result, blocker, command, cwd: tuiDir, input, submitted: false,
    isolation: "Fresh HOME/XDG; no inherited credentials; project config disabled; --pure; no enabled providers",
    captures, ownedPids: [...owned.keys()], remainingPids: remaining, nativeUnloaded: true,
    limitations: "Ghostty HTML cell-state rendering, not GPU pixel-identical; browser PNG capture is external; no network-level traffic audit" }
  await Bun.write(`${out}result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ result, out, remaining }))
}
