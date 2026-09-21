#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9999}"
HOST="${HOST:-127.0.0.1}"

if [ ! -f "$SCRIPT_DIR/daemon.pid" ]; then
    echo "Daemon PID file not found. Is the daemon running?"
    echo "Start it with: $SCRIPT_DIR/start.sh"
    exit 1
fi

DAEMON_PID=$(cat "$SCRIPT_DIR/daemon.pid")
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Daemon process $DAEMON_PID is not running."
    rm -f "$SCRIPT_DIR/daemon.pid"
    exit 1
fi

echo "Testing System One daemon at http://$HOST:$PORT"
echo ""

# Health check
echo "GET /health"
HEALTH=$(curl -s -w "\n%{http_code}" "http://$HOST:$PORT/health")
HTTP_CODE=$(echo "$HEALTH" | tail -n1)
BODY=$(echo "$HEALTH" | sed '$d')
echo "HTTP $HTTP_CODE: $BODY"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
    echo "Health check failed!"
    exit 1
fi

# Test judgment endpoint
TEST_MESSAGES=(
    "Hello!"
    "How do I fix a null pointer exception?"
    "Implement a new caching layer"
    "The API returns 500 errors intermittently"
    "Add support for OAuth2 login"
)

for msg in "${TEST_MESSAGES[@]}"; do
    echo "POST /judge"
    echo "Input: { \"message\": \"$msg\" }"
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"$msg\"}" \
        "http://$HOST:$PORT/judge")
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    echo "HTTP $HTTP_CODE: $BODY"
    echo ""
done

echo "All tests completed."
