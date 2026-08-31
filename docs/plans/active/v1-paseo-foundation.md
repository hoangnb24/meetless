# Execution Plan: Meetless V1 Release Readiness

## Current State

- `plan_revision`: `v19`
- `current_frontier`: `MANAGED-TRANSCRIPTION-CONVEX-HOSTED-DEV-INTEGRATION`
- `state`: `OWNER_EXTERNAL_GATE`
- `depends_on`: accepted managed-transcription foundation candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88`; production integration must preserve its policy, lifecycle, and local-publication boundaries
- `candidate`: local pre-external R2 is accepted at `7183b3d9a8da19ee51cd1f68ddad0bac7ba4b726`; managed-transcription foundation R1 is accepted at `cdc42fd44b8644b259a37876646cfd3f00aefa88`; the Convex local-first R3 convergence is accepted at `f93b705561eb6118c9ccbe7d0f9ae146db4f5df8`. Rejected predecessors `966b9abd78481db001e912cc2e60d895c00bef37`, `0a82b39f758e8c2ec19e831ca1c8c1b75529763d`, and `522faa0b1d1e78e54f0e7d0fc813fc0a0706ab01` remain history only.
- `authority_contract_sha256`: `4f609ef15102282f49f47e34176894e64b361fbc3524a05b1441ff7a005487e4`
- `Convex target`: owner-selected/observed project `Meetless`, existing dev deployment `frugal-mandrill-646`, region `US East (N. Virginia)`; production deployment does not exist
- `pending_ruling`: explicit production subscriber allowance amount remains open; production lineage authentication, credentials, provider access, and external purchase integration also remain owner/external gates
- `blocked_by`: local implementation is accepted and the authorized dev target is known; production allowance, production deployment, credentials, webhook/secret configuration, provider spend/calls, sandbox purchase/restore, availability, review, and publication require owner/external inputs
- `next_action`: advance the configuration seam and hosted-dev auth/webhook/provider integration against authorized Convex dev when credentials and real provider spend are supplied; keep production undeployable without an explicit subscriber allowance and do not choose its amount

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
funds Meetless-managed transcription. The owner clarified that the trial
remains seven days with a five-hour total allowance, while the subscriber
monthly allowance amount remains intentionally unfinalized. This plan owns
that foundation contract, the store sandbox, RevenueCat purchase integration,
App Store Connect submission, and launch-evidence frontier.

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

## Accepted Foundation: MANAGED-TRANSCRIPTION-FOUNDATION-CONTRACT

### Outcome

Define the authority and smallest credible proof for Meetless-managed
transcription before implementation. The accepted direction keeps Ask,
existing transcripts, citations, provider/model controls, and user-supplied
transcription providers/API keys free. RevenueCat Premium gates only
Meetless-managed transcription, where the publisher's provider credential
remains backend-only.

Convex-first is the accepted V1 backend direction. The local-first Convex
implementation frontier below may define the owner of verified subscription
lineage, device credentials, atomic quota ledger, managed jobs, and temporary
uploads against a local deployment. It does not replace local `MeetingStore`
ownership of transcripts, citations, and meeting evidence.

The managed subscriber allowance is one backend-configured allowance in each
subscription-anchored monthly period, without rollover; its amount is not
finalized. Production must fail closed and remain undeployable without an
explicit configured subscriber allowance. A non-production hosted canary may
use an explicitly labeled test allowance, never product authority. The
seven-day trial receives five hours (18,000 seconds) total during the trial.
Each period snapshots its assigned configured limit, so a later reduction
cannot change an already-started period.

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
  - Convex-first is the accepted V1 direction; the local-first implementation
    frontier is recorded below.
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
  - Owner accepted trial, device, restore, server duration, temporary data,
    job lease, expiry, refund/revocation, and free Ask/BYOK behavior on
    2026-08-31. Subscriber monthly allowance behavior is authoritative, but
    its amount remains intentionally unfinalized.
- [x] Close the bounded fake-backed foundation proof defined below. Lead accepted convergence candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88` after independent artifact inspection, focused composition proof, typecheck, build, and frozen-authority verification.
- [x] Freeze the local-first Convex implementation contract in product and ADR
  authority on 2026-08-31: explicit user action gates upload; ordered
  ten-minute transport/provider chunks remain one logical billing timeline; the
  manifest and server-derived PCM duration are authoritative; V1 has no
  diarization or user-facing 60-minute cap.
- [x] Close the region-neutral local Convex boundary correction using generated
  upload URLs/storage IDs; production deployment, credentials, and provider
  access remain deferred gates.
- [x] Reconcile the executable Ask gate so Ask is free; Premium UI remains
  deferred because final UI work is outside this frontier.
- [ ] Apply the profile-backed App Sandbox entitlement and In-App Purchase configuration.
- [ ] Replace unrestricted writable paths with container/export-safe behavior.
- [ ] Produce and validate a sandbox development build.
- [x] Record the observed Apple catalog app, subscription group, products,
  prices, seven-day offers, quota-neutral descriptions, and Family Sharing-off
  state; availability and release evidence remain open.
- [x] Record the observed RevenueCat project, `app_store` app, products,
  `premium` entitlement, default offering, and monthly/annual packages.
- [ ] Configure Apple credentials and prove sandbox purchase and restore.
- [ ] Configure and verify the RevenueCat webhook and secret.
- [ ] Confirm Apple availability/eligibility and complete App Store Connect
  agreements and release metadata.
- [ ] Configure the production subscriber allowance; until an explicit value
  exists, production remains undeployable. Do not select that value in this
  frontier.
- [ ] Prove sandbox purchase, cancellation, restore, and offline/free behavior.
- [ ] Capture icon, screenshot, demo, privacy, review, and launch evidence.
- [ ] Upload the exact build, wait for processing, and submit it to App Review.
- [ ] Record the public Mac App Store URL after approval.

### Observed Apple And RevenueCat Catalog State (2026-08-31)

The catalog objects below are observed configuration state, not proof of
credentials, sandbox purchase or restore, webhook delivery, production
deployment, availability, review, or publication.

Apple:

- App ID `6807070739`, bundle ID `com.meetless.app`.
- Subscription group `22348334`.
- Monthly Apple ID `6807071303`, product
  `com.meetless.app.premium.monthly`, US price `$9.99`.
- Annual Apple ID `6807073268`, product
  `com.meetless.app.premium.annual`, US price `$79.99`.
- Both products have seven-day offers observed from 2026-08-31 through `No End
  Date`; Family Sharing is off.
- Apple descriptions are quota-number-neutral: monthly, `Monthly plan with
  managed transcription allowance`; annual, `Annual plan with monthly managed
  transcription quota`.

RevenueCat:

- Project `proj0d7b4465` (`Meetless`).
- App `appe0ef526253`, type `app_store`, bundle ID `com.meetless.app`.
- Products `prod18ec63f975` (monthly) and `prod381da0b787` (annual).
- Entitlement `entl69875a0345`, lookup `premium`, contains both products.
- Current/default offering `ofrng235b5d5086`, with packages
  `pkge846368fb40` (`$rc_monthly`) and `pkgeb835b3ed04` (`$rc_annual`).
- No Apple credentials, webhook, or RevenueCat secret was configured. The
  owner-selected `Productivity` category was not persisted because the
  available MCP/API surface exposes no category field; this is a non-runtime
  metadata gap, not completed configuration.
- `app_store` is the accepted RevenueCat type for a new post-2020 universal
  Apple macOS app; legacy `mac_app_store` is not required.

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
- Recording and canonical timeline preparation remain local and have no cloud
  duration cap. Only an explicit user action to transcribe with Meetless starts
  cloud preparation/upload; saving or completing a recording never uploads it.
  The single canonical timeline is then physically segmented into ordered
  upload/provider chunks of at most 10 minutes, with a shorter final chunk
  allowed. Recording-internal capture chunks, upload/provider chunks, and the
  logical billing timeline remain distinct, and physical chunks do not create
  multiple jobs or charges.
- The local Convex upload boundary uses generated upload URLs and storage IDs
  for bounded chunks rather than HTTP action bodies. Backend engine adapters may
  change without changing the client-facing managed provider or free BYOK path.
- Audio and provider output are temporary backend data. The durable transcript
  remains local unless separately authorized.
- Family Sharing remains disabled for V1.

### Accepted Owner Contract (2026-08-31)

- Monthly and annual products receive one backend-configured allowance in each
  subscription-anchored monthly period without rollover; its amount is not
  finalized. Production must fail closed and remain undeployable without an
  explicit configured subscriber allowance. A non-production hosted canary may
  use an explicitly labeled test allowance, never product authority. The
  seven-day trial receives 18,000 seconds total during the seven-day trial.
  Restore and product changes do not reset a period, and limit changes apply
  only to the next period.
- One verified subscription account may enroll three Macs. Restore binds a new
  Mac to the same account and quota without automatically revoking an old Mac.
- The server derives billable duration from validated sample count on one 16
  kHz mono PCM WAV timeline; client and provider duration claims are not
  authority, and overlapping microphone/system sources are not double charged.
- Cloud preparation/upload starts only after an explicit managed-transcription
  action. The server validates an immutable manifest with contiguous sample
  offsets/counts and rejects missing, duplicate, overlapping, or otherwise
  non-contiguous parts. It derives duration from accepted PCM16 sample counts
  and reserves/settles once for the logical job; retries and recovery cannot
  double-charge it.
- The physical upload/provider chunks are ordered and at most 10 minutes each;
  they are not separate timelines or billable jobs. V1 managed transcription
  does not provide diarization, and no user-facing 60-minute job cap is
  authorized. Any later safety ceiling requires new owner authority.
- The local-first Convex implementation is region-neutral and may proceed
  against a local deployment. US East versus EU West is deferred until before
  cloud production deployment; production deployment, region, credentials, and
  provider calls remain owner/external gates.
- Temporary audio, orphan uploads, provider results, and transcripts in transit
  have a 24-hour TTL. Jobs have a six-hour lease, and acknowledged local
  publication triggers earlier result deletion.
- A validly admitted job may finish after natural expiry within its lease;
  verified grace remains active, while refund or revocation stops work when
  observed. Ask and BYOK remain free; only managed transcription requires
  Premium.

### Foundation Proof Acceptance Boundary

The accepted foundation was one bounded fake-backed vertical proof. It
demonstrated:

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
   BYOK bypasses Premium/quota and Ask remains free.

The next authorized local implementation criterion is:

6. the region-neutral Convex boundary uses generated upload URLs and storage
   IDs for ordered physical chunks while preserving one logical billing
   timeline; provider execution remains replaceable and local `MeetingStore`
   remains the durable transcript owner.

The first five criteria define the accepted fake-backed foundation. Criterion
six is now authorized as local implementation; production Convex deployment,
region selection, credentials, provider calls, external store changes, and
final UI remain outside this repository-only frontier.

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
repository or external mutation. Lead keeps Convex-first as the accepted
direction: Convex is credible as the transactional control plane and temporary
object store, but not as an assumed arbitrary-length synchronous audio
processor. A region-neutral local deployment is now authorized for the next
implementation frontier. Hosted production region, credentials/provider
access, real provider behavior, and target-market latency remain external
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

`CPF-004` was not authorized as a guessed product limit in R2. The owner has
now explicitly rejected a user-facing 60-minute cap and permits local recording
and canonical preparation without a cloud duration cap. The local Convex seam
uses ordered physical upload/provider chunks of at most 10 minutes behind one
logical billing timeline. Any later operational safety ceiling still requires
new owner authority; native anchor-buffer policy and production provider limits
remain outside this frontier.

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
- No Convex package/config/project, production credential, provider call, native capture launch, StoreKit/RevenueCat mutation, signing, upload, publication, or external state change was attempted. The R2 candidate was validated against the then-frozen authority digest `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`; this revision records the amended digest above.

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

### R2 Convergence Candidate Disposition (2026-08-31; accepted)

Lead accepts bounded convergence candidate
`7183b3d9a8da19ee51cd1f68ddad0bac7ba4b726`, prepared from exact base
`360e01675d46f0b9207358b1e84eddff814a7273`. No authority file or MeetingStore
production implementation changed.

- `CPF-002`: `Mp3Finalizer` keeps only the MP3 stage/publication in
  `exportRoot`. Source timelines and the managed canonical WAV use a
  deterministic per-recording staging directory below the MeetingStore-owned
  private artifact root. Persisted stage recovery, rebuild, enumeration, and
  startup cleanup cover the private root; the existing MeetingStore deletion
  manifest removes that root with the recording.
- `CPF-007`: running-runtime artifact enumeration retains meeting-owned paths
  after their 24-hour expiry. The direct regression obtains the path through
  `RecordingService.ownedManagedArtifactPaths`, deletes the meeting without a
  startup sweep, and observes the private artifact removed.
- `CPF-001`, `CPF-003`, `CPF-005`, and `CPF-006-LOCAL` remain unchanged and
  covered by the focused R1 regression set.

Observed convergence proof and Lead acceptance:

- The focused R1 set passed 9 files and 107 tests, including finalizer path
  assertions, all four publication/saved/handoff/cleanup restart failpoints,
  private-stage startup enumeration, and expired-artifact runtime deletion.
- Meeting domain/store regressions passed 6 files and 67 tests. The broader
  plugin suite passed 17 files and 124 tests in the full-access environment.
- `npm run typecheck`, `npm run build:meetless`, and `git diff --check` passed.
- The convergence candidate was validated against the then-frozen authority
  digest `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`;
  this revision records the amended digest above.
- No Convex/provider credentials or calls, native capture launch,
  StoreKit/RevenueCat mutation, signing, upload, publication, or external
  state change was attempted. This proof makes no production latency claim.
- Lead independently verified the exact seven-path delta and parent, inspected
  the private staging/deletion corrections, reran the 9-file/107-test focused
  proof, typecheck, build, diff check, and frozen authority digest. The only
  remaining work is owner-gated production integration and release evidence.

### Completed Frontier: MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-IMPLEMENTATION

Plan revision `v15` freezes the accepted managed-transcription behavior and
authorizes repository implementation against a region-neutral local Convex
deployment. This is no longer waiting on a product duration/size decision. The
implementation must preserve the accepted policy owner, shared lifecycle
lease, temporary-data rules, and local `MeetingStore` transcript/citation
ownership.

The frozen implementation contract is:

- Recording and canonical timeline preparation remain local and have no cloud
  duration cap. Completing or saving a recording never uploads it; cloud
  preparation/upload starts only after an explicit user action to transcribe
  with Meetless.
- After that action, one canonical 16 kHz mono PCM16 logical timeline is
  physically segmented into ordered upload/provider chunks of at most 10
  minutes, with a shorter final chunk allowed. Recording-internal capture
  chunks and upload/provider chunks are distinct, and the latter do not create
  multiple billable timelines or managed jobs.
- The server validates an immutable manifest with contiguous sample
  offsets/counts, rejects missing, duplicate, overlapping, or non-contiguous
  parts, derives duration from accepted PCM sample counts, and reserves/settles
  once for the logical job. Retry and recovery paths are idempotent and cannot
  double-charge.
- V1 managed transcription has no diarization and no user-facing 60-minute
  job cap. Any later operational safety ceiling requires new owner authority.
- The Convex seam uses generated upload URLs and storage IDs for bounded chunks;
  audio bytes do not pass through HTTP action bodies. Provider execution remains
  replaceable, and Ask/BYOK remain free.

The local implementation was accepted at `f93b705561eb6118c9ccbe7d0f9ae146db4f5df8`.
The observed Convex development target is recorded in `Current State`; no
production deployment, production allowance, provider behavior, production
latency, or external mutation is claimed here.

### Live Frontier: MANAGED-TRANSCRIPTION-CONVEX-HOSTED-DEV-INTEGRATION

This frontier advances the accepted local seam toward the owner-selected
Convex development target without selecting a production subscriber
allowance. It may proceed locally and against authorized Convex dev for the
configuration seam, authenticated development wiring, webhook handling, and
provider integration. External credentials and real provider spend remain
gated, and a hosted canary allowance must be explicitly labeled as test-only.

The frontier must preserve these boundaries:

- The subscriber allowance is configuration, not a newly chosen product
  number. Production fails closed and remains undeployable until an explicit
  subscriber allowance is configured; the seven-day trial remains five hours
  (`18,000` seconds) total.
- Each subscription-anchored monthly period snapshots its configured limit;
  unused allowance does not roll over, and later configuration changes apply
  only to later periods.
- Authenticated development requests continue to use server-verified
  subscription lineage and device credentials. RevenueCat lookup state and
  client-selected subscriber IDs do not become authorization proof.
- Generated Convex upload URLs and storage IDs carry bounded physical chunks;
  the immutable manifest, server-derived PCM duration, one logical billing
  timeline, idempotent settlement, temporary-data TTL, job lease, and local
  `MeetingStore` publication boundary remain unchanged.

The next credible proof is a hosted-dev canary with explicit test labeling:
authentication and webhook receipt, catalog-to-entitlement mapping, upload
and recovery behavior, provider invocation only when authorized, and cleanup.
It must not claim production allowance, production deployment, or provider
spend until those owner gates are supplied and observed.

### Risks And Recovery

- App Sandbox may reject the current nested Electron, Node, helper, listener, or
  writable-path topology. Preserve the direct-DMG package path while developing
  a distinct MAS target; do not weaken existing validation to make MAS pass.
- Store and RevenueCat credentials are external. Keep public SDK configuration
  build-scoped; never persist private keys or issuer secrets in the repository.
- Convex currently offers no APAC hosted region; upload latency and regional
  data placement must be measured before selecting a production deployment.
  The local implementation is region-neutral; production platform limits,
  action retries, workflow result persistence, and concurrency must be measured
  before external deployment. No user-facing duration cap is implied by those
  operational measurements.
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
- Completed local Convex frontier: generated upload URL/storage-ID transfer,
  ordered at-most-10-minute physical chunks behind one logical job, immutable
  manifest validation, and retry/idempotency against a local deployment. This
  evidence does not claim hosted production behavior.
- Current hosted-dev frontier: add the configuration seam and authenticated
  development auth/webhook/provider integration against the owner-selected
  Convex dev target. External credentials and real provider spend remain
  gated; do not select the production subscriber allowance.
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
- 2026-08-31 `PLAN_RECONCILIATION v15`: the owner froze the local-first Convex
  implementation contract. Local recording/canonical preparation has no cloud
  duration cap and upload starts only after explicit managed-transcription
  action; ordered physical upload/provider chunks are at most 10 minutes behind
  one logical billing timeline; immutable manifests and server-derived PCM
  duration govern idempotent reservation/settlement; V1 has no diarization or
  user-facing 60-minute cap. The combined authority digest is now
  `87625cb59c10e399767e34a2ecfd2bd92bf7e3a7598673fec267479dfdd7860e`.
  Region-neutral local Convex implementation is authorized; only production
  deployment/region, credentials, and provider access/calls remain deferred
  owner/external gates.
- 2026-08-31 `PLAN_RECONCILIATION v19`: the owner clarified that the seven-day
  trial remains five hours (`18,000` seconds) total, while reopening the
  subscriber monthly allowance amount. Product and ADR authority now describe
  that allowance as backend-configured with no selected production number;
  production fails closed and remains undeployable without an explicit value.
  The owner-selected/observed Convex target is project `Meetless`, dev
  deployment `frugal-mandrill-646`, US East (N. Virginia), with no production
  deployment. Apple and RevenueCat catalog observations are recorded above;
  credentials, webhook, sandbox purchase/restore, availability, deployment,
  review, and publication remain open. The current combined authority digest is
  `4f609ef15102282f49f47e34176894e64b361fbc3524a05b1441ff7a005487e4`.

### R3 local Convex implementation predecessor (rejected by Lead)

Observed on 2026-08-31 against the R3 implementation frontier. This is local
evidence only; it does not claim hosted Convex, production authentication,
provider execution, or acceptance by Lead.

- `convex/schema.ts` and the two Convex modules define server-owned temporary
  upload metadata, immutable sample-offset parts, one logical admission and
  quota ledger transition, six-hour lease, 24-hour expiry, idempotent seal /
  settlement / acknowledgement, and an internal-only local canary seed. The
  server checks each stored part's actual canonical WAV header, sample count,
  byte length, and digest before admission. Provider execution is a
  provider-neutral local action with one full-timeline range and no diarization.
- The pure foundation manifest validator remains Convex-free. The desktop
  adapter uses a required durable local POST/register journal, streams each
  normalized 44-byte-header PCM part through a generated upload URL, sends no
  audio bytes in function arguments, and resumes registered storage IDs after
  a process restart. FFmpeg metadata chunks are located at the edge; the
  logical manifest identity is canonical header plus PCM samples.
- Recording finalization remains the only creator of the private managed WAV.
  Save/finalize performs no Convex call. The explicit managed service persists
  the MeetingStore pending transcript barrier before remote admission, holds
  the shared lifecycle lease through publication, publishes to MeetingStore,
  then acknowledges remote temporary data and removes the private artifact.

Observed commands and results:

- `npx convex dev --once --typecheck enable --codegen enable` passed against
  anonymous local deployment `http://127.0.0.1:3210`; generated Convex types
  and local function preparation completed without a cloud account.
- `npx convex run internal.managedTranscription.seedLocalCanary
  '{"tokenIdentifier":"r3-final-canary"}'` passed. The seed is an internal
  test-only verified-lineage fixture, not production authorization.
- The anonymous local HTTP canary passed generated upload URL, direct storage
  POST, duplicate part registration, seal, ordered fake provider completion,
  duplicate settlement, duplicate acknowledgement, and cleanup. Observed
  result: `sealedStatus=reserved`, `providerStatus=provider_completed`,
  `providerRanges=1`, `settledStatus=succeeded`,
  `duplicateSettledStatus=succeeded`, `cleanedState=cleaned`, and zero
  remaining part records.
- The same local backend logged actionable failures for an over-bound part
  (`Managed physical part exceeds the accepted ten-minute sample bound`) and
  an incomplete manifest (`Managed seal requires every physical part exactly
  once and in order`), each naming the frozen authority files.
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-upload.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/recording-service.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts --maxWorkers=1` passed: 8 files, 103 tests.
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed: 6 files, 67 tests. `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` passed: 17 files, 127 tests.
- `npm run typecheck` passed, including Paseo type builds, Meetless project
  references, and the app typecheck. `npm run build:meetless` passed.
  `git diff --check` passed.
- The composition proof observes no Convex calls during real fixture
  RecordingService save/finalization, no WAV stage under exportRoot, only MP3
  output there, source-chunk cleanup, private artifact consumption, one local
  MeetingStore citation, and post-publication cleanup. The adapter proof uses
  a sparse 13,200,001-sample source and a synthetic seven-part logical
  manifest longer than 60 minutes without a user-facing duration cap.

Enforcement and limits:

- Local validation: the commands above are the repository-native evidence
  owners and passed. Optional hooks: no configured `core.hooksPath`; only
  stock sample hooks are present. CI: no checked-in `.github` workflow invoking
  these commands was found. Branch protection: unverified.
- The local Convex slice has no hosted region, production deployment,
  verified Apple lineage adapter, production credentials, or real provider
  action. US East/EU West selection, production limits/latency, provider
  cancellation, and external deployment remain owner gates. The internal
  canary seed must not be exposed as a production endpoint.
- The journal closes the returned-storage-ID/register ambiguity. A transport
  failure before a generated upload response is received cannot be reconciled
  by this repository without an external storage-listing/garbage-collection
  contract; this remains an owner/provider cleanup gate. No product duration
  or size cap was added.

Lead rejected candidate `0a82b39f758e8c2ec19e831ca1c8c1b75529763d`; its
evidence is retained here as predecessor history. The bounded correction below
was rejected at closeout for the residual `MTC-R3-006` sibling failure path;
the accepted convergence is recorded afterward.

### R3 lifecycle correction (rejected at closeout)

Lead rejected candidate `0a82b39f758e8c2ec19e831ca1c8c1b75529763d` at the
correction base with accepted findings `MTC-R3-001`, `MTC-R3-002`,
`MTC-R3-003`, `MTC-R3-005`, `MTC-R3-006`, `MTC-R3-007`, and `MTC-R3-008`.
`MTC-R3-004` was not accepted as a defect: the Lead ruling requires proving
Convex indexed read-then-insert behavior through concurrent local calls, and
requires reopening if that proof contradicts OCC/serializability. This
correction candidate preserves the ruling and records evidence pending Lead
closeout; it does not claim production behavior.

The correction adds identity-only recovery after natural expiry, current
entitlement checks only for new admission, durable cancellation generations,
execution tokens and attempts, atomic provider-result settlement with the
one-charge ledger transition, bounded indexed lease/TTL reconciliation, and
current-device validation on every action-to-internal path. Device revoke
stops in-flight work while account-owned terminal results remain recoverable by
an enrolled sibling. A ready MeetingStore transcript is checked before the
private timeline is prepared, so a fresh service retry does not require a
deleted artifact.

Observed mechanical proof on 2026-08-31:

- `npm run proof:managed-convex-local` passed against an anonymous
  local Convex deployment. The script started and stopped the local process,
  seeded only internal test principals, used generated upload URLs/storage IDs,
  ran concurrent begin and same-part registration, and cleared its account
  state. Its exact result was:
  `{"frontier":"MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION","result":"passed","anonymousLocalConvex":true,"concurrentBeginAndPartOCC":true,"providerInvocations":1,"logicalTimelineSeconds":31,"noCapLogicalTimelineSeconds":4200,"restartRecovered":true,"cleanup":"account state cleared"}`.
- That proof covered natural-expiry claim/complete/settle/retrieve/ack,
  duplicate settlement and acknowledgement, process restart, cancellation
  staleness, lease expiry and fresh admission, next-period allowance
  snapshotting, post-TTL non-settlement, device revoke with sibling recovery,
  same-audio immutable binding, distinct-recording identical bytes, the
  over-sixty-minute no-cap manifest, and an oversized stored Blob rejected by
  `Blob.size` before materialization. It also proved the accepted MTC-R3-004
  OCC premise locally; no lock table was added.
- The composition regression passed through real fixture
  `RecordingService` finalization, private canonical-artifact handoff before
  source cleanup, Convex-shaped publication through MeetingStore, artifact
  cleanup, and a fresh-service retry after the private artifact was gone. The
  retry issued only the recording job-status query.
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test
  --maxWorkers=1` passed 17 files and 127 tests; the affected domain/store
  command passed 6 files and 67 tests; the managed policy/upload/transcription,
  lifecycle, Ask/BYOK, domain/store, and managed composition command passed
  14 files and 163 tests.
- `npm run typecheck`, `npm run build:meetless`, and `git diff --check` passed.
  A broader command that included every composition file reported only the
  pre-existing `m6-transport-path.test.ts` 120-second timeout and the existing
  Expo icon module-resolution failure in `meeting-path.test.ts`; those files
  are outside this correction's managed path.
- The local proof uses a deterministic provider fake with one full-timeline
  range and no diarization. It does not claim hosted Convex, cloud provider
  execution, or production auth/lineage.

The seven-finding lifecycle correction evidence remains retained as closeout
context; its exact residual and current convergence candidate are recorded
below. The prior local implementation authority digest was
`87625cb59c10e399767e34a2ecfd2bd92bf7e3a7598673fec267479dfdd7860e`; the
current reconciled digest is recorded in `Current State` and the v19 record.

### R3 device convergence (accepted)

Lead's closeout of candidate `522faa0b1d1e78e54f0e7d0fc813fc0a0706ab01`
closed `MTC-R3-001`, `MTC-R3-002`, `MTC-R3-003`, `MTC-R3-005`,
`MTC-R3-007`, and `MTC-R3-008`; the exact remaining defect was the
`MTC-R3-006` sibling failure path. This candidate is based on that closeout
and does not reopen the accepted architecture or closed findings.

The convergence change requires the admitting device for any reserved or
running provider failure cleanup, and makes the provider action's catch path
call failure cleanup only after that action has acquired the winner execution
token. An enrolled sibling may still recover account-owned terminal status,
result, and acknowledgement. The local proof adds the direct sibling attempt:
the sibling rejection leaves the reserved job, admission, and period
reservation/usage unchanged, after which the admitting device settles once.

Observed mechanical proof on 2026-08-31:

- `npm run proof:managed-convex-local` passed against an anonymous local
  Convex deployment and exited 0. Its exact result was:
  `{"frontier":"MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION","result":"passed","anonymousLocalConvex":true,"concurrentBeginAndPartOCC":true,"providerInvocations":1,"logicalTimelineSeconds":31,"noCapLogicalTimelineSeconds":4200,"restartRecovered":true,"siblingDeviceIsolation":true,"cleanup":"account state cleared"}`.
- The new proof seeds two enrolled devices, admits on the primary, rejects the
  sibling's `runProvider` before failure cleanup, verifies the reserved job,
  admission, and period reservation/usage are unchanged, then runs the primary
  to one provider invocation and one settlement. It also retains the prior
  seven-finding lifecycle and concurrent OCC cases.
- The focused managed plugin/lifecycle/composition command passed 6 files and
  43 tests; `npm run typecheck`, `npm run build:meetless`, and `git diff --check`
  passed. The frozen authority digest remained unchanged.

Lead accepted convergence candidate
`f93b705561eb6118c9ccbe7d0f9ae146db4f5df8` on 2026-08-31 after verifying
its exact parent and four-path delta. Lead personally reran
`npm run proof:managed-convex-local`; the anonymous local proof passed with
`siblingDeviceIsolation: true`, one provider invocation, preserved OCC and
restart recovery, and owned-state cleanup. The direct managed
policy/upload/transcription/composition suite passed 4 files and 32 tests;
`npm run typecheck`, `npm run build:meetless`, `git diff --check`, and the
frozen authority digest also passed. This acceptance is local only and does
not claim hosted Convex, production authentication, provider credentials,
provider network execution, or external mutation.

## Validation

Acceptance validation is the command evidence recorded above. The accepted
convergence candidate locally exercises the fake policy and one real local MeetingStore
publication composition path; it does not
prove real Convex latency, regional placement, AVFoundation upload limits,
production backend behavior, provider credentials, external purchase mutation,
signing, App Review, or publication.

This v19 docs revision records local implementation acceptance and observed
development/catalog state; it does not claim production allowance, production
deployment, provider call, production latency, external credentials, sandbox
purchase/restore, review, publication, or other external mutation.
