# Codex-managed installation

This guide is written for Codex. Its goal is to install and configure Feishu
Codex Bridge on the current user's Mac without requiring the user to operate
Homebrew or copy terminal commands.

## Operating rules

- Read `README.md` and `SECURITY.md` before changing the machine.
- Continue autonomously through safe, reversible steps. Ask the user only for
  a required approval or action that cannot be completed by Codex.
- Preserve existing bridge configuration, state, logs, `lark-cli` profiles,
  Feishu apps, Codex configuration, and project files.
- Never print, commit, upload, or send an App Secret, access token, or complete
  credential file through Feishu or chat.
- Do not update macOS or Xcode, change global Git configuration, overwrite a
  different bot, or delete an existing installation without explicit approval.
- Use absolute paths. Do not run recursive destructive commands against a home
  directory, workspace root, or unresolved variable.

## 1. Inspect before installing

Confirm all of the following with read-only checks:

- the operating system is macOS;
- `/Applications/ChatGPT.app` exists and Codex is signed in;
- `/Applications/ChatGPT.app/Contents/Resources/codex` exists;
- whether `io.github.chengzeli7.feishu-codex-bridge` is already loaded;
- whether `~/Library/Application Support/CodexFeishuBridge/config.json` exists;
- whether the current `lark-cli` profile already contains a verified bot.

If an installation already exists, treat the operation as a repair or upgrade.
Keep its configuration and data. If an available Feishu bot appears to belong
to another application or computer, stop and ask the user which bot to use.

## 2. Select the persistent Node.js runtime

Prefer the runtime bundled with ChatGPT Desktop:

```text
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/npm/bin/npm-cli.js
```

Verify that Node.js is version 20 or later. If those files do not exist, use an
already-installed, persistent Node.js 20+ runtime. Do not install Homebrew or a
system-wide runtime unless the user explicitly asks for that fallback.

## 3. Download an isolated source copy

Create a new temporary directory with `mktemp -d`. Clone
`https://github.com/chengzeli7/feishu-codex-bridge.git` into that exact directory
with a shallow clone. Do not reuse an unrelated directory and do not modify the
user's project repositories.

Review the checked-out `README.md`, `SECURITY.md`, current version, and Git
remote before executing project scripts. If Git is unavailable, download the
source archive for the current GitHub release with macOS `curl` and extract it
into the temporary directory instead.

## 4. Install local dependencies without Homebrew

From the isolated source directory, invoke the selected npm CLI with the
selected Node.js binary and run:

```bash
"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/npm/bin/npm-cli.js" \
  ci --omit=dev --ignore-scripts --no-audit --no-fund
```

Do not use `sudo` and do not install packages globally. Confirm that the bundled
`node_modules/.bin/lark-cli` exists after installation.

## 5. Run guided setup

Use the selected Node.js binary to run `scripts/onboard.mjs`. Keep the process
attached and continue observing its output.

The setup may open an official Feishu page. When user action is required, give
only the current concrete instruction, wait for the user, and then continue:

1. confirm or create the Feishu app in the opened browser;
2. enable and publish the requested bot permissions and events if prompted;
3. send the exact private-chat pairing message shown by the installer;
4. provide the absolute workspace paths that this bot may access;
5. approve a normal macOS prompt if one appears.

Do not claim success while the installer is waiting for any of these actions.

## 6. Verify and report

After setup completes, tell the user that Codex Desktop must be quit and reopened
once before the first Feishu task is sent. If this guide is being executed inside
Codex Desktop, do not quit the app on the user's behalf: finish the current
installation response, ask the user to restart Codex, and continue verification
after they return. This restart moves Desktop onto the same local app-server as
the bridge and prevents a task writer conflict.

After that restart, run `scripts/doctor.mjs` and
`scripts/service.mjs status` with the same Node.js binary. Confirm that both the
official Codex daemon and the bridge LaunchAgent are running. Ask the user to
send `健康` to the Feishu bot and confirm that the bot replies.

Report:

- installed bridge version and service label;
- whether a Feishu app was created or an existing verified app was reused;
- the paired user and allowlisted workspace aliases, without exposing secrets;
- doctor, service, and Feishu message verification results;
- exact unresolved actions or warnings, if any.

Keep the temporary source directory until verification succeeds. Afterward,
tell the user where the installed release, configuration, data, and logs live;
leave cleanup to a separate, explicitly approved action.
