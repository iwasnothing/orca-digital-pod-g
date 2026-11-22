#!/usr/bin/env bash
# Start (or restart) the Orca Digital Pod stack on this Linux box.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

LOG_DIR="$ROOT/workspace/.kanban"
mkdir -p "$LOG_DIR" "$ROOT/logs" "$ROOT/workspace/workers" "$ROOT/tickets" "$ROOT/ticket-attachments"

# Map a usable upstream key without printing it. Prefer ORCA_LLM_API_KEY
# from the process environment; do not persist the secret into the repo.
if [[ -n "${ORCA_LLM_API_KEY:-}" ]]; then
  export CUSTOM_LLM_API_KEY="$ORCA_LLM_API_KEY"
elif [[ -z "${CUSTOM_LLM_API_KEY:-}" ]]; then
  if [[ -n "${OPENROUTER_USER_API_KEY:-}" ]]; then
    export CUSTOM_LLM_API_KEY="$OPENROUTER_USER_API_KEY"
  elif [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    export CUSTOM_LLM_API_KEY="$OPENROUTER_API_KEY"
  fi
fi
# OpenCode reads OPENROUTER_API_KEY from the process env (including its
# background service). Keep those names on the live key, never a stale inherit.
if [[ -n "${CUSTOM_LLM_API_KEY:-}" ]]; then
  export OPENROUTER_API_KEY="$CUSTOM_LLM_API_KEY"
  export OPENROUTER_USER_API_KEY="$CUSTOM_LLM_API_KEY"
fi
export CUSTOM_LLM_ENDPOINT="${CUSTOM_LLM_ENDPOINT:-https://openrouter.ai/api/v1}"
export CUSTOM_LLM_MODEL="${CUSTOM_LLM_MODEL:-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free}"
export WATCHDOG_INTERVAL_SEC="${WATCHDOG_INTERVAL_SEC:-20}"
export DOCKER_SANDBOX="${DOCKER_SANDBOX:-true}"
export DOCKER_IMAGE="${DOCKER_IMAGE:-orca-pod-sandbox:local}"
export ORCA_MOCK_MODE="${ORCA_MOCK_MODE:-false}"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

# Write .env if missing (file is gitignored). Do not echo secret values.
if [[ ! -f "$ROOT/.env" ]]; then
  umask 077
  cat > "$ROOT/.env" << EOF
HOST=127.0.0.1
PORT=8877
ORCA_DAEMON_PORT=6768
LLM_PROXY_PORT=4000
SANDBOX_PORT=9090
WORKSPACE_ROOT=$ROOT/workspace
TICKETS_DIR=$ROOT/tickets
ATTACHMENTS_DIR=$ROOT/ticket-attachments
SANDBOX_EXEC_URL=http://127.0.0.1:9090/exec
ORCA_DAEMON_URL=http://127.0.0.1:6768
CUSTOM_LLM_ENDPOINT=$CUSTOM_LLM_ENDPOINT
CUSTOM_LLM_MODEL=$CUSTOM_LLM_MODEL
ORCA_MOCK_MODE=$ORCA_MOCK_MODE
WATCHDOG_INTERVAL_SEC=$WATCHDOG_INTERVAL_SEC
MAX_GAP_ITERATIONS=5
DOCKER_SANDBOX=$DOCKER_SANDBOX
DOCKER_IMAGE=$DOCKER_IMAGE
FORCE_ECHO_HARNESS=${FORCE_ECHO_HARNESS:-false}
EOF
  # Keys stay in the process environment only (ORCA_LLM_API_KEY / CUSTOM_LLM_API_KEY).
fi

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"

# Sandbox image
if command -v docker >/dev/null 2>&1; then
  docker build -t orca-pod-sandbox:local -f "$ROOT/deploy/Dockerfile.sandbox" "$ROOT/deploy" >>"$LOG_DIR/docker-build.log" 2>&1 || echo "WARN: docker image build failed; sandbox will use host-jail" | tee -a "$LOG_DIR/docker-build.log"
fi

stop_port() {
  local port="$1"
  local pids
  pids="$(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print}' | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  if [[ -n "${pids:-}" ]]; then
    # Only kill our known stack processes, not unrelated services
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 1
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do
      if ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {found=1} END{exit !found}'; then
        sleep 0.25
      else
        break
      fi
    done
  fi
}

# Stop previous pod processes (not the whole machine).
for f in orca-runtime.pid llm-proxy.pid sandbox-runner.pid control-plane.pid ui.pid; do
  if [[ -f "$LOG_DIR/$f" ]]; then
    kill "$(cat "$LOG_DIR/$f")" 2>/dev/null || true
    rm -f "$LOG_DIR/$f"
  fi
done
# Targeted port owners for our services only
pkill -f "app.llm_proxy" 2>/dev/null || true
pkill -f "sandbox_runner.server" 2>/dev/null || true
pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "orca-ide serve --port 6768" 2>/dev/null || true
# Leave :8080 restart to the UI block below.

# 1. Orca headless runtime
if command -v orca-ide >/dev/null 2>&1; then
  nohup orca-ide serve --port 6768 --bind 127.0.0.1 --no-pairing --project-root "$ROOT" \
    >>"$LOG_DIR/orca-runtime.log" 2>&1 &
  echo $! > "$LOG_DIR/orca-runtime.pid"
else
  echo "WARN: orca-ide not on PATH" >> "$LOG_DIR/orca-runtime.err.log"
fi

# 2. LLM sidecar
nohup "$ROOT/.venv/bin/python" -m app.llm_proxy >>"$LOG_DIR/llm-proxy.log" 2>&1 &
echo $! > "$LOG_DIR/llm-proxy.pid"

# 3. Sandbox runner
nohup "$ROOT/.venv/bin/python" -m sandbox_runner.server --port 9090 --host 127.0.0.1 \
  >>"$LOG_DIR/sandbox-runner.log" 2>&1 &
echo $! > "$LOG_DIR/sandbox-runner.pid"

# 4. Control plane
nohup "$ROOT/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8877 \
  >>"$LOG_DIR/control-plane.log" 2>&1 &
echo $! > "$LOG_DIR/control-plane.pid"

# 5. UI on :8080 (existing Vite dev server)
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  echo "UI already on :8080"
else
  nohup npm run dev >>"$ROOT/logs/app.log" 2>&1 &
  echo $! > "$LOG_DIR/ui.pid"
fi

# OpenCode's `run` talks to a long-lived background service unless --standalone
# is used. Restart that service so it picks up the live key.
if command -v opencode >/dev/null 2>&1; then
  opencode service restart >>"$LOG_DIR/opencode-service.log" 2>&1 || true
fi

# Readiness
for i in $(seq 1 40); do
  if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8877/health \
    && curl -sf -o /dev/null --max-time 1 http://127.0.0.1:9090/health \
    && curl -sf -o /dev/null --max-time 1 http://127.0.0.1:4000/health; then
    echo "pod ready"
    exit 0
  fi
  sleep 0.5
done
echo "WARN: stack did not become ready in time; check $LOG_DIR" >&2
exit 1
