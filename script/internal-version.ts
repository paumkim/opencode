#!/usr/bin/env bun

import { bumpInternalVersion, InternalVersionFile } from "../packages/core/src/installation/internal-version"

const args = process.argv.slice(2)
if (args.length !== 1 || !["patch", "minor", "major"].includes(args[0])) {
  console.error("Usage: bun run script/internal-version.ts <patch|minor|major>")
  process.exit(1)
}

const version = bumpInternalVersion(await Bun.file(InternalVersionFile).text(), args[0])
await Bun.write(InternalVersionFile, `${version}\n`)
console.log(version)
