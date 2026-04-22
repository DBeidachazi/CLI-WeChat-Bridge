# TODO

- Add `/wechatmodel <gemini|codex|copilot>` as a WeChat control command.
  Expected behavior:
  - intercept the command before normal prompt forwarding
  - switch the active WeChat-facing model/adapter target accordingly
  - replace the current model selection for subsequent turns
  - return a clear confirmation message to WeChat after the switch
