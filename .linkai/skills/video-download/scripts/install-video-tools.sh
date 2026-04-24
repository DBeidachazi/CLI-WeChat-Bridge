#!/usr/bin/env bash
set -euo pipefail

install_dir="${1:-${HOME}/.local/bin}"
mkdir -p "${install_dir}"

log() {
  printf '[video-tools] %s\n' "$*" >&2
}

download() {
  local url="${1}"
  local output="${2}"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "${output}" "${url}"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "${output}" "${url}"
    return
  fi

  echo "Neither curl nor wget is available." >&2
  return 127
}

is_musl() {
  ldd --version 2>&1 | grep -qi musl
}

machine_arch="$(uname -m)"
case "${machine_arch}" in
  aarch64 | arm64)
    ytdlp_glibc_asset="yt-dlp_linux_aarch64"
    ytdlp_musl_asset="yt-dlp_musllinux_aarch64"
    ffmpeg_asset="ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
    ;;
  x86_64 | amd64)
    ytdlp_glibc_asset="yt-dlp_linux"
    ytdlp_musl_asset="yt-dlp_musllinux"
    ffmpeg_asset="ffmpeg-master-latest-linux64-gpl.tar.xz"
    ;;
  *)
    echo "Unsupported architecture for automatic video tools install: ${machine_arch}" >&2
    exit 1
    ;;
esac

if is_musl; then
  ytdlp_asset="${ytdlp_musl_asset}"
else
  ytdlp_asset="${ytdlp_glibc_asset}"
fi

ytdlp_path="${install_dir}/yt-dlp"
if [[ ! -x "${ytdlp_path}" ]]; then
  log "installing ${ytdlp_asset} from yt-dlp latest release"
  download \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlp_asset}" \
    "${ytdlp_path}"
  chmod +x "${ytdlp_path}"
else
  log "yt-dlp already exists at ${ytdlp_path}"
fi

if [[ -x "${install_dir}/ffmpeg" && -x "${install_dir}/ffprobe" ]]; then
  log "ffmpeg and ffprobe already exist in ${install_dir}"
else
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT
  archive_path="${tmp_dir}/${ffmpeg_asset}"

  log "installing ${ffmpeg_asset} from BtbN FFmpeg-Builds latest release"
  download \
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${ffmpeg_asset}" \
    "${archive_path}"

  tar -xJf "${archive_path}" -C "${tmp_dir}"
  ffmpeg_source="$(find "${tmp_dir}" -type f -path '*/bin/ffmpeg' -print -quit)"
  ffprobe_source="$(find "${tmp_dir}" -type f -path '*/bin/ffprobe' -print -quit)"

  if [[ -z "${ffmpeg_source}" || -z "${ffprobe_source}" ]]; then
    echo "Downloaded FFmpeg archive did not contain ffmpeg and ffprobe." >&2
    exit 1
  fi

  install -m 0755 "${ffmpeg_source}" "${install_dir}/ffmpeg"
  install -m 0755 "${ffprobe_source}" "${install_dir}/ffprobe"
fi

printf '%s\n' "${install_dir}"
