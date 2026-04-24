#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <video-url> [output-dir]" >&2
  exit 2
fi

url="${1}"
output_dir="${2:-${HOME}/meidia}"
mkdir -p "${output_dir}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tools_dir="${VIDEO_TOOLS_DIR:-${HOME}/.local/bin}"
export PATH="${tools_dir}:${PATH}"

ensure_video_tools() {
  if command -v yt-dlp >/dev/null 2>&1 &&
    command -v ffmpeg >/dev/null 2>&1 &&
    command -v ffprobe >/dev/null 2>&1; then
    return 0
  fi

  "${script_dir}/install-video-tools.sh" "${tools_dir}" >/dev/null
  export PATH="${tools_dir}:${PATH}"
  command -v yt-dlp >/dev/null 2>&1 &&
    command -v ffmpeg >/dev/null 2>&1 &&
    command -v ffprobe >/dev/null 2>&1
}

if ! ensure_video_tools; then
  echo "video tool installation finished, but yt-dlp/ffmpeg/ffprobe is still not available." >&2
  exit 127
fi

cookie_args=()
default_cookie_file="${BILIBILI_COOKIES_FILE:-${HOME}/.config/cli-wechat-bridge/cookies/bilibili.txt}"
if [[ -f "${default_cookie_file}" ]]; then
  cookie_args+=(--cookies "${default_cookie_file}")
fi

downloaded_path="$(
  yt-dlp \
    --format "bestvideo[height<=1080][vcodec^=avc1]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" \
    --ffmpeg-location "$(dirname -- "$(command -v ffmpeg)")" \
    --merge-output-format mp4 \
    --restrict-filenames \
    --print after_move:filepath \
    "${cookie_args[@]}" \
    -o "${output_dir}/%(extractor)s_%(id)s.%(ext)s" \
    "${url}" | tail -n 1
)"

if [[ -z "${downloaded_path}" || ! -s "${downloaded_path}" ]]; then
  echo "yt-dlp did not produce a non-empty video file." >&2
  exit 1
fi

video_codec="$(
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
    -of default=nokey=1:noprint_wrappers=1 "${downloaded_path}" | head -n 1
)"
audio_codec="$(
  ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
    -of default=nokey=1:noprint_wrappers=1 "${downloaded_path}" | head -n 1
)"

case "${video_codec}" in
  h264 | hevc) video_ok=true ;;
  *) video_ok=false ;;
esac

if [[ "${audio_codec}" == "aac" || -z "${audio_codec}" ]]; then
  audio_ok=true
else
  audio_ok=false
fi

if [[ "${video_ok}" == "false" || "${audio_ok}" == "false" ]]; then
  source_path="${downloaded_path}"
  converted_path="${downloaded_path%.*}.wechat.mp4"
  ffmpeg -y -i "${downloaded_path}" \
    -map 0:v:0 -map 0:a? \
    -c:v libx264 -preset veryfast -crf 23 \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    "${converted_path}" >&2
  downloaded_path="${converted_path}"
  rm -f "${source_path}"
fi

printf '%s\n' "${downloaded_path}"
