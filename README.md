# CLI WeChat Bridge

把微信消息桥接到本地 CLI，会话权威仍然留在你自己的终端里。

当前仓库支持这些适配器：

- `codex`
- `gemini`
- `copilot`
- `claude`
- `opencode`
- `shell`

项目的核心目标不是把微信变成新的主界面，而是让你离开电脑时，仍然能通过微信向本地 CLI 发消息、接收回复、处理审批，并在需要时回到本地继续原生终端工作流。

## 当前推荐用法

推荐直接用 Docker Compose 跑这个项目。

现在容器启动链路已经做了这些事情：

- 自动安装缺失的 `codex`、`gemini`、`copilot`、`claude`、`opencode`
- 自动检查并修复本项目可执行文件的 `+x`
- 缺少微信凭据时自动执行 `bun run setup`
- 把微信登录二维码直接打印到 `docker logs`
- 把微信和 CLI 的往返文本转录打印到 `docker logs`
- `wechat-gemini-start` / `wechat-copilot-start` 这类替换 bridge 的后台日志同样会进入 `docker logs`
- 容器内部安装 `tmux`
- 默认适配器是 `codex` 时，容器启动后会自动创建 `wechat-codex` 的 `tmux` companion session
- 允许你在容器里直接执行 `wechat-codex-start`、`wechat-gemini-start` 之类的命令切换当前活动适配器

## 重要行为

这几个行为是当前实现里最需要先知道的：

1. 一个容器内同一时刻只有一个活动 bridge。
2. `wechat-codex-start`、`wechat-gemini-start`、`wechat-copilot-start` 这类命令会复用当前工作区 bridge，或者替换掉旧 bridge。
3. 如果你正在用 `codex`，再运行 `wechat-gemini-start`，当前 bridge 会被切换到 `gemini`。
4. 如果你已经通过微信 `/model gemini` 切走，再用 `/model codex` 切回，bridge 会自动创建或复用 `wechat-codex` 的 `tmux` companion session；不用再手动进容器跑一次 `wechat-codex-start`。
5. Docker 模式下容器主进程是 manager，不再是单个 bridge 本体，所以切换适配器不会再把整个容器一起杀掉。
6. `tmux` session 只有在第一次运行 `wechat-*-start` 或微信 `/model codex` 自动拉起 Codex companion 时才会创建；刚进容器时 `tmux ls` 为空是正常的。
7. `tmux` 模式下，`wechat-*-start` 后台 bridge 现在按 `persistent` 启动，不会因为 launcher 进程退出就被误回收。

## Docker Compose 快速开始

### 1. 启动容器

```bash
git clone https://github.com/DBeidachazi/CLI-WeChat-Bridge
cd CLI-WeChat-Bridge
docker compose up --build -d
```

### 2. 扫微信二维码

```bash
docker compose logs -f cli-wechat-bridge
```

如果容器里还没有微信凭据，启动时会自动执行 `bun run setup`，二维码会直接出现在日志里。扫码并在手机里确认即可。

默认凭据路径：

```text
/root/.claude/channels/wechat/account.json
```

宿主机对应挂载目录：

```text
./home/.claude/channels/wechat/account.json
```

### 3. 进入容器，手动登录各家 CLI

```bash
docker compose exec cli-wechat-bridge bash
```

然后按你的需要手动登录：

```bash
codex
gemini
copilot
claude
opencode
```

项目不会替你自动登录这些 provider 账号；推荐你第一次进容器后把需要的 CLI 都手动登录一遍。

### 4. 启动你想要的适配器

常用的是这些：

```bash
wechat-codex-start
wechat-gemini-start
wechat-copilot-start
wechat-claude-start
wechat-opencode-start
```

如果你已经在当前容器里使用 `codex`，此时再执行：

```bash
wechat-gemini-start
```

当前 bridge 会切换成 `gemini`。同理，`wechat-copilot-start`、`wechat-claude-start`、`wechat-opencode-start` 也是一样的替换逻辑。

## 你会在日志里看到什么

容器日志现在会包含三类关键信息：

- 启动和重启信息
- 微信二维码登录输出
- 微信和 CLI 的文本往返转录

查看日志：

```bash
docker compose logs -f cli-wechat-bridge
```

当前默认会把转录打印出来，格式大致类似：

```text
[wechat-bridge] [transcript] wechat->cli sender=xxx
  现在帮我看一下这个错误

[wechat-bridge] [transcript] cli->wechat context=message recipient=xxx
  我已经定位到问题了，正在修复。
```

如果最终回复里触发了文件、图片、视频、语音发送，日志里也会记录发送的附件路径。

## 本地仓库模式

如果你不想走 Docker，也可以直接在本地仓库里运行。

### 1. 安装依赖

```bash
bun install
npm install -g .
```

开发态也可以：

```bash
npm link
```

### 2. 登录微信

```bash
bun run setup
```

### 3. 启动单命令入口

```bash
wechat-codex-start
wechat-gemini-start
wechat-copilot-start
wechat-claude-start
wechat-opencode-start
```

如果你更喜欢仓库内 script，对应的是：

```bash
bun run codex:start
bun run gemini:start
bun run copilot:start
bun run claude:start
bun run opencode:start
```

## 手动桥接入口

如果你想把 bridge 和 companion 分开跑，也保留了这些入口：

```bash
wechat-bridge-codex
wechat-bridge-gemini
wechat-bridge-copilot
wechat-bridge-claude
wechat-bridge-opencode
wechat-bridge-shell
```

仓库内 script 版本：

```bash
bun run bridge:codex
bun run bridge:gemini
bun run bridge:copilot
bun run bridge:claude
bun run bridge:opencode
bun run bridge:shell
```

## Docker 相关说明

Compose 配置当前包含这些默认行为：

- 基础镜像：`imbios/bun-node:latest-24-debian`
- 自动安装 `tmux`
- `restart: unless-stopped`
- 网络：`openclaw-net`，外部网络
- 用户：`0:0`
- 挂载：`./home:/root`
- `/app` 使用镜像内置源码，不再挂载宿主机仓库，避免 AI 把项目源码目录当作日常上下文扫描

## GitHub Actions 与 DockerHub

仓库现在带了一个 DockerHub 发布工作流：

```text
.github/workflows/dockerhub.yml
```

触发方式：

- push 到 `main`
- push `v*` tag
- 手动执行 `workflow_dispatch`

发布前需要在 GitHub 仓库里配置这些 secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

可选变量：

- `DOCKERHUB_IMAGE_NAME`

如果不配 `DOCKERHUB_IMAGE_NAME`，默认镜像名是：

```text
cli-wechat-bridge
```

最终推送的镜像地址形如：

```text
docker.io/<DOCKERHUB_USERNAME>/cli-wechat-bridge
```

工作流会自动构建并推送：

- `latest`（默认分支）
- 分支名 tag
- Git tag
- 短 SHA tag

## skills 与文档同步

第一次运行 `wechat-*-start` 创建 `tmux` session 时，会自动把：

- `.claude/skills`
- `.codex/skills`
- `.gemini/skills`
- `.copilot/skills`

链接到统一的：

```text
.linkai/skills
```

并兼容旧路径：

```text
.aiskill/skills -> .linkai/skills
```

这样不同 CLI 的 skills 可以共用，而且共享目录里会自动生成一个 WeChat 多模态能力 skill，帮助 Codex/Gemini/Copilot 在首轮就知道自己能处理微信语音转写、图片/媒体输入，以及 `wechat-attachments` 输出协议。

共享 skills 必须使用文件夹结构，例如 `.linkai/skills/video-download/SKILL.md`。视频下载 skill 默认把文件保存到 `~/meidia`，并通过本项目的 `wechat-attachments` 代码块发送，不使用 OpenClaw 的 `MEDIA:` 协议。它会优先直接运行容器里的 `yt-dlp` / `ffmpeg`，缺失时再按容器架构从 `yt-dlp/yt-dlp` 和 `BtbN/FFmpeg-Builds` 的 latest release 下载二进制文件到 `~/.local/bin`。

为了避免 Gemini / Claude / Copilot 在项目目录里重复读到多份同名指令文件，`.linkai` 里的共享文档源文件只保留一份：

- `.linkai/AGENT.shared.md`

启动时会根据 `.linkai/config/markdown.xml` 检查文档版本。`AGENT.shared.md` 没有版本标记时按 `1.0.0` 处理；如果配置版本更高，会按版本顺序追加 `.linkai/config/AGENT.share-<version>.md` 或 `.linkai/config/AGENT.shared-<version>.md` 里的补丁内容，再更新 `<!-- linkai:version=... -->` 标记。这个状态跟文档本身走，不需要 SQLite。

同步到各 provider 家目录时，才会映射成它们真正识别的目标文件名，例如 `/root/.gemini/GEMINI.md`。Docker 镜像不会再把 `AGENT.md`、`AGENTS.md`、`GEMINI.md`、`TODO.md`、`PROGRESS.md` 复制到 `/app`，默认桥接工作目录也固定为 `/root`，所以模型通常只会读到一份全局上下文，例如：

- 全局级 `/root/.gemini/GEMINI.md`

而不会再把 `/app/GEMINI.md` 或 `/app/.linkai/GEMINI.md` 这种项目侧重复上下文一起吃进去。

共享根目录里的 `AGENT.shared.md` 会按目标 CLI 映射为单个文档：

- `/root/.claude/CLAUDE.md`
- `/root/.codex/AGENT.md`
- `/root/.gemini/GEMINI.md`
- `/root/.copilot/AGENT.md`

Docker 容器启动后，同一套链接会同步到：

- `/root/.claude`
- `/root/.codex`
- `/root/.gemini`
- `/root/.copilot`

同步只管理共享文档和 `.linkai/skills` 投影出来的 shared skills，不会覆盖这些目录里已有的登录态、历史记录或其他 provider 私有文件。对于 shared skills，`.linkai/skills` 是权威来源；如果 `/root/.gemini/skills/video-download` 这类目标已经是旧的实体目录，启动同步会用 `.linkai/skills/video-download` 刷新它，避免 Docker 镜像更新后 provider 目录还停在旧脚本。

如果你在服务器上使用已经发布到 Docker Hub 的镜像，执行：

```bash
docker compose pull
docker compose up -d
```

容器重建后会带上镜像里的最新 `.linkai/skills`。启动脚本会再次同步 shared skills 到 `/root/.claude`、`/root/.codex`、`/root/.gemini`、`/root/.copilot`；如果宿主文件系统不支持 symlink，multi-link 同步服务也会继续把新的 skill 文件复制/同步过去。

如果容器的 `/root` 挂载在不支持符号链接的文件系统上，例如 `exfat`，目标目录保持为真实文件/文件夹是正常 fallback。启动时会自动拉起 `scripts/multi-link-service.cjs`，这个基于 `chokidar` 的常驻同步服务会持续把 `.linkai` 与 `/root/.claude`、`/root/.codex`、`/root/.gemini`、`/root/.copilot` 之间的共享文档和 `skills` 做多向同步，用文件同步来模拟 link 效果，而不是一次性复制后就失联。

`/app` 在容器里只是 CLI-WeChat-Bridge 程序源码目录，不是给 AI 日常工作的上下文目录。除非你正在调试 bridge 程序本身，否则不要让内层 CLI 扫描 `/app` 下的源码；日常对话、记忆、skills、登录态和临时工作文件都应放在家目录 `/root`。

## 配置

项目会自动读取仓库根目录下的 `.env`。

目前比较重要的几个配置项：

```dotenv
WECHAT_BRIDGE_DEFAULT_CLI_PROGRAM=codex
WECHAT_BRIDGE_DEFAULT_MODEL=gpt-5.4-mini
WECHAT_BRIDGE_WORKDIR=/root
WECHAT_BRIDGE_SHARED_ROOT=/app/.linkai
WECHAT_BRIDGE_UPDATE_CHECK_HOUR=5

WECHAT_BRIDGE_CODEX_APPROVAL_POLICY=never
WECHAT_BRIDGE_CODEX_SANDBOX=danger-full-access
WECHAT_BRIDGE_SPAWN_CODEX=codex --model gpt-5.4-mini --dangerously-bypass-approvals-and-sandbox

WECHAT_BRIDGE_SPAWN_GEMINI=gemini --acp
WECHAT_BRIDGE_SPAWN_COPILOT=copilot --acp --stdio
WECHAT_BRIDGE_ACP_AUTO_APPROVE=true

WECHAT_BRIDGE_AUTO_INSTALL_CLIS=true
WECHAT_BRIDGE_CLI_INSTALL_POLICY=missing
#WECHAT_BRIDGE_FORCE_UPDATE_CLIS=true
WECHAT_BRIDGE_AUTO_WECHAT_SETUP=true
WECHAT_BRIDGE_LOG_TRANSCRIPT=true
WECHAT_BRIDGE_BACKGROUND_LOG_TO_CONTAINER=true
```

`WECHAT_BRIDGE_CLI_INSTALL_POLICY=missing` 表示容器启动时只安装缺失的 CLI，已存在的 `codex/gemini/copilot/claude/opencode` 会跳过，避免每次重启都重新 `npm install -g`。需要强制刷新 CLI 时，把策略改成 `always`，或者临时打开 `WECHAT_BRIDGE_FORCE_UPDATE_CLIS=true`。

## 常见问题

### `bun run wechat-codex-start` 为什么报 script not found

因为 `wechat-codex-start` 是全局命令，不是 `package.json` 里的 script。

你应该运行：

```bash
wechat-codex-start
```

如果你想用 `bun run`，对应写法是：

```bash
bun run codex:start
```

### 为什么刚进容器时 `tmux ls` 是空的

因为 `tmux` session 不是容器启动时就创建的，而是在你第一次执行 `wechat-codex-start`、`wechat-gemini-start` 这类命令时才创建。

### 我能不能从 `codex` 直接切到 `gemini`

可以。直接运行：

```bash
wechat-gemini-start
```

它会停止当前活动 bridge，并切换到 `gemini`。当前实现是单活动 bridge 设计，不会在同一个容器里并行保留多个活动适配器。

### 为什么容器里还要手动执行 `codex` / `gemini` / `copilot`

因为这些 provider CLI 的账号登录态属于各自工具本身，项目不会替你自动代登。推荐第一次进入容器后把你要用的 CLI 都手动登录完成。

## 测试

常用测试命令：

```bash
bun test test/companion/local-companion-start.test.ts
bun test test/bridge/wechat-bridge.test.ts
git diff --check
docker compose config
```

## 致谢

项目在微信协议和 channel 方向上参考了 `openclaw-weixin` 的一些思路，也在此基础上继续朝“保留本地原生 CLI 工作流”的方向做了分化实现。

原项目地址：[UNLINEARITY/CLI-WeChat-Bridge](https://github.com/UNLINEARITY/CLI-WeChat-Bridge)
