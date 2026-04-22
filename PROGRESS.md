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
- Switched `wechat-*-start` to tmux-backed companion sessions with `.linkai/skills` sync links for `.codex/skills`, `.gemini/skills`, and `.copilot/skills`.
- Switched update checks from rolling 24h cache to a local 5:00 daily window.
- Added Docker packaging with `imbios/bun-node`, `docker-compose.yml`, `tmux`, `unless-stopped`, `openclaw-net`, `user: "0:0"`, and `./home:/root`.
- Added runtime bootstrap scripts to auto-install/update Codex, Gemini, Copilot, Claude, and OpenCode inside the container and reinstall the local package globally.
- Fixed container runtime dependency handling for native modules by adding build tooling, a dedicated `/app/node_modules` volume, and startup-time dependency hashing/rebuild logic for `node-pty`.
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

## In Progress

- Cleaning up remaining TypeScript/test drift that already existed in the repo alongside the new ACP changes.

## Notes

- Gemini ACP probing succeeded and returned live mode/model metadata plus a real prompt response.
- Copilot ACP probing succeeded and returned live mode/model/config metadata plus a real prompt response.
- Rebuilt the Docker image and verified inside the live container that `/app/node_modules/node-pty/build/Release/pty.node` exists and `require("node-pty")` succeeds.
- The repo still has pre-existing strict TypeScript issues outside this change set, so validation is being done incrementally with runnable entrypoints and targeted checks.
