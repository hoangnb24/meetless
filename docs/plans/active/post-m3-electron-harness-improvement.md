# Harness Improvement: Correlated Electron Recording Proof

Date: 2026-08-20

## Status

Active

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

## Native Validation

Pending implementation. Required evidence includes allowed and recoverable
forbidden cases for the unique identity, test-only accessibility, complete
correlation, and the already accepted title-bar geometry. Local command,
optional hook, checked-in CI invocation, and external branch-protection
enforcement will be reported separately; no hook, CI workflow/provider,
external permission, or branch-protection change is authorized.

## Fresh Rerun

Pending. A materially equivalent fresh agent must discover the capability from
repository guidance, invoke it from the accepted starting conditions, and
produce the correlated result without owner UI intervention. This record must
remain active or awaiting fresh rerun until that succeeds.

## Decision

Pending fresh rerun.

## Result

Pending implementation, frozen-candidate review, and the fresh-agent rerun.
M4 remains closed.
