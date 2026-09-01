# Installation

**English** | [简体中文](INSTALL.zh-CN.md)

Feishu Codex Bridge supports three installation paths. The Codex-managed path is
recommended because it performs the same checks as a manual installation while
asking for user input only when a browser, Feishu, macOS, or pairing action is required.

## Requirements

- macOS
- ChatGPT Desktop installed at `/Applications/ChatGPT.app` and signed in
- Node.js 20 or later
- One Feishu custom app with bot capability
- One Feishu user and private chat
- At least one local workspace path to allowlist
- Optional: `ffmpeg` for voice transcription

## Option A: Codex-managed installation

Open a new Codex task on the target Mac and send:

```text
Install and configure Feishu Codex Bridge on this Mac by following:
https://github.com/chengzeli7/feishu-codex-bridge/blob/main/docs/CODEX_INSTALL.md
Read the guide and then execute it autonomously. Pause only when the guide says
that I must complete a browser, Feishu, macOS, or pairing action.
```

Codex follows the checked-in [installation contract](CODEX_INSTALL.md). It
preserves an existing installation, selects a persistent Node.js runtime,
downloads an isolated copy, runs setup, installs a per-user LaunchAgent, and
performs health checks.

After setup finishes, quit and reopen Codex Desktop once, then send `健康` to
the bot. The restart puts Desktop and the bridge on the same local app-server.

## Option B: Homebrew

```bash
brew install chengzeli7/tap/feishu-codex-bridge
feishu-codex-bridge init
```

The package includes the official `lark-cli`. The guided installer checks the
runtime, opens the official Feishu app-creation flow, pairs one private-chat
user, collects allowlisted workspaces, installs the service, and runs diagnostics.

## Option C: source installation

### 1. Download and install dependencies

```bash
git clone https://github.com/chengzeli7/feishu-codex-bridge.git
cd feishu-codex-bridge
npm ci
```

### 2. Create and publish a Feishu app

Create a custom app in the [Feishu Open Platform](https://open.feishu.cn/app),
enable bot capability, and configure:

Events and callbacks:

- `im.message.receive_v1`
- `card.action.trigger`

Permissions:

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:message:readonly`
- Optional: `speech_to_text:speech`

Create and publish an app version. Publish a new version whenever permissions or
events change.

### 3. Configure the bot locally

```bash
lark-cli config init --new
lark-cli auth status --json --verify
```

Keep the App ID and App Secret in the local `lark-cli` profile. Never commit or
send them through Feishu. When more than one profile exists, set `larkProfile`
in `config.local.json` so every listener, reply, card update, download, and
health check uses the intended bot.

### 4. Pair the user and workspaces

```bash
npm run setup
```

When prompted, send the exact pairing message shown by the setup tool to the bot.
Then enter the absolute paths that the bot may use. The generated
`config.local.json` is ignored by Git and created with mode `0600`.

### 5. Verify and install the service

```bash
npm run doctor
npm test
npm run validate:cards
npm run service -- install
npm run service -- status
```

Quit and reopen Codex Desktop once. Then send:

```text
版本
健康
任务
```

## Upgrade an existing installation

Run the Codex-managed installation prompt again, or update a source checkout to
the latest published release and rerun:

```bash
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run doctor
npm run service -- install
npm run service -- status
```

The installer creates a versioned release directory and preserves the existing
configuration, state, Feishu profiles, logs, and allowlisted workspaces. Quit
and reopen Codex Desktop once after the upgrade, then send `版本` and `健康`.

## Next steps

- [Configure workspaces and limits](CONFIGURATION.md)
- [Learn the message model and commands](USAGE.md)
- [Troubleshoot installation or runtime problems](TROUBLESHOOTING.md)
- [Deploy on multiple Macs](MULTI_MAC.en.md)
