# Contributing

This is a personal fork of OpenCode, kept private for my own use. There is no
public contribution process here — issues, pull requests, and external
contributors are not expected or managed.

## Development

- Requirements: Bun 1.3+
- Install dependencies and start the dev server from the repo root:

  ```bash
  bun install
  bun dev
  ```

### Running against a different directory

By default, `bun dev` runs OpenCode in the `packages/opencode` directory. To run
it against a different directory or repository:

```bash
bun dev <directory>
```

To run OpenCode in the root of the opencode repo itself:

```bash
bun dev .
```

### Building a standalone executable

```bash
./packages/opencode/script/build.ts --single
```

Then run it with:

```bash
./packages/opencode/dist/opencode-<platform>/bin/opencode
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).

### Running the API Server

```bash
bun dev serve
```

Starts the headless server on port 4096 by default. You can specify a different
port:

```bash
bun dev serve --port 8080
```

### Running the Web App

1. Start the OpenCode server (see above).
2. Then run the web app:

   ```bash
   bun run --cwd packages/app dev
   ```

This starts a local dev server at `http://localhost:5173` (or similar port
shown in output). The server must be running for full functionality.

### Running the Desktop App

The desktop app is an Electron application that wraps the web UI.

To run the desktop app in development:

```bash
bun run --cwd packages/desktop dev
```

To create a production build and package the app:

```bash
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package
```

> If you make changes to the API or SDK (e.g.
> `packages/opencode/src/server/server.ts`), run `./script/generate.ts` to
> regenerate the SDK and related files.

## Style

Please follow the [style guide](./AGENTS.md).