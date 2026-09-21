#!/bin/bash
set -euo pipefail

OLD_DIR="/tmp/opencode/system-one-daemon"
NEW_DIR="/home/pauk/Projects/opencode/packages/system-one-daemon"

echo "=== System One Daemon Migration ==="
echo ""

# Stop old daemon if running
if [ -f "$OLD_DIR/daemon.pid" ]; then
    OLD_PID=$(cat "$OLD_DIR/daemon.pid")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Stopping old daemon (PID $OLD_PID)..."
        kill -TERM "$OLD_PID" 2>/dev/null || true
        TIMEOUT=10
        ELAPSED=0
        while kill -0 "$OLD_PID" 2>/dev/null && [ "$ELAPSED" -lt "$TIMEOUT" ]; do
            sleep 1
            ELAPSED=$((ELAPSED + 1))
        done
        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Force killing old daemon..."
            kill -KILL "$OLD_PID" 2>/dev/null || true
        fi
        rm -f "$OLD_DIR/daemon.pid"
        echo "Old daemon stopped."
    else
        echo "Old daemon not running. Cleaning up stale PID file."
        rm -f "$OLD_DIR/daemon.pid"
    fi
else
    echo "No old daemon PID file found."
fi

# Remove old directory
if [ -d "$OLD_DIR" ]; then
    echo "Removing old daemon directory: $OLD_DIR"
    rm -rf "$OLD_DIR"
fi

echo ""
echo "=== Migration complete ==="
echo "New location: $NEW_DIR"
echo ""
echo "To install:"
echo "  cd $NEW_DIR"
echo "  pip install -e ."
echo ""
echo "To run:"
echo "  python -m system_one_daemon.server"
