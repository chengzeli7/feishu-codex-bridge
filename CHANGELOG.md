# Changelog

All notable public changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-08-21

- Fixed false failure cards when another Codex Desktop process owns an unloaded task.
- Keeps affected continuations in the bridge's durable queue and removes them only after Codex accepts the new turn, preventing lost or duplicate messages.

## [0.1.2] - 2026-08-21

- Automatically restores archived Codex tasks before continuing them from Feishu.
- Routes stopped or failed task continuations through Codex's native writer queue when Codex Desktop still owns the task, preserving the original task context without forcing a competing writer.
- Acknowledges continuations that remain in the native queue without reporting a false completion watch.
- Simplified the task home card by removing the top metrics and hid the completion-follow action for tasks that have already finished.

## [0.1.1] - 2026-08-20

- Fixed Codex Desktop task ownership conflicts by sharing the official local
  app-server and releasing a completed task's writer subscription.
- Added recoverable migration for legacy bridge and app-server LaunchAgents so
  older services no longer retain the single-instance lock.
- Added a dedicated **Back to task list** action to detailed progress cards and
  restored the compact task list to the five most recent tasks.
- Disabled automatic `codex://threads/...` navigation by default while keeping
  shared Desktop task synchronization enabled, preventing cross-window task
  ownership conflicts.
- Added a Codex-managed installation guide that can be invoked with one prompt
  and uses the Node.js runtime bundled with ChatGPT Desktop when available.
- Made the LaunchAgent retain the exact persistent Node.js runtime used during
  installation, removing Homebrew as a requirement for Codex-managed setup.
- Added offline Card 2.0 validation for CI, an opt-in live `lark-cli` dry-run,
  expanded regression coverage, and repository ownership metadata.

## [0.1.0] - 2026-08-20

First public beta.

- Added single-user Feishu private-chat control for Codex Desktop tasks.
- Added natural-language task creation, precise reply binding, continuation routing, and ambiguity confirmation.
- Added Card 2.0 dashboards for task lists, summaries, structured detailed progress, queues, health, and schedules.
- Added live in-place progress updates with plan, tool/MCP, command, file, error, and duration summaries.
- Added Codex Desktop shared app-server synchronization and safe message queuing for active turns.
- Added image, file, and optional Feishu ASR voice input.
- Added one-time, daily, and weekly local schedules with offline catch-up limits.
- Added persistent event spooling, deduplication, reconnect recovery, and a single-instance lock.
- Added allowlisted users, chats, and workspaces; high-risk remote approvals remain disabled.
- Added secret redaction and filtering of raw reasoning, full tool arguments, and full terminal output.
- Added an interactive setup flow, sanitized offline bundle export, macOS LaunchAgent installer, tests, and Card 2.0 validation.

[Unreleased]: https://github.com/chengzeli7/feishu-codex-bridge/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/chengzeli7/feishu-codex-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/chengzeli7/feishu-codex-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/chengzeli7/feishu-codex-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chengzeli7/feishu-codex-bridge/releases/tag/v0.1.0
