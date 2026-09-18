import { describe, it, expect } from "bun:test"
import { join } from "node:path"
import { packageDir, ghosttyRevision, zigVersion } from "../src/build/lib.ts"

it("postinstall does not invoke a compiler or acquire source", () => {
  const result = Bun.spawnSync([process.execPath, "run", "scripts/postinstall.ts"], {
    cwd: packageDir,
    env: { ...process.env, ZIG: "/missing/zig", PATH: "/missing" },
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("native build is manual")
})

// Native checks are deliberately explicit: ordinary install/test must not fetch
// source or build a library. This suite fails (never silently skips) if requested
// before build:lib and setup:native. Linux requires cc, nm, and Python 3 with
// venv/pip support. Only setup:native installs pinned ABI verifier dependencies.
describe.skipIf(process.env.GHOSTTY_NATIVE_TEST !== "1")("real upstream native library", () => {
  const native = join(packageDir, "native")
  const source = join(packageDir, "zig", "ghostty")
  const library = join(native, "libghostty-vt.so")

  it("records the exact revision, toolchain, and artifact checksum", async () => {
    expect(process.platform).toBe("linux")
    const info = await Bun.file(join(native, "build-info.json")).json()
    expect(info.ghosttyRevision).toBe(ghosttyRevision)
    expect(info.zigVersion).toBe(zigVersion)
    expect(info.sha256).toBe(new Bun.CryptoHasher("sha256").update(await Bun.file(library).arrayBuffer()).digest("hex"))
  })

  it("exports real VT APIs and no invented process manager", () => {
    const result = Bun.spawnSync(["nm", "-D", "--defined-only", library])
    expect(result.exitCode).toBe(0)
    const symbols = result.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1))
    for (const symbol of [
      "ghostty_terminal_new",
      "ghostty_terminal_vt_write",
      "ghostty_terminal_resize",
      "ghostty_formatter_format_buf",
      "ghostty_render_state_update",
      "ghostty_snapshot_encode_alloc",
      "ghostty_snapshot_decoder_ready",
    ])
      expect(symbols).toContain(symbol)
    expect(symbols.some((symbol) => symbol?.startsWith("ghostty_vt_"))).toBe(false)
  })

  it("passes upstream ABI type-schema verification", async () => {
    const python = join(packageDir, ".toolchains", "abi-venv", "bin", "python")
    if (!(await Bun.file(python).exists())) {
      throw new Error("Missing package-local ABI verifier environment; run bun run setup:native")
    }
    const result = Bun.spawnSync([
      python,
      "-I", // Ignore user site-packages and PYTHON* environment overrides.
      join(source, "src/terminal/c/types-schema-verify.py"),
      join(source, "src/terminal/c/types.schema.json"),
      library,
    ])
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    console.log(result.stdout.toString().trim())
  })

  for (const [example, output] of [
    ["formatter", "Line 3: Overwritten!"],
    ["snapshot", "primary history rows"],
    ["render", "Full redraw needed."],
  ]) {
    it(`compiles and executes upstream ${example} C example against installed headers/library`, () => {
      const executable = join(native, `verify-${example}`)
      const compile = Bun.spawnSync([
        // Upstream examples omit ABI enum sentinels in exhaustive switches.
        "cc",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-switch",
        join(source, `example/c-vt-${example}/src/main.c`),
        "-I",
        join(native, "include"),
        "-L",
        join(native, "lib"),
        `-Wl,-rpath,${join(native, "lib")}`,
        "-lghostty-vt",
        "-o",
        executable,
      ])
      expect(compile.stderr.toString()).toBe("")
      expect(compile.exitCode).toBe(0)
      const run = Bun.spawnSync([executable])
      expect(run.exitCode).toBe(0)
      expect(run.stdout.toString()).toContain(output!)
    })
  }
})
