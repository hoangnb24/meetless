# Issue 12 retention and cleanup validation — 2026-09-13

Bounded retention and GUI Delete are accepted. The hosted attempt failed with
uncertain completion; full issue #12 remains OPEN.

## Accepted policy and revisions

- Policy `d41d6d55bae89652e55d2011bf5e1f74fb4461f7`: every retained recording
  keeps local MP3 and canonical WAV, including after successful transcription.
  Delete them with the user's recording/meeting deletion, not on local expiry.
- Backend temporary-data TTL remains 24 hours. Explicit Transcribe, one logical
  job, idempotent billing, and existing retry semantics remain unchanged.
- Account-owned cleanup: `eaf7844cf808c3cb24100e7e6b23dba9868f1045`.
- Local canonical retention: `560b408862535686c9eb6711b145fc766c03c9b6`.
- Idle saved meeting Delete UI: `61b0a8381b2185958220481ab4e94f66e6195347`.
- Source acceptance is distinct from deployed identity and observed app behavior.

## Source and local evidence accepted

Retention uses V3 receipts without expiry, validates V2 migration before atomic
replacement, preserves retained recordings even with damaged metadata, and
uses trusted recording IDs for deletion. Symlink paths fail closed.

- `.artifacts/retention/HANDOFF.md`, `identity.json`, `task-only.patch`, and
  `lead-acceptance.json` bind the candidate and source/local acceptance.
- Combined evidence covers 85 tests. The initial frozen run had 84 passes and
  one existing completed-recovery assertion failure. After its separately
  recorded correction, affected suites passed 29/29; the dedicated retention
  suite passed 9/9. This was not a new single 85-test run after all corrections.
- Plugin TypeScript build passed. Actual pinned Paseo compiler produced bundles
  and rejected a deliberately invalid entry; hashes and dependency graph remain
  in `.artifacts/retention/pinned-compiler.json` and adjacent compiler artifacts.
- `negative-before-v3.log` retains three intended pre-change failures: expired
  retained WAV missing, corrupt retained directory swept, and deletion blocked
  by corrupt metadata. Earlier failed runs remain recorded in the handoff.
- These tests use real filesystem/store/finalizer/service paths with controlled
  inputs and provider/upload doubles; they do not establish hosted behavior.

Account-owned cleanup skips absent uploads, reconciles only the stored account,
then refreshes state before existing cleanup logic.

- `.artifacts/issue12/cleanup-scope/proof.md`, `manifest.json`, and
  `lead-acceptance.json` bind this source/local acceptance.
- Focused action/quota-cleanup suites passed 30 tests; Convex typecheck passed.
  The isolated baseline produced three intended failures and four passes.
- Actual handlers used synthetic DB/storage/scheduler. Hosted scheduling,
  concurrency control, and production cleanup behavior are not proven here.

The UI correction removes the broad meeting-processing Delete guard while
preserving capture/finalization/transcription/Ask/loading/pending protections.

- `.artifacts/ui-delete/HANDOFF.md`, `identity.json`, and `lead-acceptance.json`
  bind source/local and Expo-export acceptance; 56 App tests and types passed.
- Two new baseline negative cases failed because Delete remained disabled.
- Actual Expo/Metro package export passed (`candidate-export-v2.log`,
  `export-identity.json`). The first export failed on omitted submodule content;
  supplying the exact pinned Paseo gitlink resolved it without source workaround.
- Tests mock client/presentation boundaries; accepted signed GUI proof is below.

## Accepted development deployment identity

Target: `dev:frugal-mandrill-646`. One guarded native deployment exited 0 and
reported ready at `2026-09-13T08:15:48.585Z`; separate verification exited 0 at
`2026-09-13T08:15:56.619Z`. All 33 module path/hash/environment entries matched
the prepared immutable eaf source candidate. Metadata matched: nodeVersion null,
udfServerVersion 1.45.0, nodeDependencies absent.

Evidence: `.artifacts/issue12/backend-deploy/EXECUTION.md`, `execution.json`,
`execution-binding.json`, `candidate-module-diff.json`,
`post-deploy-verification.json`, and `lead-acceptance.json`.

Preparation binding SHA256:
`b989602e6476ceada4c2a9afd15f09c1f64ccb208d27f97a5ffa5bd5b0677691`.

Acceptance covers deployment identity only, not hosted quota/cleanup behavior.

## Accepted first signed MAS retention run

Producer: HEAD `560b408862535686c9eb6711b145fc766c03c9b6` plus captured dirty
inputs; source snapshot SHA256
`2f5a85088be3d94013888a2600134bf84046ec0e0fc131ed7adf56a68dd9c167`.
Candidate manifest SHA256
`d6988a77f485c0b5a1a4faf2c6c026315795a75ad7897fd6bfc3c7bbba1dd923`;
signed cdHash `cc215bb0c4d8c5b5182ea8b22ab5673132ad79bf`.

`.artifacts/issue12/retention-live/HANDOFF.md`, `candidate-manifest.json`,
`installed-inputs.json`, and `lead-acceptance.json` bind bounded runtime acceptance.
The preserving update and strict installed signature verification passed.
Eight old MP3s, seven old WAVs, and old logical data remained unchanged; seven
valid receipts migrated V2 to V3. One old missing WAV remained missing.
Actual UI Record/Stop created new MP3/WAV, both unchanged after actual quit and
supported relaunch. Installed client/server Delete removed only that owned
meeting, its recording, both audio files, and managed directory.
No Transcribe, provider, purchase, or owner-account changes occurred in this run.

GUI Delete was disabled in this first run; its API deletion is not GUI proof.

## Accepted second signed MAS GUI Delete run

Source `61b0a8381b2185958220481ab4e94f66e6195347`; candidate manifest SHA256
`826f9b2e31dc46f9e7722750e2f2687977dd3f4b4b8b730ba59599c230a65014`;
cdHash `be605bb408ba23497247577eeb7624b2146f24d5`.
`.artifacts/issue12/delete-ui-live/HANDOFF.md`, `candidate-manifest.json`,
`installed-inputs.json`, and `lead-acceptance.json` bind accepted GUI evidence.
The full preserving update and strict installed signature verification passed;
30 shipped files matched generated, packaged, and installed bytes.

Actual GUI: saved untranscribed Delete enabled → named confirmation → Cancel
preserved all data → Confirm deleted only the owned meeting, MP3/WAV/directory
and automatically cleared selection. No API substitute or manual reset was used.

Eight old meetings, eight MP3s, seven WAVs, metadata, transcript, and consent
remained unchanged. This corrects the GUI finding while preserving run 1 history.

## Hosted attempt failed; dependent execution stopped

Under `.artifacts/issue12/hosted-prep/`, the first three read-only probes failed;
the fourth produced an accepted identity snapshot using 10 reads and no mutations.
One authorized narrow fixture attempt then failed after empty `deleteDocuments[]`
succeeded. Challenge-creation HTTP failure was classified as uncertain completion:
14 adapter requests, no returned challenge ID, upload session, or quota denial.
Immediate and later separate complete read-only audits each observed zero rows;
these observations do not establish quiescence or settlement of the failed request.
No retry, cleanup mutation, audio upload, or provider call followed.

Evidence within that directory:

- `runs/e8b0009f-bcf9-463f-b783-315a6b552332/journal.json`, SHA256
  `c17f54b4b8bdd02336942e589933fd698beb462cb8a2706fcf7a7214e48d1a56`.
- `fixture-attempt-1-result.json`, SHA256
  `d018c94f0c41c34dd2c4801b41f848236ed7147f547064efaea94dd0ddd115e9`.
- `uncertain-run-presence-audit-1.json`, SHA256
  `7c927734583e19b43e2ea46c7861a13ed13bd3bcaffe1937da709f38582ea72d`.

Lead stopped dependent hosted execution because retained evidence cannot establish
original request settlement. A local typed-transport/status-capture candidate is
prepared with 33 passing local tests, but is not independently accepted or remotely
executed. It does not authorize or prove a new hosted run.

## Remaining limits

- Actual elapsed-24h and post-provider-success retention were not observed.
- Previously missing WAV is not restored; capture fidelity is not accepted.
- Hosted quota behavior and actual signed quota-denial UI remain unproven; #12 OPEN.
- No CI, optional hook, or branch-protection enforcement is claimed.
