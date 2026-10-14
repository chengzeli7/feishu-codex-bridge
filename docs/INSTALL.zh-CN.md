# 安装

[English](INSTALL.md) | **简体中文**

Feishu Codex Bridge 提供三种安装方式。推荐使用 Codex 托管安装：它会执行与
手动安装相同的检查，并且只在浏览器、飞书、macOS 授权或配对必须由用户处理时暂停。

## 环境要求

- macOS
- 已安装并登录 `/Applications/ChatGPT.app`
- Node.js 20 或更高版本
- 一个启用机器人能力的飞书企业自建应用
- 一个飞书用户和对应机器人私聊
- 至少一个允许访问的目录，可以是日常材料目录，不必是代码仓库
- 可选：语音转写需要 `ffmpeg`

## 方式 A：Codex 托管安装

在目标 Mac 上新建一个 Codex 任务，发送：

```text
请按照下面的 Codex 托管安装指南，在这台 Mac 上安装并配置 Feishu Codex Bridge：
https://github.com/chengzeli7/feishu-codex-bridge/blob/main/docs/CODEX_INSTALL.md
阅读指南后直接自主执行。只有指南明确要求我完成浏览器、飞书、macOS 授权或配对操作时
才暂停。
```

Codex 会遵循仓库里的[安装约定](CODEX_INSTALL.md)，保护已有安装和配置，选择
持久化 Node.js 运行时，在隔离目录下载项目，执行引导配置，安装当前用户的
LaunchAgent，并完成健康检查。

首次启用共享 daemon 时，如果 Desktop 已经打开，需要由你退出并重新打开一次；
已使用共享 daemon 的正常升级不要求每次重启。安装完成后验证 `版本`、`健康`、`任务`，
再验证一个无副作用请求及其同一事项续聊。完整验收标准见[安装约定](CODEX_INSTALL.md#6-verify-and-report)。

## 方式 B：Homebrew

该 Tap 独立维护，可能晚于 GitHub Release。安装前用
`brew info chengzeli7/tap/feishu-codex-bridge` 查看版本；需要 GitHub 最新版时使用方式 A。

```bash
brew install chengzeli7/tap/feishu-codex-bridge
feishu-codex-bridge init
```

安装包包含官方 `lark-cli`。引导程序会检查运行环境、打开飞书官方创建应用流程、
配对唯一私聊用户、收集项目白名单、安装后台服务并运行诊断。

## 方式 C：从源码安装

### 1. 下载项目并安装依赖

```bash
git clone https://github.com/chengzeli7/feishu-codex-bridge.git
cd feishu-codex-bridge
git checkout v0.1.6
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

### 2. 创建并发布飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用机器人并配置：

事件与回调：

- `im.message.receive_v1`
- `card.action.trigger`

权限：

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:message:readonly`
- 可选：`speech_to_text:speech`

创建并发布应用版本。以后修改权限或事件时，需要再次发布版本。

### 3. 在本机配置机器人

```bash
./node_modules/.bin/lark-cli config init --new
./node_modules/.bin/lark-cli auth status --json --verify
```

App ID 和 App Secret 只保存在本机 `lark-cli` Profile，不要提交到仓库或通过
飞书发送。如果本机存在多个 Profile，请在 `config.local.json` 中设置
`larkProfile`，确保监听、回复、卡片更新、附件下载和健康检查始终使用目标机器人。

### 4. 配对用户和项目

```bash
npm run setup
```

按照安装器提示，向机器人发送它显示的精确配对消息，再输入允许访问的项目绝对路径。
生成的 `config.local.json` 已被 Git 忽略，文件权限为 `0600`。

### 5. 验证并安装后台服务

```bash
npm run doctor -- --preflight
npm run service -- install
npm run doctor
npm run service -- status
```

退出并重新打开一次 Codex Desktop，然后在飞书发送：

```text
版本
健康
任务
```

## 升级已有安装

重新发送 Codex 托管安装提示词，或将源码目录更新到最新正式 Release 后执行：

```bash
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node scripts/onboard.mjs
```

安装器会创建新的版本目录、备份配置和 LaunchAgent，并保留状态、飞书 Profile、日志和项目白名单。
升级不重新配对或切换飞书 Profile。向机器人发送 `版本` 和 `健康`，确认真实回复；
首次切换共享 daemon 时才需要重启 Desktop。源码安装的既有状态、附件和事件目录保持原位置，不能删除。

## 下一步

- [配置项目和限制](CONFIGURATION.zh-CN.md)
- [了解消息路由和命令](USAGE.zh-CN.md)
- [排查安装或运行问题](TROUBLESHOOTING.zh-CN.md)
- [部署到多台 Mac](MULTI_MAC.md)

## 诊断与卸载

Codex 托管安装不会自动往系统 PATH 安装全局命令。可继续让 Codex 诊断、升级或卸载；
也可在安装日志指出的 release 目录运行 `node bin/feishu-codex-bridge.mjs doctor`、
`status` 或 `uninstall`。从其他目录操作时，显式设置 `BRIDGE_CONFIG` 为已安装的 config 路径。
卸载停止 Bridge 并保留配置、数据及共享 Codex daemon。Homebrew 用户可直接使用同名全局命令。
