# Issue #30: Capture permission recovery

Date: 2026-09-15

## Status

Active. Source repair and independent review in progress; Apple runtime recovery
and next-candidate acceptance remain separate gates. Epic #21 remains open.

## Outcome and authority

Restore recording after real macOS authorization, without repeated prompts,
false grants, premature meeting/helper creation, or lost media. Authority:
[recording](../../product/recording.md), [ADR0004](../../decisions/0004-recording-host-and-capture-permission-boundary.md),
[production evidence](../../patterns/production-evidence.md), and issue #30.
This task owns permission recovery; #31 owns branding in a separate worktree.

## Observed baseline

- Installed Apple TestFlight 1.0 (3), source
  `7e958c3d7586029fa77347e987e0e380b980f563`, build UUID
  `401bf672-c396-4ae0-8bb7-1ca1632e037d`, `/Applications/Meetless.app`.
- On September 15 around 17:03–17:05 +07, System Settings showed Meetless ON
  under Screen & System Audio Recording. The installed runtime's read-only
  `/__meetless/capture-permissions` response returned microphone authorized,
  systemAudio denied. UI showed audio saved locally; no capture helper ran.
- Correlated tccd messages at 16:42:43 and 16:45:41 +07 explicitly report
  `Failed to match existing code requirement` for `com.meetless.app` and
  `kTCCServiceScreenCapture`: stored Apple Development requirement versus
  current TestFlight requirement. Both check and request are from PID 2601,
  `/Applications/Meetless.app/Contents/MacOS/MeetlessHost`. This establishes a
  signing-grant mismatch on this installation, not a second helper TCC owner.
- Source confirms status/request in MeetlessHost and SCStream capture in the
  helper, behind both authorization gates. No capture was reached in this run.
- Attempts to open recording setup through Computer Use did not change the
  renderer; host accessibility inspection timed out. No new permission dialog
  or relaunch requirement was observed. Do not infer their wording or outcome.
- Private evidence is retained in this worktree's ignored `.artifacts/issue-30/`
  (`tcc-provenance.log`, `installed-permissions.json`, `installed-signature.txt`).
  Earlier accepted artifact provenance remains in the original checkout's
  `.artifacts/app-store-upload/20260915-build3/runtime-acceptance/`.

## Repair and limits

- Stop repeating a ScreenCapture request once attempted; always use a fresh OS
  preflight to establish authorization. A successful request return is not a grant.
- Guide Settings recovery without claiming the visible toggle is OFF. Explain
  earlier-install access and conditional OS-requested quit/reopen.
- Recheck when the desktop window regains focus as well as AppState activation;
  React Native Web visibility can remain active while Settings is foreground.
- Independent review found overlapping reads could let an older response
  overwrite a newer grant or revocation. A controlled reversed-response test
  failed against `0aa3070` (older denied replaced newer authorized). Sequence
  ownership now allows only the latest initiated read to update displayed
  status/errors. Tests cover older denied, authorized and transport failure.
- Preserve host ownership, renderer intent validation, capture gates, local
  media, bundle identifiers, signing policy and entitlements.
- This patch cannot rewrite a stale OS grant. Actual recovery must be measured
  separately; unit evidence does not close #30 or establish Apple acceptance.

## Recovery proposal requiring owner authorization

First preserve evidence and recheck no recording, finalization, transcription or
other user task is active. For **Meetless only**, turn its Screen & System Audio
Recording switch OFF then ON in System Settings. Observe the exact OS dialog;
if macOS requests quit/reopen, use ordinary quit and reopen the canonical app
only after a fresh stopped-work check. Recheck the host API before recording.
If it remains denied, stop and reassess; do not silently escalate to removing
entries, tccutil reset, data reset, changing identities or replacing the app.
Once authorized, capture/stop only a fictional sample and verify saved local
audio plus preservation of existing files, with no transcription/upload.
Fresh-state acceptance still needs an explicitly authorized clean environment.

## Validation and handoff

- [x] Native focused injected-OS tests: not determined, denied, request-result
  false positive, repeated request/relaunch, Settings grant and revocation.
- [x] Renderer focus/grant/revocation and permission guidance regressions:
  four focused suites, 84 tests passed (recording provider, surface, renderer
  permission boundary, production-host response validation).
- [x] `npm run typecheck` passed. Three recording-service permission/gating
  cases passed (26 unrelated cases skipped): no premature session/helper,
  zero-media rollback, permission denial then successful fixture retry.
- [x] After the sequencing repair, all 15 recording-provider tests and typecheck
  passed. The targeted regression fails against the prior source and passes
  with the fix (`ordered-response-before-fix.log`, `ordered-response-tests.log`).
- [ ] Independent review of exact source commit.
- [ ] Owner-authorized installed recovery and fictional recording proof.
- [ ] Combined #30/#31 candidate, signed/TestFlight runtime proof and Lead acceptance.

Initial JS test invocation lacked generated workspace outputs (65 surface tests
passed; two suites could not load). Typecheck exposed an uninitialized Paseo
submodule in the fresh worktree. The remote did not contain the pinned Paseo
commit; fetched that exact commit from the original local checkout (no ref or
source changes), rebuilt, then reran successfully. Native tests use injected OS
responses; recording-service cases use synthetic local media. These are local
confidence only. No CI run or branch-protection enforcement was verified.
No installed app replacement, TCC mutation, new real recording,
cloud upload, force quit, or backup changes have been performed.
