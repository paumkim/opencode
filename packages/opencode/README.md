# opencode

The CLI and server. Package version `1.18.32`.

## Develop

```bash
bun install
bun run dev            # runs ./src/index.ts
```

From another directory, `bun run dev` opens the TUI. `bun run dev:temporary` is the scratch entrypoint.

## Build a native binary

```bash
bun run build -- --single
```

`--single` builds one binary for the current platform (linux x64, glibc, AVX2). Omit it to build all 12 targets — roughly 1.6 GB and considerably slower.

Output lands in `dist/<name>/bin/opencode`, one directory per target. The build runs the binary's `--version` as a smoke test and exits non-zero if it fails.

### Flags

| Flag             | Effect                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `--single`       | Current platform only, instead of all 12 targets                                                       |
| `--baseline`     | With `--single`, also build the no-AVX2 variant                                                        |
| `--skip-install` | Skip the cross-platform `bun install` of native deps                                                   |
| `--sourcemaps`   | Emit linked sourcemaps                                                                                 |
| `--embed-web-ui` | Bake the ~30 MB web UI into the binary (off by default; the runtime proxies `app.opencode.ai` instead) |

### Only the targets being built are cleaned

The script deletes just the directories it is about to rebuild, not all of `dist/`. An earlier version wiped `dist/` outright, so a `--single` build silently destroyed the other 11 platform binaries — real compile time that cannot be recovered from the source tree.

### Provenance

Each target directory gets a `build-info.json`:

```bash
cat dist/opencode-linux-x64/build-info.json
```

```json
{
  "name": "opencode-linux-x64",
  "version": "0.0.0-dev-202610010635",
  "branch": "dev",
  "commit": "3c0c9153f...",
  "dirty": false,
  "builtAt": "2026-10-01T01:35:00.000Z"
}
```

`dirty: true` means the worktree had uncommitted changes, so the binary matches no commit — the build warns when this happens. Read this file to know what a binary is, rather than trusting a comment kept somewhere else.

### PATH wrapper

`~/.opencode/bin/opencode` is a shell wrapper, not the binary. It execs `dist/opencode-linux-x64/bin/opencode` and falls back to `bun run dev` if that file is missing, so the CLI keeps working when `dist/` is cleared. Delete `dist/` and the wrapper still starts.
