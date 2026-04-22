# TODO

- Validate the new split command surface on the live WeChat bridge:
  - `/model <gemini|codex|copilot|claude|opencode|shell>` stays in the outer bridge layer and switches adapters before normal prompt forwarding
  - `/ai <command>` forwards slash commands directly into the inner AI session, e.g. `/ai status` -> `/status`, `/ai model gpt-5.4` -> `/model gpt-5.4`
  - startup-time adapter switching should work even when the default Codex companion is not connected
