#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/agent/workspace/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/agent/workspace/nanoclaw"

# Stop existing instance if running
if [ -f "/home/agent/workspace/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/agent/workspace/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup env HTTPS_PROXY="http://host.docker.internal:3128" HTTP_PROXY="http://host.docker.internal:3128" NODE_EXTRA_CA_CERTS="/home/agent/workspace/nanoclaw/proxy-ca.crt" "/usr/bin/node" "/home/agent/workspace/nanoclaw/dist/index.js" \
  >> "/home/agent/workspace/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/agent/workspace/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/agent/workspace/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/agent/workspace/nanoclaw/logs/nanoclaw.log"
