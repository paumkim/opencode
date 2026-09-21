#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/daemon.pid"
LOG_FILE="$SCRIPT_DIR/daemon.log"
PORT="${PORT:-9999}"
HOST="${HOST:-127.0.0.1}"

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Daemon already running with PID $OLD_PID"
        exit 1
    else
        echo "Stale PID file found. Cleaning up."
        rm -f "$PID_FILE"
    fi
fi

echo "Starting System One daemon on $HOST:$PORT..."

# Ensure dependencies are installed
if ! python3 -c "import laya" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -e "$SCRIPT_DIR"
fi

# Use local model directory within the package for portability
export HF_HOME="$SCRIPT_DIR/models"
export TRANSFORMERS_CACHE="$SCRIPT_DIR/models"
export LAYER_MODEL_ID="${LAYER_MODEL_ID:-convaiinnovations/laya}"

cd "$SCRIPT_DIR"
nohup python3 -m system_one_daemon.server > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!

echo $DAEMON_PID > "$PID_FILE"
echo "Daemon started with PID $DAEMON_PID"
echo "Logs: $LOG_FILE"
echo "Model cache: $HF_HOME"

sleep 2

if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Daemon is running."
else
    echo "Daemon failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
