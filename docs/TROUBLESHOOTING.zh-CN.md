# 故障排查

[English](TROUBLESHOOTING.md) | **简体中文**

先运行内置诊断：

```bash
npm run service -- status
npm run doctor
npm run service -- logs
```

## 机器人不回复

按顺序检查：

1. Mac 已唤醒、联网，并登录到安装服务的同一个用户。
2. `npm run service -- status` 显示 LaunchAgent 正在运行。
3. `npm run doctor` 可以连接飞书和本机 Codex daemon。
4. 包含所需权限和事件的飞书应用版本已经发布。
5. `allowedUserIds`、`allowedChatIds` 和 `requireP2P` 与配对私聊一致。
6. 本机存在多个 `lark-cli` 应用时，`larkProfile` 指向目标机器人。

修正配置后重启服务：

```bash
npm run service -- restart
```

## Codex 提示任务已在其他应用中打开

首次安装或从旧版本升级后，退出并重新打开一次 Codex Desktop。Desktop 和 Bridge
必须连接同一个本地 app-server。

当前版本默认被动同步，并在回合结束后释放任务写入权。如果 Desktop 仍持有正在执行的
任务，Bridge 会把后续消息加入队列，而不是争抢任务。不要同时启动第二个 Bridge 实例。

## 继续任务提示失败，但刷新后任务变成进行中

`v0.1.3` 已修复另一个 Desktop 进程持有未加载任务时的误报失败。请升级到最新版本并
重启服务。如果问题仍然存在，请记录时间、任务 ID 前缀和脱敏后的服务日志，不要公开
凭据或私有任务内容。

## 已停止、失败或归档的任务无法继续

请升级到最新版本。Bridge 会恢复归档任务，并通过 Codex 原生写入流程继续已停止或失败的
任务。如果其他进程仍持有任务，请发送 `队列`，确认消息是否正在等待。

## 详细进展卡不再更新

卡片回调 token 会过期。失效后自动原地更新会停止，点击“刷新”即可获取最新快照和新卡片。

## 语音消息失败

确认：

- 飞书应用拥有 `speech_to_text:speech` 权限，并已发布最新版本；
- `ffmpegBin` 指向可执行文件；
- 语音不超过 60 秒。

文字、图片和文件不依赖语音权限。

## 多台 Mac 出现重复或漏消息

不要让多台 Mac 同时消费同一个飞书应用的长连接事件。每台 Mac 应使用独立应用和机器人。
参见[多台 Mac](MULTI_MAC.md)。

## 安全地提交问题

请提供：

- Bridge 版本；
- macOS 和 Codex Desktop 版本；
- 当时 Mac 是否唤醒；
- 失败消息的时间；
- 脱敏后的 doctor、服务状态和相关日志片段。

提交前删除 App Secret、Token、飞书 ID、本机用户名、私有路径和任务内容。凭据、授权或
文件边界问题请使用私密安全报告流程。
