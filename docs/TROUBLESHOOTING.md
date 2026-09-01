# Troubleshooting

**English** | [简体中文](TROUBLESHOOTING.zh-CN.md)

Start with the built-in diagnostics:

```bash
npm run service -- status
npm run doctor
npm run service -- logs
```

## The bot does not reply

Check these in order:

1. The Mac is awake, online, and logged into the same user account that installed the service.
2. `npm run service -- status` reports the LaunchAgent as running.
3. `npm run doctor` can reach both Feishu and the local Codex daemon.
4. The Feishu app version containing the required permissions and events is published.
5. `allowedUserIds`, `allowedChatIds`, and `requireP2P` match the paired private chat.
6. When multiple `lark-cli` apps exist, `larkProfile` points to the intended bot.

After fixing configuration, restart the service:

```bash
npm run service -- restart
```

## Codex says the task is open in another app

After the first installation or an upgrade from an older build, quit and reopen
Codex Desktop once. Desktop and the bridge must use the same local app-server.

Current releases synchronize passively and release a completed task's writer.
If Desktop still owns an active writer, the bridge queues the follow-up instead
of competing for the task. Do not start a second bridge instance.

## A follow-up reports failure, but the task becomes active

`v0.1.3` fixed a false-failure path for unloaded tasks owned by another Desktop
process. Upgrade to the latest release and restart the service. If the problem
continues, collect the timestamp, task ID prefix, and sanitized service logs.
Do not publish credentials or proprietary task content.

## A stopped, failed, or archived task cannot continue

Upgrade to the latest release. The bridge restores archived tasks and routes
stopped or failed continuations through Codex's native writer flow. If another
process owns the task, confirm that the message appears under `队列`.

## A detail card stops updating

Card callback tokens expire. Automatic in-place updates stop when the token is
no longer valid; select **Refresh** to obtain a current snapshot and a new card.

## Voice messages fail

Verify:

- the Feishu app has `speech_to_text:speech` permission and the updated version is published;
- `ffmpegBin` points to an executable binary;
- the recording is no longer than 60 seconds.

Text, images, and files do not require voice permission.

## Messages are duplicated or missed on multiple Macs

Do not run the same Feishu app's long-lived event stream on more than one Mac.
Each Mac should use a separate app and bot. See [Multiple Macs](MULTI_MAC.en.md).

## Collecting a safe report

Include:

- bridge version;
- macOS and Codex Desktop versions;
- whether the Mac was awake;
- the failing message time;
- sanitized output from `doctor`, service status, and the relevant log window.

Remove App Secrets, tokens, Feishu IDs, local usernames, private paths, and task
content before filing an issue. Use the private security process for any
credential, authorization, or filesystem-boundary problem.
