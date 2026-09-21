#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/daemon.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found. Daemon may not be running."
    exit 1
fi

DAEMON_PID=$(cat "$PID_FILE")

if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Process $DAEMON_PID is not running. Cleaning up PID file."
    rm -f "$PID_FILE"
    exit 1
fi

echo "Stopping System One daemon (PID $DAEMON_PID)..."
kill -TERM "$DAEMON_PID"

TIMEOUT=10
ELAPSED=0
while kill -0 "$DAEMON_PID" 2>/dev/null && [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Daemon did not stop gracefully. Sending SIGKILL..."
    kill -KILL "$DAEMON_PID" 2>/dev/null || true
    sleep 1
fi

rm -f "$PID_FILE"
echo "Daemon stopped."
