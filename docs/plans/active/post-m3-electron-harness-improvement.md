# Harness Improvement: Correlated Electron Recording Proof

Date: 2026-08-20

## Status

Awaiting fresh rerun

## Representative Job

Complete the bounded post-M3 recording correction without owner-operated UI by
adding repository-native automation for capabilities 1, 3, 4, and 5 in the
2026-08-20 project-owner directive. The fixed worker starts from repository
revision `c4a4640`, uses the accepted M1-M3 authority in
[`v1-paseo-foundation.md`](v1-paseo-foundation.md), preserves
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

## Implementation Candidate

`POST-M3-E2E-IMPL` (2026-08-20) adds the repository-native capability in the
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

## Native Validation

The candidate's local evidence includes allowed and recoverable forbidden cases
for generic Electron identity, invalid/missing envelope, production
accessibility leakage, every correlation stage, and the accepted title-bar
geometry. `npm run proof:post-m3:smoke` passes as experimental renderer-only
support. The deterministic integrated proof passes with generated fixture
labels. The native attempt reports the current accepted host capability as
invalid and skips without fake substitution. Local command enforcement is
present; no hook, CI workflow/provider, external permission, or branch-
protection change is authorized.

Observed validation: `npm run test:post-m3` passed 29 tests;
`npm run validate:isolation` passed 46 tests; `npm run test:composition` passed
1 test; `npm run test:focused` passed 194 tests; and `npm run typecheck` passed.
The package-level `npm run proof:post-m3` passed its deterministic fake result
and reported native `invalid` as `native-provider-unavailable` with
`noFakeSubstitution: true`.

## Fresh Rerun

Awaiting fresh rerun. A materially equivalent fresh agent must discover the
capability from repository guidance, invoke it from the accepted starting
conditions, and produce the correlated result without owner UI intervention.
The baseline above remains preserved until that rerun and Lead acceptance.

## Decision

Candidate implementation is ready for Lead review; decision remains pending the
required fresh rerun.

## Result

Implementation candidate complete and awaiting fresh-agent rerun. Candidate
commit identity is recorded in the peer disposition. M4 remains closed.
