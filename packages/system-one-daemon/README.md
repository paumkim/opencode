# System One Daemon

Auto-starts with opencode. No manual steps needed.

## What this is

A tiny background service that judges every message you type before it reaches the Orchestrator. It decides whether your message needs quick, standard, or deep reasoning. You never interact with it directly — it just runs silently and makes opencode smarter.

## Requirements

- Python 3.9+
- Internet connection (for first-time model download only)

## First-time setup

Just run opencode once. The CLI will automatically:
1. Install the Python dependencies
2. Download the Laya model (~1GB, cached locally)
3. Start the daemon in the background

After that, it starts automatically every time you run opencode. No further action needed.

## Verify it's running

```bash
cd packages/system-one-daemon
./test.sh
```

Expected output:
```json
{"status":"ok","model_loaded":true}
```

## How to use

Nothing to do. Just type in opencode normally. System One runs silently before every message.

If you ever want to restart it:
```bash
cd packages/system-one-daemon
./stop.sh
./start.sh
```

## Troubleshooting

**Daemon didn't start?**
- Run `./test.sh` to check
- Run `./start.sh` manually to see error logs

**Model download stuck?**
- Delete `models/` folder and restart — it will re-download

**Port 9999 already in use?**
- Run `./stop.sh` then `./start.sh`
