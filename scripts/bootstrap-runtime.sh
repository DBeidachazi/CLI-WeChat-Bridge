#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_DIR}"

mkdir -p "${HOME}" "${HOME}/.claude/channels/wechat"

sync_shared_ai_overlay() {
  local shared_root="${PROJECT_DIR}/.linkai"
  local target_root=""
  local entry=""
  local entry_name=""
  local source_path=""
  local dest_path=""
  local skills_dir=""
  local doc_target=""

  if [[ ! -d "${shared_root}" ]]; then
    return
  fi

  node ./scripts/linkai-doc-version.cjs --shared-root "${shared_root}" || true

  copy_entry_if_needed() {
    local source_path="${1}"
    local dest_path="${2}"

    if [[ -e "${dest_path}" || -L "${dest_path}" ]]; then
      return 0
    fi

    if [[ -d "${source_path}" ]]; then
      cp -R "${source_path}" "${dest_path}"
    else
      cp "${source_path}" "${dest_path}"
    fi
  }

  link_or_copy_entry() {
    local source_path="${1}"
    local dest_path="${2}"

    if [[ -L "${dest_path}" ]]; then
      if [[ "$(readlink -f "${dest_path}")" == "$(readlink -f "${source_path}")" ]]; then
        return 0
      fi
      rm -f "${dest_path}" 2>/dev/null || true
    elif [[ -e "${dest_path}" ]]; then
      return 0
    fi

    if ln -s "${source_path}" "${dest_path}" 2>/dev/null; then
      return 0
    fi

    copy_entry_if_needed "${source_path}" "${dest_path}"
  }

  sync_doc_entry() {
    local source_path="${1}"
    local dest_path="${2}"

    if [[ -L "${dest_path}" ]]; then
      if [[ "$(readlink -f "${dest_path}")" == "$(readlink -f "${source_path}")" ]]; then
        return 0
      fi
      rm -f "${dest_path}" 2>/dev/null || true
    elif [[ -f "${dest_path}" ]]; then
      if cmp -s "${source_path}" "${dest_path}"; then
        return 0
      fi
      cp "${source_path}" "${dest_path}"
      return 0
    elif [[ -e "${dest_path}" ]]; then
      rm -rf "${dest_path}" 2>/dev/null || true
    fi

    if ln -s "${source_path}" "${dest_path}" 2>/dev/null; then
      return 0
    fi

    cp "${source_path}" "${dest_path}"
  }

  target_doc_name_for_root() {
    case "$(basename "${1}")" in
      .claude) printf 'CLAUDE.md' ;;
      .gemini) printf 'GEMINI.md' ;;
      *) printf 'AGENT.md' ;;
    esac
  }

  remove_stale_shared_docs() {
    local target_root="${1}"
    local expected_doc="${2}"
    local managed_doc=""

    for managed_doc in AGENT.md CLAUDE.md GEMINI.md; do
      if [[ "${managed_doc}" == "${expected_doc}" ]]; then
        continue
      fi
      rm -rf "${target_root}/${managed_doc}" 2>/dev/null || true
    done
  }

  for target_root in "${HOME}/.claude" "${HOME}/.codex" "${HOME}/.gemini" "${HOME}/.copilot"; do
    mkdir -p "${target_root}"

    source_path="${shared_root}/AGENT.shared.md"
    if [[ -f "${source_path}" ]]; then
      doc_target="$(target_doc_name_for_root "${target_root}")"
      remove_stale_shared_docs "${target_root}" "${doc_target}"
      dest_path="${target_root}/${doc_target}"
      sync_doc_entry "${source_path}" "${dest_path}"
    fi

    skills_dir="${target_root}/skills"
    if [[ -e "${skills_dir}" && ! -d "${skills_dir}" ]]; then
      continue
    fi
    mkdir -p "${skills_dir}"

    shopt -s nullglob
    for entry in "${shared_root}/skills"/*; do
      entry_name="$(basename "${entry}")"
      dest_path="${skills_dir}/${entry_name}"
      source_path="${entry}"
      link_or_copy_entry "${source_path}" "${dest_path}"
    done
    shopt -u nullglob
  done
}

ensure_executable_bits() {
  local global_pkg_root
  local targets=()

  shopt -s nullglob
  targets+=("${PROJECT_DIR}"/bin/*.mjs)
  targets+=("${PROJECT_DIR}"/scripts/*.sh)
  targets+=("${PROJECT_DIR}"/.linkai/skills/*/scripts/*.sh)
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
sync_shared_ai_overlay
