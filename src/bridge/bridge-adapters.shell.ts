import type { ApprovalRequest } from "./bridge-types.ts";
import { isHighRiskShellCommand, nowIso, truncatePreview } from "./bridge-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import * as shared from "./bridge-adapters.shared.ts";

type ShellRuntime = shared.ShellRuntime;

const {
  buildShellInputPayload,
  buildShellProfileCommand,
  resolveShellRuntime,
} = shared;

export class ShellAdapter extends AbstractPtyAdapter {
  private pendingShellCommand: string | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;

  protected buildSpawnArgs(): string[] {
    return this.getShellRuntime().launchArgs;
  }

  protected override buildEnv(): Record<string, string> {
    const env = super.buildEnv();
    if (this.getShellRuntime().family === "posix") {
      env.PS1 = "";
      env.PROMPT = "";
      env.RPROMPT = "";
    }
    return env;
  }

  protected afterStart(): void {
    if (this.options.profile) {
      this.writeToPty(
        `${buildShellProfileCommand(this.options.profile, this.getShellRuntime().family)}\r`,
      );
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (isHighRiskShellCommand(text)) {
      this.pendingShellCommand = text;
      const request: ApprovalRequest = {
        source: "shell",
        summary: "High-risk shell command detected. Confirmation is required.",
        commandPreview: truncatePreview(text, 180),
      };
      this.pendingApproval = request;
      this.state.pendingApproval = request;
      this.setStatus("awaiting_approval", "Waiting for shell command approval.");
      this.emit({
        type: "approval_required",
        request,
        timestamp: nowIso(),
      });
      return;
    }

    await super.sendInput(text);
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
    }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status === "busy") {
        this.setStatus("idle", "Shell command interrupted.");
        this.emit({
          type: "task_complete",
          summary: "Interrupted",
          timestamp: nowIso(),
        });
      }
    }, 1_500);
    return true;
  }

  protected override prepareInput(text: string): string {
    return buildShellInputPayload(text, this.getShellRuntime().family);
  }

  protected override defaultCompletionDelayMs(): number {
    return 15_000;
  }

  protected override async applyApproval(
    action: "confirm" | "deny",
    _pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (action === "deny") {
      this.pendingShellCommand = null;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.setStatus("idle", "Shell command denied.");
      this.emit({
        type: "task_complete",
        summary: "Denied",
        timestamp: nowIso(),
      });
      return true;
    }

    const command = this.pendingShellCommand;
    if (!command) {
      return false;
    }

    this.pendingShellCommand = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    await super.sendInput(command);
    return true;
  }

  protected override handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    const match = text.match(/__WECHAT_BRIDGE_DONE__:(-?\d+)/);
    const visibleText = this.filterShellOutput(
      text.replace(/__WECHAT_BRIDGE_DONE__:-?\d+/g, ""),
    );

    if (visibleText.trim()) {
      this.emit({
        type: "stdout",
        text: visibleText,
        timestamp: nowIso(),
      });
    }

    if (match) {
      this.clearCompletionTimer();
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        exitCode: Number(match[1]),
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }
  }

  private filterShellOutput(text: string): string {
    const family = this.getShellRuntime().family;
    return text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return false;
        }
        if (trimmed.startsWith("$__wechatBridge")) {
          return false;
        }
        if (trimmed.startsWith("$ErrorActionPreference")) {
          return false;
        }
        if (trimmed === "try {" || trimmed === "} catch {" || trimmed === "}") {
          return false;
        }
        if (family === "posix") {
          if (trimmed === "__wechat_bridge_status=$?") {
            return false;
          }
          if (trimmed.startsWith("printf '__WECHAT_BRIDGE_DONE__:%s")) {
            return false;
          }
        }
        return true;
      })
      .join("\n");
  }

  private getShellRuntime(): ShellRuntime {
    return resolveShellRuntime(this.options.command);
  }
}

