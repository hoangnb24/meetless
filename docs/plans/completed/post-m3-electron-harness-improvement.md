# Harness Improvement: Correlated Electron Recording Proof

Date: 2026-08-20

## Status

Completed

## Representative Job

Complete the bounded post-M3 recording correction without owner-operated UI by
adding repository-native automation for capabilities 1, 3, 4, and 5 in the
2026-08-20 project-owner directive. The fixed worker starts from repository
revision `c4a4640`, uses the accepted M1-M3 authority in
[`v1-paseo-foundation.md`](../active/v1-paseo-foundation.md), preserves
`com.meetless.app` as the sole production host/TCC authority, excludes
XCUITest, keeps M4 closed, does not push, and stops rather than claiming a
physical or live-source result from fixture, DevTools, or accessibility events.

## Baseline

The post-M3 episode produced repeated false-positive readiness handbacks before
the owner could start a recording:

- automation first inspected the unrelated `com.themrb.meetless` SwiftUI app
  instead of the accepted host-managed Electron renderer;
- later AX/set-value and keyboard preflights reported the title and Start
  controls usable while bypassing the physical pointer path;
- the recording strip overlapped Electron's hidden title-bar hit-test region,
  so the owner-visible control still did not receive ordinary pointer input;
- the pointer correction proved renderer delivery with title input and a
  non-invoking right-click, but did not produce a fresh recording;
- Computer Use then timed out attaching to the exact repo-owned Electron window
  by both display name and bundle path, even after one clean accepted-host
  restart, and correctly refused to issue an unobserved Start click.

The owner intervened repeatedly to reject superseded click handbacks, identify
the two concurrent app identities, reproduce the visible zero-media error and
non-interactive control, supply Computer Use evidence, and finally authorize a
repository capability instead of more physical owner actions. Existing
automated proof covers zero-valid-media failure, valid-chunk recovery, startup
settlement ordering, Electron focus ordering, and title-bar geometry, but no
single harness correlates renderer interaction through capture, MP3, and M3
transcription.

## Earliest Gap

The earliest missing capability was a stable, repository-owned way to identify
and automate the tested Electron renderer while correlating its state with the
authoritative recording lifecycle. Visibility, AX exposure, focus, and a
successful dispatched event were treated as separate proxies, so no one proof
could fail at the first missing UI/runtime/media/transcription correlation.

## Correct Owner

`repository-harness` in this consumer repository owns the correction. Product
lifecycle remains owned by the existing MeetingStore/recording/transcription
boundaries; macOS TCC remains owned only by the accepted
`com.meetless.app` host; physical WindowServer and private live-source
availability remain external environment boundaries.

## Intervention

Add the smallest repository-native Playwright Electron capability that:

- launches a controlled, uniquely identifiable Meetless Electron test app and
  documents Playwright Electron's experimental support;
- forces Chromium/Electron accessibility only in authenticated UI-test mode,
  with stable control names, while production launch fails closed against that
  leakage;
- drives title, Start, and Stop and records visible state/errors plus bounded
  screenshots/traces;
- correlates one recording and meeting identity across renderer state,
  authoritative socket/store state, helper/chunks, finalized MP3, and the
  existing M3 transcription handoff;
- emits an actionable stage-specific diagnostic for every missing correlation;
  and
- labels deterministic fixture/DevTools evidence separately from unverified
  physical-click, TCC, and live-source claims.

The owning project directive and the M1-M3 plan are the policy authority. The
intervention must be removed or revised if it creates another production/TCC
permission owner, enables accessibility outside controlled UI-test mode, or
requires maintaining a second recording/transcription policy path.

## Implementation Candidate (superseded)

`POST-M3-E2E-IMPL` (2026-08-20, base candidate
`83b981bd6a02e6155269dc4849f7e69a89e2984b`) adds the repository-native capability in the
accepted owner scope. The candidate keeps `com.meetless.app/MeetlessHost` as
the only production host and uses the logical tested identity
`com.meetless.desktop` plus the exact accepted host path/CDHash, PID ancestry,
runtime instance ID, and fresh run ID. A consumed one-shot envelope under the
runtime root controls CDP, renderer markers, fixture/provider mode, and the
optional forced accessibility path; invalid or missing envelopes remain
production mode, and production does not enable accessibility.

The integrated proof launches the accepted host through LaunchServices and
attaches Playwright to its run-scoped renderer CDP endpoint. The deterministic
fake-provider proof correlates renderer title/Start/Stop, recording socket
`recording`/`saved`/post-stop `idle`, MeetingStore identifiers, helper PID and
argv, microphone/system chunk identities, MP3 identity, and a ready fixture
transcript. The separate `_electron.launch()` smoke is explicitly
experimental and renderer-only. No result claims a physical click, TCC grant,
or live Zoom/Meet source. M4 remains closed.

## Base Candidate Validation (historical, superseded)

The candidate's local evidence includes allowed and recoverable forbidden cases
for generic Electron identity, invalid/missing envelope, production
accessibility leakage, every correlation stage, and the accepted title-bar
geometry. `npm run proof:post-m3:smoke` passes as experimental renderer-only
support. The deterministic integrated proof passes with generated fixture
labels. The native attempt reports the current accepted host capability as
invalid with `status: incomplete` and exits nonzero without fake substitution;
the combined proof is also non-passing when native acceptance is incomplete.
Local command enforcement is
present; no hook, CI workflow/provider, external permission, or branch-
protection change is authorized.

Observed validation: `npm run test:post-m3` passed 29 tests;
`npm run validate:isolation` passed 46 tests; `npm run test:composition` passed
1 test; `npm run test:focused` passed 194 tests; and `npm run typecheck` passed.
The package-level `npm run proof:post-m3` passed its deterministic fake result
and reported native `invalid` as `native-provider-unavailable` with
`noFakeSubstitution: true`.

## Revision 1 Candidate

`POST-M3-E2E-IMPL-R1` keeps the base boundary and corrects only the accepted POC
review blockers: a consumed marker is bound to the current host/desktop PID
start instances and removed on owned shutdown; the runtime root and envelope/
marker enforce same-UID `0700`/`0600` regular-file controls; identity validation
uses the actual installed-host authority, exact host-to-desktop-to-Electron
ancestry, trusted bridge status, and socket `runtime.uiTest`; native-incomplete
results are non-passing; and cleanup failures are manifest-visible with a
preserved-state diagnostic. M4 remains closed.

Observed R1 validation:

- `npm run test:post-m3`: 5 files, 37 tests passed.
- `npm run validate:isolation`: 8 files, 54 tests passed.
- `npm run test:composition`: 1 test passed; `npm run typecheck` passed.
- `npm run proof:post-m3:smoke`: passed as experimental renderer-only evidence.
- `npm run proof:post-m3:fake`: passed with generated-fixture labels and cleanup
  status `passed` (`stagedRootRemoved`, `originalRootRestored`, and
  `runStateRemoved` true).
- `npm run proof:post-m3:native`: exited 1 with native status `incomplete`,
  label `native-provider-signed-host-capability`, evidence class
  `native-provider-unavailable`, and `noFakeSubstitution: true`.
- `npm run proof:post-m3`: exited 1 with fake `passed` plus native `incomplete`;
  its aggregate cleanup status was `passed` and the original runtime root was
  restored.

## Fresh Rerun

A materially equivalent fresh agent started from clean candidate
`1cbba679f35b0fcc7117305dc0ea3c8197d9139c`, discovered the capability through
`docs/WORKFLOW.md`, `docs/README.md`, this runbook, this Harness record, the V1
plan, and package scripts, then exercised it without owner intervention or
retries.

- `proof:post-m3:smoke` passed and retained its experimental renderer-only
  labels: recording, TCC, physical-click, and live-source claims were false.
- `proof:post-m3:fake` passed the correlated UI -> socket/store -> fixture
  helper -> microphone/system WAV chunks -> finalized MP3 -> ready fixture
  transcript chain. The 5,589-byte MP3 had SHA-256
  `217912dbe5ba083f0dd4641bde079cb82db4fd6bb10982c8d4775c0b5aee333b`.
- `proof:post-m3:native` exited 1 with `status: incomplete`, evidence class
  `native-provider-unavailable`, and `noFakeSubstitution: true`.
- `test:post-m3` passed 5 files and 37 tests.
- Cleanup removed the envelope/marker and owned processes and restored the
  original runtime root byte-for-byte; its digest before and after was
  `a95ee44af4e0f2b77a30458511cf1d1b5f902c743b37ce2206f1fe6a63f2fb69`.

The rerun retrieved and used the intervention, improved the deterministic
repository-wiring outcome, and needed no owner UI action. It did not establish
a physical WindowServer click, TCC permission, native provider handoff, or live
Zoom/Meet source.

## Decision

Keep. Lead accepts `1cbba679f35b0fcc7117305dc0ea3c8197d9139c` as the bounded
POC implementation for capabilities 1, 3, 4, and 5. The fresh rerun discovered
and exercised the intervention with the same positive result and truthful
negative native result. The intervention remains useful because it replaces
ambiguous app/window preflights with one identity-bound, stage-correlated proof.

## Result

Harness improvement completed and retained. The deterministic repository
capability is accepted at POC level. The broader post-M3 gate is not closed:
native signed-host capability, physical/TCC evidence, and a fresh live-source
recording into the accepted M3 path remain unproved. M4 remains closed.
