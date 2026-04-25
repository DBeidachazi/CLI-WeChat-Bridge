# CLI-WeChat-Bridge 后台服务系统化改造 TODO

## 背景

当前 CLI-WeChat-Bridge 的目标不是把微信变成新的主界面，而是：

- 用户离开电脑时，可以通过微信向本地 CLI / Agent 发消息；
- 可以从微信接收回复、处理审批、查看结果；
- 用户回到电脑前时，可以继续原本的本地工作流；
- Docker / Linux / WSL 下可以利用 tmux 保留可 attach 的 companion session；
- gemini / copilot 当前通过 ACP 连接，不再天然具备可交互的程序化终端界面；
- 目前 bridge 后台进程启动后会常驻，关闭 shell 不会停止，只能通过 `ps` / `kill` 手动查杀；
- tmux 目前只控制 gemini/codex 等 companion 面板，不等于控制整个 bridge 生命周期。

当前文档中已经有 Docker manager、tmux companion、adapter 切换、日志转录等设计基础。目标是把这些零散能力整理成一整套可控的后台服务系统。

## 总体目标

把当前项目从“若干 start 脚本 + 后台 bridge + tmux companion”升级成：

```text
wechat-manager
  ├─ bridge lifecycle supervisor
  ├─ adapter manager
  ├─ session backend abstraction
  ├─ transcript/log manager
  ├─ approval manager
  ├─ optional task scheduler
  ├─ HTTP/WebSocket API
  └─ optional local Web Console
```

核心原则：

- `wechat-bridge` 不应该脱离 manager 独自后台化。
- 真正常驻的进程只能有一个：`wechat-manager`。
- `tmux` 只作为 Linux/Docker/WSL 下的 companion 可视终端，不承担系统生命周期管理。
- ACP 不要强行伪装成终端；ACP 会话应该用 Chat/Event UI 续接。
- `tmux` / `node-pty` 会话才使用 Terminal UI 续接。
- Windows 原生不要强依赖 `tmux`，应使用 `node-pty` / ConPTY backend。
- Docker/Linux/WSL 继续优先使用 `tmux`。
- 支持 `stdio` / ACP 的 adapter 优先走协议通信，不必走 `pty`。

## Phase 1：统一 Manager 与进程生命周期

### 1.1 新增 `wechat-manager`

新增 manager 入口：

`src/manager/manager.ts`

职责：

- 启动 / 停止当前 active bridge；
- 维护当前 active adapter；
- 创建或复用 `tmux` companion session；
- 管理 bridge 子进程；
- 接收 `start` / `stop` / `restart` / `status` / `switch` 等控制命令；
- 监听 bridge exit；
- 处理 `SIGTERM` / `SIGINT`；
- Docker 模式下作为容器主进程 PID 1；
- 本地模式下作为 daemon 运行。

建议目录：

```text
src/
  manager/
    manager.ts
    state.ts
    ipc-server.ts
    ipc-client.ts
    process-supervisor.ts
    adapter-manager.ts
    runtime-paths.ts
```

### 1.2 bridge 不再 detached 到无人管理状态

当前问题：

```text
wechat-gemini-start
  -> spawn bridge
  -> bridge 后台 detached
  -> launcher 退出
  -> bridge 成为不可控后台进程
```

目标改成：

```text
wechat-manager
  -> spawn wechat-bridge --adapter gemini
  -> manager 持有 bridge pid
  -> manager 监听 bridge exit
  -> manager 负责 stop/restart/switch
```

要求：

- 所有 `wechat-*-start` 命令不再直接后台化 bridge；
- 必须通过 manager 控制 bridge；
- bridge 退出时 manager 应更新 state；
- manager 退出时必须清理 bridge 和子进程。

### 1.3 Runtime state 文件

新增统一状态目录：

`~/.cli-wechat-bridge/runtime/`

状态文件：

`~/.cli-wechat-bridge/runtime/state.json`

建议结构：

```json
{
  "managerPid": 123,
  "activeAdapter": "gemini",
  "bridgePid": 456,
  "bridgeStatus": "running",
  "tmuxSession": "wechat-gemini",
  "backend": "acp",
  "workdir": "/root",
  "startedAt": "2026-04-25T07:35:00.000Z",
  "updatedAt": "2026-04-25T07:36:10.000Z"
}
```

注意：

- state 文件只用于展示和恢复；
- 不应该把 state 文件作为唯一控制手段；
- 真正控制应通过 IPC 发给 manager。

### 1.4 IPC 控制接口

新增本地 socket：

`~/.cli-wechat-bridge/runtime/manager.sock`

所有 CLI 命令通过 IPC 发 JSON 给 manager。

支持操作：

```json
{ "op": "status" }
{ "op": "start", "adapter": "gemini" }
{ "op": "stop" }
{ "op": "restart" }
{ "op": "switch", "adapter": "codex" }
{ "op": "attach", "adapter": "gemini" }
{ "op": "logs", "follow": true }
```

## Phase 2：统一 CLI 命令体系

### 2.1 新增标准命令

新增这些命令：

- `wechat-bridge-start`
- `wechat-bridge-stop`
- `wechat-bridge-restart`
- `wechat-bridge-status`
- `wechat-bridge-logs`
- `wechat-bridge-attach`
- `wechat-model`

示例：

```bash
wechat-bridge-start --adapter gemini
wechat-bridge-stop
wechat-bridge-restart
wechat-bridge-status
wechat-bridge-logs -f
wechat-bridge-attach
wechat-model codex
wechat-model gemini
```

### 2.2 保留兼容命令

保留现有命令：

- `wechat-codex-start`
- `wechat-gemini-start`
- `wechat-copilot-start`
- `wechat-claude-start`
- `wechat-opencode-start`

但内部逻辑改成调用 manager client：

```text
wechat-gemini-start
  -> manager.switch("gemini")
```

不要再由这些命令直接启动 bridge 进程。

### 2.3 stop 流程

`wechat-bridge-stop` 不能直接粗暴 kill。

优雅停止流程：

1. client 向 manager 发送 stop
2. manager 向 bridge 发送 graceful shutdown
3. bridge 停止微信轮询
4. bridge 保存必要状态
5. bridge 关闭 adapter / session
6. manager 等待 bridge 自然退出
7. 超时后 `SIGTERM`
8. 再超时后 `SIGKILL`
9. 清理 `tmux` session
10. 清理 runtime state / lock

伪代码：

```ts
async function stopBridge() {
  const state = await loadState();

  if (!state.bridgePid) {
    return { ok: true, message: "bridge is not running" };
  }

  await sendShutdownToBridge().catch(() => null);

  const exited = await waitForExit(state.bridgePid, 5000);

  if (!exited) {
    process.kill(state.bridgePid, "SIGTERM");
  }

  const exitedAfterTerm = await waitForExit(state.bridgePid, 3000);

  if (!exitedAfterTerm) {
    process.kill(state.bridgePid, "SIGKILL");
  }

  if (state.tmuxSession) {
    await killTmuxSession(state.tmuxSession).catch(() => null);
  }

  await clearState();
}
```

Linux 下建议按进程组杀，避免残留子进程：

```ts
process.kill(-bridgePid, "SIGTERM");
```

### 2.4 status 输出

`wechat-bridge-status` 输出示例：

```text
CLI WeChat Bridge

Manager: running
Manager PID: 123

Bridge: running
Bridge PID: 456

Active adapter: gemini
Backend: acp
Tmux session: none
Workdir: /root

Wechat account: /root/.claude/channels/wechat/account.json
Transcript log: enabled

Commands:
  wechat-bridge-stop
  wechat-bridge-logs -f
  wechat-model codex
```

对于 tmux backend：

```text
Active adapter: codex
Backend: tmux
Tmux session: wechat-codex
Attach:
  wechat-bridge-attach
  tmux attach -t wechat-codex
```

## Phase 3：Session Backend 抽象

### 3.1 新增统一接口

新增：

`src/session/session-backend.ts`

接口示例：

```ts
export interface SessionBackend {
  name: string;

  start(options: StartSessionOptions): Promise<SessionHandle>;

  stop(sessionId: string): Promise<void>;

  write(sessionId: string, input: string): Promise<void>;

  isAlive(sessionId: string): Promise<boolean>;

  getOutputStream(sessionId: string): AsyncIterable<SessionEvent>;
}
```

Session event：

```ts
export type SessionEvent =
  | { type: "terminal_data"; data: string }
  | { type: "message"; role: "user" | "assistant" | "system"; content: string }
  | {
      type: "tool_call";
      name: string;
      status: "running" | "success" | "failed";
      detail?: unknown;
    }
  | { type: "approval_required"; id: string; command?: string; detail?: unknown }
  | { type: "error"; message: string; detail?: unknown };
```

### 3.2 Backend 类型

实现这些 backend：

```text
src/session/backends/
  tmux-backend.ts
  node-pty-backend.ts
  stdio-backend.ts
  acp-backend.ts
```

用途：

- `tmux-backend`
  Docker / Linux / WSL 下的可 attach companion session
- `node-pty-backend`
  Windows 原生 / macOS / Linux fallback
  适合 TTY 型 CLI
- `stdio-backend`
  适合支持 `--stdio` 的 CLI
- `acp-backend`
  适合 `gemini --acp` / `copilot --acp`
  输出结构化 chat/event，不假装成终端

### 3.3 自动选择 backend

配置：

```dotenv
WECHAT_BRIDGE_SESSION_BACKEND=auto
# auto | tmux | node-pty | stdio | acp

WECHAT_BRIDGE_ENABLE_TMUX=true
WECHAT_BRIDGE_ENABLE_NODE_PTY=true
WECHAT_BRIDGE_ENABLE_STDIO=true
WECHAT_BRIDGE_ENABLE_ACP=true
```

自动选择逻辑建议：

```ts
if (adapter.protocol === "acp") {
  backend = "acp";
} else if (adapter.supportsStdio) {
  backend = "stdio";
} else if (process.platform === "win32") {
  backend = "node-pty";
} else {
  backend = "tmux";
}
```

### 3.4 Adapter capability 声明

每个 adapter 显式声明能力：

```ts
export const adapters = {
  gemini: {
    name: "gemini",
    protocol: "acp",
    command: "gemini",
    args: ["--acp"],
    viewType: "chat",
    preferredBackend: "acp",
    fallbackBackend: "stdio",
  },

  copilot: {
    name: "copilot",
    protocol: "acp",
    command: "copilot",
    args: ["--acp", "--stdio"],
    viewType: "chat",
    preferredBackend: "acp",
    fallbackBackend: "stdio",
  },

  codex: {
    name: "codex",
    protocol: "tty",
    command: "codex",
    args: [],
    viewType: "terminal",
    preferredBackend: "tmux",
    fallbackBackend: "node-pty",
  },

  shell: {
    name: "shell",
    protocol: "tty",
    command: "bash",
    args: [],
    viewType: "terminal",
    preferredBackend: "node-pty",
    fallbackBackend: "tmux",
  },
};
```

## Phase 4：ACP 与终端会话分离展示

### 4.1 不要把 ACP 伪装成终端

错误方向：

```text
ACP -> node-pty -> xterm.js
```

正确方向：

```text
ACP -> structured events -> Chat/Event UI
```

ACP session 应该保存：

- 用户消息
- assistant 回复
- tool call
- approval request
- error event
- attachment event
- adapter status

### 4.2 Session view type

新增：

```ts
type SessionViewType = "chat" | "terminal";
```

ACP：

```json
{
  "id": "gemini-main",
  "adapter": "gemini",
  "backend": "acp",
  "viewType": "chat"
}
```

TTY：

```json
{
  "id": "codex-main",
  "adapter": "codex",
  "backend": "tmux",
  "viewType": "terminal"
}
```

### 4.3 Transcript store

新增 transcript store：

`~/.cli-wechat-bridge/transcripts/`

建议结构：

```text
transcripts/
  sessions/
    <session-id>.jsonl
  latest.json
```

每条记录：

```json
{
  "time": "2026-04-25T08:00:00.000Z",
  "sessionId": "gemini-main",
  "adapter": "gemini",
  "backend": "acp",
  "source": "wechat",
  "role": "user",
  "type": "message",
  "content": "帮我看一下这个错误"
}
```

assistant：

```json
{
  "time": "2026-04-25T08:00:10.000Z",
  "sessionId": "gemini-main",
  "adapter": "gemini",
  "backend": "acp",
  "source": "adapter",
  "role": "assistant",
  "type": "message",
  "content": "我已经定位到问题..."
}
```

tool call：

```json
{
  "time": "2026-04-25T08:00:12.000Z",
  "sessionId": "gemini-main",
  "adapter": "gemini",
  "backend": "acp",
  "type": "tool_call",
  "name": "read_file",
  "status": "running"
}
```

## Phase 5：本地 Web Console

### 5.1 是否需要前端

需要，但不要一开始做重型桌面端。

优先做本地 Web Console：

`http://127.0.0.1:17860`

Docker 可映射端口：

```yaml
ports:
  - "127.0.0.1:17860:17860"
```

用途：

- 回到电脑前接管现场；
- 查看微信转录；
- 查看 ACP 会话；
- 查看审批；
- 停止 / 重启 bridge；
- 切换 adapter；
- 对终端型会话 attach；
- 对 ACP 会话继续聊天。

### 5.2 Web Console 页面

第一版页面：

- `/status`
- `/sessions`
- `/logs`

第二版页面：

- `/session/:id`
- `/approvals`
- `/settings`
- `/tasks`

### 5.3 API 设计

新增 HTTP API：

```text
GET  /api/status
GET  /api/sessions
GET  /api/sessions/:id/messages
POST /api/sessions/:id/input
POST /api/sessions/:id/stop
POST /api/sessions/:id/restart
POST /api/adapter/switch
GET  /api/approvals
POST /api/approvals/:id/approve
POST /api/approvals/:id/deny
GET  /api/logs
```

WebSocket：

```text
WS /ws/sessions/:id
WS /ws/logs
```

### 5.4 ACP Chat UI

ACP session 显示为 Chat/Event UI。

需要显示：

- 用户消息
- assistant 回复
- 系统消息
- tool call
- approval request
- error
- 附件
- adapter 状态

输入框：

- 继续刚才的任务
- 重新执行
- 解释失败原因
- 保存结果

输入发送到：

```text
Web UI
  -> manager
  -> acp backend
  -> gemini/copilot
```

### 5.5 Terminal UI

只对 `viewType = terminal` 的 session 显示 Terminal UI。

实现：

```text
xterm.js
  <-> WebSocket
  <-> manager
  <-> tmux attach / node-pty
```

Linux / Docker / WSL：

```text
Web xterm.js
  <-> node-pty spawn("tmux", ["attach", "-t", "wechat-codex"])
  <-> tmux session
```

Windows 原生：

```text
Web xterm.js
  <-> node-pty
  <-> powershell / codex / shell
```

ACP 不走这个路径。

## Phase 6：日志系统统一

### 6.1 日志目录

新增：

`~/.cli-wechat-bridge/logs/`

结构：

```text
logs/
  manager.log
  bridge.log
  transcript.log
  adapters/
    gemini.log
    codex.log
    copilot.log
    claude.log
    opencode.log
```

### 6.2 `wechat-bridge-logs`

命令：

- `wechat-bridge-logs`
- `wechat-bridge-logs -f`
- `wechat-bridge-logs --manager`
- `wechat-bridge-logs --bridge`
- `wechat-bridge-logs --transcript`
- `wechat-bridge-logs --adapter gemini`

### 6.3 Docker logs 兼容

保留当前 Docker logs 行为：

- 启动和重启信息；
- 微信二维码；
- 微信与 CLI 的文本往返转录；
- 文件/图片/视频/语音附件发送路径；
- adapter 后台日志。

本地文件日志与 Docker stdout 双写。

## Phase 7：定时任务系统

### 7.1 不要一开始引入复杂队列

第一版使用：

`Bun cron / node-cron + SQLite 或 JSON`

不要第一版就引入：

- `BullMQ + Redis`
- `Agenda + MongoDB`
- `pg-boss + PostgreSQL`
- `n8n`

这些可以作为后续可选集成。

### 7.2 任务命令

微信和本地 CLI 支持：

- `/task add`
- `/task list`
- `/task remove`
- `/task run`
- `/task enable`
- `/task disable`

示例：

```text
/task add "每天早上9点总结昨晚 issue" --cron "0 9 * * *" --adapter codex
/task list
/task run <id>
/task remove <id>
```

### 7.3 任务数据结构

```ts
type ScheduledTask = {
  id: string;
  name: string;
  cron: string;
  adapter: "codex" | "gemini" | "copilot" | "claude" | "opencode" | "shell";
  prompt: string;
  enabled: boolean;
  timezone?: string;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
};
```

存储位置：

- `~/.cli-wechat-bridge/tasks.sqlite`

或 MVP：

- `~/.cli-wechat-bridge/tasks.json`

### 7.4 任务配置

```dotenv
WECHAT_BRIDGE_SCHEDULER_ENABLED=true
WECHAT_BRIDGE_SCHEDULER_STORE=/root/.cli-wechat-bridge/tasks.sqlite
WECHAT_BRIDGE_SCHEDULER_TIMEZONE=Asia/Shanghai
WECHAT_BRIDGE_SCHEDULER_MAX_CONCURRENCY=1
WECHAT_BRIDGE_SCHEDULER_MISFIRE_POLICY=skip
```

第一版建议：

`MAX_CONCURRENCY=1`

原因：

- 当前项目本质是本地 CLI 会话桥接；
- 并发 prompt 可能污染上下文；
- 定时任务不应同时往同一个 CLI session 塞多条消息。

## Phase 8：Windows 原生支持

### 8.1 不要要求 Windows 原生依赖 `tmux`

`tmux` 在这些场景可以继续用：

- Docker Linux container
- WSL
- Linux host
- macOS

但 Windows 原生应使用：

- `node-pty` / ConPTY

### 8.2 Bun 与 `node-pty` 兼容风险

`node-pty` 是 native addon。

项目主体可以继续 Bun，但建议 `node-pty` backend 先以 Node.js 子进程形式运行：

```text
bun manager
  -> spawn node pty-host.js
      -> node-pty
      -> child CLI
```

这样避免 Bun 对 native addon 的兼容风险影响主进程。

### 8.3 Windows backend 设计

Windows 原生：

```text
manager
  -> node-pty backend
  -> powershell / codex / shell
```

ACP adapter：

```text
manager
  -> acp backend
  -> gemini/copilot
```

不要把 ACP 塞进 `node-pty`。

## Phase 9：Approval 管理

### 9.1 Approval store

新增：

- `~/.cli-wechat-bridge/approvals/`

或使用 SQLite。

审批记录：

```ts
type ApprovalRequest = {
  id: string;
  sessionId: string;
  adapter: string;
  command?: string;
  description?: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  resolvedAt?: string;
};
```

### 9.2 微信审批

微信侧支持：

- `/approve <id>`
- `/deny <id>`

或按钮式消息，如果当前微信通道支持。

### 9.3 Web 审批

Web Console 显示：

```text
Gemini wants to run:
  git diff

Allow / Deny / Always allow in this session
```

## Phase 10：Docker 模式整合

### 10.1 容器主进程

Docker 模式：

`container PID 1 = wechat-manager`

manager 负责：

- 自动安装缺失 CLI；
- 自动检查项目可执行文件 `+x`；
- 缺少微信凭据时自动 setup；
- 输出二维码到 `docker logs`；
- 启动默认 adapter；
- 管理 bridge；
- 管理 `tmux` companion；
- 输出 transcript；
- 响应 `docker stop`。

### 10.2 `docker stop` 行为

当容器收到 `SIGTERM`：

1. manager 接收 `SIGTERM`
2. manager 停止 scheduler
3. manager graceful shutdown bridge
4. manager 停止 adapter session
5. manager kill `tmux` session
6. manager flush logs
7. manager exit 0

### 10.3 工作目录原则

保持：

- `/app = 程序源码目录`
- `/root = AI 日常工作目录、登录态、skills、任务、日志、状态`

不要让内层 CLI 默认扫描 `/app` 源码，除非正在调试 bridge 自身。

## Phase 11：本地模式整合

### 11.1 本地安装

支持：

```bash
bun install
npm install -g .
wechat-manager start
wechat-bridge-start --adapter gemini
```

或：

```bash
wechat-gemini-start
```

### 11.2 本地 daemon

本地模式 manager 可用：

- `wechat-manager start`
- `wechat-manager stop`
- `wechat-manager status`

后续可选：

- `wechat-manager install-service`
- `wechat-manager uninstall-service`

Linux 可集成 `systemd`。

Windows 后续可集成 Windows Service，但不要第一版就做。

## Phase 12：测试

### 12.1 Manager 测试

新增测试：

- `bun test test/manager/manager-lifecycle.test.ts`
- `bun test test/manager/manager-ipc.test.ts`
- `bun test test/manager/bridge-supervisor.test.ts`

覆盖：

- manager start；
- manager stop；
- bridge spawn；
- bridge graceful shutdown；
- bridge crash 后 state 更新；
- switch adapter；
- repeated start 不重复创建 bridge；
- stale state 清理；
- stale pid 检测。

### 12.2 Session backend 测试

- `bun test test/session/tmux-backend.test.ts`
- `bun test test/session/acp-backend.test.ts`
- `bun test test/session/stdio-backend.test.ts`

`node-pty` backend 可以在 Node 环境单独测：

- `node test/session/node-pty-backend.test.js`

### 12.3 CLI 命令测试

- `bun test test/cli/wechat-bridge-start.test.ts`
- `bun test test/cli/wechat-bridge-stop.test.ts`
- `bun test test/cli/wechat-bridge-status.test.ts`
- `bun test test/cli/wechat-model.test.ts`

### 12.4 Docker 测试

```bash
docker compose config
docker compose up --build -d
docker compose logs -f cli-wechat-bridge
docker compose exec cli-wechat-bridge wechat-bridge-status
docker compose exec cli-wechat-bridge wechat-model gemini
docker compose exec cli-wechat-bridge wechat-bridge-stop
docker compose down
```

## 推荐实施顺序

第一批必须完成：

1. `wechat-manager`
2. runtime state
3. IPC server/client
4. start/stop/status/restart CLI
5. 兼容 `wechat-*-start`
6. bridge 不再无人托管后台化
7. Docker PID 1 改为 manager

第二批完成：

1. `SessionBackend` 抽象
2. `tmux` backend
3. `acp` backend
4. adapter capability 声明
5. transcript store
6. `logs` 命令

第三批完成：

1. Web Console status 页面
2. Web Console sessions 页面
3. ACP Chat/Event UI
4. WebSocket 推送 session events
5. approval 面板

第四批完成：

1. `xterm.js` Terminal UI
2. `node-pty` backend
3. Windows 原生支持
4. scheduler
5. 多会话/历史会话

## 最终验收标准

### 进程管理

- 执行 `wechat-gemini-start` 后，bridge 必须由 manager 管理；
- 关闭当前 shell 后 bridge 可继续运行；
- 执行 `wechat-bridge-stop` 后，不残留 bridge / adapter / `tmux` 子进程；
- `wechat-bridge-status` 能准确显示 manager、bridge、adapter、backend、`tmux` session；
- `wechat-model codex/gemini/copilot` 能正确切换 adapter；
- 切换 adapter 不会杀掉整个容器。

### tmux

- Docker/Linux/WSL 下 codex/shell 这类 TTY adapter 可以继续使用 `tmux`；
- `tmux ls` 能看到对应 session；
- `wechat-bridge-attach` 可以 attach 到当前 terminal session；
- 只关闭 `tmux` 不应误判为 bridge 停止；
- 停 bridge 时可以按配置清理 `tmux` session。

### ACP

- gemini/copilot 走 ACP 时，不强行创建 terminal UI；
- ACP 消息、回复、tool call、approval 都进入 transcript；
- 用户可以从 Web Console 继续向 ACP session 发送消息；
- 微信侧和 Web Console 看到的 session 状态一致。

### Web Console

- `/status` 能显示 manager / bridge / adapter 状态；
- `/sessions` 能显示当前会话；
- ACP session 显示为 Chat/Event UI；
- terminal session 显示为 `xterm.js` Terminal UI；
- 可以在 Web Console 停止 / 重启 / 切换 adapter；
- 可以查看 logs / transcript。

### Docker

- `docker compose up -d` 后 manager 成为主进程；
- `docker compose logs -f` 能看到二维码、启动日志、转录；
- `docker stop` 可以优雅停止所有子进程；
- `/root` 挂载目录保存登录态、任务、日志、状态；
- `/app` 不作为默认 AI 工作目录。

### Windows

- Windows 原生不要求安装 `tmux`；
- TTY 型 CLI 使用 `node-pty` backend；
- ACP 型 CLI 使用 `acp` backend；
- Bun 主进程可以继续存在；
- `node-pty` 可以先用 Node 子进程隔离运行。

## 非目标

第一版不要做这些：

- 不要一开始引入 Redis/BullMQ
- 不要一开始引入 MongoDB/Agenda
- 不要一开始引入 PostgreSQL/pg-boss
- 不要一开始做完整桌面端
- 不要把 ACP 强行包装成 terminal
- 不要让每个 start/stop 脚本自己 `ps` / `kill`
- 不要让 bridge 自己 detached 成无人管理 daemon
- 不要让 `tmux` 成为系统生命周期管理器

## 核心结论

当前项目需要从“脚本驱动”改成“manager 驱动”。

最终架构应该是：

- 微信 = 临时移动入口
- manager = 本地后台运行时
- ACP backend = 协议型 agent 会话
- `tmux` / `node-pty` backend = 终端型 agent 会话
- Web Console = 回到电脑前恢复现场

也就是：

```text
Mobile handoff
+
Local agent supervisor
+
Desktop recovery UI
```

第一优先级不是做前端，也不是换 `node-pty`，而是：

先做 `wechat-manager`，统一管住 bridge、adapter、tmux、日志、状态和停止流程。
