import { afterEach, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { GhosttyTerminal, type ExitEvent } from "../src/index"
import { createTerminal, freeTerminal, setWritePty, unloadLibrary, writeTerminal } from "../src/ffi/bindings"
import { packageDir } from "../src/build/lib"
import type { Proc } from "../../core/src/pty/pty"

const terminals: GhosttyTerminal[] = []
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
  unloadLibrary()
})

function session(cols = 80, rows = 24) {
  const terminal = new GhosttyTerminal({ cols, rows, cwd: "/tmp", env: { PATH: process.env.PATH!, TERM: "xterm-256color", PROOF: "value with spaces" } })
  terminals.push(terminal)
  let raw = ""
  let exit: ExitEvent | undefined
  terminal.onData((data) => { raw += data })
  terminal.onExit((event) => { exit = event })
  // Compile-time proof: no async spawn/Promise adapter is needed for core's Proc.
  const proc: Proc = terminal
  return { terminal, proc, raw: () => raw, exit: () => exit }
}

async function until(predicate: () => boolean, context: () => string = () => "", timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${context()}`)
    await Bun.sleep(10)
  }
}

function gone(pid: number) {
  try { process.kill(pid, 0); return false } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return true
    throw cause
  }
}

test("real shell has TTY stdin/stdout, real pid, cwd/env/argv, raw ANSI, and final Ghostty screen", async () => {
  const s = session(30, 6)
  expect(s.proc.pid).toBe(0)
  const result = s.terminal.spawn("/bin/sh", ["-c", `
    test -t 0 && test -t 1 || exit 91
    printf 'TTY:%s:%s:%s:%s\n' "$$" "$PWD" "$PROOF" "$1"
    printf '\x1b[2J\x1b[H\x1b[38;2;255;0;0mRED\x1b[0m\x1b[3;5Hcafé\x1b[1;2H!'
    exit 7
  `, "proof", "argument with 'quotes'"])
  expect(result).toBeUndefined()
  expect(s.proc.pid).toBeGreaterThan(0)
  await until(() => !!s.exit(), s.raw)
  expect(s.exit()).toEqual({ exitCode: 7, code: 7 })
  expect(s.raw()).toContain(`TTY:${s.proc.pid}:/tmp:value with spaces:argument with 'quotes'`)
  expect(s.raw()).toContain("\x1b[38;2;255;0;0mRED\x1b[0m")
  expect(s.terminal.readScreen()).toBe("R!D\n\n    café")
  expect(s.terminal.readScreen("html")).toContain("color: rgb(255, 0, 0)")
  expect(() => s.terminal.write("after exit")).toThrow("exited")
  await until(() => gone(s.proc.pid))
})

test("typed input reaches the shell; PTY and Ghostty both resize", async () => {
  const s = session(20, 6)
  s.terminal.spawn("/bin/sh", ["-c", `
    stty -echo
    printf 'READY\n'
    IFS= read -r line
    printf 'INPUT:%s\n' "$line"
    stty size
    IFS= read -r line
    printf 'SIZE:'; stty size
    printf '\x1b[2J\x1b[H123456789AB'
    exit 0
  `])
  await until(() => s.raw().includes("READY"), s.raw)
  s.terminal.write("hello 'typed'\r")
  await until(() => s.raw().includes("6 20"), s.raw)
  expect(s.raw()).toContain("INPUT:hello 'typed'")
  expect(() => s.terminal.resize(0, 4)).toThrow(RangeError)
  s.terminal.resize(10, 4)
  expect([s.terminal.cols, s.terminal.rows]).toEqual([10, 4])
  s.terminal.write("continue\r")
  await until(() => !!s.exit(), s.raw)
  expect(s.raw()).toContain("SIZE:4 10")
  expect(s.terminal.readScreen()).toBe("123456789A\nB")
})

test("WRITE_PTY answers real shell cursor and status queries in order", async () => {
  const s = session()
  s.terminal.spawn("/bin/bash", ["--noprofile", "--norc", "-c", `
    stty -echo -icanon min 1 time 0
    printf '\x1b[4;7H\x1b[6n\x1b[5n'
    IFS= read -r -d R -t 3 cursor || exit 81
    IFS= read -r -d n -t 3 status || exit 82
    [[ "$cursor" == $'\x1b[4;7' && "$status" == $'\x1b[0' ]] || exit 83
    printf '\x1b[2J\x1b[HQUERY_OK'
    exit 0
  `])
  await until(() => !!s.exit(), s.raw)
  expect(s.exit()?.exitCode).toBe(0)
  expect(s.raw()).toContain("\x1b[6n\x1b[5n")
  expect(s.terminal.readScreen()).toBe("QUERY_OK")
})

test("bun-pty streaming-decoded strings feed Ghostty and split UTF-8 characters survive", async () => {
  const s = session()
  s.terminal.spawn("/bin/sh", ["-c", "stty -echo; printf '\x1b[2J\x1b[Hcaf\\303'; IFS= read -r x; printf '\\251'; exit 0"])
  await until(() => s.raw().includes("caf"), s.raw)
  s.terminal.write("go\r")
  await until(() => !!s.exit(), s.raw)
  expect(s.raw()).toBe("\x1b[2J\x1b[Hcafé")
  expect(s.terminal.readScreen()).toBe("café")
})

test("styled HTML preserves truecolor background and escapes text", async () => {
  const s = session()
  s.terminal.spawn("/bin/sh", ["-c", "printf '\x1b[1;38;2;12;34;56;48;2;65;43;21m<&>\x1b[0m'"])
  await until(() => !!s.exit(), s.raw)
  expect(s.terminal.readScreen()).toBe("<&>")
  const html = s.terminal.readScreen("html")
  expect(html).toContain("rgb(12, 34, 56)")
  expect(html).toContain("rgb(65, 43, 21)")
  expect(html).toContain("font-weight: bold")
  expect(html).toContain("&lt;&amp;&gt;")
})

for (const signal of ["SIGTERM", undefined]) {
  test(`real ${signal ?? "default SIGTERM"} drains trap output before one exit 42`, async () => {
    const s = session()
    let count = 0
    let outputAtExit = ""
    s.terminal.onExit(() => { count++; outputAtExit = s.raw() })
    s.terminal.spawn("/bin/bash", ["--noprofile", "--norc", "-c", `
      stty -echo
      trap 'printf TRAPPED; exit 42' TERM
      printf READY
      while :; do read -r line; done
    `])
    await until(() => s.raw().includes("READY"), s.raw)
    s.terminal.kill(signal)
    expect(s.exit()).toBeUndefined() // signal delivery must not synthesize exit
    await until(() => !!s.exit(), s.raw)
    expect(outputAtExit).toBe("READYTRAPPED")
    expect(s.terminal.readScreen()).toBe("READYTRAPPED")
    expect(s.exit()).toEqual({ exitCode: 42, code: 42 })
    await until(() => gone(s.proc.pid))
    expect(() => s.terminal.kill("SIGTERM")).toThrow("exited")
    s.terminal.dispose()
    await Bun.sleep(30)
    expect(count).toBe(1)
  })
}

test.skipIf(process.platform !== "linux")("SIGSTOP pauses and SIGCONT resumes only the owned child without exit", async () => {
  const s = session()
  const other = session()
  const script = "stty -echo; printf READY; while IFS= read -r line; do printf 'ACK:%s' \"$line\"; done"
  s.terminal.spawn("/bin/bash", ["--noprofile", "--norc", "-c", script])
  other.terminal.spawn("/bin/bash", ["--noprofile", "--norc", "-c", script])
  await until(() => s.raw() === "READY" && other.raw() === "READY")
  const status = () => readFileSync(`/proc/${s.proc.pid}/status`, "utf8")
  expect(status()).toContain(`PPid:\t${process.pid}\n`)
  s.terminal.kill("SIGSTOP")
  await until(() => /^State:\s+T/m.test(status()), status)
  s.terminal.write("paused\r")
  other.terminal.write("unaffected\r")
  await until(() => other.raw().includes("ACK:unaffected"), other.raw)
  await Bun.sleep(100)
  expect(s.exit()).toBeUndefined()
  expect(s.raw()).toBe("READY")
  s.terminal.kill("SIGCONT")
  await until(() => s.raw().includes("ACK:paused"), s.raw)
  expect(s.exit()).toBeUndefined()
  expect(other.exit()).toBeUndefined()
  s.terminal.dispose()
  other.terminal.dispose()
  await until(() => gone(s.proc.pid) && gone(other.proc.pid))
})

test("unsupported signals throw without affecting the child; SIGKILL uses natural exit", async () => {
  const s = session()
  s.terminal.spawn("/bin/sh", ["-c", "printf READY; exec sleep 30"])
  await until(() => s.raw().includes("READY"), s.raw)
  for (const signal of ["SIGFAKE", "", "0", "toString"]) {
    expect(() => s.terminal.kill(signal)).toThrow("not supported")
  }
  expect(s.exit()).toBeUndefined()
  expect(gone(s.proc.pid)).toBe(false)
  s.terminal.kill("SIGKILL")
  expect(s.exit()).toBeUndefined()
  await until(() => !!s.exit(), s.raw)
  // bun-pty's natural exit exposes code 1 for signal death, not the OS signal.
  expect(s.exit()).toEqual({ exitCode: 1, code: 1 })
  await until(() => gone(s.proc.pid))
})

test.skipIf(process.platform !== "linux")("signal exit and stopped-child disposal release owned processes and PTY fds", async () => {
  // Warm the native libraries/read loop before measuring process-wide descriptors.
  const warm = session()
  warm.terminal.spawn("/bin/sh", ["-c", "exit 0"])
  await until(() => !!warm.exit())
  warm.terminal.dispose()
  const fds = () => readdirSync("/proc/self/fd").length
  const baseline = fds()
  for (let i = 0; i < 4; i++) {
    const s = session()
    s.terminal.spawn("/bin/bash", ["--noprofile", "--norc", "-c",
      "trap 'printf FINAL; exit 42' TERM; printf READY; while :; do read -r line; done"])
    await until(() => s.raw().includes("READY"), s.raw)
    if (i % 2 === 0) {
      s.terminal.kill()
      await until(() => !!s.exit(), s.raw)
      expect(s.raw()).toBe("READYFINAL")
      expect(s.exit()?.code).toBe(42)
      // The transport closes before explicit engine disposal, but Bun reaps
      // child bookkeeping (e.g. pidfds) asynchronously, so allow brief settling.
      await until(() => fds() === baseline, () => `fds=${fds()} baseline=${baseline}`, 2000)
      expect(fds()).toBe(baseline)
    } else {
      s.terminal.kill("SIGSTOP")
      await until(() => /^State:\s+T/m.test(readFileSync(`/proc/${s.proc.pid}/status`, "utf8")))
    }
    s.terminal.dispose()
    s.terminal.dispose()
    await until(() => gone(s.proc.pid))
    expect(fds()).toBe(baseline)
  }
})

test("disposal kills the child, cancels queued query replies, detaches listeners, and is idempotent", async () => {
  const s = session()
  let callbacks = 0
  s.terminal.onData(() => { callbacks++; s.terminal.dispose() })
  s.terminal.spawn("/bin/sh", ["-c", "stty -echo -icanon; printf '\x1b[6n'; exec sleep 30"])
  await until(() => callbacks === 1, s.raw)
  s.terminal.dispose()
  await until(() => gone(s.terminal.pid))
  expect(s.exit()).toBeUndefined()
  expect(callbacks).toBe(1)
  expect(() => s.terminal.readScreen()).toThrow("disposed")
  expect(() => s.terminal.write("x")).toThrow("disposed")
  expect(() => s.terminal.resize(10, 10)).toThrow("disposed")
  expect(() => s.terminal.spawn("/bin/sh")).toThrow("disposed")
})

test("multiple engines are independent; live ownership prevents unload", async () => {
  const a = session()
  const b = session()
  expect(() => unloadLibrary()).toThrow("live terminals")
  a.terminal.dispose()
  b.terminal.spawn("/bin/sh", ["-c", "printf SURVIVOR"])
  await until(() => !!b.exit(), b.raw)
  expect(b.terminal.readScreen()).toBe("SURVIVOR")
  expect(() => b.terminal.spawn("/bin/sh")).toThrow("already spawned")
})

test("invalid creation and spawn failure do not leak native owners", () => {
  expect(() => new GhosttyTerminal({ cols: NaN, rows: 3 })).toThrow(RangeError)
  const s = session()
  expect(() => s.terminal.write("x")).toThrow("not spawned")
  expect(() => s.terminal.spawn("/no/such/ghostty-test-shell")).toThrow("Failed to spawn")
  expect(() => s.terminal.readScreen()).toThrow("disposed")
  unloadLibrary()
})

test("callback bytes are copied and remain valid after subsequent VT writes/free", () => {
  const terminal = createTerminal(20, 5)
  const replies: Uint8Array[] = []
  try {
    setWritePty(terminal, (data) => { replies.push(data) })
    writeTerminal(terminal, new TextEncoder().encode("\x1b[2;3H\x1b[6n"))
    writeTerminal(terminal, new TextEncoder().encode("\x1b[5n"))
  } finally { freeTerminal(terminal) }
  expect(replies.map((data) => new TextDecoder().decode(data))).toEqual(["\x1b[2;3R", "\x1b[0n"])
  freeTerminal(terminal)
  expect(() => writeTerminal(terminal, new Uint8Array([65]))).toThrow("freed")
})

test("package construction explicitly fails without native engine (isolated source copy, no mocks)", async () => {
  // A sibling of src inherits declared package dependencies, but has no native directory.
  const directory = await mkdtemp(join(packageDir, ".missing-engine-"))
  try {
    await cp(join(packageDir, "src"), join(directory, "src"), { recursive: true })
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { GhosttyTerminal } from ${JSON.stringify(join(directory, "src/index.ts"))};
      try { new GhosttyTerminal({cols:80,rows:24}); process.exit(91) }
      catch (error) {
        if (!String(error).includes("Failed to load libghostty-vt")) throw error;
        console.log("MISSING_ENGINE_REJECTED");
      }
    `], { cwd: packageDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("MISSING_ENGINE_REJECTED")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
