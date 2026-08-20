# Contributing

Thanks for helping improve Feishu Codex Bridge.

## Before opening an issue

- Search existing issues first.
- Do not include `App Secret`, tokens, real Feishu IDs, local usernames, logs containing private content, or proprietary source code.
- Use the security process in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Development setup

```bash
npm ci
npm test
npm run validate:cards
```

The unit tests must not require a real Feishu app, Codex account, or user configuration. Keep live smoke tests opt-in.

## Pull requests

1. Keep each pull request focused on one problem.
2. Add or update tests for behavior changes.
3. Preserve the single-user, private-chat, workspace-allowlist security model unless the change explicitly redesigns and documents it.
4. Never weaken redaction, approval, event deduplication, or queue safety to make a test pass.
5. Update README and CHANGELOG when user-visible behavior changes.

By contributing, you agree that your contribution is licensed under Apache-2.0.
