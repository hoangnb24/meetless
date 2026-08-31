# Execution Plan: Meetless V1 Release Readiness

## Current State

- `plan_revision`: `v12`
- `current_frontier`: `MANAGED-TRANSCRIPTION-PRE-EXTERNAL-SEAM-R2-CONVERGENCE`
- `state`: `LOCAL_CONVERGENCE_REQUIRED`
- `depends_on`: accepted managed-transcription foundation candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88`; production integration must preserve its policy, lifecycle, and local-publication boundaries
- `candidate`: R2 candidate `966b9abd78481db001e912cc2e60d895c00bef37` is rejected for the bounded CPF-002/CPF-007 convergence below. Managed-transcription foundation R1 remains accepted at `cdc42fd44b8644b259a37876646cfd3f00aefa88`
- `pending_ruling`: none for the bounded local R2 correction; owner selection of job duration/size limits, Convex project/region, and external configuration remains deferred
- `blocked_by`: R2 is not externally blocked. Real regional latency, upload/action limits, provider credentials, App Store profile, RevenueCat configuration, sandbox purchase, upload, review, and publication still require external targets or owner-gated mutation
- `next_action`: the same SERIAL writer applies the bounded CPF-002/CPF-007 convergence; no third broad review and no Convex dependency, project, credential, provider call, or external mutation

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
- [x] Close the bounded fake-backed foundation proof defined below. Lead accepted convergence candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88` after independent artifact inspection, focused composition proof, typecheck, build, and frozen-authority verification.
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
historical context only and are not acceptance evidence. The accepted
convergence candidate below supersedes this disposition.

### R1 Correction Batch Disposition (2026-08-31; superseded by convergence)

Lead rejected correction candidate `51ee0cd61bae184d9936e2105294465f8de16108`
for the frozen MTF-001 through MTF-008 finding set. Its proof claims remain
historical context only. The convergence correction below preserves the six
closed findings and addresses the two remaining blockers; Lead acceptance is
recorded below.

### R1 Convergence Correction Disposition (2026-08-31; accepted)

The accepted convergence correction candidate is
`cdc42fd44b8644b259a37876646cfd3f00aefa88`, prepared from
`ee55af2179d00bac7856f178f0b87f5b4fee9f19` and preserves original base
`64cf07d71bf82c798f8c3db417ada7d3c14ad7b5`. Lead acceptance observed the
following code/test evidence:

- `MTF-001`: `ManagedTranscriptionPolicy.reserve` reconciles expired leases
  before identity lookup; `reAdmit` requires active/grace entitlement, current
  quota, and creates a new admission/lease. The policy test covers stale
  admission rejection, fresh completion, and one ledger charge.
- `MTF-002`: `ManagedTimelineEvidence`, SHA-256 edge identities, immutable
  recording/audio keys, manifest/content conflict checks, and overlapping-window
  rejection remain in the policy. Policy tests cover false rebinding, identical
  bytes across distinct recordings, overlapping microphone/system timelines,
  and a false PCM timeline window; adapter tests cover tampered MP3 and the
  no-handoff-after-source-cleanup boundary.
- `MTF-003`: `ManagedTranscriptionService` creates one MeetingStore range with
  `rangeMs` equal to the canonical timeline duration and rejects any non-full
  range. `publishResult` reconciles durable MeetingStore state, publishes all
  checkpoints, and acknowledges the managed result only after `ready`. The
  adapter test uses a 496,000-sample (31-second) timeline, injects a crash after
  provider completion, rehydrates a new policy/service/store boundary, and
  proves one provider call, one full range, one charge, and a local citation.
- `MTF-004`: the managed service requires and holds the existing shared
  `MeetingLifecycleCoordinator` transcription lease through provider, settle,
  and MeetingStore publication. The blocked-provider test proves deletion is
  refused until release.
- `MTF-005`: provider status errors and non-configured status fail the job and
  release quota before provider execution; the adapter test proves the failed
  state and zero reservation.
- `MTF-006`: `Mp3Finalizer.stage` reuses validated source-timeline staging and
  writes the temporary canonical 16 kHz mono PCM WAV alongside the durable MP3
  in one finalization step. `RecordingService.finishSaved` hands it to the
  narrow managed-artifact consumer before `cleanupEligibleInventory`; without
  a consumer the finalizer-owned artifact is cleaned locally. The real
  RecordingService composition test proves source chunks are gone after save,
  the handoff artifact remains consumable, and managed publication consumes it
  and publishes citations through MeetingStore.
- `MTF-007`: `ManagedAllowanceConfiguration` is snapshotted into each period;
  later configuration affects only periods created afterward. The policy test
  proves reduction, next-period allowance, and exhaustion.
- `MTF-008`: `ManagedTranscriptionPolicy.snapshot`/`fromSnapshot` and the
  `ManagedTimelineArtifactStore` sidecar provide fake durable state and
  rehydration boundaries. The crash test creates new policy, artifact-store,
  service, and MeetingStore instances after provider completion; settlement,
  local publication, provider non-recall, and exactly one ledger charge are
  observed.

Convergence architectural decisions:

- `packages/managed-transcription-foundation` remains the one policy owner for
  verified lineage, revocable device credentials, snapshotted quota periods,
  reservation/settlement, jobs, admissions, and provider temporary state. Its
  snapshot boundary uses ordinary data only and has no Node, storage,
  transport, UI, RevenueCat, Convex, StoreKit, or provider dependency.
- `packages/meetless-plugin/src/finalizer.ts` owns creation of the temporary
  canonical timeline while validated chunks exist. The artifact is handed to a
  narrow consumer before source cleanup; the managed adapter consumes and
  cleans it after local publication. No post-cleanup inventory reconstruction
  or durable MP3-as-WAV parsing remains on the default path.
- `packages/meetless-plugin/src/managed-transcription.ts` verifies the saved
  MP3 and handed-off artifact at the edge, calls the existing
  `TranscriptionProvider`, and publishes only through `MeetingStore`. Ask and
  BYOK remain free; final Premium UI and production runtime wiring remain
  outside this frontier.

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

### Production Integration Preflight Verdict (2026-08-31)

Two independent read-only preflights inspected accepted base `03d4249` without
repository or external mutation. Lead keeps Convex-first conditionally: Convex
is credible as the transactional control plane and temporary object store, but
not as an assumed arbitrary-length synchronous audio processor. Hosted region,
real upload/action/provider behavior, and target-market latency remain external
gates.

Frozen local correction findings:

- `CPF-001`: add a separate host-authenticated managed-upload port with bounded
  streaming/parts, idempotent completion, cancellation, and status recovery.
  It must not alter or reuse the direct/BYOK `TranscriptionProvider` contract.
- `CPF-002`: move managed canonical audio and metadata into private app-owned
  state. Only the durable user-visible MP3 may use the export destination.
- `CPF-003`: make finalizer-to-managed-owner transfer recoverable before source
  cleanup, including publication/saved/handoff/cleanup crash boundaries.
- `CPF-005`: use deterministic recording-bound timeline identity; caller input
  cannot create a second admission for the same recording.
- `CPF-007`: give local artifacts meeting ownership, creation/expiry state, the
  accepted 24-hour TTL, startup/orphan sweep, and meeting-deletion cleanup.
- `CPF-006-LOCAL`: persist a local pending/transcribing barrier before remote
  submission, recover it after restart, and reacquire the shared lifecycle lease
  for publication. Remote cancellation/provider semantics remain external.

`CPF-004` is not authorized as a guessed product limit. The owner must later
choose a maximum managed-job duration/size after long-duration RSS, disk, and
upload measurements. Native anchor-buffer policy and production provider limits
remain outside R2.

`PARALLEL_CHECK v1`: `SERIAL`. The ready corrections share finalizer,
RecordingService, private artifact ownership, MeetingStore deletion lifecycle,
runtime composition, and integration proof. Contract digest remains
`79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`.

R2 acceptance requires a fake transport with a canonical WAV larger than 25 MB
without full-file adapter buffering; duplicate part/completion recovery;
cancel/revoke and restart behavior; failpoints around finalization handoff;
success/failure/expiry/deletion cleanup; durable deletion refusal while managed
work is pending; unchanged Ask/BYOK behavior; focused proof, typecheck, build,
and unchanged authority digest. R2 does not install Convex, wire production,
choose a region or job limit, launch capture, use credentials, or mutate an
external service.

### R2 Pre-External Seam Candidate Disposition (2026-08-31; pending Lead closeout)

The repository-only R2 candidate is prepared from exact base
`66353f59038afba3407a7f61c280d91b0b3e612b`. Its final immutable commit and
complete changed-path manifest are reported in the peer handoff; this section
records the implementation and personally observed proof without treating it
as Lead acceptance.

- `CPF-001`: `FileManagedUploadPort` and `FileManagedUploadRepository` define
  a host-authenticated, provider-independent upload seam. Sessions and parts
  are ordinary private temporary state, parts are streamed into bounded files,
  duplicate/conflicting parts and completion are idempotent/explicit, and a
  fresh instance rehydrates status and receipts. The large proof streams a
  26,400,044-byte canonical WAV (>25 MiB) in 256 KiB parts.
- `CPF-002`: `ManagedTimelineArtifactStore` copies the finalizer-owned
  canonical WAV into a private per-recording directory with metadata and a
  24-hour expiry. The durable export remains the MP3; the managed artifact is
  consumed and removed after local publication.
- `CPF-003`: `RecordingService` persists the managed stage reference and
  handoff state through publication, saved, handoff, and source-cleanup
  boundaries. A fresh service rebuilds a missing managed stage from the frozen
  validated inventory before source cleanup, while an accepted handoff resumes
  without reassembling or re-calling the provider.
- `CPF-005`: finalizer evidence and the upload manifest use
  `recording:${recordingId}` as the canonical timeline identity; caller audio
  labels are ignored by the managed adapter and rejected by the upload edge.
- `CPF-007`: artifact metadata records recording/meeting ownership, creation,
  exact expiry, and the accepted 24-hour TTL. Startup sweeps remove expired,
  malformed, corrupt, and orphaned private artifacts; MeetingStore includes
  the deterministic private artifact path in its deletion manifest and refuses
  a saved recording while its handoff remains pending.
- `CPF-006-LOCAL`: `ensureManagedTranscript` persists the local pending barrier
  before provider submission. The shared lifecycle lease spans provider work
  and is reacquired for publication; MeetingStore remains the sole durable
  transcript/citation owner. Ask/BYOK code paths are unchanged.

Observed R2 proof, pending Lead closeout:

- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-upload.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/inventory.test.ts packages/meetless-plugin/test/recording-service.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts --maxWorkers=1` passed 9 files and 106 tests. This includes the >25 MiB stream, malformed/false WAV rejection, upload session restart, duplicate/completion/cancel cleanup, real finalizer handoff failpoints, provider-status release, durable deletion barrier, shared lifecycle lease, and provider-result publication recovery.
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed 6 files and 67 tests.
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` ran 17 files and 123 tests: 15 files/118 tests passed; the 5 failures were the pre-existing sandbox-denied localhost/Unix-socket listener tests in `chat-service.test.ts` and `control-server.test.ts` (`listen EPERM`). No R2-owned plugin test failed.
- `npm run typecheck` passed; `npm run build:meetless` passed; `git diff --check` remains required after this plan entry.
- The composition proof traverses real fixture `RecordingService` finalization and source-chunk cleanup, fake private artifact handoff, fake upload receipt completion, an injected post-provider-success crash, fresh policy/upload/store instances, one provider call, and MeetingStore citation publication. It does not claim real Convex latency or production provider behavior.
- No Convex package/config/project, production credential, provider call, native capture launch, StoreKit/RevenueCat mutation, signing, upload, publication, or external state change was attempted. Authority files remain frozen at combined digest `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`.

### R2 Convergence Ruling (2026-08-31)

Lead rejects candidate `966b9abd78481db001e912cc2e60d895c00bef37`
after bounded FAST closeout. The reviewer recommended acceptance, but the
artifact inspection leaves two accepted-contract gaps:

- `CPF-002` remains open because finalizer source timelines and
  `.managed.wav.stage` are still written under `exportRoot`. The frozen finding
  allows only the user-visible MP3 in the export destination; transient private
  managed audio must use an app-owned staging root before and during handoff.
- `CPF-007` requires a direct deletion regression correction: while the runtime
  is active, `ownedArtifactPaths` excludes expired meeting-owned artifacts, so
  meeting deletion can leave them until a later startup sweep. Deletion must
  own and remove the path regardless of whether TTL has just elapsed.

`PLAN_RECONCILIATION v12`: one bounded convergence is authorized on top of
`966b9abd`. Keep CPF-001, CPF-003, CPF-005, and CPF-006-LOCAL closed. Move only
private audio/source staging out of `exportRoot`, preserve MP3 atomic
publication, update stage enumeration/recovery/deletion accordingly, and prove
expired-artifact deletion while running. No third broad review is authorized;
Lead will inspect and run direct regressions on the convergence candidate.

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

Observed first-correction validation on 2026-08-31 (historical, superseded):

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

Observed convergence-correction validation on 2026-08-31:

- `npm run typecheck` passed, including Paseo type builds and the Meetless app
  typecheck; `npm run build:meetless` passed.
- Focused convergence command
  `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/inventory.test.ts packages/meetless-plugin/test/recording-service.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts --maxWorkers=1`
  passed (8 files, 94 tests). This includes the 31-second provider-result
  crash/retry and the real RecordingService finalizer handoff composition.
- The policy/adapter/composition subset after the final boundary checks passed
  (3 files, 16 tests).
- Affected domain/store command
  `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1`
  passed (6 files, 66 tests). Affected plugin/lifecycle command
  `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1`
  passed (16 files, 116 tests).
- `npm test` completed the native/Paseo/build pretest successfully and ran 71
  files: 66 passed and 5 failed, with 716 passing and 5 failed tests out of
  721. The failed files were the M6 transport timeout, two suites blocked by
  missing `@expo/vector-icons/build/createIconSet`, one macOS artifact-resign
  diagnostic assertion, and three macOS package-signature diagnostic
  assertions. The convergence tests were included in the passing result.
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
- 2026-08-31 `FOUNDATION_PROOF R1-CONVERGENCE`: Lead's closeout left MTF-003
  and MTF-006 open. The convergence candidate is based on `ee55af2`, preserves
  the six closed findings, creates one full-duration MeetingStore range with
  acknowledgement only after local publication, and moves canonical WAV
  creation into finalization before source-chunk cleanup. A fake durable
  artifact sidecar and fresh-instance crash proof cover provider-result
  recovery; the real RecordingService composition covers pre-cleanup handoff
  and post-cleanup publication. Lead accepted candidate `cdc42fd4` after
  independently rerunning the 8-file/94-test focused proof, typecheck,
  `build:meetless`, `git diff --check`, and the frozen authority digest. Authority
  files and external state remain unchanged.
- 2026-08-31 `PLAN_RECONCILIATION v9`: the bounded fake-backed foundation is
  closed. The next frontier is the production Convex/AVFoundation integration
  gate. Repository inspection found no Convex project, configuration, or
  deployment target, so no external project, credential, provider, or store
  mutation is authorized or attempted. Internal briefing may proceed; real
  regional latency and upload/action-limit proof waits on the owner gate.

## Validation

Acceptance validation is the command evidence recorded above. The accepted
candidate locally exercises the fake policy and one real local MeetingStore
publication composition path; it does not
prove real Convex latency, regional placement, AVFoundation upload limits,
production backend behavior, provider credentials, external purchase mutation,
signing, App Review, or publication.
