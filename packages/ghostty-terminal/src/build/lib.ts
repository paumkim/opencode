import { mkdir, copyFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { detectPlatform } from "./detect.ts"

export const ghosttyRevision = "f9a3f24a56bf05f70894e1a084809d4fffadf420"
export const zigVersion = "0.16.0"
export const packageDir = fileURLToPath(new URL("../../", import.meta.url))

export interface BuildResult {
  success: boolean
  libraryPath: string | null
  zigVersion: string | null
  durationMs: number
  error?: string
}

// Explicit builds only. Source acquisition is a separate, user-initiated git
// submodule update; Zig may fetch hash-pinned upstream dependencies here.
export async function buildLib(): Promise<BuildResult> {
  const start = performance.now()
  try {
    const platform = detectPlatform()
    const source = join(packageDir, "zig", "ghostty")
    if (!(await Bun.file(join(source, "build.zig.zon")).exists())) {
      throw new Error(
        "Initialize source from repo root: git submodule update --init -- packages/ghostty-terminal/zig/ghostty",
      )
    }
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: source })
    if (revision.exitCode !== 0 || revision.stdout.toString().trim() !== ghosttyRevision) {
      throw new Error(`Ghostty source must be pinned to ${ghosttyRevision}`)
    }
    const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], { cwd: source })
    if (dirty.exitCode !== 0 || dirty.stdout.length !== 0) {
      throw new Error("Ghostty submodule must be clean for a reproducible build")
    }
    const zon = await Bun.file(join(source, "build.zig.zon")).text()
    if (!zon.includes(`.minimum_zig_version = "${zigVersion}"`)) {
      throw new Error("Upstream Zig requirement differs from the package pin")
    }
    const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
    const local = join(
      packageDir,
      ".toolchains",
      `zig-${arch}-${os}-${zigVersion}`,
      process.platform === "win32" ? "zig.exe" : "zig",
    )
    const zig = process.env.ZIG ?? ((await Bun.file(local).exists()) ? local : "zig")
    const version = Bun.spawnSync([zig, "version"])
    if (version.exitCode !== 0 || version.stdout.toString().trim() !== zigVersion) {
      throw new Error(`Zig ${zigVersion} required. Install locally in .toolchains or set ZIG to the executable.`)
    }
    const native = join(packageDir, "native")
    await mkdir(native, { recursive: true })
    const args = [
      "build",
      "-Demit-lib-vt=true",
      "-Doptimize=ReleaseFast",
      "-Dcpu=baseline",
      "-Demit-xcframework=false",
      "--prefix",
      native,
      "--global-cache-dir",
      join(packageDir, ".toolchains", "cache"),
      "--summary",
      "all",
      "-j2",
    ]
    console.log(`Ghostty ${ghosttyRevision}\n${zig} ${args.join(" ")}\ncwd: ${source}`)
    // Inherit both streams to avoid sequential pipe-draining deadlocks.
    const proc = Bun.spawn([zig, ...args], { cwd: source, stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    if (code !== 0) throw new Error(`Zig build failed with exit code ${code}`)
    const artifact = join(native, process.platform === "win32" ? "bin" : "lib", platform.libraryFilename)
    const libraryPath = join(native, platform.libraryFilename)
    await copyFile(artifact, libraryPath)
    await copyFile(join(packageDir, "src", "ffi", "formatter.c"), join(native, "formatter.c"))
    await Bun.write(join(native, "zig-version"), `${zigVersion}\n`)
    await Bun.write(
      join(native, "build-info.json"),
      JSON.stringify(
        {
          ghosttyRevision,
          zigVersion,
          zig,
          platform: process.platform,
          arch: process.arch,
          args,
          artifact,
          libraryPath,
          sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(libraryPath).arrayBuffer()).digest("hex"),
        },
        null,
        2,
      ) + "\n",
    )
    return { success: true, libraryPath, zigVersion, durationMs: performance.now() - start }
  } catch (error) {
    return {
      success: false,
      libraryPath: null,
      zigVersion: null,
      durationMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

if (import.meta.main) {
  const result = await buildLib()
  if (!result.success) {
    console.error(result.error)
    process.exit(1)
  }
  console.log(`Built ${result.libraryPath} in ${result.durationMs.toFixed(0)}ms`)
}
