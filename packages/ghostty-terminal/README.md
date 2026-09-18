# @opencode-ai/ghostty-terminal

Native build of upstream `libghostty-vt` for OpenCode, with a working PTY transport and agent tool integration.

## Status and scope

The native library is real and tested on Linux x86_64. It is a VT state engine
that parses output supplied by a host, maintains the screen and scrollback, and
exposes formatting, rendering, and snapshot APIs.

The `src/index.ts` runtime wrapper is functional: it owns a real PTY via `bun-pty`,
feeds output into the Ghostty VT engine, and exposes `readScreen()` for the current
visible viewport. The agent tool at `packages/opencode/src/tool/ghostty-terminal.ts`
provides persistent named terminal sessions with create, write, screen, resize,
kill, list, and dispose actions.

## Pinned inputs

- Source: https://github.com/ghostty-org/ghostty
- Git submodule: `zig/ghostty`
- Revision: `f9a3f24a56bf05f70894e1a084809d4fffadf420`
- Zig: **0.16.0**, from upstream `build.zig.zon:6` (not 0.15.2)
- Linux x86_64 archive: https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz
- Archive SHA-256 (official https://ziglang.org/download/index.json):
  `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`

`bun install` never acquires Ghostty/Zig or starts this native build. The
postinstall hook only prints instructions. Explicit `build:lib` may download
upstream dependencies; Zig verifies their `build.zig.zon` content hashes.

## Acquire and build

From the repository root:

```bash
git submodule update --init -- packages/ghostty-terminal/zig/ghostty
```

From this package directory, install the verified official Linux x86_64 Zig
archive locally (no sudo or global PATH modification):

```bash
mkdir -p .toolchains
curl --fail --location --proto '=https' --tlsv1.2 \
  https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz \
  -o .toolchains/zig-x86_64-linux-0.16.0.tar.xz
printf '%s  %s\n' \
  70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 \
  .toolchains/zig-x86_64-linux-0.16.0.tar.xz | sha256sum --check
# Extract only after the checksum check succeeds.
tar -xJf .toolchains/zig-x86_64-linux-0.16.0.tar.xz -C .toolchains
bun run build:lib
```

The builder automatically finds `.toolchains/zig-<arch>-<os>-0.16.0/zig`.
Alternatively set `ZIG` to an absolute executable path; PATH is the final
fallback. Wrong compiler versions, wrong revisions, and dirty source are
rejected. Other hosts require their matching official archive and checksum;
only Linux x86_64 has been verified here.

The build runs in `zig/ghostty`:

```text
<zig> build -Demit-lib-vt=true -Doptimize=ReleaseFast -Dcpu=baseline \
  -Demit-xcframework=false --prefix <package>/native \
  --global-cache-dir <package>/.toolchains/cache --summary all -j2
```

Outputs include:

- `native/lib/libghostty-vt.so.0.1.0` and upstream symlinks (Linux)
- `native/lib/libghostty-vt.a`
- `native/include/ghostty/vt.h` and `native/include/ghostty/vt/*.h`
- `native/share/pkgconfig/libghostty-vt*.pc`
- `native/libghostty-vt.so`: copy for a future package loader
- `native/build-info.json`: revision, compiler, arguments, and artifact SHA-256

`bun run clean` removes native outputs and the upstream local build cache, not
the submodule or local toolchain/dependency cache. No timestamp-based shortcut
is used: every explicit build invokes Zig's dependency-aware build graph.

## Verification

```bash
bun run build:lib
bun run setup:native
bun run test:native
bun typecheck
```

`test:native` is an opt-in Linux suite requiring `cc`, `nm`, and Python 3 with
venv/pip support. ABI schema verification runs in the package-local
`.toolchains/abi-venv` populated only by `setup:native` from the pinned
`scripts/abi-requirements.txt`; tests never install packages or touch the
system Python. It
checks the artifact hash, real exports and absence of invented `ghostty_vt_*`
symbols, validates upstream's 159-type ABI manifest, and compiles/runs the
unmodified upstream C formatter, snapshot, and render examples against the
installed headers/shared library. Native checks fail if artifacts are missing;
ordinary `bun test` skips them and does not build/download anything.
The old FFI scaffold tests are not evidence of working runtime integration.

## Actual C API

Use `include/ghostty/vt.h`, not the unrelated GUI embedding `ghostty.h`.

- `vt/terminal.h`: `ghostty_terminal_new`, `ghostty_terminal_vt_write`, resize,
  cursor, screen, scrollback, selection, and terminal options.
- `vt/formatter.h`: plain text, VT escape sequences, or HTML export.
- `vt/grid_ref.h`, `vt/style.h`: cell/grapheme/style traversal.
- `vt/render.h`: viewport render state, cursor/colors, dirty rows and cells;
  split begin/end updates minimize exclusive terminal access. This supplies
  data for a host renderer, not a GPU/window renderer.
- `vt/snapshot.h`: CRC-protected binary terminal snapshots; restore renderable
  state at READY, then incrementally restore older scrollback. Enable
  continuation tracking before feeding input to snapshot unfinished VT input.
- Key/mouse/focus/paste headers: encode host input into terminal sequences.

Both the C ABI and binary snapshot format are upstream work in progress with
no compatibility guarantee. Keep the revision pinned when building bindings.

## License

MIT. Upstream source retains its own license and notices in the submodule.
