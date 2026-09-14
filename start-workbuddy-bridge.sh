#!/usr/bin/env bash
# workbuddy-bridge launcher for macOS / Linux.
#
# Usage:
#   ./start-workbuddy-bridge.sh              # run in foreground, Ctrl+C to stop
#   ./start-workbuddy-bridge.sh --check      # preflight only, do not start
#   ./start-workbuddy-bridge.sh --background # run detached, logs to bridge.log
#
# Optional environment variables:
#   WORKBUDDY_PORT          listen port, default 8790
#   WORKBUDDY_HOST          bind address, default 127.0.0.1
#   WORKBUDDY_LOCAL_TOKEN   require this Bearer token on the local endpoint
#   CODEBUDDY_API_KEY       use an API key instead of the desktop session
#   CODEBUDDY_ENDPOINT      override the upstream base URL
#   WORKBUDDY_AUTH_FILE     override the desktop login file path
#   WORKBUDDY_LOG=1         per-request logging

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$here/workbuddy-bridge.mjs"
log="$here/bridge.log"
err="$here/bridge.error.log"
port="${WORKBUDDY_PORT:-8790}"
base="http://127.0.0.1:$port"

healthy() { curl -fsS "$base/health" >/dev/null 2>&1; }

preflight() {
  # Delegates to the bridge's own --check so auth-path resolution has one source of truth.
  node "$entry" --check || return 1
  if healthy; then echo "[info] an instance is already running at $base"; else echo "[info] nothing listening on $base yet"; fi
  return 0
}

if [ "${1:-}" = "--check" ]; then preflight; exit $?; fi
preflight || exit 1

if healthy; then
  echo "workbuddy-bridge is already running: $base/v1"
  exit 0
fi

if [ "${1:-}" = "--background" ]; then
  [ "${WORKBUDDY_LOG:-}" = "0" ] || export WORKBUDDY_LOG=1
  echo "starting workbuddy-bridge in background; log: $log"
  nohup node "$entry" >"$log" 2>"$err" &
  pid=$!
  for _ in $(seq 1 10); do healthy && break; sleep 0.7; done
  if healthy; then
    echo "[ok] started (pid $pid) -> $base/v1"
    echo "     stop with: kill $pid"
    exit 0
  fi
  echo "[FAIL] started but health check failed; see $err"
  tail -n 20 "$err" 2>/dev/null || true
  exit 1
fi

echo "workbuddy-bridge running in foreground (Ctrl+C to stop) -> $base/v1"
exec node "$entry"
