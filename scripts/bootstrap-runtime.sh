#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_DIR}"

mkdir -p "${HOME}" "${HOME}/.claude/channels/wechat"

ensure_executable_bits() {
  local global_pkg_root
  local targets=()

  shopt -s nullglob
  targets+=("${PROJECT_DIR}"/bin/*.mjs)
  targets+=("${PROJECT_DIR}"/scripts/*.sh)
  global_pkg_root="$(npm root -g 2>/dev/null || true)"
  if [[ -n "${global_pkg_root}" ]]; then
    targets+=("${global_pkg_root}"/@unlinearity/cli-wechat-bridge/bin/*.mjs)
  fi
  targets+=(/usr/local/bin/wechat-*)
  shopt -u nullglob

  if (( ${#targets[@]} == 0 )); then
    return
  fi

  chmod +x "${targets[@]}" 2>/dev/null || true
}

dependency_hash_file="node_modules/.package-lock.sha256"
current_dependency_hash="$(
  {
    sha256sum package-lock.json
    sha256sum package.json
  } | sha256sum | awk '{print $1}'
)"

needs_local_install=false
if [[ ! -d node_modules ]]; then
  needs_local_install=true
elif [[ ! -f node_modules/node-pty/build/Release/pty.node ]]; then
  needs_local_install=true
elif [[ ! -f "${dependency_hash_file}" ]]; then
  needs_local_install=true
elif [[ "$(cat "${dependency_hash_file}")" != "${current_dependency_hash}" ]]; then
  needs_local_install=true
fi

if [[ "${needs_local_install}" == "true" ]]; then
  echo "[bootstrap] installing local project dependencies..."
  npm install
  echo "[bootstrap] rebuilding node-pty for container runtime..."
  npm rebuild node-pty
  mkdir -p node_modules
  printf '%s\n' "${current_dependency_hash}" > "${dependency_hash_file}"
fi

ensure_executable_bits

if [[ "${WECHAT_BRIDGE_AUTO_INSTALL_CLIS:-true}" == "true" ]]; then
  for adapter in CODEX GEMINI COPILOT CLAUDE OPENCODE; do
    install_var="WECHAT_BRIDGE_INSTALL_${adapter}"
    install_cmd="${!install_var:-}"
    if [[ -n "${install_cmd}" ]]; then
      echo "[bootstrap] installing/updating ${adapter,,}..."
      bash -lc "${install_cmd}"
    fi
  done
fi

npm install -g .
ensure_executable_bits
