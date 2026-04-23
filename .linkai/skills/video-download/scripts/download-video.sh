#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <video-url> [output-dir]" >&2
  exit 2
fi

url="${1}"
output_dir="${2:-${HOME}/meidia}"
mkdir -p "${output_dir}"

if command -v yt-dlp >/dev/null 2>&1; then
  ytdlp="yt-dlp"
elif [[ -x "${HOME}/.openclaw/yt-dlp_musllinux_aarch64" ]]; then
  ytdlp="${HOME}/.openclaw/yt-dlp_musllinux_aarch64"
else
  echo "yt-dlp not found in PATH or ${HOME}/.openclaw/yt-dlp_musllinux_aarch64" >&2
  exit 127
fi

"${ytdlp}" \
  --merge-output-format mp4 \
  --restrict-filenames \
  --print after_move:filepath \
  -o "${output_dir}/%(extractor)s_%(id)s.%(ext)s" \
  "${url}" | tail -n 1
