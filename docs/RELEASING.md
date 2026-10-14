# Release checklist

The one-prompt installer follows the latest published GitHub Release. Updating
`main` or opening a PR alone does not deliver a new installable version.

## Prepare and verify

1. Keep `package.json`, both lockfile version fields, README badges, changelog,
   and pinned manual-install examples aligned. Preserve the existing bilingual
   Codex installation prompts and their stable `main/docs/CODEX_INSTALL.md` URL.
2. Update English and Chinese README, usage, installation, and troubleshooting
   content for actual behavior. Label illustrative renders and live evidence
   accurately; do not reuse historical QA as a new live check.
3. Run the affected tests, `npm run validate:cards`, `npm run validate:docs`, and
   `git diff --check`. The installation regression suite executes actual setup,
   onboarding, doctor, and service scripts in isolated directories. Its macOS
   services, bot auth, and inbound pairing are simulated external boundaries.
4. Verify dependencies from a clean release copy using the persistent Node.js
   runtime. Test the user-local npm fallback when its bootstrap contract changes.
   Remove/rename the temporary source in isolation to prove installed dependency
   links do not point back into it.
5. In an authorized live installation, retain existing config/data, run the
   upgrade, check daemon plus Bridge health, and verify real Feishu request/result
   and same-task continuation. Keep missing human steps explicit.

## Merge and publish

1. Commit explicit paths on the existing release branch and update its PR with
   the final scope and evidence. Wait for the latest head's applicable CI checks.
2. Complete required review and merge only with the user's authorization. Do not
   enable automatic merge or change branch protection to bypass a failed gate.
3. Read back the merged PR and exact merge commit. Create the version tag at that
   commit, never at an unreviewed working tree or an unrelated latest `main`.
4. From that exact commit, run `npm run export:bundle`. Verify the ZIP SHA-256,
   every manifest entry, and absence of local config, credentials, state, logs,
   and private paths. The bundle deliberately excludes dependencies.
5. Create a GitHub Release with the sanitized ZIP and `.sha256`, bilingual changes,
   installation/upgrade links, verification results, and any real acceptance limits.
   Publish it as latest only after its source and assets are ready.
6. If the Homebrew formula is offered for this version, update its tag, archive
   SHA-256, and version assertion through the tap's delivery process. Until then,
   label it as a separately versioned channel rather than promising parity.

## Read back the public installation path

Resolve `releases/latest` again as a new installer would. Download its exact
source tag, compare package/lock versions, install dependencies, and verify the
CLI plus release tests. Download the published bundle independently and verify
its checksum and manifest. Check that both README installation prompts still
lead to the intended guide. Report PR merge, Release/tag, checks, and live
acceptance separately. Once the current head's CI is green, stop CI monitoring;
do not keep a timer solely to wait for a later review or merge.
