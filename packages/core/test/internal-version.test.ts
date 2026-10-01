import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import {
  bumpInternalVersion,
  internalVersion,
  InternalVersionFile,
  readInternalVersion,
  validateInternalVersion,
} from "../src/installation/internal-version"
import { ConsoleAgentSegment, ConsoleVersion, InstallationVersion } from "../src/installation/version"
import consolePkg from "../../console/app/package.json"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temporary() {
  const dir = await mkdtemp("/tmp/opencode/internal-version-")
  dirs.push(dir)
  return dir
}

import pkg from "../package.json"
// `readPackageVersion` deliberately prefers `packages/opencode/package.json` -- the package the
// binary is actually published from and the one the daemon's compiled-artifact check compares
// against -- and only falls back to this package's own version, then to a pinned constant. Import
// both so the resolution order is asserted rather than assumed.
import opencodePkg from "../../opencode/package.json"

test("internal bumps reset lower components without changing compatibility version", () => {
  const compatibility = InstallationVersion
  expect(bumpInternalVersion("0.1.0\n", "patch")).toBe("0.1.1")
  expect(bumpInternalVersion("2.3.4", "minor")).toBe("2.4.0")
  expect(bumpInternalVersion("2.3.4", "major")).toBe("3.0.0")
  expect(InstallationVersion).toBe(compatibility)
  // The compatibility version is the opencode package's, not this package's. Asserting it against
  // `pkg.version` only passed while the two happened to be equal, and broke the moment a release
  // bumped `packages/opencode/package.json` alone -- which is what a release does, since only that
  // package ships the binary. Comparing them here would have kept failing on every release bump
  // while telling us nothing about the resolver.
  expect(InstallationVersion).toBe(opencodePkg.version)
  // Guard the premise: if the two ever stop differing, this test is no longer distinguishing
  // anything, and the assertion above would pass for the wrong reason again.
  expect(opencodePkg.version).not.toBe("0.0.0-local")
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
})

test("the console version reaches the User-Agent as its own segment", () => {
  // A source checkout has the console app next to it, so the segment is populated -- and it has to
  // be the console's own version, not a copy of the installer's: the two are released separately
  // and a header claiming otherwise sends every console-hosted request to the wrong cohort.
  expect(ConsoleVersion).toBe(consolePkg.version)
  expect(ConsoleAgentSegment).toBe(` console/${consolePkg.version}`)
  // Leading space is load-bearing: this is spliced straight after the installer version, so a
  // missing one has to collapse to nothing rather than leave a double space in the header.
  expect(ConsoleAgentSegment.startsWith(" ")).toBe(true)
  expect(`opencode/${InstallationVersion}${ConsoleAgentSegment}`).not.toContain("  ")
})

test("an absent console leaves the User-Agent byte-identical", async () => {
  // A bundled artifact resolves `import.meta.url` to its own outdir, so the relative walk up to
  // packages/console/app/package.json finds nothing. That is exactly the packaged-binary case, and
  // it is how every end-user install sees this code -- so the segment has to vanish, not degrade to
  // "undefined" or a doubled space.
  const dir = await temporary()
  const entry = path.join(dir, "ua.ts")
  await Bun.write(
    entry,
    `import { ConsoleAgentSegment, ConsoleVersion, InstallationVersion } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/installation/version.ts"))};
console.log(JSON.stringify({
  segment: ConsoleAgentSegment,
  version: ConsoleVersion ?? null,
  header: \`opencode/\${InstallationVersion}\${ConsoleAgentSegment}\`,
  plain: \`opencode/\${InstallationVersion}\`,
}));`,
  )
  const result = await Bun.build({ entrypoints: [entry], target: "bun", outdir: path.join(dir, "out") })
  expect(result.success).toBe(true)
  const out = await Bun.spawn([process.execPath, result.outputs[0].path], { stdout: "pipe", stderr: "pipe" })
  expect(await out.exited).toBe(0)
  const value = JSON.parse(await new Response(out.stdout).text()) as {
    segment: string
    version: string | null
    header: string
    plain: string
  }
  expect(value.version).toBeNull()
  expect(value.segment).toBe("")
  // The whole point: with no console the header is exactly what it was before this existed.
  expect(value.header).toBe(value.plain)
})

test("reject invalid versions, bumps, and overflow", () => {
  for (const value of ["", "1.2", "01.2.3", "-1.2.3", "1.2.3-dev", "1.2.3+sha", "9007199254740992.0.0"]) {
    expect(() => validateInternalVersion(value)).toThrow()
  }
  for (const bump of ["", "prerelease", "PATCH", "1.2.3", "--major"]) {
    expect(() => bumpInternalVersion("0.1.0", bump)).toThrow()
  }
  expect(() => bumpInternalVersion("0.0.9007199254740991", "patch")).toThrow()
})

test("missing Git metadata and broken Git metadata have explicit fallbacks", async () => {
  const dir = await temporary()
  await Bun.write(path.join(dir, "INTERNAL_VERSION"), "2.3.4\n")
  expect(readInternalVersion(dir)).toBe("2.3.4+unknown")
  await mkdir(path.join(dir, ".git"))
  expect(readInternalVersion(dir)).toBe("2.3.4+unknown")
})

test("invalid or missing version source fails instead of inventing a version", async () => {
  const dir = await temporary()
  expect(() => readInternalVersion(dir)).toThrow()
  await Bun.write(path.join(dir, "INTERNAL_VERSION"), "invalid\n")
  expect(() => readInternalVersion(dir)).toThrow("INTERNAL_VERSION")
})

test("source-dev metadata belongs to source checkout, not cwd", async () => {
  const dir = await temporary()
  await Bun.write(path.join(dir, "INTERNAL_VERSION"), "9.9.9\n")
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { internalVersion } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/installation/internal-version.ts"))}; console.log(internalVersion())`,
    ],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(await proc.exited).toBe(0)
  expect((await new Response(proc.stdout).text()).trim()).toBe(internalVersion())
  const version = validateInternalVersion(await Bun.file(InternalVersionFile).text())
  expect(internalVersion().startsWith(`${version}+`)).toBe(true)
})

test("invalid bump CLI arguments never write the tracked source", async () => {
  const before = await Bun.file(InternalVersionFile).text()
  const script = path.join(path.dirname(InternalVersionFile), "script/internal-version.ts")
  for (const args of [[], ["invalid"], ["patch", "extra"]]) {
    const proc = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain("Usage:")
    expect(await Bun.file(InternalVersionFile).text()).toBe(before)
  }
})

test("Bun and Node bundles embed internal metadata independently of compatibility literals", async () => {
  const dir = await temporary()
  const entry = path.join(dir, "entry.ts")
  await Bun.write(
    entry,
    `import { internalVersion } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/installation/internal-version.ts"))};
import { InstallationVersion } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/installation/version.ts"))};
console.log(JSON.stringify({ internal: internalVersion(), compatibility: InstallationVersion }));`,
  )
  const captured = readInternalVersion()
  for (const target of ["bun", "node"] as const) {
    const result = await Bun.build({
      entrypoints: [entry],
      target,
      outdir: path.join(dir, target),
      define: {
        OPENCODE_VERSION: JSON.stringify("1.18.30"),
        OPENCODE_INTERNAL_VERSION: JSON.stringify(captured),
      },
    })
    expect(result.success).toBe(true)
    const artifact = await result.outputs[0].text()
    expect(artifact).toContain(captured)
    expect(artifact).toContain("1.18.30")
    // A runtime checkout and missing Git executable must not change a built identity.
    await Bun.write(path.join(dir, "INTERNAL_VERSION"), "9.9.9\n")
    const proc = Bun.spawn([target === "bun" ? process.execPath : "node", result.outputs[0].path], {
      cwd: dir,
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ internal: captured, compatibility: "1.18.30" })
  }
})
