#!/usr/bin/env bun

import net from "node:net";
import path from "node:path";

import { createBridgeAdapter } from "../bridge/bridge-adapters.ts";
import {
  attachLocalCompanionMessageListener,
  readLocalCompanionEndpoint,
  sendLocalCompanionMessage,
  type LocalCompanionMessage,
} from "./local-companion-link.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";

function log(adapter: string, message: string): void {
  process.stderr.write(`[${adapter}-companion] ${message}\n`);
}

type LocalCompanionCliOptions = {
  adapter: "codex" | "claude" | "opencode";
  cwd: string;
};

function parseCliArgs(argv: string[]): LocalCompanionCliOptions {
  let adapter: "codex" | "claude" | "opencode" | null = null;
  let cwd = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: local-companion --adapter <codex|claude|opencode> [--cwd <path>]",
          "",
          'Starts the visible local companion and connects it to the matching running bridge for the current directory.',
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--adapter") {
      if (!next || !["codex", "claude", "opencode"].includes(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      adapter = next as "codex" | "claude" | "opencode";
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|opencode>");
  }

  return { adapter, cwd };
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles((message) => log("local", message));
  const options = parseCliArgs(process.argv.slice(2));

  const endpoint = readLocalCompanionEndpoint(options.cwd);
  if (!endpoint || endpoint.kind !== options.adapter) {
    throw new Error(
      `No active ${options.adapter} bridge endpoint was found for ${options.cwd}. Start "wechat-bridge-${options.adapter}" in that directory first.`,
    );
  }

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const nextSocket = net.connect({
      host: "127.0.0.1",
      port: endpoint.port,
    });

    nextSocket.once("connect", () => resolve(nextSocket));
    nextSocket.once("error", (error) => reject(error));
  });

  socket.setNoDelay(true);

  const adapter = createBridgeAdapter({
    kind: endpoint.kind,
    command: endpoint.command,
    cwd: endpoint.cwd,
    profile: endpoint.profile,
    initialSharedSessionId: endpoint.sharedSessionId ?? endpoint.sharedThreadId,
    initialResumeConversationId: endpoint.resumeConversationId,
    initialTranscriptPath: endpoint.transcriptPath,
    renderMode: endpoint.kind === "codex" ? "panel" : "companion",
  });

  let shuttingDown = false;
  let helloAcknowledged = false;
  let detachListener: (() => void) | null = null;

  const publishState = () => {
    sendLocalCompanionMessage(socket, {
      type: "state",
      state: adapter.getState(),
    });
  };

  const sendResponse = (id: string, ok: boolean, result?: unknown, error?: string) => {
    sendLocalCompanionMessage(socket, {
      type: "response",
      id,
      ok,
      result,
      error,
    });
  };

  const closeCompanion = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    detachListener?.();
    detachListener = null;
    try {
      await adapter.dispose();
    } catch {
      // Best effort cleanup.
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      // Best effort cleanup.
    }
    process.exit(exitCode);
  };

  adapter.setEventSink((event) => {
    sendLocalCompanionMessage(socket, {
      type: "event",
      event,
    });
    publishState();
  });

  detachListener = attachLocalCompanionMessageListener(socket, (message: LocalCompanionMessage) => {
    if (!helloAcknowledged) {
      if (message.type === "hello_ack") {
        helloAcknowledged = true;
      }
      return;
    }

    if (message.type !== "request") {
      return;
    }

    void (async () => {
      try {
        switch (message.payload.command) {
          case "send_input":
            await adapter.sendInput(message.payload.text);
            sendResponse(message.id, true);
            break;
          case "list_resume_sessions":
          case "list_resume_threads":
            sendResponse(
              message.id,
              true,
              await adapter.listResumeSessions(message.payload.limit),
            );
            break;
          case "resume_session":
            await adapter.resumeSession(message.payload.sessionId);
            publishState();
            sendResponse(message.id, true);
            break;
          case "resume_thread":
            await adapter.resumeSession(message.payload.threadId);
            publishState();
            sendResponse(message.id, true);
            break;
          case "interrupt":
            sendResponse(message.id, true, await adapter.interrupt());
            break;
          case "reset":
            await adapter.reset();
            publishState();
            sendResponse(message.id, true);
            break;
          case "resolve_approval":
            sendResponse(
              message.id,
              true,
              await adapter.resolveApproval(message.payload.action),
            );
            break;
          case "dispose":
            sendResponse(message.id, true);
            await closeCompanion(0);
            break;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        sendResponse(message.id, false, undefined, text);
      }
    })();
  });

  socket.once("close", () => {
    void closeCompanion(0);
  });
  socket.once("error", () => {
    void closeCompanion(1);
  });

  sendLocalCompanionMessage(socket, {
    type: "hello",
    token: endpoint.token,
    companionPid: process.pid,
  });

  await adapter.start();
  publishState();
  log(options.adapter, `Connected to bridge ${endpoint.instanceId}.`);
}

main().catch((error) => {
  log("local", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
