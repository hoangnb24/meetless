# Issue 13: Ask first-use correction and authentication blocker

Date: 2026-09-13. Issue: https://github.com/hoangnb24/meetless/issues/13

This record preserves the initial failure and selection-only acceptance. The
owner subsequently approved reuse of existing provider configuration through
scoped folder access; see the [follow-up validation](issue-13-provider-access-validation-2026-09-13.md)
for the accepted Codex Ask result and later corrections. The separate-login
proposal below is historical and superseded.

## Outcome and owner scope

The owner requested starting #13 with Ask on the existing transcribed recording
named Test, reporting earlier recording/Apple/audio checks satisfactory. This
run did not repeat recording, purchase, or Transcribe. The owner report is not
relabelled as a complete same-candidate journey pass.

Lead and independent reviewer ACCEPT the first-use model-selection correction.
Ask itself remains blocked: one real question reached a terminal HTTP 401
authentication failure. No answer, citation playback, or successful-chat
relaunch acceptance is claimed. #13 remains open.

## Source, producer, and consumer

- Source commit: `56e73b1` (initialize Ask workspace before model discovery).
- Accepted source SHA-256:
  `fa25aa5f33da0734ec0cacef16e23b70b152abc6fe33e7bb327e037dbfc59174`.
- Accepted test SHA-256:
  `bcd71b6be0db3f9eb92ce6d95b83deff328e6f49aa83992124b29e2782741808`.
- Original installed manifest:
  `826f9b2e31dc46f9e7722750e2f2687977dd3f4b4b8b730ba59599c230a65014`.
- Corrected installed manifest:
  `8bcfc899cec0846e9df8669a8ce079647d8b27a6348c0ca8665a5e043c5b3f99`.
- Actual producer: `npm run dev:mas:update`, exit 0, including normal build,
  signing, validation, preserving update, and installed plugin readiness.
- Actual consumer: `/Applications/Meetless.app`, its embedded Electron UI and
  installed Meetless plugin. Installed chat-service bytes match accepted source.
- Update backup: `.artifacts/macos-mas-development/update-backups/backup-TfHObg`.
  Previous whole app retained by the normal updater; no backup cleanup occurred.

## Observed defect and bounded correction

The ready Test is dated 2026-09-12 23:40 in the UI; the older Test is not ready.
On the original candidate, choosing Codex GPT-5.6-Luna returned to Choose model
and displayed a generic Ask error before any question was submitted.

The actual daemon reported ENOENT for the neutral `chat-execution` directory.
Provider feature discovery requires an existing working directory, but the
directory was only created during question execution, after selection.

The correction awaits the existing recursive 0700 directory creation before
provider discovery. It preserves the neutral workspace and existing provider,
model, citation, and credential policies. No live directory was manually created
to conceal the old-candidate failure.

## Validation

| Check | Result and evidence level |
| --- | --- |
| Fresh-directory regression before fix | Four cases failed: controls, selection, features, providers. The stub uses real filesystem stat. Local negative proof. |
| Chat-service suite after fix | 25/25 passed; includes selection persistence without opening an execution workspace. Local proof. |
| `npm run typecheck` | Passed. |
| Normal preserving MAS update | Exit 0, signature validation and `owner-test-ready`; eight meetings visible. Actual path. |
| Data preservation immediately after update | All 33 pre-existing store/audio files match baseline hashes exactly. |
| Actual model selection | GPT-5.6-Luna selected and persisted; Ask input enabled, original selection error absent. |
| Actual Ask | One user-authorized question submitted through the UI. Attempt started 10:07:01.123Z, failed 10:07:19.489Z: 18.366 seconds. API rejected missing authentication with HTTP 401. No transcript segment was retrieved. |
| Failure feedback/navigation | Question and Retry remained visible; switching to the older Test showed no question, returning restored the failed question. Same-process navigation only. |
| Original data after Ask/navigation | Existing meeting/recording/transcript/consent rows and audio hashes unchanged. Store changes are the new chat selection/thread. |
| Answer/citation/audio/relaunch | Not reached; no success claimed. |

The writer's original red/green/typecheck outputs are retained as an explicitly
labelled summarized handoff, not manufactured raw logs. The real pre-fix UI and
daemon failure plus post-fix actual UI establish the bounded product proof.

## Remaining authentication boundary

The real Codex turn started and its API request was rejected; this is not an
unknown in-flight result or a successful inference. No Retry was performed.

Read-only metadata shows the MAS runtime uses the container's home directory.
Its `.codex` contains runtime/session state but no `auth.json` or `config.toml`.
The ordinary user Codex home has ChatGPT authentication metadata. Credential
values were not emitted or copied. No evidence establishes a Keychain defect.

Paseo delegates authentication to providers. The relevant Meetless product,
runtime, and app material does not establish a verified MAS provider sign-in or
credential-bridging route. An ordinary shell login would not by itself prove
authentication inside this separate app environment.

Proposed next work, pending owner product decision: add a provider-owned Codex
sign-in route for Meetless's isolated environment, with a clear sign-in state
and recovery, then explicitly retry the retained Test question. Do not present
this proposal as existing functionality or silently copy ordinary Codex tokens.
No login, account change, backend deployment, or new provider retry was performed.

## Evidence and acceptance

Local evidence root: `.artifacts/issue13/ask-live/`.

- `baseline.json`, `post-update.json`, `before-ask.json`,
  `first-ask-failed.json`, `after-navigation.json`: hashes and state comparisons.
- `update.log`, `accepted-source.patch`, `source-acceptance.json`,
  `actual-selection-acceptance.json`: producer/source/acceptance binding.
- `model-selection-failed-ui.*`, `model-selection-passed-ui.*`,
  `first-ask-failed-ui.*`, `other-meeting-ui.txt`, `returned-test-ui.txt`:
  actual UI observations. UI/store snapshots stay local.
- `source-proof/validation-handoff.md`: original source-check result summary.
- `source-proof/ask-auth-failure.json`,
  `source-proof/auth-boundary-handoff.md`: allowlisted failure/auth diagnosis.

Independent reviewer `ask_review` and Lead `root` ACCEPT the exact source and
actual first-use selection correction on the corrected manifest. They agree
the Ask success path is blocked by authentication and the navigation proof does
not establish relaunch durability. No broader #13 or release acceptance.
