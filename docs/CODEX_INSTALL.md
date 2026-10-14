# Codex-managed installation

This is the installation contract linked by the unchanged one-prompt entry in
both READMEs. Install or upgrade Feishu Codex Bridge on the current user's Mac;
the user should not need Homebrew or copied terminal commands.

## Operating rules

- Read the release's `README.md` and `SECURITY.md` before running its scripts.
- Continue through safe, reversible steps. Ask only for a required browser,
  Feishu publication/pairing, macOS permission, or unresolved bot-ownership decision.
- Preserve the existing bot, configuration, state, logs, workspaces, and profiles.
  Never replace a failed profile with a newly created bot during an upgrade.
- Never print or upload credential files, App Secrets, or tokens. Do not change
  global Git configuration, install a system runtime, or use `sudo`.
- Use absolute paths and a persistent Node.js runtime. Do not delete source or
  old releases until all verification succeeds and cleanup is explicitly requested.
- Do not quit the Desktop app running this installation chat. If a restart is
  necessary, record the remaining checks and ask the user to restart it.

## 1. Inspect before installing

Use read-only checks to confirm macOS, the signed-in Desktop app at
`/Applications/ChatGPT.app`, and one of its supported executables, in this order:

```text
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
/Applications/ChatGPT.app/Contents/Resources/codex
```

Do not require the legacy path when the current path exists. The selected
executable must answer `--version` and `login status`; do not ask for an API key
when the Desktop sign-in is already available.

Inspect the existing `io.github.chengzeli7.feishu-codex-bridge` LaunchAgent and
`~/Library/Application Support/CodexFeishuBridge/config.json`. When installed,
read its `larkProfile` and state paths without exposing identifiers or secrets.
Treat this as an upgrade/repair, not a second installation. An absent daemon is
repairable by service installation and must not fail the preflight phase.

A configured bot without a pinned profile needs its original profile identified
before proceeding. Do not use another app simply because it is the global default.
For a fresh installation, confirm any existing bot is intended for this Mac;
ask if its ownership is ambiguous. Each Mac needs a dedicated Feishu app.

## 2. Select a persistent Node.js runtime and npm

Prefer `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` when it
exists and reports Node.js 20 or later. Otherwise use an existing persistent
Node.js 20+ installation. Keep the exact absolute executable path for all steps.

Resolve npm separately; do not assume the app bundles npm next to Node.js.
Check the app's `cua_node/lib/node_modules/npm/bin/npm-cli.js`, then resolve an
existing `npm` executable to its JavaScript entry point. Invoke it with the
selected Node.js. Do not rely on an interactive shell's NVM initialization.

If npm is absent, Codex may provision **npm 10.9.4 locally**: obtain its metadata
from `https://registry.npmjs.org/npm/10.9.4`, download `dist.tarball`, verify the
archive against `dist.integrity` with Node's crypto module, and extract it into
`~/Library/Application Support/CodexFeishuBridge/tools/npm-10.9.4`. Use that
copy's `package/bin/npm-cli.js`. Never install npm globally. A metadata,
checksum, or download failure must stop that step without executing the archive.

Prepend the selected Node.js directory to the subprocess `PATH` for npm and
all setup commands. Dependencies use `/usr/bin/env node`, including `lark-cli`.
The service installer records this same runtime in its LaunchAgent and `PATH`.

## 3. Download an isolated release copy

Resolve the latest published, non-draft, non-prerelease tag:

```bash
gh release view --repo chengzeli7/feishu-codex-bridge --json tagName,isDraft,isPrerelease
```

If `gh` is unavailable, use macOS `curl` with GitHub's latest-release API. Never
silently fall back to the moving `main` branch. Create a fresh directory with
`mktemp -d`, then clone the exact resolved tag with `--depth 1 --branch <tag>`.
If Git is unavailable, download and extract the source archive for that tag.
Do not reuse another project checkout.

Check the remote/tag and require `package.json` and `package-lock.json` versions
to equal the tag without its leading `v`. Read the installation guide from that
release too; stop on contradictory requirements or a version mismatch.

The attached release ZIP is an alternative: download its `.sha256`, check the
ZIP hash, then verify every `BUNDLE_MANIFEST.json` entry after extraction. Both
source forms require the dependency step below.

## 4. Install dependencies locally

Run the selected npm entry point using the selected Node.js, with the isolated
source copy as the working directory:

```text
<absolute-node> <absolute-npm-cli.js> ci --omit=dev --ignore-scripts --no-audit --no-fund
```

Verify `node_modules/.bin/lark-cli` exists. Run its version/auth checks with the
selected Node.js directory on `PATH`. For an upgrade, use the installed
`larkProfile` explicitly; do not switch the global active profile.

## 5. Run guided setup or upgrade

Run `<absolute-node> scripts/onboard.mjs` from the isolated source copy and keep
observing its output. It performs:

1. Runtime checks and verification of the intended Feishu profile.
2. For a new installation only, official app creation if needed, private-chat
   pairing, and workspace selection. Existing configuration skips re-pairing.
3. `doctor --preflight` using the newly downloaded `lark-cli`; no live daemon is
   required yet. Fix failed prerequisites rather than suppressing them.
4. Reuse an already healthy shared daemon without restarting other Codex work.
   Otherwise start it (installing a missing runtime) and bootstrap durable
   management. Only after it is ready, create a versioned release copy, back up
   configuration/LaunchAgent, and install the Bridge.
5. Full `doctor` and service status against the installed release and bot.

When the installer requires the user, present only the current concrete action:
confirm/create the app in the official browser flow, publish requested bot
permissions and events, send the exact private-chat pairing phrase after the
ready marker, or accept a macOS permission prompt. Do not claim completion while
waiting. Do not send the pairing phrase on behalf of the user.

Use workspace paths already specified by the user. For general-purpose use with
no project specified, create `~/Documents/Codex/FeishuTasks` and configure it as
`no-project` (shown as 日常事项); Codex can answer these setup prompts itself.
Do not add unrelated project directories. Existing workspace aliases and paths
remain unchanged during upgrades, including temporarily unavailable volumes.

The default installed data stays in the support directory. When importing an
existing source configuration, data paths are made absolute to preserve its
original state, attachments, and event spool; that source data directory remains
required and must not be deleted as temporary cleanup.

## 6. Verify and report

First run the installed release's `scripts/doctor.mjs` and
`scripts/service.mjs status` using the selected Node.js. Set `BRIDGE_CONFIG` to
the installed `config.json` explicitly when a source checkout also has a local
configuration. Require all mandatory doctor checks to pass and the LaunchAgent
to report a running state and PID. Listener startup alone is insufficient.

The service enables the per-user shared-daemon environment. If Desktop was
already open before its first setup, tell the user to quit and reopen it once.
Do not close the app that owns this installation chat. Resume verification after
the user returns; existing installations already using the shared daemon do not
need an unconditional restart on every upgrade.

Ask the paired user to send `版本`, `健康`, and `任务`. Verify the actual returned
cards, the installed version, and connection status. Then verify one harmless
request returning a result and one continuation targeting the same task; a
message merely accepted by a queue is not completion. Use a dedicated test task,
preserve user work, and do not simulate inbound events as proof of Feishu delivery.

Report installed version, release/config/log paths, reused versus new app,
paired workspace aliases, test results, and any remaining user action. Keep
separate: preflight, installed service health, real Feishu delivery, and task
execution/continuation. Do not label the whole installation verified when any
required stage is still pending.

## Repair and rollback

If the signed CLI reports `daemon executable not found` even from `daemon start`,
inspect its `app-server daemon update --help`. On versions supporting
`--from-cli`, and only after confirming that no shared daemon is running, use
`<absolute-codex> app-server daemon update --from-cli --yes` to repair the missing
managed package from the installed Desktop CLI. This pins the daemon to that CLI
version; record the change and recheck compatibility after Desktop updates.
Do not create ad-hoc binary symlinks, remove old packages, or interrupt a running
shared daemon. `daemon update` without `--from-cli` returns to production updates
and is a separate update decision. Rerun onboarding after the repair.

On failure, retain the old releases, config/LaunchAgent backups, state, and logs.
Diagnose the first failed stage; do not rerun pairing or delete data as a repair.
If the new service cannot start, stop that Bridge instance, restore its matching
config and plist backup, bootstrap the prior Bridge release, and verify status.
Do not stop the shared Codex daemon or unrelated bots. Preserve current state
rather than restoring an old state snapshot that would discard accepted work.
