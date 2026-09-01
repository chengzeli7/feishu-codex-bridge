# 配置

[English](CONFIGURATION.md) | **简体中文**

建议运行 `npm run setup` 完成引导配置。完整字段参考
[`config.example.json`](../config.example.json)，真实的 `config.local.json`
必须保留在本机并排除在 Git 之外。

## 安全与路由

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
  "defaultWorkspace": "my-project",
  "larkProfile": "my-bot-profile"
}
```

| 字段 | 作用 |
|---|---|
| `allowedUserIds` | 当前只支持一个飞书用户。 |
| `allowedChatIds` | 只接受配对产生的机器人私聊。 |
| `requireP2P` | 为 `true` 时拒绝群聊消息。 |
| `workspaces` | 将稳定别名映射到本地项目绝对路径。 |
| `workspaceAliases` | 增加自然语言名称，但不会扩大文件权限。 |
| `defaultWorkspace` | 只有路由无歧义时才使用的默认项目。 |
| `larkProfile` | 将所有飞书操作固定到一个本机 `lark-cli` Profile。 |

如果 `lark-cli` 中存在多个应用，务必配置 `larkProfile`。Bridge 会将它用于
事件监听、回复、卡片、附件下载和健康检查，避免隐式选择到其他机器人。

## 任务与队列限制

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `recentThreadLimit` | `5` | 任务首页展示数量。 |
| `pollIntervalMs` | `15000` | 后台任务状态轮询间隔。 |
| `maxQueuedMessagesPerThread` | `10` | 每个任务最多保留的后续消息。 |
| `maxOfflineOperations` | `50` | 断线时最多保留的操作。 |
| `desktopSyncEnabled` | `true` | 与 Codex Desktop 共享任务和消息。 |
| `desktopAutoOpenEnabled` | `false` | 避免后台同步自动打开任务窗口。 |

除非明确需要自动导航，否则保持 `desktopAutoOpenEnabled` 为关闭状态。被动同步可以避免
后台任务接管 Desktop 窗口。

## 附件与定时任务

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `maxAttachmentBytes` | `52428800` | 附件大小上限，单位为字节。 |
| `attachmentRetentionDays` | `7` | 本机附件保留天数。 |
| `ffmpegBin` | `/opt/homebrew/bin/ffmpeg` | 语音转换程序路径。 |
| `timeZone` | `Asia/Shanghai` | 本机定时任务时区。 |
| `scheduleCatchUpWindowMs` | `21600000` | 离线任务补偿窗口。 |

## 本机文件

后台服务会在当前用户的安装和数据目录保存配置、状态、事件暂存、日志和附件。
这些文件应只允许当前 macOS 用户读取。

不要提交：

- `config.local.json`；
- App Secret 或访问 Token；
- `data/`、日志、附件和事件暂存；
- Codex 凭据或任务内容。

修改配置后运行 `npm run doctor`。
