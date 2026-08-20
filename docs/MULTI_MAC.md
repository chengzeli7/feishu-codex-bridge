# 多台 Mac 部署

每台电脑建议创建独立飞书应用，并分别维护自己的用户白名单、项目目录和 Codex 任务。

## 为什么不能共用一个机器人

桥接通过飞书长连接消费消息和卡片回调。同一应用被多个本地实例同时消费时，无法稳定指定由哪台电脑处理，可能出现抢占、漏处理或重复执行。

如果确实需要一个机器人控制多台电脑，应增加一个中心路由层，并要求每条任务明确选择目标设备。本项目 `v0.1.0` 不包含该能力。

## 推荐步骤

1. 在目标 Mac 安装并登录 ChatGPT Desktop。
2. 为该 Mac 创建独立飞书应用，启用 README 所列事件和权限。
3. 在目标 Mac 执行 `lark-cli config init --new`。
4. 克隆本仓库并执行 `npm ci`、`npm run setup`。
5. 配置该电脑允许访问的项目目录。
6. 执行 `npm run doctor` 和 `npm run service -- install`。

不同飞书应用下的用户 `open_id` 可能不同，不要从另一台电脑复制 `allowedUserIds`。

## 离线安装包

在已经下载源码的 Mac 上执行：

```bash
npm run export:bundle
```

命令会生成 ZIP 和 `.sha256`。它们不包含：

- `config.local.json`
- `data/`
- `node_modules/`
- 飞书凭据
- Codex 登录状态
- 任务、日志和附件

复制到目标 Mac 后验证：

```bash
shasum -a 256 -c feishu-codex-bridge-*.zip.sha256
```

验证通过后解压、执行 `npm ci`，再按 README 完成本机配对和安装。
