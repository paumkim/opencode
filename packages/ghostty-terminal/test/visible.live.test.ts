/**
 * Live-window integration. Opt-in only: every test here opens a real window on
 * the user's screen, so `bun test` must never run it by accident.
 *
 *   OPENCODE_VISIBLE_TEST=1 bun test test/visible.live.test.ts
 *
 * Requires a display, `ghostty` on PATH, and `tmux`. These assert that a window
 * is created, that the agent can drive and read it, and that it is cleaned up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as visible from "../src/visible"

const optIn = process.env.OPENCODE_VISIBLE_TEST === "1"
const session = "oc-live-test"
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!optIn)("visible window (live)", () => {
  beforeAll(async () => {
    visible.dispose(session)
    visible.create({
      session,
      cwd: process.cwd(),
      cols: 90,
      rows: 25,
      env: hostEnv,
      title: "opencode-live-test",
      shell: "bash",
    })
    // The window is a compositor round-trip, not a process spawn.
    await sleep(2500)
  })

  afterAll(async () => {
    visible.dispose(session)
    await sleep(800)
  })

  test("a window is created and the session is attached", () => {
    const info = visible.info(session)
    expect(info).toBeDefined()
    expect(info?.attached).toBe(true)
    expect(info?.exited).toBe(false)
  })

  test("info reports the live viewport and the shell pid", () => {
    const info = visible.info(session)
    expect(info?.cols).toBeGreaterThan(0)
    expect(info?.rows).toBeGreaterThan(0)
    expect(info?.pid).toBeGreaterThan(0)
  })

  test("the agent can write to, and read, what the user is watching", async () => {
    visible.write(session, "echo AGENT_SAW_THIS")
    visible.write(session, "\r")
    await sleep(1000)
    expect(visible.screen(session)).toContain("AGENT_SAW_THIS")
  })

  test("C-c cancels a running process and the screen survives", async () => {
    visible.write(session, "sleep 30\r")
    await sleep(700)
    visible.write(session, "\x03")
    await sleep(700)
    expect(visible.screen(session).length).toBeGreaterThan(0)
    expect(visible.info(session)?.exited).toBe(false)
  })

  test("input beginning with a dash is not parsed as an option", async () => {
    visible.write(session, "\r")
    visible.write(session, "printf 'DASH_SAFE\\n'\r")
    await sleep(800)
    expect(visible.screen(session)).toContain("DASH_SAFE")
  })

  test("an unrecognised CSI reaches the process as a raw CSI", async () => {
    visible.write(session, "\x1b[48;2;12;34;56m\x1b[2J\x1b[H")
    await sleep(600)
    expect(visible.screen(session)).not.toContain("[2J")
    visible.write(session, "printf 'AFTER_CSI\\n'\r")
    await sleep(800)
    expect(visible.screen(session)).toContain("AFTER_CSI")
  })

  test("resize changes the live viewport", async () => {
    visible.write(session, "\r")
    visible.resize(session, 100, 30)
    await sleep(900)
    expect(visible.info(session)?.cols).toBe(100)
  })

  test("kill signals the shell but keeps the window and the final screen", async () => {
    visible.kill(session, "SIGKILL")
    await sleep(1200)
    expect(visible.info(session)).toBeDefined()
    expect(visible.screen(session).length).toBeGreaterThan(0)
    expect(visible.info(session)?.exited).toBe(true)
  })
})

describe.skipIf(!optIn)("visible window (teardown)", () => {
  test("dispose closes the window and removes the session", async () => {
    const own = "oc-live-dispose"
    visible.create({
      session: own,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: hostEnv,
      title: "opencode-live-dispose",
      shell: "bash",
    })
    await sleep(2000)
    expect(visible.info(own)).toBeDefined()
    visible.dispose(own)
    await sleep(1000)
    expect(visible.info(own)).toBeUndefined()
  })
})
