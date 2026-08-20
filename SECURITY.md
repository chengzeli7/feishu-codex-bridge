# Security Policy

## Supported versions

Security fixes are provided for the latest public release.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving authentication, event spoofing, command execution, filesystem access, credential leakage, or approval bypass.

Use GitHub's **Report a vulnerability** flow under the repository Security tab. Include:

- affected version;
- impact and prerequisites;
- minimal reproduction steps;
- suggested mitigation, if known.

Do not include real credentials, private project files, or personal Feishu identifiers.

## Deployment guidance

- Use a dedicated Feishu app for each Mac.
- Keep `config.local.json`, `data/`, logs, and `lark-cli` credentials out of source control.
- Configure exactly one `allowedUserIds` entry and the paired private chat in `allowedChatIds`.
- Limit `workspaces` to projects the remote user is allowed to access.
- Keep `approvalPolicy: never` for remotely started turns.
- Do not expose the local Codex app-server socket over TCP or the public internet.
- Review logs and rotate the Feishu App Secret if credential exposure is suspected.

This bridge can execute Codex tasks that read and modify local files. Treat access to the allowlisted Feishu account as equivalent to access to those configured workspaces.
