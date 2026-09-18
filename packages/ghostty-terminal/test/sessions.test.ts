import { afterEach, expect, test } from "bun:test"
import { TerminalSessions } from "../src/sessions"
import { unloadLibrary } from "../src/ffi/bindings"
import { readdirSync, readlinkSync } from "node:fs"
import { fileURLToPath } from "node:url"

const registries: TerminalSessions[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  unloadLibrary()
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal screen")
    await Bun.sleep(10)
  }
}

test("named session persists across writes and captures the real shell viewport", async () => {
  const sessions = new TerminalSessions()
  registries.push(sessions)
  const created = sessions.create("shell", { cols: 80, rows: 24, cwd: "/tmp" }, "/bin/sh", [
    "-c", "stty -echo; printf READY; IFS= read -r line; printf '\\033[2J\\033[HINPUT:%s' \"$line\"; IFS= read -r line",
  ])
  expect(created.pid).toBeGreaterThan(0)
  await until(() => sessions.screen("shell").includes("READY"))
  sessions.write("shell", "hello persistent shell\r")
  await until(() => sessions.screen("shell") === "INPUT:hello persistent shell")
  expect(sessions.screen("shell", "html")).toContain("hello persistent shell")
  expect(sessions.list()).toEqual([created])
})

function registry() {
  const sessions = new TerminalSessions()
  registries.push(sessions)
  return sessions
}

function gone(pid: number) {
  try { process.kill(pid, 0); return false } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
    throw error
  }
}

test("resize reaches stty, kill retains final HTML screen, dispose is idempotent", async () => {
  const sessions = registry()
  const created = sessions.create("size", { cols: 80, rows: 24 }, "/bin/bash", ["--noprofile", "--norc", "-c",
    "stty -echo; trap 'printf FINAL; exit 42' TERM; printf READY; while IFS= read -r x; do stty size; done"])
  await until(() => sessions.screen("size").includes("READY"))
  sessions.resize("size", 40, 10)
  sessions.write("size", "size\r")
  await until(() => sessions.screen("size").includes("10 40"))
  expect(sessions.info("size")).toMatchObject({ cols: 40, rows: 10 })
  sessions.kill("size")
  await until(() => sessions.info("size").exited)
  expect(sessions.info("size").exitCode).toBe(42)
  expect(sessions.screen("size", "html")).toContain("FINAL")
  expect(() => sessions.write("size", "x")).toThrow("exited")
  sessions.dispose("size")
  sessions.dispose("size")
  expect(sessions.list()).toEqual([])
  expect(() => sessions.screen("size")).toThrow("Unknown")
  await until(() => gone(created.pid))
})

test("concurrent duplicate creation, independent names/owners, close cannot resurrect", async () => {
  const sessions = registry()
  const other = registry()
  const create = () => sessions.create("same", { cols: 20, rows: 5 }, "/bin/sh", ["-c", "printf READY; read x"])
  const results = await Promise.allSettled([Promise.resolve().then(create), Promise.resolve().then(create)])
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1)
  other.create("same", { cols: 20, rows: 5 }, "/bin/sh", ["-c", "printf OTHER; read x"])
  await until(() => other.screen("same") === "OTHER")
  sessions.close()
  expect(other.screen("same")).toBe("OTHER")
  expect(() => create()).toThrow("closed")
  expect(() => sessions.write("same", "x")).toThrow("closed")
})

test("invalid creation/spawn fails without owners or exit listeners", () => {
  const sessions = registry()
  const listeners = process.listenerCount("exit")
  expect(() => sessions.create("bad/name", { cols: 20, rows: 5 }, "/bin/sh")).toThrow("name")
  expect(() => sessions.create("bad", { cols: 501, rows: 5 }, "/bin/sh")).toThrow("dimensions")
  expect(() => sessions.create("bad", { cols: 20, rows: 5 }, "/missing/ghostty-shell")).toThrow("spawn")
  expect(sessions.list()).toEqual([])
  expect(process.listenerCount("exit")).toBe(listeners)
  unloadLibrary()
})

test.skipIf(process.platform !== "linux")("disposeAll releases child PIDs, PTY descriptors, native owners and exit listeners", async () => {
  const sessions = registry()
  sessions.create("warm", { cols: 20, rows: 5 }, "/bin/sh", ["-c", "exit 0"])
  await until(() => sessions.info("warm").exited)
  sessions.disposeAll()
  // Other tests/Bun may lazily open source files; measure owned PTY descriptors,
  // not unrelated process-wide descriptors. Native ownership is checked by unloadLibrary.
  const ptys = () => readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`)
      return target.includes("/dev/pts/") || target.includes("/dev/ptmx") ? [target] : []
    } catch { return [] } // The directory enumeration descriptor may already be closed.
  }).sort()
  const fds = ptys()
  const listeners = process.listenerCount("exit")
  for (let i = 0; i < 4; i++) {
    const item = sessions.create("child", { cols: 20, rows: 5 }, "/bin/sh", ["-c", "printf READY; read x"])
    await until(() => sessions.screen("child") === "READY")
    sessions.disposeAll()
    await until(() => gone(item.pid))
    expect(ptys()).toEqual(fds)
    expect(process.listenerCount("exit")).toBe(listeners)
    expect(sessions.list()).toEqual([])
  }
  unloadLibrary()
})

test("process.exit disposes registered terminals in a separate Bun process", async () => {
  const source = fileURLToPath(new URL("../src/sessions.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, "-e", `
    import { TerminalSessions } from ${JSON.stringify(source)};
    const sessions = new TerminalSessions();
    const child = sessions.create('exit', {cols:20,rows:5}, '/bin/sh', ['-c', 'read x']);
    console.log(child.pid);
    process.exit(0);
  `], { stdout: "pipe", stderr: "pipe" })
  const pid = Number((await new Response(child.stdout).text()).trim())
  expect(await child.exited).toBe(0)
  expect(pid).toBeGreaterThan(0)
  await until(() => gone(pid))
})
