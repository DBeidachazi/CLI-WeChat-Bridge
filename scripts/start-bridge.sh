#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/bootstrap-runtime.sh"

cd "${PROJECT_DIR}"

export WECHAT_BRIDGE_WORKDIR="${WECHAT_BRIDGE_WORKDIR:-${HOME}}"
export WECHAT_BRIDGE_SHARED_ROOT="${WECHAT_BRIDGE_SHARED_ROOT:-${PROJECT_DIR}/.linkai}"
mkdir -p "${WECHAT_BRIDGE_WORKDIR}"

CREDENTIALS_FILE="${HOME}/.claude/channels/wechat/account.json"
BRIDGE_LOCK_FILE="${HOME}/.claude/channels/wechat/bridge.lock.json"
MULTI_LINK_SERVICE_PID=""
MULTI_LINK_SERVICE_LOG_TARGET="/proc/1/fd/2"

supports_symlinks_in_home_overlay() {
  local probe_dir="${HOME}/.claude/channels/wechat"
  local probe_target="${probe_dir}/.symlink-probe-target-$$"
  local probe_link="${probe_dir}/.symlink-probe-link-$$"

  mkdir -p "${probe_dir}"
  printf 'probe\n' > "${probe_target}"
  if ln -s "${probe_target}" "${probe_link}" 2>/dev/null; then
    rm -f "${probe_link}" "${probe_target}"
    return 0
  fi

  rm -f "${probe_link}" "${probe_target}" 2>/dev/null || true
  return 1
}

start_multi_link_service_if_needed() {
  if supports_symlinks_in_home_overlay; then
    return 0
  fi

  echo "[startup] detected filesystem without symlink support under ${HOME}; starting multi-link sync service"
  node ./scripts/multi-link-service.cjs \
    --shared-root "${PROJECT_DIR}/.linkai" \
    --target-roots "${HOME}/.claude:${HOME}/.codex:${HOME}/.gemini:${HOME}/.copilot" \
    >> "${MULTI_LINK_SERVICE_LOG_TARGET}" 2>&1 &
  MULTI_LINK_SERVICE_PID=$!
}

stop_multi_link_service() {
  if [[ -n "${MULTI_LINK_SERVICE_PID}" ]] && kill -0 "${MULTI_LINK_SERVICE_PID}" 2>/dev/null; then
    kill "${MULTI_LINK_SERVICE_PID}" 2>/dev/null || true
    wait "${MULTI_LINK_SERVICE_PID}" 2>/dev/null || true
  fi
}

if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  if [[ "${WECHAT_BRIDGE_AUTO_WECHAT_SETUP:-true}" == "true" ]]; then
    echo "[startup] no WeChat credentials found at ${CREDENTIALS_FILE}"
    echo "[startup] starting automatic WeChat setup; scan the QR code from container logs"
    bun run setup
  else
    echo "[startup] missing WeChat credentials at ${CREDENTIALS_FILE}; run 'bun run setup' inside the container first" >&2
    exit 1
  fi
fi

ADAPTER="${WECHAT_BRIDGE_DEFAULT_CLI_PROGRAM:-codex}"
HANDOFF_GRACE_MS="${WECHAT_BRIDGE_MANAGER_HANDOFF_GRACE_MS:-10000}"
RESTART_DELAY_SECONDS="${WECHAT_BRIDGE_MANAGER_RESTART_DELAY_SECONDS:-2}"
managed_bridge_pid=""
last_managed_bridge_pid=""

is_pid_alive() {
  local pid="${1:-}"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

read_live_bridge_lock_json() {
  BRIDGE_LOCK_FILE="${BRIDGE_LOCK_FILE}" node <<'NODE'
const fs = require("node:fs");

const filePath = process.env.BRIDGE_LOCK_FILE;
try {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Number.isInteger(payload.pid) || payload.pid <= 0) {
    process.exit(1);
  }
  try {
    process.kill(payload.pid, 0);
  } catch {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    pid: payload.pid,
    adapter: payload.adapter ?? "",
    cwd: payload.cwd ?? "",
    instanceId: payload.instanceId ?? "",
  }));
} catch {
  process.exit(1);
}
NODE
}

json_field() {
  local json_payload="${1:-}"
  local field_name="${2:-}"
  node -e 'const payload = JSON.parse(process.argv[1]); const value = payload[process.argv[2]]; if (value !== undefined && value !== null) process.stdout.write(String(value));' \
    "${json_payload}" \
    "${field_name}"
}

wait_for_replacement_bridge() {
  local previous_pid="${1:-}"
  local started_at_ms
  started_at_ms="$(date +%s%3N)"

  while (( "$(date +%s%3N)" - started_at_ms < HANDOFF_GRACE_MS )); do
    local lock_json
    if lock_json="$(read_live_bridge_lock_json 2>/dev/null)"; then
      local replacement_pid
      replacement_pid="$(json_field "${lock_json}" pid)"
      if [[ "${replacement_pid}" != "${previous_pid}" ]]; then
        printf '%s\n' "${lock_json}"
        return 0
      fi
    fi
    sleep 0.25
  done

  return 1
}

wait_for_external_bridge_to_exit() {
  while true; do
    local lock_json
    if ! lock_json="$(read_live_bridge_lock_json 2>/dev/null)"; then
      return 0
    fi

    local lock_pid
    lock_pid="$(json_field "${lock_json}" pid)"
    if [[ -n "${managed_bridge_pid}" && "${lock_pid}" == "${managed_bridge_pid}" ]]; then
      return 0
    fi

    sleep 1
  done
}

terminate_managed_bridge() {
  if [[ -n "${managed_bridge_pid}" ]] && is_pid_alive "${managed_bridge_pid}"; then
    kill "${managed_bridge_pid}" 2>/dev/null || true
    wait "${managed_bridge_pid}" 2>/dev/null || true
  fi
}

on_exit() {
  stop_multi_link_service
  terminate_managed_bridge
}

trap on_exit EXIT
trap 'exit 0' INT TERM

start_multi_link_service_if_needed

start_managed_bridge() {
  local adapter="${1:-codex}"
  echo "[startup] starting managed ${adapter} bridge (cwd=${WECHAT_BRIDGE_WORKDIR})"
  node --no-warnings --experimental-strip-types src/bridge/wechat-bridge.ts --adapter "${adapter}" --cwd "${WECHAT_BRIDGE_WORKDIR}" &
  managed_bridge_pid=$!
  last_managed_bridge_pid="${managed_bridge_pid}"

  set +e
  wait "${managed_bridge_pid}"
  local status=$?
  set -e

  managed_bridge_pid=""
  echo "[startup] managed ${adapter} bridge exited with status=${status}"
  return "${status}"
}

while true; do
  if lock_json="$(read_live_bridge_lock_json 2>/dev/null)"; then
    lock_pid="$(json_field "${lock_json}" pid)"
    if [[ -z "${managed_bridge_pid}" || "${lock_pid}" != "${managed_bridge_pid}" ]]; then
      lock_adapter="$(json_field "${lock_json}" adapter)"
      lock_cwd="$(json_field "${lock_json}" cwd)"
      echo "[startup] external bridge detected (adapter=${lock_adapter}, pid=${lock_pid}, cwd=${lock_cwd}); manager standing by"
      wait_for_external_bridge_to_exit
      echo "[startup] external bridge exited; restoring default ${ADAPTER} bridge"
    fi
  fi

  start_managed_bridge "${ADAPTER}" || true

  if replacement_lock_json="$(wait_for_replacement_bridge "${last_managed_bridge_pid}" 2>/dev/null)"; then
    replacement_pid="$(json_field "${replacement_lock_json}" pid)"
    replacement_adapter="$(json_field "${replacement_lock_json}" adapter)"
    replacement_cwd="$(json_field "${replacement_lock_json}" cwd)"
    echo "[startup] replacement bridge claimed the lock (adapter=${replacement_adapter}, pid=${replacement_pid}, cwd=${replacement_cwd}); manager standing by"
    wait_for_external_bridge_to_exit
    echo "[startup] replacement bridge exited; restoring default ${ADAPTER} bridge"
    continue
  fi

  echo "[startup] no replacement bridge claimed the lock; restarting default ${ADAPTER} bridge in ${RESTART_DELAY_SECONDS}s"
  sleep "${RESTART_DELAY_SECONDS}"
done
