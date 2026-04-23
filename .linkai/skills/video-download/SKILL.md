---
name: video-download
description: Download online videos with yt-dlp for CLI-WeChat-Bridge and send them back to WeChat as local video attachments. Use when the user asks to download, save, fetch, or send a video from Bilibili, YouTube, X/Twitter, or another yt-dlp supported URL.
---

# Video Download

Use this skill when the user wants a remote video downloaded and sent back through CLI-WeChat-Bridge.

## Bridge-Specific Rule

For CLI-WeChat-Bridge, the final reply must end with a `wechat-attachments` block:

```wechat-attachments
video /root/meidia/example.mp4
```

Do not put the video path in a plain sentence. Do not use a URL in the attachment block. The path must be an absolute local path to a real file.

## Workflow

1. Create the output directory:

```bash
mkdir -p "$HOME/meidia"
```

2. Download the URL with `yt-dlp` into `~/meidia`.

Prefer the bundled helper if available:

```bash
helper="$(find "$HOME" -path '*/skills/video-download/scripts/download-video.sh' -print -quit)"
"$helper" "https://example.com/video"
```

The helper runs `yt-dlp` directly. If `yt-dlp` is missing, it installs `yt-dlp-dl` globally with npm, downloads the `yt-dlp` binary into `~/.local/bin`, and retries.

If running manually, use this pattern:

```bash
yt-dlp --merge-output-format mp4 -o "$HOME/meidia/%(extractor)s_%(id)s.%(ext)s" "VIDEO_URL"
```

3. Verify the resulting file exists and is non-empty:

```bash
ls -lh "$HOME/meidia"
```

4. Reply with a short note and exactly one trailing attachment block:

```wechat-attachments
video /absolute/path/to/downloaded.mp4
```

## Notes

- In Docker, `$HOME` is normally `/root`, so `~/meidia` becomes `/root/meidia`.
- Use `.mp4` when possible because WeChat video upload is most reliable with MP4.
- If `yt-dlp` is not installed, install it first; do not fall back to sending a remote video URL unless the user explicitly allows a link.
- If the file is too large for WeChat, try a lower format or transcode/compress before sending.
