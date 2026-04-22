# AGENT

## Purpose

This repository bridges WeChat messages into local CLI agents such as Codex, Claude, OpenCode, Gemini, Copilot, and a restricted shell mode. The core runtime polls WeChat, forwards inbound messages into the active adapter, and sends final replies or attachments back to WeChat.

## Project Structure

- `src/bridge/`
  Runtime bridge orchestration, adapter implementations, prompt shaping, approval handling, final-reply forwarding, and session/thread state.
- `src/companion/`
  Local companion startup, endpoint IPC, tmux-backed launcher flow, and workspace-scoped bridge/client reconnection logic.
- `src/wechat/`
  WeChat transport, channel configuration, setup flow, polling/send APIs, and MCP-facing channel/server code.
- `src/config/`
  Environment loading and bridge runtime configuration defaults.
- `src/utils/`
  Shared utility code such as version checking.
- `bin/`
  Repo entrypoints for bridge and companion commands.
- `scripts/`
  Runtime bootstrap and container helper scripts.
- `test/`
  Bun-based unit tests for bridge logic, launcher helpers, transport behavior, and adapter-specific flows.
- `docs/`
  Release notes and supporting project documentation.
- `home/`
  Local runtime mount point used by the containerized workflow.

## Shared Skills

- Shared project-level skills live under `.linkai/skills`.
- Backward compatibility is kept through `.aiskill/skills -> .linkai/skills`.
- The launcher links `.codex/skills`, `.gemini/skills`, and `.copilot/skills` into the shared skills directory.
- The launcher also ensures a generated `wechat-bridge-multimodal` skill exists so supported agents can discover WeChat multimodal input/output behavior on the first turn.

## Working Rules

- When a change affects delivery status, roadmap, or current investigation state, update `PROGRESS.md` in the same change set.
- Keep `AGENT.md`, `PROGRESS.md`, and the generated shared WeChat bridge skill aligned when multimodal capabilities or workflow expectations change.
- Prefer incremental, adapter-safe changes: keep Codex/Claude/OpenCode behavior stable while extending Gemini/Copilot ACP multimodal support.
- If local validation is blocked by missing tooling, record the limitation explicitly in `PROGRESS.md` or the final change summary.

## Current Focus

- First-turn multimodal capability discovery is now documented and injected into inbound prompts.
- Shared skill synchronization now targets `.linkai/skills` with legacy `.aiskill/skills` compatibility.
- Inbound WeChat image/media ingestion now downloads and decrypts inbound media into local files, prefers encrypted CDN references over plain image URLs, and forwards compatible attachments into ACP prompts.
- WeChat image key parsing must remain compatible with both direct hex keys and `base64(hex)` `media.aes_key` values, because runtime failures otherwise surface as Gemini `Provided image is not valid` errors.
- Gemini can also fail on outbound image attempts when the model downloads a non-image file with an image extension; bridge behavior should prefer recovering the session instead of leaving later text-only turns stuck in the same invalid-image state.
- WeChat should treat `/new` as a reset-style control alias, because users naturally try chat-style reset wording from the phone.
- WeChat command routing is now split:
  - outer bridge commands such as `/help`, `/status`, `/model`, `/reset`, and `/stop`
  - inner AI passthrough commands via `/ai ...`, which should forward slash commands into the active model session without outer interception
- Remaining verification work is now runtime validation on the target host and any follow-up fixes from CI or environment-specific behavior.
