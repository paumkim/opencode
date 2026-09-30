import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { dispose, screen, sessionName, sessionPrefix, toTmuxArgs, tmuxSocket, write, DEFAULT_TMUX_SOCKET, VisibleUnavailableError } from "../src/visible"

describe("toTmuxArgs", () => {
  // The return value is one inner array per `send-keys` invocation. `-l` is
  // command-scoped in tmux, so a literal run and a key name can never share an
  // invocation; the shape below is what keeps them apart.
  test("plain text becomes one literal run", () => {
    expect(toTmuxArgs("hello")).toEqual([["-l", "--", "hello"]])
  })

  test("a leading dash is not read as an option", () => {
    expect(toTmuxArgs("-echo hi")).toEqual([["-l", "--", "-echo hi"]])
  })

  test("carriage return and newline are Enter", () => {
    expect(toTmuxArgs("\r")).toEqual([["Enter"]])
    expect(toTmuxArgs("\n")).toEqual([["Enter"]])
  })

  test("control characters become control keys", () => {
    expect(toTmuxArgs("\x03")).toEqual([["C-c"]])
    expect(toTmuxArgs("\t")).toEqual([["Tab"]])
    expect(toTmuxArgs("\x7f")).toEqual([["BSpace"]])
    expect(toTmuxArgs("\x01")).toEqual([["C-a"]])
  })

  test("arrow keys become key names", () => {
    expect(toTmuxArgs("\x1b[A")).toEqual([["Up"]])
    expect(toTmuxArgs("\x1bOB")).toEqual([["Down"]])
  })

  test("an unrecognised CSI is forwarded as bytes, not shredded", () => {
    // The bug this guards: ESC [ 2 J was once turned into Escape + "[2J" typed
    // out as text, so a clear-screen became four visible keystrokes.
    expect(toTmuxArgs("\x1b[2J")).toEqual([["-l", "--", "\x1b[2J"]])
    expect(toTmuxArgs("\x1b[48;2;1;2;3m")).toEqual([["-l", "--", "\x1b[48;2;1;2;3m"]])
  })

  test("a lone escape is the Escape key", () => {
    expect(toTmuxArgs("\x1b")).toEqual([["Escape"]])
    expect(toTmuxArgs("ab\x1b")).toEqual([["-l", "--", "ab"], ["Escape"]])
  })

  test("a realistic command line splits into literal and key runs", () => {
    expect(toTmuxArgs("ls -la\r")).toEqual([["-l", "--", "ls -la"], ["Enter"]])
  })

  test("consecutive key names share the one invocation that can carry them", () => {
    // All-key input is one group: no `-l` is needed, so one call is enough.
    expect(toTmuxArgs("\r\r")).toEqual([["Enter", "Enter"]])
    expect(toTmuxArgs("\x1b[A\x1b[A\x1b[B")).toEqual([["Up", "Up", "Down"]])
  })

  test("a key run splits again as soon as literal text resumes", () => {
    expect(toTmuxArgs("ab\x03cd")).toEqual([["-l", "--", "ab"], ["C-c"], ["-l", "--", "cd"]])
  })

  test("no group ever mixes -l with a key name", () => {
    // The invariant behind the bug: one flat list let `-l` swallow the key
    // names, so `ls -la\r` typed the characters "ls -laEnter" instead of
    // running anything. Every group is a whole invocation, so it is one kind
    // of group or the other and never both.
    for (const data of ["hello", "ls -la\r", "\x03", "ab\x1b", "a\r\x1b[A\x03b\t", "\x1b[2J\r"]) {
      for (const group of toTmuxArgs(data)) {
        if (group[0] === "-l") {
          // A literal group is exactly ["-l", "--", run], with a non-empty run.
          expect(group).toEqual(["-l", "--", group[2]])
          expect((group[2] as string).length).toBeGreaterThan(0)
        } else {
          // A key group carries neither flag, so tmux still looks names up.
          expect(group).not.toContain("-l")
          expect(group).not.toContain("--")
        }
      }
    }
  })

  test("empty input produces no tmux call at all", () => {
    expect(toTmuxArgs("")).toEqual([])
  })
})

/**
 * `write` against a real tmux server.
 *
 * Unlike `visible.live.test.ts` this needs no display, no Ghostty, and opens no
 * window: a detached tmux session is enough, because `write` and `screen` speak
 * to tmux and never to the window. That is exactly why it belongs in the default
 * suite — it is the guard that catches a `write` which packs its arguments into
 * the wrong `send-keys` invocation, and nothing about that is visible to a unit
 * assertion. Skipped only when tmux itself is absent.
 */
const haveTmux = Bun.which("tmux") !== null
const tmuxSession = "oc-visible-tmux-unit"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!haveTmux)("write (real tmux)", () => {
  beforeAll(async () => {
    dispose(tmuxSession)
    // /bin/sh rather than the user's login shell, so the screen is the same on
    // every machine and holds no prompt, history or rc-file noise to match on.
    const created = Bun.spawnSync({
      cmd: ["tmux", "-L", tmuxSocket(), "new-session", "-d", "-s", tmuxSession, "-x", "80", "-y", "24", "/bin/sh"],
    })
    if (created.exitCode !== 0) {
      throw new Error(`tmux could not start a session: ${created.stderr.toString().trim() || created.exitCode}`)
    }
    await sleep(300)
  })

  afterAll(() => {
    dispose(tmuxSession)
  })

  test("text plus a carriage return runs the command instead of typing 'Enter'", async () => {
    // The regression. With one flat argument list, `-l` and `Enter` shared a
    // `send-keys` command line, so tmux sent the characters "Enter" and the
    // pane ran nothing. Every marker here is computed by the shell, so it can
    // only reach the screen if the command really executed.
    write(tmuxSession, "echo oc-ran-$((6*7))\r")
    await sleep(1200)
    const output = screen(tmuxSession)
    expect(output).toContain("oc-ran-42")
    expect(output).not.toContain("Enter")
    expect(output).not.toContain("not found")
  })

  test("a key-only write presses the key instead of typing its name", async () => {
    write(tmuxSession, "\r")
    await sleep(800)
    const output = screen(tmuxSession)
    expect(output).not.toContain("Enter")
    expect(output.length).toBeGreaterThan(0)
  })

  test("literal text still arrives verbatim, dash-leading included", async () => {
    write(tmuxSession, "echo -- -dash-$((2*5))\r")
    await sleep(1200)
    const output = screen(tmuxSession)
    expect(output).toContain("-dash-10")
    expect(output).not.toContain("Enter")
  })

  test("interleaved literal runs and control keys all reach the pane", async () => {
    // One write, four groups: literal, C-c, literal, Enter. The computed marker
    // proves the tail ran, i.e. no key was flattened into typed-out text.
    write(tmuxSession, "echo oc-head\x03echo oc-$((3*3))\r")
    await sleep(1200)
    const output = screen(tmuxSession)
    expect(output).toContain("oc-9")
    expect(output).not.toContain("Enter")
  })
})

describe("session naming", () => {
  test("different owners never collide on the same short name", () => {
    const a = sessionName("[\"ses_1\",\"build\"]", "main")
    const b = sessionName("[\"ses_2\",\"build\"]", "main")
    expect(a).not.toBe(b)
    expect(a.endsWith("-main")).toBe(true)
    expect(b.endsWith("-main")).toBe(true)
  })

  test("the same owner is stable across calls", () => {
    expect(sessionName("[\"ses_1\",\"build\"]", "main")).toBe(sessionName("[\"ses_1\",\"build\"]", "main"))
  })

  test("prefix lists exactly that owner's sessions", () => {
    const owner = "[\"ses_1\",\"build\"]"
    expect(sessionName(owner, "dev").startsWith(sessionPrefix(owner))).toBe(true)
  })

  test("names contain no character tmux rejects", () => {
    const name = sessionName('["ses:1/2","gen.eral"]', "a.b:c")
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("VisibleUnavailableError", () => {
  test("carries an actionable hint alongside the reason", () => {
    const error = new VisibleUnavailableError("no display here", "offer headless instead")
    expect(error.message).toBe("no display here")
    expect(error.hint).toBe("offer headless instead")
  })
})

describe("tmux socket isolation", () => {
  // tmuxSocket() memoises, so each env case is exercised in a child process
  // rather than by mutating process.env in place.
  function socketUnder(env: Record<string, string | undefined>) {
    return Bun.spawnSync({
      cmd: ["bun", "-e", `import { tmuxSocket } from "${import.meta.dir}/../src/visible.ts"; console.log(tmuxSocket())`],
      env: { ...process.env, ...env },
    })
      .stdout.toString()
      .trim()
  }

  test("defaults to a dedicated socket, not the shared one", () => {
    expect(DEFAULT_TMUX_SOCKET).not.toBe("default")
    expect(socketUnder({ OPENCODE_TMUX_SOCKET: undefined })).toBe(DEFAULT_TMUX_SOCKET)
  })

  test("an empty value falls back instead of producing a bare -L ''", () => {
    // `??` would keep "" here, and `tmux -L ""` fails with "Is a directory".
    expect(socketUnder({ OPENCODE_TMUX_SOCKET: "" })).toBe(DEFAULT_TMUX_SOCKET)
  })

  test("the shared 'default' server is refused outright", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `import { tmuxSocket } from "${import.meta.dir}/../src/visible.ts"; console.log(tmuxSocket())`],
      env: { ...process.env, OPENCODE_TMUX_SOCKET: "default" },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("shared tmux server")
  })

  test("a malformed socket name is refused rather than passed to tmux", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `import { tmuxSocket } from "${import.meta.dir}/../src/visible.ts"; console.log(tmuxSocket())`],
      env: { ...process.env, OPENCODE_TMUX_SOCKET: "bad name/with slash" },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("not a usable tmux socket name")
  })

  test("a custom dedicated socket is honoured", () => {
    expect(socketUnder({ OPENCODE_TMUX_SOCKET: "oc-custom" })).toBe("oc-custom")
  })

  test("the in-process resolver agrees with the default", () => {
    expect(tmuxSocket()).toBe(DEFAULT_TMUX_SOCKET)
  })
})
