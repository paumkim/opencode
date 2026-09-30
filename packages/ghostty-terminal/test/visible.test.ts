import { describe, expect, test } from "bun:test"
import { sessionName, sessionPrefix, toTmuxArgs, tmuxSocket, DEFAULT_TMUX_SOCKET, VisibleUnavailableError } from "../src/visible"

describe("toTmuxArgs", () => {
  test("plain text becomes one literal run", () => {
    expect(toTmuxArgs("hello")).toEqual(["-l", "--", "hello"])
  })

  test("a leading dash is not read as an option", () => {
    expect(toTmuxArgs("-echo hi")).toEqual(["-l", "--", "-echo hi"])
  })

  test("carriage return and newline are Enter", () => {
    expect(toTmuxArgs("\r")).toEqual(["Enter"])
    expect(toTmuxArgs("\n")).toEqual(["Enter"])
  })

  test("control characters become control keys", () => {
    expect(toTmuxArgs("\x03")).toEqual(["C-c"])
    expect(toTmuxArgs("\t")).toEqual(["Tab"])
    expect(toTmuxArgs("\x7f")).toEqual(["BSpace"])
    expect(toTmuxArgs("\x01")).toEqual(["C-a"])
  })

  test("arrow keys become key names", () => {
    expect(toTmuxArgs("\x1b[A")).toEqual(["Up"])
    expect(toTmuxArgs("\x1bOB")).toEqual(["Down"])
  })

  test("an unrecognised CSI is forwarded as bytes, not shredded", () => {
    // The bug this guards: ESC [ 2 J was once turned into Escape + "[2J" typed
    // out as text, so a clear-screen became four visible keystrokes.
    expect(toTmuxArgs("\x1b[2J")).toEqual(["-l", "--", "\x1b[2J"])
    expect(toTmuxArgs("\x1b[48;2;1;2;3m")).toEqual(["-l", "--", "\x1b[48;2;1;2;3m"])
  })

  test("a lone escape is the Escape key", () => {
    expect(toTmuxArgs("\x1b")).toEqual(["Escape"])
    expect(toTmuxArgs("ab\x1b")).toEqual(["-l", "--", "ab", "Escape"])
  })

  test("a realistic command line splits into literal and key runs", () => {
    expect(toTmuxArgs("ls -la\r")).toEqual(["-l", "--", "ls -la", "Enter"])
  })

  test("empty input produces no tmux call at all", () => {
    expect(toTmuxArgs("")).toEqual([])
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
