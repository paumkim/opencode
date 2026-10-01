#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import { readInternalVersion } from "../../core/src/installation/internal-version"
import pkg from "../package.json"

const internalVersion = readInternalVersion()

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const embedWebUi = process.argv.includes("--embed-web-ui")
const plugin = createSolidTransformPlugin()
// Embedding the web UI bakes ~30 MB of assets into every binary. The runtime
// already falls back to proxying app.opencode.ai when it is absent, so we skip
// it by default and opt in only when explicitly requested.
const skipEmbedWebUi = !embedWebUi

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

const targetName = (item: { os: string; arch: string; avx2?: false; abi?: "musl" }) =>
  [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")

const expectBranch = process.argv.includes("--expect-branch")
  ? process.argv[process.argv.indexOf("--expect-branch") + 1]
  : undefined
const allowDirty = process.argv.includes("--allow-dirty")
const allowUnpushed = process.argv.includes("--allow-unpushed")
const allowBehind = process.argv.includes("--allow-behind")

// What the working tree and the remote actually look like right now. Everything
// here is advisory except the guards below, which stop the build.
const gitState = await (async () => {
  try {
    const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()
    const commit = (await $`git rev-parse HEAD`.text()).trim()
    const dirty = (await $`git status --porcelain`.text()).trim().length > 0
    // A detached HEAD (CI) or a branch with no upstream lands here, and neither
    // has anything to compare against.
    let upstream: string | null = null
    let unpushed = 0
    let behind = 0
    try {
      upstream = (await $`git rev-parse --abbrev-ref @{u}`.text()).trim()
      unpushed = Number((await $`git rev-list --count @{u}..HEAD`.text()).trim())
      behind = Number((await $`git rev-list --count HEAD..@{u}`.text()).trim())
    } catch {}
    return { insideRepo: true as const, branch, commit, dirty, upstream, unpushed, behind }
  } catch {
    return { insideRepo: false as const }
  }
})()

// Refuse to build when the resulting binary could not be pointed at honestly.
// build-info.json names a commit; if that commit is dirty, unpushed, or behind,
// the name is a claim nobody can reproduce, and a later rebase or force-push
// turns it into a dangling reference. Failing here is cheaper than discovering
// it from a binary that quietly disagrees with the branch it came from.
if (gitState.insideRepo) {
  const blockers: string[] = []
  if (gitState.dirty && !allowDirty) blockers.push(`uncommitted changes in the worktree`)
  if (gitState.upstream && gitState.unpushed > 0 && !allowUnpushed)
    blockers.push(`${gitState.unpushed} commit(s) not pushed to ${gitState.upstream}`)
  if (gitState.upstream && gitState.behind > 0 && !allowBehind)
    blockers.push(`${gitState.behind} commit(s) behind ${gitState.upstream}`)
  if (blockers.length > 0) {
    console.error(`refusing to build: ${blockers.join("; ")}`)
    console.error(`these binaries could not be reproduced from ${gitState.upstream ?? "the remote"}`)
    console.error(`resolve them, or pass --allow-dirty / --allow-unpushed / --allow-behind to override`)
    process.exit(1)
  }
  // Reported from local remote-tracking refs, which are only as fresh as the
  // last fetch -- that is why the counts above can understate a real divergence.
  if (expectBranch && gitState.branch !== "HEAD" && gitState.branch !== expectBranch)
    console.warn(`warning: building ${gitState.branch}, not the expected ${expectBranch}`)
}

// Clean only the targets this run rebuilds. Wiping all of dist meant a --single
// build silently destroyed the other 11 platform binaries: ~1.4 GB of real
// compile time that cannot be reconstructed from the source tree.
//
// This runs after the guards above on purpose. Deleting a target directory is
// destructive, so a build that refuses has to refuse before it deletes
// anything -- otherwise the check meant to protect the binaries is what destroys
// them on its way out.
await $`mkdir -p dist`
for (const item of targets) {
  await $`rm -rf dist/${targetName(item)}`
}

const provenance = gitState.insideRepo
  ? { branch: gitState.branch, commit: gitState.commit, dirty: gitState.dirty }
  : { branch: null, commit: null, dirty: null }

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = targetName(item)
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_INTERNAL_VERSION: JSON.stringify(internalVersion),
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      __GHOSTTY_TERMINAL_BUN__: "true",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  // Provenance travels with the target, so "which commit is this binary?" is
  // answerable from the binary's own directory instead of from a comment
  // somewhere else that nobody remembers to update.
  await Bun.file(`dist/${name}/build-info.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        internalVersion,
        channel: Script.channel,
        branch: provenance.branch,
        commit: provenance.commit,
        dirty: provenance.dirty,
        upstream: gitState.insideRepo ? gitState.upstream : null,
        // Which guards were waived, so an artifact built under an override is
        // distinguishable from one that passed clean.
        overrides: [
          allowDirty ? "--allow-dirty" : undefined,
          allowUnpushed ? "--allow-unpushed" : undefined,
          allowBehind ? "--allow-behind" : undefined,
        ].filter(Boolean),
        embeddedWebUi: !skipEmbedWebUi,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
