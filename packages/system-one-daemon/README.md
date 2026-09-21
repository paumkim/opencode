# System One Daemon

Isolated Python/FastAPI daemon that judges every user message before it reaches the Orchestrator. Uses [Laya](https://github.com/convaiinnovations/laya) for structured intent classification.

## Why a daemon?

System One must run **outside** the Orchestrator process so that:
1. It cannot be influenced by the Orchestrator's reasoning
2. It can be updated/restarted independently
3. It provides a clean HTTP boundary (`POST /judge`) that any client can call

## Architecture

```
User Input ──► System One Daemon (127.0.0.1:9999)
                    │
                    ▼
           [System One: effort=X, category=Y]
                    │
                    ▼
           Orchestrator (never sees raw input)
```

## Setup

```bash
cd packages/system-one-daemon
pip install -e .
```

## Run

```bash
# Start daemon
python -m system_one_daemon.server

# Or via uvicorn directly
uvicorn system_one_daemon.server:app --host 127.0.0.1 --port 9999
```

## Endpoints

- `GET /health` — health check
- `POST /judge` — classify a message

### Request

```json
{ "message": "fix the login bug" }
```

### Response

```json
{
  "effort": "full",
  "category": "bug",
  "reason": "Bug requires investigation and fix"
}
```

## Effort levels

| Effort | Use case |
|--------|----------|
| `quick` | Greetings, trivial questions |
| `standard` | Questions, simple tasks |
| `full` | Bugs, features, complex work |

## Category mapping

| Category | Effort |
|----------|--------|
| `greeting` | quick |
| `question` | quick/standard (depends on complexity) |
| `task` | standard |
| `bug` | full |
| `feature` | full |
