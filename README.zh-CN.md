# Feishu Codex Bridge

[English](README.md) | **简体中文**

[![CI](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-orange.svg)](CHANGELOG.md)

一个运行在个人 Mac 上的单用户、自托管飞书 Codex 远程控制台。

Self-hosted Feishu/Lark remote control bridge for Codex Desktop. Create and continue Codex tasks, inspect live progress, and receive completion notifications from Feishu while all execution remains on your own Mac.

> `v0.1.1` 是当前公开 Beta。项目依赖 Codex Desktop 当前提供的本地 app-server 能力，Codex 更新后可能需要同步适配。

## 能做什么

- 直接发送普通消息创建 Codex 任务，无需记忆命令。
- 回复任务卡或继续表达，将消息精确发送到对应任务。
- 在飞书查看当前阶段、执行计划、工具/MCP、命令、修改文件、错误和耗时。
- 打开详细进展后，以约 2 秒防抖更新同一张卡片。
- 在 Codex Desktop 和飞书之间共享任务、用户消息、回复与完成状态，并在任务结束后释放会话写锁。
- Desktop 任务同步默认不自动打开或接管窗口，避免后台任务造成跨窗口冲突。
- 支持图片、文件、短语音、任务排队、断线恢复和完成通知。
- 支持一次性、每日和每周本地定时任务。
- 使用用户、私聊和项目目录白名单限制远程访问范围。

它不是远程桌面：默认不能看屏幕、控制鼠标键盘，也不能绕过 Codex 或 macOS 权限。

## 架构

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

飞书只负责传输指令和展示状态。Codex 任务、项目文件和运行状态保留在用户自己的 Mac 上。

## 当前支持范围

- macOS
- 单个飞书用户
- 机器人私聊
- ChatGPT Desktop 内置 Codex 运行时
- Node.js 20 或更高版本
- 飞书版 `lark-cli`

Linux、Windows、群聊、多用户和云端路由暂未支持。

## 快速开始

### 最简单：直接让 Codex 安装

在目标 Mac 上打开 Codex，新建任务，把下面整段发送给 Codex：

```text
请按照下面的 Codex 托管安装指南，在这台 Mac 上安装并配置 Feishu Codex Bridge：
https://github.com/chengzeli7/feishu-codex-bridge/blob/main/docs/CODEX_INSTALL.md
阅读指南后直接自主执行。只有指南明确要求我完成浏览器、飞书、macOS 授权或配对操作时
才暂停。
```

这个流程不要求用户安装或操作 Homebrew。Codex 会优先使用 ChatGPT Desktop 内置的持久化
Node.js 运行时，自动下载源码、安装依赖、完成引导配置并验证服务；只在浏览器、飞书、
macOS 授权和配对等必须由用户完成的步骤暂停。下载文件或安装用户级后台服务时，Codex
仍可能请求正常权限。

### 可选：自己使用 Homebrew 安装

```bash
brew install chengzeli7/tap/feishu-codex-bridge && feishu-codex-bridge init
```

安装包内置官方 `lark-cli`。引导程序会：

1. 检查 macOS、ChatGPT Desktop、Node.js 和 `lark-cli`；
2. 自动打开飞书官方一键创建应用链接，并等待创建完成；
3. 监听一次机器人私聊配对消息，确认唯一允许使用的用户；
4. 收集允许访问的项目目录；
5. 执行健康检查、安装 LaunchAgent，并确认服务已经运行。

应用创建与浏览器授权复用官方 `lark-cli config init --new` 流程。配对消息不能静默跳过，因为它用于证明哪个飞书用户有权远程控制这台 Mac。

### 为什么当前不要求 MCP 或 Plugin

桥接器本质上是本机消息通道和后台服务：接收飞书事件，再连接 Codex Desktop 运行时。
MCP 的主要用途是向 Codex 暴露工具和数据源，无法代替飞书应用创建、本机服务安装和安全配对。

[Codex Skill](https://developers.openai.com/codex/skills) 很适合固化安装、升级、诊断和恢复流程。
OpenAI 官方建议在面向其他用户分发时，把可复用 Skill 打包成
[Plugin](https://developers.openai.com/plugins/build/plugins)。后续 Plugin 可以让这个流程出现在
插件目录里，但它底层仍会运行同一个本机安装器，也不能跳过飞书安全确认。现阶段，直接把
上面的提示词发给 Codex 是步骤最少的安装方式。

### 从源码安装

#### 1. 安装依赖

准备以下环境：

- 已安装并登录 `/Applications/ChatGPT.app`
- Node.js 20+
- `lark-cli`
- 可选：`ffmpeg`，仅语音转写需要

```bash
git clone https://github.com/chengzeli7/feishu-codex-bridge.git
cd feishu-codex-bridge
npm ci
```

#### 2. 创建飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用机器人，并配置：

事件与回调：

- `im.message.receive_v1`
- `card.action.trigger`

权限：

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:message:readonly`
- 可选：`speech_to_text:speech`

创建并发布应用版本，然后把机器人添加到自己的飞书。权限或事件变化后，需要再次发布应用版本。

#### 3. 在本机配置机器人凭据

```bash
lark-cli config init --new
lark-cli auth status --json --verify
```

`App ID` 和 `App Secret` 只保存在本机 `lark-cli` 配置中，不要写入项目文件，也不要通过飞书发送。

#### 4. 配对用户和项目目录

```bash
npm run setup
```

配置器会启动一次性事件监听。按提示向机器人发送：

```text
配对 Codex 助手
```

然后配置允许访问的项目绝对路径。生成的 `config.local.json` 权限为 `0600`，并已被 Git 忽略。

#### 5. 验证并安装后台服务

```bash
npm run doctor
npm test
npm run validate:cards
npm run service -- install
npm run service -- status
```

在飞书依次发送：

```text
版本
健康
任务
检查当前项目状态，只读取，不修改
```

## 使用方式

自然语言是默认入口：

```text
检查这个项目最近失败的测试
再补充分析失败原因
明天 10:30 汇总当前项目进度
```

精确命令用于明确控制：

| 命令 | 作用 |
|---|---|
| `任务` / `首页` | 打开任务首页 |
| `新建` | 打开新建任务表单 |
| `进度1` | 查看第 1 个任务摘要 |
| `详情1` / `详细进展1` | 查看结构化执行详情 |
| `继续1 消息` | 向指定任务发送后续指令 |
| `关注1` / `取消关注1` | 管理完成通知 |
| `停止1` | 二次确认后停止当前回合 |
| `归档1` | 归档已结束任务 |
| `队列` | 查看等待发送的消息 |
| `定时任务` | 查看本地计划任务 |
| `健康` / `版本` / `帮助` | 查看服务状态与说明 |

序号来自最近一次任务列表或搜索结果。

## 配置

可参考 [config.example.json](config.example.json)。关键安全字段：

```json
{
  "allowedUserIds": ["ou_replace_with_your_open_id"],
  "allowedChatIds": ["oc_replace_with_your_chat_id"],
  "requireP2P": true,
  "workspaces": {
    "my-project": "/absolute/path/to/my-project"
  },
  "workspaceAliases": {
    "my-project": ["主项目", "项目简称"]
  },
  "defaultWorkspace": "my-project"
}
```

- `allowedUserIds` 当前必须且只能配置一个用户。
- `allowedChatIds` 建议固定配对产生的唯一私聊。
- 新任务只能进入 `workspaces` 白名单中的绝对路径。
- `workspaceAliases` 只影响自然语言识别，不扩大文件权限。

## 安全模型

- 只接受白名单用户的私聊消息。
- 飞书启动的 Codex 回合使用 `approvalPolicy: never`。
- 需要额外权限或人工输入时，必须回到 Codex Desktop 处理。
- 不支持飞书内高风险审批、删除 Codex 任务或任意本地目录选择。
- 详细进展过滤原始 reasoning、完整工具参数和完整终端输出。
- 命令、错误和 URL 中常见的 Token、密码、API Key 会被脱敏。
- 配置、队列、日志和附件目录默认只允许当前 macOS 用户访问。

公开部署前请阅读 [SECURITY.md](SECURITY.md)。

## 多台 Mac

每台电脑建议使用独立飞书应用和机器人。不要让同一个应用在多台电脑上同时消费长连接事件，否则可能出现抢占、漏处理或重复执行。

详细说明见 [docs/MULTI_MAC.md](docs/MULTI_MAC.md)。

## 开发与验证

```bash
npm ci
npm test
npm run validate:cards
npm run export:bundle
```

运维命令：

```bash
npm run service -- status
npm run service -- restart
npm run service -- logs
npm run service -- uninstall
```

导出命令生成不包含 `config.local.json`、`data/`、`node_modules/`、凭据、附件和日志的 ZIP 与 SHA-256 文件。

## 已知限制

- Mac 睡眠或关机时无法处理飞书消息；唤醒后服务会恢复。
- 首次安装或从旧版本升级后，需要退出并重新打开一次 Codex Desktop，让它接入与桥接相同的本地 app-server。
- Desktop 正在执行且被另一个进程持有的回合不能直接 steer，后续消息会安全排队。
- 当前 Codex daemon 尚未实现 `thread/items/list` 时，详细进展会回退到 `thread/read` 本地分页。
- 卡片更新 token 失效后停止自动更新，可点击“刷新”获取新状态。
- 语音依赖飞书 ASR、租户权限和 60 秒时长限制。
- 定时任务运行在本机，不是云端调度。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交安全问题时不要创建公开 Issue，请使用 [SECURITY.md](SECURITY.md) 中的流程。

## License

[Apache License 2.0](LICENSE)

## Disclaimer

这是社区维护的非官方项目，与 OpenAI、飞书或字节跳动不存在隶属或官方合作关系。Codex、ChatGPT、Feishu 和 Lark 等名称及商标归各自权利人所有。
