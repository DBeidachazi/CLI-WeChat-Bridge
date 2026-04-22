# TODO

- Validate the new split command surface on the live WeChat bridge:
  - `/model <gemini|codex|copilot|claude|opencode|shell>` stays in the outer bridge layer and switches adapters before normal prompt forwarding
  - `/ai <command>` forwards slash commands directly into the inner AI session, e.g. `/ai status` -> `/status`, `/ai model gpt-5.4` -> `/model gpt-5.4`
  - startup-time adapter switching should work even when the default Codex companion is not connected

- Add a shared baseline-rules layout for all AI runtimes under the canonical `.linkai` root:
  - create a generic rules folder under `.linkai`
  - add `base_rules.md` for shared defaults such as language preference, code style, indentation habits, and other cross-AI behavior rules
  - verify how each AI runtime generates or consumes `AGENT.md`, coding-guideline files, and behavior-policy files
  - expose the shared base document into each AI-specific docs/config area with symlinks where appropriate, including `.aiskill` as a compatibility alias
  - confirm the shared base rules and each AI-specific document stay aligned instead of drifting

- Draft an `AGENT.md` template for the shared assistant persona and behavior contract:
  - use the provided template as the starting point
  - include the role/persona block, core directives, tone rules, and image-request workflow
  - validate how that template should be merged with project-specific constraints versus per-AI overrides

- Investigate the WeChat "正在输入中..." indicator:
  - identify whether OpenClaw Weixin or the upstream WeChat API exposes a typing-status endpoint/event
  - confirm the request/response format and whether the bridge can trigger it safely during long-running turns
  - evaluate whether the bridge should emit typing status automatically while an AI task is in progress
