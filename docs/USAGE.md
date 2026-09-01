# Usage

**English** | [简体中文](USAGE.zh-CN.md)

Natural language is the primary interface. Exact commands remain available when
you need deterministic task selection or service control.

## Start a task

Send a normal private message:

```text
Check why the latest tests failed. Read only; do not modify files yet.
```

If more than one workspace could match, the bot asks you to choose. You can also
open `新建` and select an allowlisted project explicitly.

## Continue a task

The safest options are:

1. reply directly to the task card; or
2. send `继续1 <message>`, where the number comes from the latest task list.

Reply binding keeps the message attached to the intended Codex task. Stopped,
failed, or archived tasks are restored or resumed through Codex's native flow.
If another Desktop process still owns the active writer, the follow-up is kept
in a durable local queue and delivered once the writer is available.

## Follow progress

Send `任务` to open the five most recent tasks. Select a task to see its summary,
or use `详情1` for structured execution details:

- current stage and elapsed time;
- plan steps and their states;
- tool and MCP calls;
- commands;
- changed files;
- recoverable or terminal errors.

Raw reasoning, full tool arguments, and full terminal output are intentionally
excluded. An opened detail card updates in place while its callback token remains valid.

## Images, files, and voice

Send an image or file directly to create a task with that attachment. Reply to a
task card with the attachment to add it to that task. Short voice messages can
be transcribed when Feishu ASR permission and `ffmpeg` are available; the
current voice duration limit is 60 seconds.

## Local schedules

Schedules run on the Mac, not in the cloud:

```text
定时 每天 09:00 android-main 检查 CI
定时 明天 10:30 memory 汇总进度
定时任务
```

One-time, daily, and weekly expressions are supported. The Mac must be awake at
execution time or within the configured catch-up window.

## Exact commands

| Command | Action |
|---|---|
| `任务` / `首页` | Open the task dashboard |
| `新建` | Open the create-task form |
| `进度1` | Show task 1 summary |
| `详情1` / `详细进展1` | Show task 1 structured progress |
| `继续1 <message>` | Continue task 1 |
| `关注1` / `取消关注1` | Manage completion notifications |
| `停止1` | Stop the current turn after confirmation |
| `归档1` | Archive a completed task |
| `队列` | Show durable follow-up messages |
| `定时任务` | Show local schedules |
| `静默 2小时` / `恢复通知` | Pause or resume notifications |
| `健康` / `版本` / `帮助` | Show service status, version, or help |

Numbers refer to the latest task list or search result.

## Availability

- The Mac must be awake and online.
- The bridge recovers its event spool and durable queue after a disconnect.
- Scheduled work is local and cannot run while the Mac is powered off.
- Permission or human-input requests must be handled in Codex Desktop.

See [Troubleshooting](TROUBLESHOOTING.md) when a message does not receive a reply.
