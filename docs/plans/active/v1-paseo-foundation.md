# Execution Plan: Meetless V1 Release Readiness

## Current State

- `plan_revision`: `v3`
- `current_frontier`: `SHIPATON-MAS-PREMIUM-CORRECTION-R1`
- `state`: `STRUCTURAL_CORRECTION_READY_FOR_LEAD_ACCEPTANCE`
- `depends_on`: Apple Developer/App Store Connect and RevenueCat project access for external stages
- `candidate`: correction is based on original `main@5743c7f4283e4000a3798ac7f2a275d241e79dcc`; immutable candidate commit is recorded in the peer handoff
- `pending_ruling`: Lead acceptance of the structural correction; external MAS/RevenueCat stages remain open
- `blocked_by`: missing App Store provisioning profile, RevenueCat project configuration, and external store gates; M7-F29 remains separately owner-held
- `next_action`: Lead review of the immutable correction candidate, followed by separately authorized external MAS/RevenueCat work

## Ownership And Authority

Date: 2026-08-30

- Owner: `v1-paseo-foundation` owns residual M7, paused `M7-F29-NOTARIZE-STAPLE-VERIFY`, and TCC R3.
- Owned scope: residual M7 release gates; paused M7-F29; TCC R3 candidate acceptance.
- Authority: ADR0001, ADR0003, ADR0004, ADR0005, product monetization policy, and the macOS artifact-validation specification where its non-DMG mechanics still apply.

## Outcome

Keep one compact execution record for the remaining Meetless V1 release work.
The accepted M0–M6, design, package, signing-preparation, and recording-start
history is completed evidence; this plan tracks only the live frontiers listed
in `Current State`.

The owner changed the release path on 2026-08-30 from direct DMG to the Mac App
Store for RevenueCat Shipaton 2026. This plan also owns the store sandbox,
RevenueCat Premium, App Store Connect submission, and launch-evidence frontier.

## Ownership And Boundaries

- Residual M7 owns the remaining release, legal, target, and distribution gates.
- `SHIPATON-MAS-REVENUECAT` supersedes the direct-DMG distribution frontier but
  does not erase its historical proof. It owns sandbox packaging, purchase
  policy, App Store Connect readiness, submission, and launch evidence.
- `M7-F29-NOTARIZE-STAPLE-VERIFY` remains paused under its separate owner hold;
  no notarization, stapling, upload, publication, or credential inspection is
  authorized by this reconciliation.
- `TCC-V1-CORRECTION-R3-ACCEPTANCE` owns only candidate rebind and Lead ruling.
  Its implementation candidate preserves the accepted permission and rollback
  behavior while adding renderer intent binding and recoverable app/surface
  failure handling.
- The R1 correction changes host artifact ownership/linking, authorization-state
  lock lifetime, MAS entitlement validation, and Premium chat composition. It
  does not change the immutable M3 evidence manifest or claim any external store
  stage complete.

## Stable Authority

- [ADR0001 — maintained Paseo fork and pin](../../decisions/0001-maintained-paseo-fork.md)
  owns Paseo provenance and the exact dependency revision.
- [ADR0002 — direct notarized macOS DMG](../../decisions/0002-direct-notarized-macos-dmg.md)
  is superseded distribution history; its retained artifacts remain direct-DMG
  evidence only.
- [ADR0003 — runtime isolation and host ownership](../../decisions/0003-meetless-runtime-isolation-and-host-ownership.md)
  owns runtime topology, app boundary, companion transport, renderer endpoint,
  readiness, and shutdown.
- [ADR0004 — recording host and capture permission boundary](../../decisions/0004-recording-host-and-capture-permission-boundary.md)
  owns the recording host/helper and microphone/system-audio permission boundary.
- [ADR0005 — Mac App Store and RevenueCat](../../decisions/0005-mac-app-store-and-revenuecat.md)
  owns the store distribution, sandbox, product identifiers, and Premium gate.
- [Premium product policy](../../product/monetization.md) owns user-visible free,
  paid, trial, purchase, restore, and unavailable-service behavior.
- [macOS artifact validation](../../specs/macos-artifact-validation.md) owns
  candidate, package, sign, re-sign, and validation stages.

## Live Frontier: TCC-V1-CORRECTION-R3-ACCEPTANCE

`TCC-V1-CORRECTION-R2` is superseded history and has no live owner. R3 is the
only active TCC frontier; its permission policy is now anchored by
[ADR0004](../../decisions/0004-recording-host-and-capture-permission-boundary.md).

The current candidate keeps MeetingStore bootstrap available so permission
recovery can render. It still forbids Meeting/session creation and native helper
spawn before both typed microphone and system-audio permissions are authorized.
Permission mutations require the exact packaged renderer Host/Origin and a
fresh one-use user-intent token. Invalid, replayed, foreign, or malformed
requests fail before native invocation. Status/decode/settings failures clear
checking, stay visible, and leave an actionable Recheck path; absent runtime
state is `Proposed`, while typed `notDetermined` is `Will ask`.

The candidate must be rebound to this clean-main snapshot before Lead acceptance.
No app launch, real permission request, TCC or Settings change, signing,
installation, package mutation, Keychain access, notarization, upload,
publication, or user-data deletion is part of this frontier.

## Residual M7 And Paused M7-F29

The accepted package and signing-preparation evidence remain pre-release only.
Residual M7 still includes the unresolved Human/legal inventory decisions,
supported-target limits, real clean-install permission attribution/persistence,
and release acceptance. M7-F29 retains the exact DMG and owner hold from the
archived ledger; it may resume only after the owner supplies a validated
`notarytool` profile name and explicit resume direction.

M7-F29 is no longer on the selected release path. Do not resume notarization or
stapling for Shipaton; retain it only as direct-DMG history.

## Live Frontier: SHIPATON-MAS-REVENUECAT

### Outcome

Publish Meetless's first public version through the Mac App Store during the
Shipaton window, with RevenueCat-backed monthly and annual subscriptions that
unlock meeting-scoped Ask, then retain judge-usable launch evidence.

### Progress

- [x] Select Mac App Store distribution and supersede direct DMG.
- [x] Define free features, `premium`, products, trial, and target US prices.
- [x] Add executable premium policy and UI proof.
  - Server enforcement and typed RPC/client boundary landed on 2026-08-30.
  - Proof: focused typechecks passed and 45 contract/client/plugin tests passed,
    including denial before chat persistence or agent execution.
  - Renderer proof: localized package prices, eligible-trial copy, purchase,
    restore, dismissal, and draft preservation passed in the surface suite.
- [x] Add the native RevenueCat/StoreKit adapter and authenticated renderer boundary.
  - RevenueCat 5.87.1 is pinned by SwiftPM and the real SDK target links.
  - `npm run build:native` now produces and checks the SwiftPM-owned
    `native/macos-host/.build/release/MeetlessHost` artifact; install and package
    workflows copy this artifact and refuse a missing or fallback binary.
  - Native focused tests build through the same SwiftPM core and prove Premium
    waits do not block authorization clear/shutdown or grant access after revoke.
  - The native socket normalizes status, purchase, cancellation, restore, and
    unavailable results without exposing receipts, keys, or raw SDK errors.
- [x] Establish the structural Mac App Store sandbox baseline.
  - A distinct contract pins Electron 41.2.0 `mas` arm64, Apple Distribution,
    an App Store provisioning profile, container-owned state, and
    security-scoped external export.
  - Parent application-group and inherited-child entitlement closures are exact
    and validated by `npm run validate:macos:app-store`; positive and negative
    contract proofs passed on 2026-08-31. The Team ID/application-group input is
    build-scoped and contains no credential.
- [ ] Apply the profile-backed App Sandbox entitlement and In-App Purchase configuration.
- [ ] Replace unrestricted writable paths with container/export-safe behavior.
- [ ] Produce and validate a sandbox development build.
- [ ] Configure RevenueCat project, entitlement, offering, and products.
- [ ] Configure App Store Connect app, subscription group, products, prices, trial, and agreements.
- [ ] Prove sandbox purchase, cancellation, restore, and offline/free behavior.
- [ ] Capture icon, screenshot, demo, privacy, review, and launch evidence.
- [ ] Upload the exact build, wait for processing, and submit it to App Review.
- [ ] Record the public Mac App Store URL after approval.

### R1 Structural Correction Proof (2026-08-31)

- [x] SwiftPM is the single host build owner. `MeetlessHost` is built through
  the pinned RevenueCat 5.87.1 dependency, and build/install/package workflows
  reject an artifact without real RevenueCat symbols.
- [x] Runtime authorization revalidates leases without holding its lock across
  Premium status, purchase, or restore waits; native focused tests cover clear,
  shutdown, revocation, and stale-lease denial.
- [x] The MAS contract requires the parent application-group entitlement and the
  inherited child sandbox closure, with explicit build-time Team ID/application-
  group inputs and deterministic positive/negative validation.
- [x] Provider/control discovery does not construct the Premium transport;
  Ask and retry paths gate before persistence/execution and fail closed when
  Premium is unavailable.
- [ ] No RevenueCat project, App Store profile, signing, upload, sandbox
  purchase, App Review, or public listing evidence exists in this correction.

### Risks And Recovery

- App Sandbox may reject the current nested Electron, Node, helper, listener, or
  writable-path topology. Preserve the direct-DMG package path while developing
  a distinct MAS target; do not weaken existing validation to make MAS pass.
- Store and RevenueCat credentials are external. Keep public SDK configuration
  build-scoped; never persist private keys or issuer secrets in the repository.
- The local keychain has Apple Development and Apple Distribution identities,
  but the installed profiles inspected on 2026-08-30 are iOS-only and none
  matches macOS `com.meetless.app`; a Mac App Store profile must be created and
  installed before a certificate-backed sandbox package can be proven.
- App Review and store processing are external gates. Record exact states and
  do not claim publication before the public listing is observed.

### Validation

- Focused: Premium policy, purchase adapter, renderer boundary, and sandbox entitlement tests.
- Integration: packaged sandbox app with StoreKit/RevenueCat sandbox purchase and restore.
- Repository: typecheck, focused tests, build, and a MAS-specific package validator.
- External: App Store Connect processing, App Review submission, and public listing.

R1 repository validation observed on 2026-08-31 includes `npm run typecheck`,
the targeted Premium/MAS/composition Vitest run (18 files, 117 tests),
`npm run build:native`, SwiftPM host/test builds, and positive/negative MAS
validator runs. The broader `npm run test:focused` run remains non-green only
in baseline areas outside this correction: missing Expo vector-icons module,
three signing-fixture diagnostic expectations, one artifact-resign diagnostic
expectation, and one readiness startup deadline timeout. These are reported in
the peer handoff and are not reclassified as R1 proof. The broader composition
suite also has its existing Expo module failure and an M6 transport fixture
timeout; the focused R1 chat composition proof passes independently.

## Completed Evidence

- [M7 and TCC historical ledger](../completed/v1-paseo-foundation-m7-accepted-history.md)
  preserves the full pre-reconciliation active plan, including accepted and
  superseded candidate identities, validation, owner holds, TCC R2/R3 evidence,
  and residual release gates. It is evidence, not current authority.
- [M0–M6 and design history](../completed/v1-paseo-foundation-m0-m6.md) preserves
  the accepted product and architecture foundation.
- [post-M3 harness evidence](../completed/post-m3-electron-harness-improvement.md)
  preserves the accepted installation-only harness capability.

## Reconciliation Record

- Base snapshot: clean `main@3ab08d4f45699ee1dee49b75c6b0caf40086bdae`.
- The former 4,943-line active ledger moved to completed evidence; no evidence
  bytes were removed from that history.
- Executable references to the former active plan are replaced by stable ADR or
  specification/product authority. No semantic plan lint or new harness behavior
  is introduced. Harness doctor remains installation-only.
- `test/evidence/m3/20260819T153402Z-live/manifest.json` is immutable historical
  evidence and remains byte-identical.

## Validation

The reconciliation validation and exact changed-file list are recorded in the
peer handoff for frontier `MEETLESS-HARNESS-AUTHORITY-CORRECTION`. The live
candidate remains pending Lead rebind and ruling; this plan does not self-accept
TCC or release work.
