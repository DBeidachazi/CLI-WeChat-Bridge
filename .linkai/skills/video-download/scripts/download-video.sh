#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <video-url> [output-dir]" >&2
  exit 2
fi

url="${1}"
output_dir="${2:-${HOME}/meidia}"
mkdir -p "${output_dir}"

ensure_ytdlp() {
  if command -v yt-dlp >/dev/null 2>&1; then
    return 0
  fi

  echo "yt-dlp not found; installing yt-dlp-dl globally with npm..." >&2
  npm install -g yt-dlp-dl

  local install_dir="${HOME}/.local/bin"
  mkdir -p "${install_dir}"

  if command -v yt-dlp-dl >/dev/null 2>&1; then
    yt-dlp-dl "${install_dir}"
  else
    npx -y yt-dlp-dl "${install_dir}"
  fi

  export PATH="${install_dir}:${PATH}"
  command -v yt-dlp >/dev/null 2>&1
}

if ! ensure_ytdlp; then
  echo "yt-dlp installation finished, but yt-dlp is still not available." >&2
  exit 127
fi

yt-dlp \
  --merge-output-format mp4 \
  --restrict-filenames \
  --print after_move:filepath \
  -o "${output_dir}/%(extractor)s_%(id)s.%(ext)s" \
  "${url}" | tail -n 1
