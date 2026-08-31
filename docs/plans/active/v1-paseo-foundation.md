# Execution Plan: Meetless V1 Release Readiness

## Current State

- `plan_revision`: `v7`
- `current_frontier`: `MANAGED-TRANSCRIPTION-FAKE-BACKED-FOUNDATION-R1-CORRECTION`
- `state`: `FOUNDATION_PROOF_CORRECTION_PENDING`
- `depends_on`: the accepted managed-transcription policy in product authority and ADR0005; proof must precede production backend, UI, provider-credential, or external-store work
- `candidate`: predecessor `51ee0cd61bae184d9936e2105294465f8de16108` was rejected by Lead; the correction candidate is implemented from that correction base and remains pending Lead closeout. MAS/RevenueCat structural candidate `9f73a7199a65735219d98c2df0eff8de8a2ddcc9` remains accepted reusable evidence only
- `pending_ruling`: Lead closeout of `MANAGED-TRANSCRIPTION-FAKE-BACKED-FOUNDATION-R1-CORRECTION`
- `blocked_by`: no product-contract blocker remains; external App Store profile, RevenueCat configuration, sandbox purchase, upload, review, and publication gates remain separately open
- `next_action`: Lead closeout of the correction candidate; real Convex/AVFoundation latency, production backend rollout, provider credential use, final UI, signing, upload, and publication remain separate gates

## Ownership And Authority

Date: 2026-08-30; reconciled 2026-08-31

- Owner: `v1-paseo-foundation` owns the managed-transcription foundation contract,
  residual M7, paused `M7-F29-NOTARIZE-STAPLE-VERIFY`, and TCC R3.
- Owned scope: managed-transcription authority and entry criteria; residual M7
  release gates; paused M7-F29; TCC R3 candidate acceptance.
- Authority: ADR0001, ADR0003, ADR0004, ADR0005, product monetization policy, and the macOS artifact-validation specification where its non-DMG mechanics still apply.

## Outcome

Keep one compact execution record for the remaining Meetless V1 release work.
The accepted M0–M6, design, package, signing-preparation, and recording-start
history is completed evidence; this plan tracks only the live frontiers listed
in `Current State`.

The owner changed the release path on 2026-08-30 from direct DMG to the Mac App
Store for RevenueCat Shipaton 2026. On 2026-08-31 the owner also replaced the
initial Premium gate: Ask and user-supplied transcription remain free; Premium
funds Meetless-managed transcription. This plan owns that foundation contract,
the store sandbox, RevenueCat purchase integration, App Store Connect
submission, and launch-evidence frontier.

## Ownership And Boundaries

- Residual M7 owns the remaining release, legal, target, and distribution gates.
- `SHIPATON-MAS-REVENUECAT` supersedes the direct-DMG distribution frontier but
  does not erase its historical proof. It owns sandbox packaging, purchase
  mechanics, App Store Connect readiness, submission, and launch evidence.
- `MANAGED-TRANSCRIPTION-FAKE-BACKED-FOUNDATION` owns one bounded vertical proof
  of the accepted identity, device, quota, duration, job, cleanup, expiry, and
  local-publication contracts. It does not authorize production provider
  credentials, production backend rollout, external store mutation, or final UI.
- `M7-F29-NOTARIZE-STAPLE-VERIFY` remains paused under its separate owner hold;
  no notarization, stapling, upload, publication, or credential inspection is
  authorized by this reconciliation.
- `TCC-V1-CORRECTION-R3-ACCEPTANCE` owns only candidate rebind and Lead ruling.
  Its implementation candidate preserves the accepted permission and rollback
  behavior while adding renderer intent binding and recoverable app/surface
  failure handling.
- The accepted R1 correction changed host artifact ownership/linking,
  authorization-state lock lifetime, MAS entitlement validation, and the former
  Premium chat composition. Its build, sandbox, native purchase, and runtime
  boundary proof is reusable structural evidence. Its Ask gate is superseded
  product behavior and is not authority for the managed-transcription gate.

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
  owns store distribution, sandbox, product identifiers, purchase mechanics,
  and managed-transcription account, quota, duration, lifecycle, and expiry
  contracts.
- [Premium product policy](../../product/monetization.md) owns user-visible free,
  paid, trial, quota, device, purchase, restore, expiry, and temporary-data
  behavior.
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

## Live Frontier: MANAGED-TRANSCRIPTION-FOUNDATION-CONTRACT

### Outcome

Define the authority and smallest credible proof for Meetless-managed
transcription before implementation. The accepted direction keeps Ask,
existing transcripts, citations, provider/model controls, and user-supplied
transcription providers/API keys free. RevenueCat Premium gates only
Meetless-managed transcription, where the publisher's provider credential
remains backend-only.

Convex-first is the intended V1 backend direction. It will be evaluated as the
owner of verified subscription lineage, device credentials, atomic quota
ledger, managed jobs, and temporary uploads. It does not replace local
`MeetingStore` ownership of transcripts, citations, and meeting evidence.

The managed allowance is a backend-configured 50 hours (180,000 seconds) in
each subscription-anchored monthly period, without rollover. The seven-day
trial receives five hours (18,000 seconds). Each period snapshots its assigned
limit, so a later reduction cannot change an already-started period.

`TranscriptionProvider` remains the execution abstraction. Provider/engine
selection may change independently from payment mode; entitlement, admission,
quota reservation, and charging stay outside provider implementations.

### Progress

- [x] Select Mac App Store distribution and supersede direct DMG.
- [x] Accept the replacement product direction at Lead review boundary:
  `ACCEPT_WITH_REQUIRED_DECISIONS` on 2026-08-31.
  - Ask, existing transcripts, citations, provider/model controls, and BYOK are
    free.
  - Premium gates only Meetless-managed transcription.
  - Convex-first is the intended V1 direction, pending the foundation proof and
    contracts below.
- [x] Preserve the former Ask Premium implementation as historical candidate
  evidence only. Its product gate is superseded and must not be treated as
  current policy or copied into the managed-transcription path.
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
- [x] Decide and promote the managed-transcription product contracts into
  durable product/ADR authority.
  - Owner accepted quota, trial, device, restore, server duration, temporary
    data, job lease, expiry, refund/revocation, and free Ask/BYOK behavior on
    2026-08-31.
- [ ] Close the bounded fake-backed foundation proof defined below. The original R1 candidate was rejected; the correction candidate has locally observed evidence recorded below and is pending Lead closeout.
- [x] Reconcile the executable Ask gate so Ask is free; Premium UI remains
  deferred because final UI work is outside this frontier.
- [ ] Apply the profile-backed App Sandbox entitlement and In-App Purchase configuration.
- [ ] Replace unrestricted writable paths with container/export-safe behavior.
- [ ] Produce and validate a sandbox development build.
- [ ] Configure RevenueCat project, entitlement, offering, and products.
- [ ] Configure App Store Connect app, subscription group, products, prices, trial, and agreements.
- [ ] Prove sandbox purchase, cancellation, restore, and offline/free behavior.
- [ ] Capture icon, screenshot, demo, privacy, review, and launch evidence.
- [ ] Upload the exact build, wait for processing, and submit it to App Review.
- [ ] Record the public Mac App Store URL after approval.

### Accepted Direction And Dependency Boundaries

- The backend derives the stable billing/quota account from server-verified App
  Store subscription lineage. RevenueCat App User ID, client entitlement state,
  and client-selected subscriber IDs are lookup data, not authorization proof.
- Each installation receives revocable device credentials. Enrollment, StoreKit
  transaction exchange, refresh credentials, and device private-key material
  remain trusted-native-host and Keychain scoped; the renderer sees typed state
  only.
- Restore Purchases binds a new installation to the existing verified
  subscription and shared quota account without resetting quota or automatically
  revoking another Mac. At most three Macs may remain enrolled.
- Short-lived access credentials authorize managed backend requests. A
  longer-lived, rotatable device/refresh credential remains in Keychain.
- macOS prepares bounded AVFoundation audio chunks before upload. Backend engine
  adapters may change without changing the client-facing managed provider or
  free BYOK path.
- Audio and provider output are temporary backend data. The durable transcript
  remains local unless separately authorized.
- Family Sharing remains disabled for V1.

### Accepted Owner Contract (2026-08-31)

- Monthly and annual products receive 180,000 seconds in each
  subscription-anchored monthly period without rollover; the seven-day trial
  receives 18,000 seconds. Restore and product changes do not reset a period,
  and limit changes apply only to the next period.
- One verified subscription account may enroll three Macs. Restore binds a new
  Mac to the same account and quota without automatically revoking an old Mac.
- The server derives billable duration from validated sample count on one 16
  kHz mono PCM WAV timeline; client and provider duration claims are not
  authority, and overlapping microphone/system sources are not double charged.
- Temporary audio, orphan uploads, provider results, and transcripts in transit
  have a 24-hour TTL. Jobs have a six-hour lease, and acknowledged local
  publication triggers earlier result deletion.
- A validly admitted job may finish after natural expiry within its lease;
  verified grace remains active, while refund or revocation stops work when
  observed. Ask and BYOK remain free; only managed transcription requires
  Premium.

### Foundation Proof Acceptance Boundary

The authorized next implementation frontier is one bounded fake-backed
vertical proof. It must demonstrate:

1. a verified subscription lineage enrolls a device key; App User ID-only or a
   client-selected subscriber ID fails authorization; restore binds a second
   installation to the same quota account; and a credential can be revoked;
2. one managed job uses an immutable recording/canonical-timeline manifest and
   collision-resistant content identity: retries are idempotent, distinct
   recordings with identical bytes remain distinct, overlapping source ranges
   cannot be charged independently, and post-lease work requires active quota,
   a fresh admission, and a fresh lease with exactly one settlement;
3. the chosen duration authority rejects a false client duration;
4. temporary uploads/results are cleaned after success, failure, cancellation,
   expiry, and orphan recovery without persisting a transcript as durable
   backend meeting data;
5. provider completion, settlement ambiguity, checkpoint recovery, and
   publication are reconciled through the existing local transcript/citation
   lifecycle while the shared meeting lifecycle lease protects deletion;
   BYOK bypasses Premium/quota and Ask remains free; and
6. [future integration gate] real AVFoundation chunks satisfy the selected
   Convex upload/action limits, target-market latency is measured against
   available regions, and action retry/concurrency behavior is explicit rather
   than assumed.

The first five criteria authorize and define the bounded fake-backed proof. The
future integration gate is not executable in R1 because no production Convex
deployment or selected upload/region contract exists. Production
backend/provider credentials, external store changes, and final UI remain
outside this scope.

### R1 Fake-Backed Proof Disposition (2026-08-31; superseded)

Lead rejected predecessor candidate `51ee0cd61bae184d9936e2105294465f8de16108`
for the frozen MTF-001 through MTF-008 finding set. Its proof claims are
historical context only and are not acceptance evidence. The correction
candidate below supersedes this disposition and remains pending Lead closeout.

### R1 Correction Batch Disposition (2026-08-31; pending Lead closeout)

The correction candidate is built from `51ee0cd61bae184d9936e2105294465f8de16108`
and preserves original base `64cf07d71bf82c798f8c3db417ada7d3c14ad7b5`. Local
tests observe the following code/test evidence; this plan does not mark any of
it accepted until Lead closes the correction frontier:

- `MTF-001`: `ManagedTranscriptionPolicy.reserve` reconciles expired leases
  before identity lookup; `reAdmit` requires active/grace entitlement, current
  quota, and creates a new admission/lease. Policy test covers stale-admission
  rejection, fresh completion, and one ledger charge.
- `MTF-002`: `ManagedTimelineEvidence`, SHA-256 edge identities, immutable
  recording/audio keys, manifest/content conflict checks, and overlapping-window
  rejection live in the policy and `RecordingManagedTimelinePreparer`. Policy
  tests cover false rebinding, identical bytes across distinct recordings, and
  overlapping microphone/system timelines; adapter tests cover tampered MP3 and
  inventory bytes.
- `MTF-003`: `ManagedTranscriptionService.publishResult` reconciles MeetingStore
  publications and publishes a pending transcript whose ranges are all already
  checkpointed. The adapter test proves no provider re-call.
- `MTF-004`: the managed service requires and holds the existing shared
  `MeetingLifecycleCoordinator` transcription lease through provider, settle,
  and MeetingStore publication. The blocked-provider test proves deletion is
  refused until release.
- `MTF-005`: provider status errors and non-configured status fail the job and
  release quota before provider execution; the adapter test proves the failed
  state and zero reservation.
- `MTF-006`: `RecordingManagedTimelinePreparer` validates the real inventory
  chunk shape, mixes overlapping source chunks into a temporary canonical
  16 kHz mono PCM WAV, and leaves the durable MeetingStore output as MP3. The
  adapter and composition tests prove the edge mapping and cleanup.
- `MTF-007`: `ManagedAllowanceConfiguration` is snapshotted into each period;
  later configuration affects only periods created afterward. The policy test
  proves reduction, next-period allowance, and exhaustion.
- `MTF-008`: `ManagedTranscriptionPolicy.snapshot` and `fromSnapshot` provide
  the fake durable-state/rehydration boundary. The adapter crash test rebuilds
  a new policy/service after provider completion, publishes locally without a
  provider re-call, and proves one charge; the policy test repeats settlement.

The correction candidate makes no Convex latency, regional placement,
production action retry, provider-credential, external purchase mutation,
signing, upload, or publication claim.

Correction candidate architectural decisions:

- `packages/managed-transcription-foundation` is the one policy owner for
  verified lineage, revocable device credentials, snapshotted quota periods,
  reservation/settlement, jobs, admissions, and temporary artifacts. Its fake
  snapshot boundary uses ordinary data only; it has no Node, storage,
  transport, UI, RevenueCat, Convex, StoreKit, or provider dependency.
- `packages/meetless-plugin/src/managed-transcription.ts` is an edge adapter:
  it verifies saved MP3 and inventory/chunk identities, prepares the temporary
  canonical timeline, calls the existing `TranscriptionProvider`, and publishes
  only through `MeetingStore`. Provider completion is recorded before the
  injected crash point; settlement and local publication are independently
  recoverable after snapshot rehydration.
- Ask no longer receives a Premium gate; managed transcription remains the only
  Premium/quota path. The final Premium UI and production runtime wiring remain
  outside this correction frontier.

### Accepted Reusable R1 Structural Evidence (2026-08-31)

- [x] SwiftPM is the single host build owner. `MeetlessHost` is built through
  the pinned RevenueCat 5.87.1 dependency, and build/install/package workflows
  reject an artifact without real RevenueCat symbols.
- [x] Runtime authorization revalidates leases without holding its lock across
  Premium status, purchase, or restore waits; native focused tests cover clear,
  shutdown, revocation, and stale-lease denial.
- [x] The MAS contract requires the parent application-group entitlement and the
  inherited child sandbox closure, with explicit build-time Team ID/application-
  group inputs and deterministic positive/negative validation.
- [x] Provider/control discovery does not construct the Premium transport. The
  former Ask/retry Premium gate was proven on the candidate, but that behavior
  is now superseded by the free Ask path and is retained only as historical
  evidence that admission can occur before persistence/execution.
- [ ] No RevenueCat project, App Store profile, signing, upload, sandbox
  purchase, App Review, or public listing evidence exists in this correction.

### Risks And Recovery

- App Sandbox may reject the current nested Electron, Node, helper, listener, or
  writable-path topology. Preserve the direct-DMG package path while developing
  a distinct MAS target; do not weaken existing validation to make MAS pass.
- Store and RevenueCat credentials are external. Keep public SDK configuration
  build-scoped; never persist private keys or issuer secrets in the repository.
- Convex currently offers no APAC hosted region; upload latency and regional
  data placement must be measured before selecting a production deployment.
  Region choice, upload/action limits, nonautomatic action retries, workflow
  result persistence, and concurrency must be explicit in the foundation proof.
- Convex mutations can own atomic admission and ledger transitions, but neither
  Convex nor the provider call is assumed exactly-once. Stable idempotency,
  reservation/settlement, ambiguous outcomes, and cleanup are application
  contracts.
- The local keychain has Apple Development and Apple Distribution identities,
  but the installed profiles inspected on 2026-08-30 are iOS-only and none
  matches macOS `com.meetless.app`; a Mac App Store profile must be created and
  installed before a certificate-backed sandbox package can be proven.
- App Review and store processing are external gates. Record exact states and
  do not claim publication before the public listing is observed.

### Validation

- Foundation R1: the fake-backed identity, quota, idempotency, duration,
  cleanup, local-publication, and free-path proof above.
- Focused R1: free Ask/BYOK policy, managed transcription admission, and
  existing meeting-store publication proof. Purchase adapter, renderer
  boundary, and sandbox entitlement tests remain separate reusable evidence.
- Integration: packaged sandbox app with StoreKit/RevenueCat sandbox purchase,
  restore-to-new-installation, device enrollment, and managed transcription.
- Repository: typecheck, focused tests, build, and a MAS-specific package validator.
- External: App Store Connect processing, App Review submission, and public listing.

Observed predecessor R1 validation on 2026-08-31 (historical, not acceptance evidence):

- `npm run typecheck` passed; `npm run build:meetless` passed.
- `npm run test --workspace=@meetless/managed-transcription-foundation` passed
  (1 file, 7 tests).
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/chat-service.test.ts test/composition/managed-transcription-path.test.ts test/composition/chat-path.test.ts` passed (5 files, 32 tests).
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed (6 files, 66 tests).
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` passed (16 files, 112 tests).
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts test/composition/managed-transcription-path.test.ts` passed (3 files, 10 tests).
- `npm run test:composition` ran 5 files and reported 3 passed, with the
  pre-existing M6 transport timeout (120 seconds) and missing
  `@expo/vector-icons/build/createIconSet` module. It is not R1 proof.
- `npm test` completed its native/Paseo/build pretest and ran 71 files with
  65 passing and 6 baseline failures (715 tests, 709 passing): the same M6
  transport timeout and Expo module failure, three retained macOS signing
  diagnostic expectations, and one readiness deadline fixture. The new R1
  tests were included in the passing result.
- No real AVFoundation/Convex latency, production backend, credentials,
  StoreKit/RevenueCat mutation, signing, upload, or publication was attempted.

Observed correction validation on 2026-08-31:

- `npm run typecheck` passed, including Paseo type builds and the Meetless app
  typecheck; `npm run build:meetless` passed.
- Focused correction R1 command
  `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/chat-service.test.ts test/composition/managed-transcription-path.test.ts test/composition/chat-path.test.ts`
  passed (5 files, 38 tests).
- Affected domain/store command
  `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1`
  passed (6 files, 66 tests).
- Affected plugin/lifecycle command
  `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1`
  passed (16 files, 116 tests).
- `npm test` completed native/Paseo/build pretest successfully and reported
  65 passing files and 715 passing tests out of 71 files and 721 tests. The six
  pre-existing failures were the M6 transport timeout (120 seconds), two
  missing `@expo/vector-icons/build/createIconSet` imports, three retained
  macOS signing diagnostic expectations, and one readiness deadline fixture.
  They are outside the correction scope.
- `git diff --check` passed. The two authority files remain byte-identical to
  original base `64cf07d71bf82c798f8c3db417ada7d3c14ad7b5`; their frozen
  combined SHA-256 remains
  `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`.
- No real AVFoundation/Convex latency, production backend, credentials,
  StoreKit/RevenueCat mutation, signing, upload, or publication was attempted.

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
- 2026-08-31 `PLAN_RECONCILIATION v4`: Lead accepted the managed-transcription
  direction with required decisions. The MAS/RevenueCat candidate
  `9f73a7199a65735219d98c2df0eff8de8a2ddcc9` is closed structural evidence;
  its Ask gate is superseded. The current frontier is docs/foundation contract
  work, and implementation remains blocked on the five owner/authority gates.
- 2026-08-31 `PLAN_RECONCILIATION v5`: the owner accepted all five managed-
  transcription contracts. Product policy and ADR0005 now own the free Ask/BYOK,
  quota/trial, three-Mac restore, sample-count duration, 24-hour TTL, six-hour
  lease, natural-expiry completion, and refund/revocation behavior. The next
  frontier is the bounded fake-backed foundation proof.
- This v5 reconciliation changes product and ADR authority plus this plan. It
  changes no implementation, executable contract, package, external service,
  credential, or store state.
- 2026-08-31 `FOUNDATION_PROOF R1`: the fake-backed policy owner, MeetingStore
  publication adapter, Ask-free service path, focused executable proof, and
  honest broader-suite limits were added from original base `64cf07d`. The
  authority files remain frozen and no production service or external state was
  changed.
- 2026-08-31 `FOUNDATION_PROOF R1-CORRECTION`: Lead rejected correction base
  `51ee0cd61bae184d9936e2105294465f8de16108` for MTF-001 through MTF-008. The
  correction candidate adds fresh post-lease admission, verified canonical
  timeline identity, checkpoint-publication recovery, shared lifecycle leasing,
  provider-status release, explicit temporary WAV preparation over the real
  inventory shape, period-snapshotted allowance, and snapshot rehydration. The
  locally observed proof is recorded above and remains pending Lead closeout;
  authority files and external state remain unchanged.

## Validation

Correction validation is the command evidence recorded above. The correction
candidate locally exercises the fake policy and one real local MeetingStore
publication composition path; it remains pending Lead closeout and does not
prove real Convex latency, regional placement, AVFoundation upload limits,
production backend behavior, provider credentials, external purchase mutation,
signing, App Review, or publication.
