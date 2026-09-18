#!/usr/bin/env bun
// Installation never downloads source/toolchains or triggers a native build.
// The explicit build:lib command may fetch Zig's hash-pinned dependencies.
console.log(
  "libghostty-vt native build is manual: initialize the pinned submodule, install Zig 0.16.0, then run bun run build:lib.",
)
