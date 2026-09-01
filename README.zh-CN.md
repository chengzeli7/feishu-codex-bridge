# Feishu Codex Bridge

<div align="center">

**在飞书里使用 Codex，所有执行仍留在你的 Mac。**

一个单用户、自托管的 Codex Desktop 飞书助手，用于远程创建任务、
查看进展、继续对话和接收完成通知。

[快速开始](docs/INSTALL.zh-CN.md) · [工作原理](docs/ARCHITECTURE.zh-CN.md) · [使用指南](docs/USAGE.zh-CN.md) · [English](README.md)

[![CI](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/chengzeli7/feishu-codex-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.4-orange.svg)](CHANGELOG.md)

</div>

![Feishu Codex Bridge 将飞书私聊连接到运行在个人 Mac 上的 Codex Desktop](docs/images/hero.png)

> **公开 Beta：** 当前版本为 `v0.1.4`。项目依赖 Codex Desktop 现有的本地
> app-server 能力，后续 Codex 更新可能需要同步进行兼容性适配。

## 它解决什么问题？

Codex Desktop 在你的 Mac 上工作，但你不一定一直坐在电脑前。
Feishu Codex Bridge 把机器人私聊变成一个轻量的任务控制台：

1. 在飞书发送普通消息，创建一个 Codex 任务。
2. 在任务卡中查看计划、命令、文件、错误和耗时。
3. 回复任务卡，在原有上下文中继续同一个任务。
4. 在任务完成或需要你处理时收到通知。

项目代码、Codex 会话、凭据和运行状态始终保留在自己的 Mac 上。

## 20 秒产品演示

![产品演示：创建任务、查看结构化进展、收到结果并继续任务](docs/images/product-demo.gif)

这是使用示例数据重绘的产品演示，不是真实用户或项目截图。可以打开三张原图查看细节：
[创建任务](docs/images/demo-step-1.png) ·
[查看进展](docs/images/demo-step-2.png) ·
[收到结果并继续](docs/images/demo-step-3.png) ·
[观看 12 秒宣传视频](docs/media/x-launch-demo.mp4)。

## 三个最常用的场景

| 远程发起任务 | 随时查看进度 | 带着上下文继续 |
|---|---|---|
| 直接发送自然语言需求，或选择一个已加入白名单的项目。 | 不打开 Codex Desktop，也能查看任务列表和详细进展。 | 回复任务卡继续对应任务，需要精确选择时再使用命令。 |
| `检查最近失败的测试，先不要修改` | 计划 · 工具/MCP · 命令 · 修改文件 · 错误 | `继续1，再补一个回归测试` |

此外还支持图片、文件、短语音、持久化消息队列、完成关注，以及一次性、
每日或每周在本机执行的定时任务。

## 它适合你吗？

| 适合这些情况 | 建议选择其他方案 |
|---|---|
| 经常在个人 Mac 上使用 Codex Desktop | 需要 Linux、Windows 或持续在线的云端执行器 |
| 希望从手机查看或继续任务 | 需要完整控制屏幕、鼠标或键盘 |
| 希望代码和凭据留在本机 | 需要多人共享或群聊机器人 |
| 可以明确配置允许访问的项目 | 需要不受限制地访问任意目录 |

## 工作原理

![飞书私聊通过本机 Bridge 将请求发送给 Codex Desktop 和白名单项目](docs/images/workflow-zh-CN.svg)

飞书只负责传输消息和展示卡片。Bridge、消息队列、调度器、Codex 运行时和
项目文件都运行在你的 Mac 上。任务所有权与断线恢复机制见
[架构说明](docs/ARCHITECTURE.zh-CN.md)。

## 快速开始

### 最简单：直接让 Codex 安装

在目标 Mac 上打开 Codex，新建任务，把下面整段发送给 Codex：

```text
请按照下面的 Codex 托管安装指南，在这台 Mac 上安装并配置 Feishu Codex Bridge：
https://github.com/chengzeli7/feishu-codex-bridge/blob/main/docs/CODEX_INSTALL.md
阅读指南后直接自主执行。只有指南明确要求我完成浏览器、飞书、macOS 授权或配对操作时
才暂停。
```

Codex 会自动下载项目、选择持久化 Node.js 运行时、执行引导配置、安装当前用户的
后台服务并完成验证。你只需要处理浏览器确认、发布飞书应用、macOS 权限提示，以及
发送一次机器人私聊配对消息。

安装完成后，在飞书依次发送：

```text
健康
任务
检查这个项目最近失败的测试，暂时不要修改文件
```

希望自己安装？完整的 Homebrew 和源码流程见[安装指南](docs/INSTALL.zh-CN.md)。

### 安装前可以预期什么

| 项目 | 说明 |
|---|---|
| 常见耗时 | 约 5～15 分钟，具体取决于飞书应用发布过程 |
| 自动完成 | 下载、依赖安装、本机配置、LaunchAgent 和诊断 |
| 需要你处理 | 浏览器确认、发布飞书应用、macOS 提示和一次配对消息 |
| 安装数据 | `~/Library/Application Support/CodexFeishuBridge` |
| 日志 | `~/Library/Logs/CodexFeishuBridge` |
| 卸载 | `feishu-codex-bridge uninstall` 停止服务并保留本机数据 |

安装器会保留已有 Bridge 状态、飞书 Profile、Codex 设置和项目文件，也不会修改
全局 Git 配置。

## 安全边界

- **单用户私聊：** 只接受完成配对的用户和私聊会话。
- **项目白名单：** 新任务只能进入明确配置的项目目录。
- **不绕过审批：** 飞书创建的回合使用 `approvalPolicy: never`。
- **凭据保留本地：** 飞书和 Codex 凭据不会写入仓库。
- **进展信息过滤：** 不展示原始 reasoning、完整工具参数和完整终端输出，常见密钥会脱敏。
- **不是远程桌面：** 不能查看电脑屏幕，也不能控制鼠标和键盘。

飞书账号一旦可以访问机器人，就相当于可以访问白名单中的项目。部署前请阅读
[SECURITY.md](SECURITY.md)。

## 当前支持范围

| 已支持 | 暂未支持 |
|---|---|
| macOS | Linux 和 Windows |
| 单个白名单飞书用户 | 多用户 |
| 机器人私聊 | 群聊 |
| ChatGPT Desktop 内置 Codex 运行时 | 云端 Codex 路由 |
| 明确配置的本地项目 | 任意目录访问 |

Mac 必须保持唤醒并联网。睡眠或关机后无法处理消息，因为它是本机 Bridge，
不是云端中转服务。

当前飞书卡片和精确命令以中文为主；自然语言任务可以使用 Codex 支持的其他语言。
完整的卡片和命令多语言支持将在后续版本提供。

## 和其他方案有什么区别？

| 能力 | Feishu Codex Bridge | 远程桌面 | 普通聊天机器人 |
|---|---|---|---|
| 结构化 Codex 任务进展 | 内置 | 只能通过屏幕查看 | 需要自行集成 |
| 继续同一个 Codex 任务 | 回复卡片或精确命令 | 手动操作 Desktop | 需要自行绑定任务 |
| 代码和凭据保留在 Mac | 是 | 是 | 取决于机器人架构 |
| 手机交互体验 | 原生飞书卡片 | 桌面画面串流 | 只有聊天 |
| 控制屏幕、鼠标和键盘 | 否 | 是 | 否 |

## 兼容性

| 组件 | 当前支持 |
|---|---|
| 操作系统 | macOS |
| Codex | ChatGPT Desktop 内置运行时 |
| Node.js | CI 覆盖 20、22 和 24 |
| 飞书/Lark | 企业自建应用、机器人能力、私聊 |
| `lark-cli` | 项目内置依赖，当前为 `1.0.89` |

## 常见问题

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>这是云服务吗？</strong><br><br>
      不是。飞书只传输消息和卡片，执行、队列、文件与凭据都留在你的 Mac。
    </td>
    <td width="50%" valign="top">
      <strong>可以读取所有文件吗？</strong><br><br>
      不可以。新任务仅限项目白名单，并继续受 Codex 与 macOS 权限限制。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>为什么 Mac 睡眠后不回复？</strong><br><br>
      项目没有云端中转。Mac 睡眠或关机后，本机 Bridge 无法接收和执行消息。
    </td>
    <td width="50%" valign="top">
      <strong>一个机器人能控制多台 Mac 吗？</strong><br><br>
      建议每台 Mac 使用独立飞书应用，避免长连接抢占、漏处理或重复执行。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>支持群聊吗？</strong><br><br>
      暂不支持。当前单用户安全模型只接受完成配对的机器人私聊。
    </td>
    <td width="50%" valign="top">
      <strong>Codex 需要审批怎么办？</strong><br><br>
      远程回合使用 <code>approvalPolicy: never</code>，额外权限或人工输入需回到 Codex Desktop。
    </td>
  </tr>
</table>

更多答案和诊断步骤见[故障排查](docs/TROUBLESHOOTING.zh-CN.md)。

## 文档

| 指南 | 内容 |
|---|---|
| [安装](docs/INSTALL.zh-CN.md) | Codex 托管、Homebrew 和源码安装 |
| [使用](docs/USAGE.zh-CN.md) | 自然语言、精确命令、附件、定时任务和队列 |
| [配置](docs/CONFIGURATION.zh-CN.md) | 白名单、项目、机器人 Profile、路径和限制 |
| [架构](docs/ARCHITECTURE.zh-CN.md) | 组件、数据流、任务所有权和本地优先设计 |
| [故障排查](docs/TROUBLESHOOTING.zh-CN.md) | 不回复、窗口冲突、卡片不更新、语音和诊断 |
| [多台 Mac](docs/MULTI_MAC.md) | 为什么每台 Mac 应使用独立飞书应用 |
| [Codex 托管安装指南](docs/CODEX_INSTALL.md) | Codex 自动安装时遵循的执行约定 |

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请不要创建公开 Issue，
应按照 [SECURITY.md](SECURITY.md) 中的方式提交。

## License

[Apache License 2.0](LICENSE)

## Disclaimer

这是社区维护的非官方项目，与 OpenAI、飞书、Lark 或字节跳动不存在隶属或官方合作关系。
Codex、ChatGPT、Feishu 和 Lark 等名称及商标归各自权利人所有。
