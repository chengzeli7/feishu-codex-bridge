# Multiple Mac deployment

[简体中文](MULTI_MAC.md) | **English**

Use a separate Feishu app and bot for each Mac. Each installation should maintain
its own user allowlist, workspace paths, and Codex tasks.

## Why one bot cannot be shared

The bridge consumes Feishu messages and card callbacks through a long-lived
event stream. When multiple local instances consume the same app, Feishu cannot
reliably target one computer. Messages may be raced, missed, or executed more than once.

A single bot controlling multiple computers requires a central router and an
explicit target-device choice for every task. That architecture is outside the
current release.

## Recommended setup

1. Install and sign in to ChatGPT Desktop on the target Mac.
2. Create a separate Feishu app and enable the documented bot events and permissions.
3. Configure that app in the target Mac's `lark-cli` profile.
4. Install the bridge and pair the private-chat user.
5. Configure only that Mac's allowlisted workspaces.
6. Run `npm run doctor` and install the LaunchAgent.

The same human may have different Feishu `open_id` values under different
apps. Do not copy `allowedUserIds` from another machine.

## Offline bundle

From an existing source checkout:

```bash
npm run export:bundle
```

The command creates a ZIP and SHA-256 file without configuration, credentials,
data, dependencies, task content, logs, or attachments.

On the target Mac, verify the copied bundle before extraction:

```bash
shasum -a 256 -c feishu-codex-bridge-*.zip.sha256
```

Then extract it, run `npm ci`, and complete pairing and installation locally.
