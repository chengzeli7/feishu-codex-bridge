# Feishu Codex Bridge

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](CHANGELOG.md)

A single-user, self-hosted Feishu/Lark remote control console for Codex Desktop. Create and continue Codex tasks, inspect live progress, and receive completion notifications from Feishu while all execution stays on your own Mac.

> `v0.1.0` is the first public beta. This project integrates with the local app-server capabilities currently shipped with Codex Desktop, so a future Codex update may require compatibility changes.

## Features

- Create Codex tasks by sending normal messages—commands are optional.
- Reply to a task card or use follow-up language to continue the correct task.
- Inspect the current stage, plan, tools/MCP calls, commands, changed files, errors, and elapsed time.
- Update an opened detail card in place with a roughly two-second debounce.
- Share tasks, user messages, replies, and completion state with Codex Desktop.
- Send images, files, and short voice messages.
- Queue messages safely, recover from disconnects, and send completion notifications.
- Create one-time, daily, and weekly schedules that run locally.
- Restrict access with user, private-chat, and workspace allowlists.

This is not remote desktop software. It does not provide screen viewing, mouse or keyboard control, or a way to bypass Codex and macOS permissions.

## Architecture

```text
Feishu private chat
        │ message / Card 2.0 callback
        ▼
Feishu Codex Bridge ── local state / queue / scheduler
        │ Unix WebSocket
        ▼
Codex Desktop app-server daemon
        │
        ▼
Allowlisted local workspaces
```

Feishu transports instructions and renders status. Codex tasks, project files, credentials, and runtime state remain on the user's Mac.

## Supported Environment

- macOS
- One allowlisted Feishu user
- Private bot chat
- The Codex runtime bundled with ChatGPT Desktop
- Node.js 20 or later
- Feishu `lark-cli`

Linux, Windows, group chats, multiple users, and cloud routing are not supported yet.

## Quick Start

### Recommended: Homebrew guided setup

```bash
brew install chengzeli7/tap/feishu-codex-bridge && feishu-codex-bridge init
```

The package includes the official `lark-cli`. The guided installer will:

1. verify macOS, ChatGPT Desktop, Node.js, and `lark-cli`;
2. open the official Feishu one-click app creation URL and wait for completion;
3. listen for one private-chat pairing message to identify the only allowed user;
4. collect allowlisted workspace paths;
5. run health checks, install the LaunchAgent, and confirm the service is running.

Application creation and browser authorization are handled by the official `lark-cli config init --new` flow. The pairing message cannot be skipped because it proves which Feishu user may remotely control the Mac.

### Install from source

#### 1. Install prerequisites

You need:

- ChatGPT Desktop installed at `/Applications/ChatGPT.app` and signed in
- Node.js 20+
- `lark-cli`
- Optional: `ffmpeg` for voice transcription

```bash
git clone https://github.com/chengzeli7/feishu-codex-bridge.git
cd feishu-codex-bridge
npm ci
```

#### 2. Create a Feishu app

Create a custom app in the [Feishu Open Platform](https://open.feishu.cn/app), enable the bot capability, and configure:

Events and callbacks:

- `im.message.receive_v1`
- `card.action.trigger`

Permissions:

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:message:readonly`
- Optional: `speech_to_text:speech`

Create and publish an app version, then add the bot to your Feishu account. Publish another app version whenever permissions or events change.

#### 3. Configure bot credentials locally

```bash
lark-cli config init --new
lark-cli auth status --json --verify
```

Keep the `App ID` and `App Secret` only in the local `lark-cli` profile. Never commit them or send them through Feishu.

#### 4. Pair the user and workspaces

```bash
npm run setup
```

The setup tool starts a one-shot event listener. When prompted, send this exact message to the bot:

```text
配对 Codex 助手
```

Then enter the absolute paths of the projects the bridge may use. The generated `config.local.json` is created with mode `0600` and is ignored by Git.

#### 5. Verify and install the service

```bash
npm run doctor
npm test
npm run validate:cards
npm run service -- install
npm run service -- status
```

Send these messages to the bot:

```text
版本
健康
任务
检查当前项目状态，只读取，不修改
```

## Usage

Natural language is the default interface:

```text
检查这个项目最近失败的测试
再补充分析失败原因
明天 10:30 汇总当前项目进度
```

Exact commands are available for deterministic control:

| Command | Action |
|---|---|
| `任务` / `首页` | Open the task dashboard |
| `新建` | Open the create-task form |
| `进度1` | Show task 1 summary |
| `详情1` / `详细进展1` | Show structured execution details |
| `继续1 <message>` | Continue task 1 |
| `关注1` / `取消关注1` | Manage completion notifications |
| `停止1` | Stop the current turn after confirmation |
| `归档1` | Archive a completed task |
| `队列` | Show queued messages |
| `定时任务` | Show local schedules |
| `健康` / `版本` / `帮助` | Show service status and help |

Numbers refer to the latest task list or search result.

## Configuration

Use [config.example.json](config.example.json) as a reference. The most important security fields are:

```json
{
  "allowedUserIds": ["ou_replace_with_your_open_id"],
  "allowedChatIds": ["oc_replace_with_your_chat_id"],
  "requireP2P": true,
  "workspaces": {
    "my-project": "/absolute/path/to/my-project"
  },
  "workspaceAliases": {
    "my-project": ["main project", "project nickname"]
  },
  "defaultWorkspace": "my-project"
}
```

- `allowedUserIds` currently requires exactly one user.
- `allowedChatIds` should contain the private chat discovered during pairing.
- New tasks can only start in the absolute paths listed under `workspaces`.
- `workspaceAliases` affects natural-language routing only; it does not expand filesystem access.

## Security Model

- Only private messages from the allowlisted user are accepted.
- Feishu-started Codex turns use `approvalPolicy: never`.
- Requests requiring additional permissions or human input must be handled in Codex Desktop.
- Remote high-risk approvals, task deletion, and arbitrary directory selection are not supported.
- Detailed progress excludes raw reasoning, full tool arguments, and full terminal output.
- Common tokens, passwords, API keys, and URL credentials are redacted from progress and logs.
- Configuration, queues, logs, and attachments are stored with local-user-only permissions.

Read [SECURITY.md](SECURITY.md) before exposing a deployment.

## Multiple Macs

Use a separate Feishu app and bot for each Mac. Multiple machines consuming the same app's long-lived event stream may race, miss messages, or execute a request more than once.

See [docs/MULTI_MAC.md](docs/MULTI_MAC.md).

## Development

```bash
npm ci
npm test
npm run validate:cards
npm run export:bundle
```

Service operations:

```bash
npm run service -- status
npm run service -- restart
npm run service -- logs
npm run service -- uninstall
```

The export command creates a ZIP and SHA-256 file without `config.local.json`, `data/`, `node_modules/`, credentials, attachments, or logs.

## Known Limitations

- The bridge cannot process messages while the Mac is asleep or powered off.
- A turn actively owned by another Desktop process cannot be steered directly; follow-up messages are queued safely.
- If the Codex daemon does not implement `thread/items/list`, detailed progress falls back to local pagination over `thread/read`.
- Automatic card updates stop when the callback token expires; use **Refresh** to fetch a new snapshot.
- Voice input depends on Feishu ASR permissions and a 60-second duration limit.
- Scheduled tasks run locally; this is not a cloud scheduler.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Do not open a public issue for a vulnerability; follow [SECURITY.md](SECURITY.md) instead.

## License

[Apache License 2.0](LICENSE)

## Disclaimer

This is an unofficial community project and is not affiliated with or endorsed by OpenAI, Feishu, Lark, or ByteDance. Codex, ChatGPT, Feishu, and Lark are trademarks of their respective owners.
