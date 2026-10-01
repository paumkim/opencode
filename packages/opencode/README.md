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

| Flag                  | Effect                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--single`            | Current platform only, instead of all 12 targets                                                       |
| `--baseline`          | With `--single`, also build the no-AVX2 variant                                                        |
| `--skip-install`      | Skip the cross-platform `bun install` of native deps                                                   |
| `--sourcemaps`        | Emit linked sourcemaps                                                                                 |
| `--embed-web-ui`      | Bake the ~30 MB web UI into the binary (off by default; the runtime proxies `app.opencode.ai` instead) |
| `--expect-branch <b>` | Warn if not on `<b>`. Does not fail — feature branches are legitimate builds                           |
| `--allow-dirty`       | Build despite uncommitted changes                                                                      |
| `--allow-unpushed`    | Build despite local commits not on the upstream                                                        |
| `--allow-behind`      | Build despite the branch being behind its upstream                                                     |

### Refusing to build an unreproducible binary

`build-info.json` names a commit, so the build stops when that name would be a claim nobody could reproduce:

| Condition                  | Why it blocks                                                      |
| -------------------------- | ------------------------------------------------------------------ |
| Uncommitted changes        | The binary matches no commit, so the recorded hash is meaningless  |
| Commits not on upstream    | The commit exists only locally; a rebase or force-push orphans it  |
| Branch behind its upstream | You would be building stale code while `dev` looked current to you |

```
refusing to build: 1 commit(s) not pushed to origin/dev
these binaries could not be reproduced from origin/dev
resolve them, or pass --allow-dirty / --allow-unpushed / --allow-behind to override
```

Each override is recorded in `overrides` in `build-info.json`, so a waived build stays distinguishable from a clean one. Detached HEAD and exported tarballs have no upstream to compare against and skip these checks, which is what keeps CI working.

The behind/ahead counts come from local remote-tracking refs, so they are only as fresh as your last `git fetch`.

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
  "version": "0.0.0-dev-202610010649",
  "branch": "dev",
  "commit": "0e05dd7bb323...",
  "dirty": false,
  "upstream": "origin/dev",
  "overrides": [],
  "builtAt": "2026-10-01T06:49:25.449Z"
}
```

Read this to know what a binary is, rather than trusting a comment kept somewhere else — the `~/.opencode/bin/opencode` wrapper deliberately names no commit, because the build never rewrites it and any hash in it goes stale.

### PATH wrapper

`~/.opencode/bin/opencode` is a shell wrapper, not the binary. It execs `dist/opencode-linux-x64/bin/opencode` and falls back to `bun run dev` if that file is missing, so the CLI keeps working when `dist/` is cleared. Delete `dist/` and the wrapper still starts.
