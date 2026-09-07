# Architecture

**English** | [简体中文](ARCHITECTURE.zh-CN.md)

Feishu Codex Bridge is a local transport and orchestration service. Feishu is
the remote interface; Codex Desktop remains the execution environment.

![Architecture flow](images/workflow-en.svg)

## Components

### Feishu private chat or explicitly allowed group

Receives the user's messages, attachments, and Card 2.0 actions. It also renders
task dashboards, progress snapshots, queues, schedules, health, and completion notifications.

### Local bridge

A per-user macOS LaunchAgent consumes Feishu events and owns:

- sender, chat, bot-mention, and workspace validation;
- natural-language and exact-command routing;
- event deduplication and durable spooling;
- follow-up queues and local schedules;
- attachment retention and progress redaction;
- Card 2.0 creation and updates.

### Codex Desktop app-server

The bridge connects through a local Unix WebSocket. Tasks started from Feishu
are visible in Codex Desktop, and Desktop-created tasks can appear in the bridge
dashboard. The socket is never exposed over TCP or the public internet.

### Allowlisted workspaces

New tasks can start only in absolute paths listed in `workspaces`. Natural
language aliases help routing but never grant access to additional directories.

## Task lifecycle

1. The bridge validates the Feishu sender and chat; group messages must mention this bot.
2. It resolves the target workspace or existing Codex task.
3. It submits the turn through the shared local app-server.
4. Progress snapshots are filtered and rendered as Feishu cards.
5. The task writer is released when the turn ends so Desktop can reopen it.
6. If another process still owns the writer, follow-ups wait in a durable queue.
7. Completion, failure, or required user action produces a notification.

This ownership model avoids opening the same task as competing writers. Desktop
synchronization is passive by default and does not navigate to task windows.

## Local state and recovery

Incoming events are deduplicated before execution. Events, queued operations,
schedules, and task mappings are persisted locally so a bridge restart does not
silently lose accepted work. A single-instance lock prevents two local bridge
processes from consuming the same app configuration.

State version 4 also persists outgoing payloads and submission attempts:

- Replies are frozen before sending and retried with the same delivery key.
  Retry windows are bounded; uncertain card updates are held for verification
  instead of sending an extra fallback card.
- A task submission is recorded before the app-server call. If its outcome is
  unknown, exact client-ID matches in read-only turn history can restore the
  accepted task and its watch. No match does not mean rejection: uncertain work
  is not automatically submitted again.
- Completion is tied to the exact turn and its terminal evidence. Final answers
  take precedence over commentary; health diagnostics show pending deliveries
  and submissions that still need verification.

These safeguards reduce duplicate work and missed replies; they are not an
unconditional exactly-once guarantee across external services or a cloud relay.

## Why no MCP server is required

MCP exposes tools and data sources to Codex. This project solves a different
problem: it receives Feishu events and transports them to the local Codex runtime
as a background service. An MCP server would not remove Feishu app creation,
user pairing, the LaunchAgent, or workspace authorization.

A Codex skill or plugin can make installation and recovery easier, but it would
still install and operate this local bridge.

## Trust boundary

- Feishu credentials stay in the local `lark-cli` profile.
- Codex credentials remain managed by ChatGPT Desktop.
- Remote turns cannot approve additional permissions.
- Progress output is summarized and redacted before it leaves the Mac.
- Access to the paired Feishu account should be treated as access to every
  allowlisted workspace.

See [SECURITY.md](../SECURITY.md) for deployment guidance.
