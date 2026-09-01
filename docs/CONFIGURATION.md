# Configuration

**English** | [简体中文](CONFIGURATION.zh-CN.md)

Run `npm run setup` for guided configuration. Use
[`config.example.json`](../config.example.json) as the complete reference and
keep the real `config.local.json` out of Git.

## Security and routing

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
  "defaultWorkspace": "my-project",
  "larkProfile": "my-bot-profile"
}
```

| Field | Purpose |
|---|---|
| `allowedUserIds` | Exactly one Feishu user is supported. |
| `allowedChatIds` | Restricts events to the paired private chat. |
| `requireP2P` | Rejects group-chat messages when `true`. |
| `workspaces` | Maps stable aliases to absolute local project paths. |
| `workspaceAliases` | Adds natural-language names without granting new filesystem access. |
| `defaultWorkspace` | Workspace used only when routing is unambiguous. |
| `larkProfile` | Pins every Feishu operation to one local `lark-cli` profile. |

If `lark-cli` contains multiple apps, always set `larkProfile`. The bridge
applies it to event consumers, replies, cards, downloads, and health checks so a
different bot is never selected implicitly.

## Task and queue limits

| Field | Default | Purpose |
|---|---:|---|
| `recentThreadLimit` | `5` | Number of tasks shown on the dashboard. |
| `pollIntervalMs` | `15000` | Background task-state polling interval. |
| `maxQueuedMessagesPerThread` | `10` | Maximum durable follow-ups per task. |
| `maxOfflineOperations` | `50` | Maximum queued operations during a disconnect. |
| `desktopSyncEnabled` | `true` | Shares tasks and messages with Codex Desktop. |
| `desktopAutoOpenEnabled` | `false` | Keeps background sync from opening task windows. |

Keep `desktopAutoOpenEnabled` disabled unless automatic navigation is explicitly
desired. Passive synchronization avoids taking over the Desktop window.

## Attachments and schedules

| Field | Default | Purpose |
|---|---:|---|
| `maxAttachmentBytes` | `52428800` | Maximum attachment size in bytes. |
| `attachmentRetentionDays` | `7` | Local attachment retention. |
| `ffmpegBin` | `/opt/homebrew/bin/ffmpeg` | Voice conversion binary. |
| `timeZone` | `Asia/Shanghai` | Time zone for local schedules. |
| `scheduleCatchUpWindowMs` | `21600000` | Offline catch-up window. |

## Local files

The service stores configuration, state, event spools, logs, and attachments
under the current user's installation and data directories. These files should
remain readable only by the local macOS user.

Never commit:

- `config.local.json`;
- App Secrets or access tokens;
- `data/`, logs, attachments, or event spools;
- exported Codex credentials or task content.

Run `npm run doctor` after editing configuration.
