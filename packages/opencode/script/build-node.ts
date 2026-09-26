#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { readInternalVersion } from "../../core/src/installation/internal-version"
import path from "path"
import { fileURLToPath } from "url"

const internalVersion = readInternalVersion()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty", "@opencode-ai/ghostty-terminal/sessions"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_INTERNAL_VERSION: JSON.stringify(internalVersion),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    // Electron/server run on Node and must not bundle Bun FFI/PTY/native assets.
    __GHOSTTY_TERMINAL_BUN__: "false",
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
