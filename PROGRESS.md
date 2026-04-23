# Progress

## Completed

- Added `.env` loading and centralized bridge configuration defaults.
- Added default spawn commands, model defaults, ACP auto-approval, Codex unrestricted defaults, and 5:00 update-check scheduling.
- Added Gemini and Copilot adapter kinds, bins, scripts, help text, and bridge wiring.
- Verified local ACP viability against real binaries:
  - `gemini --acp`
  - `copilot --acp --stdio`
- Added an ACP adapter base with:
  - ACP stdio transport
  - session create/resume support
  - model/mode preference application
  - permission handling
  - file read/write callbacks
  - terminal create/output/wait/kill/release callbacks
  - local session cache for resume candidates
- Updated `wechat-*-start` help/output to include Gemini and Copilot.
- Switched `wechat-*-start` to tmux-backed companion sessions with `.linkai/skills` sync links for `.claude/skills`, `.codex/skills`, `.gemini/skills`, and `.copilot/skills`.
- Switched update checks from rolling 24h cache to a local 5:00 daily window.
- Added Docker packaging with `imbios/bun-node`, `docker-compose.yml`, `tmux`, `unless-stopped`, `openclaw-net`, `user: "0:0"`, and `./home:/root`.
- Added runtime bootstrap scripts to auto-install/update Codex, Gemini, Copilot, Claude, and OpenCode inside the container and reinstall the local package globally.
- Fixed container runtime dependency handling for native modules by adding build tooling and startup-time dependency hashing/rebuild logic for `node-pty`.
- Added container auto-setup for WeChat credentials: when `account.json` is missing, startup now runs `bun run setup` and emits the QR code to container logs instead of failing immediately.
- Added transcript logging to bridge stdout/stderr so the WeChat <-> CLI text flow is visible in `docker logs`.
- Updated the container entrypoint from a single bridge `exec` into a lightweight manager loop so `wechat-gemini-start` / `wechat-copilot-start` / similar replacement launches no longer kill the whole container.
- Hardened startup permissions by reapplying `chmod +x` to repo-local bins/scripts and installed global `wechat-*` commands after bootstrap/global install.
- Refreshed setup output and README so the Docker Compose flow, QR-login flow, adapter switching behavior, and transcript logging match the current implementation.
- Fixed cross-adapter session carryover so Codex thread ids are no longer reused as Gemini/Copilot ACP session ids.
- Fixed `wechat-*-start` under tmux to launch replacement bridges as `persistent`, preventing parent-exit shutdown from tearing down the bridge right after the launcher returns.
- Wired detached replacement-bridge stdout/stderr back into container stdout/stderr, so Gemini/Copilot replacement sessions now emit startup/transcript logs to `docker logs` as well.
- Expanded `.gitignore` / `.dockerignore` to keep local auth, runtime state, `home/`, skills links, and editor files out of Git and Docker build context.
- Added a GitHub Actions workflow that builds and pushes the Docker image to DockerHub on `main`, tags, or manual dispatch.
- Kept `.linkai/skills` as the canonical shared skills root, while exposing `.aiskill/skills -> .linkai/skills` as a backward-compatible alias.
- Added automatic generation of a shared `wechat-bridge-multimodal` skill so Codex, Gemini, and Copilot can discover WeChat multimodal input/output conventions from the shared skills directory.
- Updated inbound WeChat prompt construction so the first turn now explicitly tells the model that the bridge supports multimodal WeChat input/output, voice transcripts, and `wechat-attachments` media replies.
- Updated README and prompt-oriented tests to match the new shared skill layout and first-turn multimodal capability note.
- Extended inbound bridge input from plain text to `text + attachments`, while keeping the old string-based adapter entrypoints backward-compatible.
- Added inbound WeChat media parsing for `image`, `voice`, `file`, and `video` items, with CDN download + AES-128-ECB decryption into local cached files.
- Wired ACP prompt construction to inline inbound WeChat images as multimodal prompt content when the target agent advertises image prompt capability, and otherwise fall back to local `resource_link` references.
- Updated WeChat fetch formatting and prompt tests to expose inbound attachment paths and multimodal prompt content behavior.
- Fixed inbound WeChat image decoding to accept both direct hex keys and `base64(hex)` `media.aes_key` values, matching the OpenClaw Weixin media format more closely.
- Hardened inbound image download handling so encrypted CDN URLs are preferred over plain `image_item.url`, and invalid decrypted image payloads are rejected before they are forwarded into Gemini/Copilot ACP prompts.
- Added Gemini session recovery for `Provided image is not valid` task failures so later text turns are not stuck behind the same bad multimodal state.
- Added `/new` as a WeChat alias for `/reset`, matching the more common chat-reset wording.
- Split WeChat command handling into outer bridge controls and inner AI passthrough commands:
  - `/model ...` now switches the bridge adapter layer
  - `/ai ...` now forwards slash commands into the active inner AI session, normalizing `/ai status` into `/status`
- Allowed startup-time adapter switching from WeChat before a disconnected default Codex companion blocks ordinary prompt forwarding.
- Reverted the two CRLF-polluted history entries (`781e9acbd00e9471af676a2c1e902bbb8880150e` and `5a57671c8449c16f00245fa4e0ef72fc9186815c`) with dedicated revert commits, then removed `.gitattributes` so line-ending policy is no longer enforced from the repo root.
- Updated the tracked hidden-directory overlay and container bootstrap so shared `.linkai` guidance files are linked into `.claude`, `.codex`, `.gemini`, and `.copilot` in the repo, and into `/root/.claude`, `/root/.codex`, `/root/.gemini`, and `/root/.copilot` inside Docker without overwriting provider-owned files.
- Added `scripts/multi-link-service.cjs` plus startup-time symlink probing so Docker deployments on filesystems like `exfat` now keep `.linkai` docs and `skills` continuously synchronized into `/root/.claude`, `/root/.codex`, `/root/.gemini`, and `/root/.copilot` instead of failing on unsupported symlinks or settling for one-shot copies.
- Reduced provider-context duplication by renaming shared `.linkai` guidance sources to non-reserved `*.shared.md` filenames, keeping only the target home-directory projections (`/root/.gemini/GEMINI.md`, etc.) as provider-visible memory files.
- Updated the Docker runtime so `/app` stays application source only, provider-readable guidance files are no longer copied there, managed plus `wechat-*-start` bridges default their AI workspace to `/root`, and shared docs still project from `/app/.linkai` via `WECHAT_BRIDGE_SHARED_ROOT`.

## In Progress

- Cleaning up remaining TypeScript/test drift that already existed in the repo alongside the new ACP changes.
- Tightening the shared-skill workflow so project guidance stays synchronized between `AGENT.md`, `PROGRESS.md`, and the generated shared WeChat bridge skill.
- Initializing Ultracite so future repository hygiene is driven by a single shared toolchain instead of ad hoc line-ending enforcement.
- End-to-end runtime verification on the target iStoreOS host after CI completes:
  - confirm inbound WeChat images reach Gemini/Copilot on the first turn without `Provided image is not valid`
  - confirm a bad outbound Gemini image candidate no longer poisons later text-only turns
  - confirm `/model gemini` works from WeChat even when the default Codex companion is disconnected
  - confirm `/ai status` and `/ai model ...` reach the inner AI instead of being intercepted by the outer bridge
  - confirm inbound voice/file/video handling remains stable
  - inspect any host-specific path, dependency, or credential issues on `192.168.1.111`

## Notes

- Gemini ACP probing succeeded and returned live mode/model metadata plus a real prompt response.
- Copilot ACP probing succeeded and returned live mode/model/config metadata plus a real prompt response.
- Rebuilt the Docker image and verified inside the live container that `/app/node_modules/node-pty/build/Release/pty.node` exists and `require("node-pty")` succeeds.
- Live host logs confirmed that inbound WeChat images are now being downloaded and attached into Gemini prompts, but one runtime sample failed with `Provided image is not valid`; this change set targets that decode/validation gap.
- Live host logs also showed an outbound-side failure mode: Gemini downloaded `/app/anime_sample.png` as a 100-byte plain-text `File not found` response, then kept failing later turns with the same invalid image state until the session was reset.
- The repo still has pre-existing strict TypeScript issues outside this change set, so validation is being done incrementally with runnable entrypoints and targeted checks.
- Bun is now available on the current Windows host at `C:\Users\26950\scoop\shims\bun.exe`, so targeted Bun tests are being used for transport and ACP verification.
