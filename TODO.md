# TODO

- Systemize the background service model around a single `wechat-manager` supervisor:
  - use [roadmap/wechat-manager.md](/home/dbeidachazi/wechat/CLI-WeChat-Bridge/roadmap/wechat-manager.md) as the source blueprint for lifecycle supervision, IPC, session backends, logs, transcript storage, Web Console, and scheduler follow-up
  - prioritize manager/runtime-state/IPC/start-stop-status work before frontend or Windows-specific expansion

- Validate the new split command surface on the live WeChat bridge:
  - `/model <gemini|codex|copilot|claude|opencode|shell>` stays in the outer bridge layer and switches adapters before normal prompt forwarding
  - `/ai <command>` forwards slash commands directly into the inner AI session, e.g. `/ai status` -> `/status`, `/ai model gpt-5.4` -> `/model gpt-5.4`
  - startup-time adapter switching should work even when the default Codex companion is not connected

- Add a shared `.aiskill` baseline-rules layout for all AI runtimes:
  - create a generic rules folder under `.aiskill`
  - add `base_rules.md` for shared defaults such as language preference, code style, indentation habits, and other cross-AI behavior rules
  - verify how each AI runtime generates or consumes `AGENT.md`, coding-guideline files, and behavior-policy files
  - link the shared base document into each AI-specific docs/config area with symlinks where appropriate
  - confirm the shared base rules and each AI-specific document stay aligned instead of drifting

- Draft an `AGENT.md` template for the shared assistant persona and behavior contract:
  - use the provided template as the starting point
  - include the role/persona block, core directives, tone rules, and image-request workflow
  - validate how that template should be merged with project-specific constraints versus per-AI overrides
