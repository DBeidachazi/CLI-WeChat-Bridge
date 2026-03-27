#!/usr/bin/env bun

import path from "node:path";

import {
  createBridgeAdapter,
  resolveDefaultAdapterCommand,
} from "./bridge-adapters.ts";
import { delay } from "./bridge-adapters.shared.ts";
import { forwardWechatFinalReply } from "./bridge-final-reply.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import type {
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeLifecycleMode,
  PendingApproval,
} from "./bridge-types.ts";
import {
  buildWechatInboundPrompt,
  buildOneTimeCode,
  formatApprovalMessage,
  formatPendingApprovalReminder,
  formatDuration,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatStatusReport,
  formatTaskFailedMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parseWechatControlCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatTransport,
  describeWechatTransportError,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  checkForUpdate,
  formatUpdateMessage,
} from "../utils/version-checker.ts";

type BridgeCliOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  lifecycle: BridgeLifecycleMode;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

type WechatSendContext =
  | "message"
  | "notice"
  | "approval_required"
  | "mirrored_user_input"
  | "session_switched"
  | "thread_switched"
  | "task_failed"
  | "fatal_error"
  | "inbound_error";

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const PARENT_PROCESS_POLL_MS = 5_000;

function log(message: string): void {
  process.stderr.write(`[wechat-bridge] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-bridge] ERROR: ${message}\n`);
}

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatUserFacingBridgeFatalError(message: string): string {
  return `Bridge error: ${message.replace(/\s+Recent app-server log:.*$/s, "").trim()}`;
}

export function formatWechatSendFailureLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_send_failed: context=${params.context} recipient=${params.recipientId} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function shouldWatchParentProcess(options: {
  startupParentPid: number;
  attachedToTerminal: boolean;
  lifecycle: BridgeLifecycleMode;
}): boolean {
  return (
    options.startupParentPid > 1 &&
    (options.attachedToTerminal || options.lifecycle === "companion_bound")
  );
}

export function parseCliArgs(argv: string[]): BridgeCliOptions {
  let adapter: BridgeAdapterKind | null = null;
  let commandOverride: string | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;
  let lifecycle: BridgeLifecycleMode = "persistent";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--adapter":
        if (!next || !["codex", "claude", "shell"].includes(next)) {
          throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
        }
        adapter = next as BridgeAdapterKind;
        i += 1;
        break;
      case "--cmd":
        if (!next) {
          throw new Error("--cmd requires a value");
        }
        commandOverride = next;
        i += 1;
        break;
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value");
        }
        cwd = path.resolve(next);
        i += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error("--profile requires a value");
        }
        profile = next;
        i += 1;
        break;
      case "--lifecycle":
        if (!next || !["persistent", "companion_bound"].includes(next)) {
          throw new Error(`Invalid lifecycle: ${next ?? "(missing)"}`);
        }
        lifecycle = next as BridgeLifecycleMode;
        i += 1;
        break;
      case "--shutdown-on-parent-exit":
        lifecycle = "companion_bound";
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|shell>");
  }

  const defaultCommand = resolveDefaultAdapterCommand(adapter);
  return {
    adapter,
    command: commandOverride ?? defaultCommand,
    cwd,
    profile,
    lifecycle,
  };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Usage: wechat-bridge --adapter <codex|claude|shell> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>] [--lifecycle <persistent|companion_bound>]",
      "",
      "Examples:",
      "  wechat-bridge-codex",
      "  wechat-bridge-claude --cwd ~/work/my-project",
      "  wechat-bridge-shell --cmd pwsh   # headless shell executor for non-interactive commands/scripts",
      "  wechat-bridge-shell --cmd bash   # headless shell executor for non-interactive commands/scripts",
      "  wechat-bridge-codex --lifecycle companion_bound",
      "  bun run bridge:codex            # repo-local development entrypoint",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);

  // 非阻塞地检查更新（不影响启动速度）
  setTimeout(async () => {
    try {
      const versionInfo = await checkForUpdate();
      if (versionInfo?.hasUpdate) {
        log(formatUpdateMessage(versionInfo));
      }
    } catch (error) {
      // 静默失败，不影响正常使用
    }
  }, 3000); // 延迟3秒，确保不影响启动

  const options = parseCliArgs(process.argv.slice(2));
  const transport = new WeChatTransport({ log, logError });

  const credentials = transport.getCredentials();
  if (!credentials) {
    throw new Error('No saved WeChat credentials found. Run "bun run setup" first.');
  }
  if (!credentials.userId) {
    throw new Error('Saved WeChat credentials are missing userId. Run "bun run setup" again.');
  }

  const stateStore = new BridgeStateStore({
    ...options,
    authorizedUserId: credentials.userId,
  });

  const adapter = createBridgeAdapter({
    kind: options.adapter,
    command: options.command,
    cwd: options.cwd,
    profile: options.profile,
    lifecycle: options.lifecycle,
    initialSharedSessionId:
      stateStore.getState().sharedSessionId ?? stateStore.getState().sharedThreadId,
    initialResumeConversationId: stateStore.getState().resumeConversationId,
    initialTranscriptPath: stateStore.getState().transcriptPath,
  });
  let textSendChain = Promise.resolve();
  let attachmentSendChain = Promise.resolve();
  let activeTask: ActiveTask | null = null;
  let lastOutputAt = 0;
  let lastHeartbeatAt = 0;
  let consecutivePollFailures = 0;

  const queueWechatTextAction = <T>(action: () => Promise<T>) => {
    const run = textSendChain.then(action);
    textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatAttachmentAction = <T>(action: () => Promise<T>) => {
    const run = attachmentSendChain.then(action);
    attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatMessage = (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ) => {
    return queueWechatTextAction(() => transport.sendText(senderId, text)).catch((err) => {
      logError(`Failed to send WeChat ${context}: ${describeWechatTransportError(err)}`);
      stateStore.appendLog(
        formatWechatSendFailureLogEntry({
          context,
          recipientId: senderId,
          error: err,
        }),
      );
    });
  };

  const outputBatcher = new OutputBatcher(async (text) => {
    await queueWechatMessage(stateStore.getState().authorizedUserId, text);
  });
  const startupParentPid = process.ppid;
  const attachedToTerminal = Boolean(
    process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
  );
  let shutdownPromise: Promise<void> | null = null;
  let requestedExitCode = 0;
  let stdinDetached = false;
  const parentWatchTimer =
    shouldWatchParentProcess({
      startupParentPid,
      attachedToTerminal,
      lifecycle: options.lifecycle,
    })
      ? setInterval(() => {
          if (shutdownPromise || isPidAlive(startupParentPid)) {
            return;
          }
          log(`Parent process ${startupParentPid} exited. Stopping bridge.`);
          void shutdown(0);
        }, PARENT_PROCESS_POLL_MS)
      : null;
  parentWatchTimer?.unref();

  const cleanup = async () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    try {
      await outputBatcher.flushNow();
    } catch {
      // Best effort flush.
    }
    try {
      await textSendChain;
      await attachmentSendChain;
    } catch {
      // Best effort flush.
    }
    try {
      await adapter.dispose();
    } catch {
      // Best effort shutdown.
    }
    stateStore.releaseLock();
  };

  const shutdown = async (exitCode = 0): Promise<void> => {
    requestedExitCode = exitCode;
    if (!shutdownPromise) {
      shutdownPromise = cleanup().catch((error) => {
        logError(`Shutdown cleanup failed: ${describeWechatTransportError(error)}`);
      });
    }
    await shutdownPromise;
  };

  const requestShutdown = (message: string, exitCode = 0) => {
    if (shutdownPromise) {
      return;
    }
    log(message);
    void shutdown(exitCode).finally(() => process.exit(requestedExitCode));
  };

  process.once("SIGINT", () => {
    requestShutdown("Received SIGINT. Stopping bridge.");
  });
  process.once("SIGTERM", () => {
    requestShutdown("Received SIGTERM. Stopping bridge.");
  });
  process.once("SIGHUP", () => {
    requestShutdown("Terminal session closed. Stopping bridge.");
  });
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => {
      requestShutdown("Received SIGBREAK. Stopping bridge.");
    });
  }
  if (attachedToTerminal) {
    process.stdin.on("close", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input closed. Stopping bridge.");
    });
    process.stdin.on("end", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input ended. Stopping bridge.");
    });
  }
  process.on("exit", () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    stateStore.releaseLock();
  });

  try {
    wireAdapterEvents({
      adapter,
      options,
      transport,
      stateStore,
      outputBatcher,
      queueWechatAttachmentAction,
      queueWechatMessage,
      getActiveTask: () => activeTask,
      clearActiveTask: () => {
        activeTask = null;
        lastHeartbeatAt = 0;
      },
      updateLastOutputAt: () => {
        lastOutputAt = Date.now();
      },
      syncSharedSessionState: () => {
        syncSharedSessionState(stateStore, adapter);
      },
      requestShutdown,
    });

    await adapter.start();
    syncSharedSessionState(stateStore, adapter);
    stateStore.appendLog(
      `Bridge started with adapter=${options.adapter} command=${options.command} cwd=${options.cwd}`,
    );

    log(`WeChat bridge is ready for adapter "${options.adapter}".`);
    log(`Working directory: ${options.cwd}`);
    if (options.profile) {
      log(`Profile: ${options.profile}`);
    }
    log(`Authorized WeChat user: ${credentials.userId}`);
    if (options.adapter === "codex") {
      log(
        'Start the visible Codex panel in a second terminal with: wechat-codex',
      );
    } else if (options.adapter === "claude") {
      log(
        'Start the visible Claude companion in a second terminal with: wechat-claude',
      );
    } else if (options.adapter === "shell") {
      log(
        "Shell mode runs as a headless remote executor for non-interactive commands and scripts.",
      );
    }

    while (true) {
      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: stateStore.getState().bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (err) {
        const classification = classifyWechatTransportError(err);
        if (!classification.retryable) {
          throw err;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(err);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        stateStore.appendLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (consecutivePollFailures > 0) {
        const recoveredFailures = consecutivePollFailures;
        consecutivePollFailures = 0;
        log(`WeChat long poll recovered after ${recoveredFailures} transient error(s).`);
        stateStore.appendLog(`poll_recovered: failures=${recoveredFailures}`);
      }

      if (pollResult.ignoredBacklogCount > 0) {
        stateStore.incrementIgnoredBacklog(pollResult.ignoredBacklogCount);
        stateStore.appendLog(
          `ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`,
        );
      }

      for (const message of pollResult.messages) {
        stateStore.touchActivity(message.createdAt);
        let nextTask: ActiveTask | null = null;
        try {
          nextTask = await handleInboundMessage({
            message,
            options,
            stateStore,
            adapter,
            queueWechatMessage,
            outputBatcher,
          });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const isUserFacingShellRejection =
            err instanceof Error && err.name === "ShellCommandRejectedError";
          logError(errorText);
          stateStore.appendLog(
            `${isUserFacingShellRejection ? "inbound_rejected" : "inbound_error"}: ${errorText}`,
          );
          await queueWechatMessage(
            message.senderId,
            isUserFacingShellRejection ? errorText : `Bridge error: ${errorText}`,
            "inbound_error",
          );
        }
        if (nextTask) {
          activeTask = nextTask;
          lastHeartbeatAt = 0;
        }
        syncSharedSessionState(stateStore, adapter);
      }

      const adapterState = adapter.getState();
      const lastSignalAt = Math.max(lastHeartbeatAt, lastOutputAt || activeTask?.startedAt || 0);

      if (
        activeTask &&
        options.adapter === "shell" &&
        adapterState.status === "busy" &&
        Date.now() - lastSignalAt >= 30_000
      ) {
        lastHeartbeatAt = Date.now();
        await queueWechatMessage(
          stateStore.getState().authorizedUserId,
          `${options.adapter} is still running. Waiting for more output...`,
        );
      }
    }
  } finally {
    await shutdown(requestedExitCode);
  }
}

function syncSharedSessionState(
  stateStore: BridgeStateStore,
  adapter: BridgeAdapter,
): void {
  const persistedState = stateStore.getState();
  const persistedSessionId = persistedState.sharedSessionId ?? persistedState.sharedThreadId;
  const adapterState = adapter.getState();
  const adapterSessionId = adapterState.sharedSessionId ?? adapterState.sharedThreadId;

  if (adapterSessionId && adapterSessionId !== persistedSessionId) {
    stateStore.setSharedSessionId(adapterSessionId);
  } else if (!adapterSessionId && persistedSessionId) {
    stateStore.clearSharedSessionId();
  }

  if (persistedState.adapter !== "claude") {
    return;
  }

  if (
    adapterState.resumeConversationId !== persistedState.resumeConversationId ||
    adapterState.transcriptPath !== persistedState.transcriptPath
  ) {
    if (adapterState.resumeConversationId || adapterState.transcriptPath) {
      stateStore.setClaudeResumeState(
        adapterState.resumeConversationId,
        adapterState.transcriptPath,
      );
    } else {
      stateStore.clearClaudeResumeState();
    }
  }
}

function wireAdapterEvents(params: {
  adapter: BridgeAdapter;
  options: BridgeCliOptions;
  transport: WeChatTransport;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatAttachmentAction: <T>(action: () => Promise<T>) => Promise<T>;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: () => void;
  updateLastOutputAt: () => void;
  syncSharedSessionState: () => void;
  requestShutdown: (message: string, exitCode?: number) => void;
}): void {
  const {
    adapter,
    options,
    transport,
    stateStore,
    outputBatcher,
    queueWechatAttachmentAction,
    queueWechatMessage,
    getActiveTask,
    clearActiveTask,
    updateLastOutputAt,
    syncSharedSessionState,
    requestShutdown,
  } = params;

  adapter.setEventSink((event) => {
    syncSharedSessionState();
    const adapterState = adapter.getState();
    const bridgeState = stateStore.getState();
    if (bridgeState.pendingConfirmation && !adapterState.pendingApproval) {
      stateStore.clearPendingConfirmation();
    }
    const authorizedUserId = stateStore.getState().authorizedUserId;

    switch (event.type) {
      case "stdout":
      case "stderr":
        updateLastOutputAt();
        outputBatcher.push(event.text);
        break;
      case "final_reply":
        void outputBatcher.flushNow().then(async () => {
          await forwardWechatFinalReply({
            adapter: options.adapter,
            rawText: event.text,
            sender: {
              sendText: (text) => queueWechatMessage(authorizedUserId, text),
              sendImage: (imagePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendImage(imagePath, { recipientId: authorizedUserId }),
                ),
              sendFile: (filePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendFile(filePath, { recipientId: authorizedUserId }),
                ),
              sendVoice: (voicePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVoice(voicePath, authorizedUserId),
                ),
              sendVideo: (videoPath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVideo(videoPath, { recipientId: authorizedUserId }),
                ),
            },
          });
        });
        break;
      case "status":
        if (event.message) {
          log(`${event.status}: ${event.message}`);
          stateStore.appendLog(`${event.status}: ${event.message}`);
        }
        break;
      case "notice":
        updateLastOutputAt();
        stateStore.appendLog(`${event.level}_notice: ${truncatePreview(event.text)}`);
        void outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(authorizedUserId, event.text, "notice");
        });
        break;
      case "approval_required":
        void outputBatcher.flushNow().then(async () => {
          const pending: PendingApproval = {
            ...event.request,
            code: buildOneTimeCode(),
            createdAt: nowIso(),
          };
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(
            `Approval requested (${pending.source}): ${pending.commandPreview}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatApprovalMessage(pending, adapterState),
            "approval_required",
          );
        });
        break;
      case "mirrored_user_input":
        void outputBatcher.flushNow().then(async () => {
          stateStore.appendLog(`mirrored_local_input: ${truncatePreview(event.text)}`);
          await queueWechatMessage(
            authorizedUserId,
            formatMirroredUserInputMessage(options.adapter, event.text),
            "mirrored_user_input",
          );
        });
        break;
      case "session_switched":
        stateStore.appendLog(
          `session_switched: ${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        void outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatSessionSwitchMessage({
              adapter: options.adapter,
              sessionId: event.sessionId,
              source: event.source,
              reason: event.reason,
            }),
            "session_switched",
          );
        });
        break;
      case "thread_switched":
        stateStore.appendLog(
          `thread_switched: ${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        void outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatSessionSwitchMessage({
              adapter: options.adapter,
              sessionId: event.threadId,
              source: event.source,
              reason: event.reason,
            }),
            "thread_switched",
          );
        });
        break;
      case "task_complete":
        void outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          if (options.adapter === "shell") {
            const summary = buildCompletionSummary({
              adapter: options.adapter,
              activeTask: getActiveTask(),
              exitCode: event.exitCode,
              recentOutput: outputBatcher.getRecentSummary(),
            });
            await queueWechatMessage(authorizedUserId, summary);
          }
          clearActiveTask();
        });
        break;
      case "task_failed":
        void outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          clearActiveTask();
          await queueWechatMessage(
            authorizedUserId,
            formatTaskFailedMessage(options.adapter, event.message),
            "task_failed",
          );
        });
        break;
      case "fatal_error":
        logError(event.message);
        stateStore.appendLog(`fatal_error: ${event.message}`);
        stateStore.clearPendingConfirmation();
        clearActiveTask();
        void outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatUserFacingBridgeFatalError(event.message),
            "fatal_error",
          );
        });
        break;
      case "shutdown_requested":
        stateStore.appendLog(`shutdown_requested: ${event.reason}`);
        requestShutdown(event.message, event.exitCode ?? 0);
        break;
    }
  });
}

function buildCompletionSummary(params: {
  adapter: BridgeAdapterKind;
  activeTask: ActiveTask | null;
  exitCode?: number;
  recentOutput: string;
}): string {
  const lines = [`${params.adapter} task complete.`];
  if (params.activeTask) {
    lines.push(
      `duration: ${formatDuration(Date.now() - params.activeTask.startedAt)}`,
    );
    lines.push(`input: ${params.activeTask.inputPreview}`);
  }
  if (typeof params.exitCode === "number") {
    lines.push(`exit_code: ${params.exitCode}`);
  }
  lines.push(`recent_output:\n${params.recentOutput}`);
  return lines.join("\n");
}

async function handleInboundMessage(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<void>;
  outputBatcher: OutputBatcher;
}): Promise<ActiveTask | null> {
  const { message, options, stateStore, adapter, queueWechatMessage, outputBatcher } = params;
  const state = stateStore.getState();
  const systemCommand = parseWechatControlCommand(message.text, {
    adapter: options.adapter,
    hasPendingConfirmation: Boolean(state.pendingConfirmation),
  });

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      "Unauthorized. This bridge only accepts messages from the configured WeChat owner.",
    );
    return null;
  }

  switch (systemCommand?.type) {
    case "status":
      await queueWechatMessage(
        message.senderId,
        formatStatusReport(stateStore.getState(), adapter.getState()),
      );
      return null;
    case "resume": {
      if (options.adapter === "codex") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in codex mode. Use /resume directly inside "wechat-codex"; WeChat will follow the active local thread.',
        );
        return null;
      }
      if (options.adapter === "claude") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
        );
        return null;
      }

      await queueWechatMessage(
        message.senderId,
        `/resume is not available in ${options.adapter} mode.`,
      );
      return null;
    }
    case "stop": {
      const interrupted = await adapter.interrupt();
      await queueWechatMessage(
        message.senderId,
        interrupted
          ? "Interrupt signal sent to the active worker."
          : "No running worker was available to interrupt.",
      );
      return null;
    }
    case "reset":
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearSharedSessionId();
      await adapter.reset();
      stateStore.appendLog("Worker reset by owner.");
      await queueWechatMessage(message.senderId, "Worker session has been reset.");
      return null;
    case "confirm": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      if (options.adapter !== "claude" && pending.code !== systemCommand.code) {
        await queueWechatMessage(message.senderId, "Confirmation code did not match.");
        return null;
      }
      const confirmed = await adapter.resolveApproval("confirm");
      if (!confirmed) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not apply this approval request.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval confirmed: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval confirmed. Continuing...");
      return {
        startedAt: Date.now(),
        inputPreview: pending.commandPreview,
      };
    }
    case "deny": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      const denied = await adapter.resolveApproval("deny");
      if (!denied) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not deny this approval request cleanly.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval denied: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval denied.");
      return null;
    }
  }

  if (state.pendingConfirmation) {
    await queueWechatMessage(
      message.senderId,
      formatPendingApprovalReminder(state.pendingConfirmation, adapter.getState()),
    );
    return null;
  }

  const adapterState = adapter.getState();
  if (adapterState.status === "busy") {
    if (options.adapter === "codex" && adapterState.activeTurnOrigin === "local") {
      await queueWechatMessage(
        message.senderId,
        "codex is currently busy with a local terminal turn. Wait for it to finish or use /stop.",
      );
      return null;
    }

    await queueWechatMessage(
      message.senderId,
      `${options.adapter} is still working. Wait for the current reply or use /stop.`,
    );
    return null;
  }

  const activeTask = {
    startedAt: Date.now(),
    inputPreview: truncatePreview(message.text, 180),
  };
  stateStore.appendLog(`Forwarded input to ${options.adapter}: ${truncatePreview(message.text)}`);
  await adapter.sendInput(buildWechatInboundPrompt(message.text));
  return activeTask;
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((err) => {
    logError(describeWechatTransportError(err));
    process.exit(1);
  });
}
