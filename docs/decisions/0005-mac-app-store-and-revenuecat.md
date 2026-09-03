# 0005 Distribute Meetless Through The Mac App Store With RevenueCat

Date: 2026-08-30; amended 2026-09-03

## Status

Accepted

## Context

Meetless is entering RevenueCat Shipaton 2026. The event requires a newly
published app on an eligible store and a working RevenueCat-powered purchase.
ADR0002 selected direct DMG distribution and explicitly excluded Mac App Store
sandboxing, App Store Connect, and App Review. The owner has now replaced that
distribution decision and selected the premium policy for the store release.

## Decision

### Distribution

The first public Meetless release will target the Mac App Store under bundle ID
`com.meetless.app`. The Mac App Store build is the release authority. Direct-DMG
artifacts remain historical development evidence and are not release evidence
for this distribution.

The Mac App Store artifact must use App Sandbox, the In-App Purchase capability,
an Apple Distribution identity, an App Store provisioning profile, and the
package/upload path accepted by App Store Connect. Store publication and App
Review remain external evidence; a local build cannot claim either.

### Premium policy

Recording, meeting reading, meeting-scoped Ask, citation playback, and
user-supplied-provider/API-key transcription remain free. Only
Meetless-managed transcription, using a publisher credential that remains
backend-only, requires the RevenueCat entitlement `premium`. The app offers:

- `com.meetless.app.premium.monthly` at the intended US price of `$9.99`;
- `com.meetless.app.premium.annual` at the intended US price of `$79.99`; and
- a seven-day introductory free trial configured in App Store Connect.

Storefront prices and localized presentation come from StoreKit/RevenueCat,
not hard-coded UI strings. The default RevenueCat offering contains monthly
and annual packages. The app supports purchase and restore. A missing,
unconfigured, or unreachable purchase service never grants Premium, but also
does not disable Ask, local meeting evidence, or user-supplied transcription.

### Observed catalog state (2026-08-31)

The following catalog objects were observed in the owner-selected Apple and
RevenueCat configurations. These observations do not prove credentials,
sandbox purchase or restore, webhook delivery, production deployment,
availability, review, or publication.

Apple:

- App ID `6807070739`, bundle ID `com.meetless.app`.
- Subscription group `22348334`.
- Monthly Apple ID `6807071303`, product
  `com.meetless.app.premium.monthly`, US price `$9.99`.
- Annual Apple ID `6807073268`, product
  `com.meetless.app.premium.annual`, US price `$79.99`.
- Both products have seven-day offers observed from 2026-08-31 through `No End
  Date`; Family Sharing is off.
- The quota-number-neutral descriptions are: monthly, `Monthly plan with
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

### Managed-transcription account and quota

The backend derives one billing and quota account from server-verified App
Store subscription lineage. RevenueCat App User ID, renderer entitlement state,
and a client-selected subscriber ID are lookup data, not authorization proof.
The account may enroll at most three Macs. Each installation proves possession
of a distinct revocable device key held by the trusted native host in Keychain.
Restore on a new Mac binds that device to the existing account and shared quota;
it does not reset quota or automatically revoke another Mac. V1 backend
enrollment is macOS-host only, and Family Sharing is disabled.

Monthly and annual products receive one backend-configured allowance in each
subscription-anchored monthly period. The subscriber allowance amount is not
finalized. Production must fail closed and remain undeployable without an
explicit configured subscriber allowance. A non-production hosted canary may
use an explicitly labeled test allowance, never product authority. Annual
allowance is released one monthly period at a time and unused allowance does
not roll over. The seven-day trial receives 18,000 seconds total during the
seven-day trial. Product changes and restore do not reset a current period.
Each period snapshots its configured limit, so a later reduction cannot change
an already-started period.

Admission atomically reserves quota. Settlement is idempotent for the stable
subscriber, audio, and chunk identities: duplicate requests, retries, and
recovery after a crash produce at most one ledger charge. Usage is rounded up
to a whole second. Failed or cancelled work releases its reservation unless the
provider already completed the transcription; a completed result remains
recoverable and settles once even when the client disconnects.

### Duration, temporary data, and expiry

Billable duration comes from one canonical 16 kHz, mono, 16-bit PCM WAV
timeline. The backend validates the WAV structure and derives duration from
sample count; it rejects a conflicting client duration and does not trust
provider-reported usage. Microphone and system audio contribute to one meeting
timeline and are not charged as two overlapping durations.

Recording and canonical timeline preparation may remain entirely local, with no
cloud duration cap in V1. Cloud preparation and upload begin only after an
explicit user action to transcribe with Meetless; recording completion or save
does not trigger an automatic upload. After that action, the single canonical
16 kHz mono PCM16 timeline is physically segmented into ordered
upload/provider chunks of at most 10 minutes, with a shorter final chunk
allowed. Capture chunks created by recording are separate from these transport
or provider chunks, and neither creates another recording, logical billing
timeline, or managed job.

The server validates an immutable manifest with contiguous sample offsets and
counts, rejecting missing, duplicate, overlapping, or otherwise non-contiguous
parts. Duration comes from accepted PCM sample counts. Reservation and
settlement occur once for the logical job, and retry/recovery handling is
idempotent so the logical job cannot be charged twice. V1 managed
transcription does not provide diarization and has no user-facing 60-minute
job cap. Any later safety ceiling requires new owner authority.

Managed audio chunks, orphan uploads, provider output, and transcripts in
transit have a maximum 24-hour TTL. A job lease lasts at most six hours. Audio
is deleted after provider completion once the temporary result is recoverable;
the result is deleted when the Mac acknowledges durable local publication or at
TTL, whichever comes first. Cancellation schedules immediate deletion, failed
jobs may retain input only within the TTL for retry, and cleanup must recover
orphans after interruption. Audio and transcript contents, credentials,
receipts, and raw transactions are forbidden from ordinary logs. Durable
transcripts, citations, and meeting evidence remain owned by local
`MeetingStore`.

A job admitted while entitlement and quota are valid may complete within its
lease after natural entitlement expiry. An App Store-verified grace period is
treated as active. A refund or revocation stops in-flight managed work when
observed and prevents new work. A completed result may still be retrieved
within its TTL; starting or restarting work after the lease requires active
Premium and a new valid admission.

### Convex implementation boundary

The local-first Convex implementation is region-neutral and may proceed
against a local deployment. Bounded audio chunks use Convex-generated upload
URLs and the resulting storage IDs; audio bytes do not travel through HTTP
action bodies. Provider execution remains replaceable, and this boundary does
not change the free Ask or user-supplied/BYOK paths. US East versus EU West is
deferred until before cloud production deployment. Production region,
deployment, credentials, and provider calls remain owner/external gates.

### Runtime and data boundary

The Mac App Store package must preserve ADR0003 and ADR0004 ownership where
compatible with App Sandbox. Writable product state moves inside the app
container unless the user explicitly chooses an export destination through an
App-Sandbox-compatible flow. The app must not assume unrestricted access to
`~/Documents/meetings/` in the store build.

The trusted host owns the native RevenueCat/StoreKit adapter. The renderer sees
only typed product, entitlement, purchase, restore, and error results through an
authenticated host boundary. API keys, receipts, transaction details, and raw
native errors do not enter ordinary logs or durable meeting state. RevenueCat's
public Apple SDK key is supplied at build time and may be embedded in the app;
secret keys are forbidden from the bundle and repository.

### MAS runtime-root preservation

The canonical app-container runtime root is one app-owned preservation unit.
Repository-authorized MAS/package gate operations must never recursively delete
that root or any subtree. A marker inside the root proves only that marker; it
does not prove ownership of the surrounding state. The package transaction
continues to own only the `/Applications` bundle and package identity.

Before a gate writes runtime state, installs, or launches, a plain-data
`MAS_GATE_SESSION_TRANSACTION v2` boundary must acquire its fixed sibling
transaction slot and the stable kernel-backed sibling lock, validate the exact
contract-derived root and parent, reject symlink/path/device/ownership
ambiguity, prove no live owned runtime through its caller-supplied adapter, and
receive an explicit positive free-space requirement. The gate holds that lock
through mutation. It atomically renames the entire existing root into
same-volume quarantine, creates a secure fresh root, and records intent and
rename transitions in a journal outside the root with durable atomic writes.
The parent-side construction intent is durably published before construction
directory creation, and the construction directory is journaled before
publication to the fixed active slot. This makes the post-mkdir/pre-first-
journal crash window discoverable: recovery may recreate the exact absent
directory or adopt only the exact empty construction path bound to that intent;
unexpected bytes remain retained and make the session fail closed. Every
protected move is executed by the persistent native mutation session while it
holds the same sibling kernel lock as `MeetlessHost`, using macOS
`renameatx_np` with `RENAME_EXCL | RENAME_NOFOLLOW_ANY`. The destination is
checked for absence for diagnosis, but no reservation or ordinary-rename
fallback authorizes the move; a race returns kernel `EEXIST` and preserves both
source and destination. Native-helper death before the syscall leaves the
source untouched; death after the syscall is recovered by inspecting both
paths. There is no copy fallback and no recursive removal in this boundary.
Unexpected concurrency, physical boundary ambiguity, or a changed lock
identity retains every remaining root and fails closed.

The native host participates in the same stable sibling lock. With no active
transaction, ordinary direct/production startup remains valid while holding
that lock. With an active transaction, startup requires a one-time durable
handoff bound to the exact owner token, run, fresh-root identity, active slot,
MAS bundle identity, executable bytes, and identity path; the host claims and
holds the lock for its lifetime. The gate may reacquire it only after explicit
stop and absence proof, and every repository lease caller must verify its live
kernel holder before filesystem work. JavaScript may issue only bounded
commands to the native mutation session; it cannot mutate a protected name
after an independent liveness check. The MAS coordinator recognizes the
production H→D→S→W→P→C topology by exact executable/argv evidence, including
the titled `Paseo Supervisor` process and the exact packaged
`vendor/paseo/packages/server/dist/server/server/daemon-worker.js` worker;
listeners, sockets, and open handles are part of the absence observation.
Handoff replay, wrong-root, wrong-bundle, wrong-owner, lock contention, live
descendants, incomplete/malformed evidence, and unknown process inspection all
fail closed. The generic stop command has no ambient MAS-authority bypass and
always refuses the MAS root; only the MAS coordinator owns the stop capability.

After proven stop and package rollback, the boundary reacquires the stable lock,
atomically detaches the fresh root to retained session evidence, and restores
the exact prior root or prior absence. Package identity rollback therefore
precedes runtime restoration. The fresh root and journal remain retained by
default. A completed session may later be archived by sibling rename to free
the fixed active slot; deleting retained evidence is outside this decision and
requires a separate owner-authorized policy. The journal and aggregate
attestation record only the runtime-root transaction contract, metadata,
file-byte digests, literal symlink targets, and hardlink equivalence needed to
detect mutation; they do not record child inventories, credentials, receipts,
or raw private content. Recovery is monotonic and idempotent across every
mkdir, rename, and journal-publication boundary; if exact intent is unavailable
or roots are both, neither, swapped, or changed, all bytes are retained and
the actionable `MAS-GATE-CLEANUP-001` diagnostic directs the operator to leave
roots intact and run status/recovery.

This rollback claim is limited to the entire canonical runtime root. App-group
state, Preferences/Caches outside that root, Keychain, TCC, StoreKit/RevenueCat,
LaunchServices, and remote state are retained and reported; they are neither
cleaned nor claimed rolled back by this transaction.

The repository-authorized MAS installation coordinator requires the exact
release manifest and completes the existing full read-only MAS artifact
validation before beginning the runtime transaction or mutating `/Applications`.
The validator is composed from the repository's complete package validator and
MAS-specific policy: license/notices/package-inputs, symlink/load-path,
signer/profile/entitlements/Mach-O/Electron, contract/marker/pinned candidate
inputs, and exact expected RevenueCat public SDK-key comparison. It returns a
frozen plain `MAS_GATE_ARTIFACT_BINDING v1` containing the manifest hash,
canonical bundle path/fingerprint, artifact/candidate/package-input/artifact-
input/license/signature digests, and only the public-key SHA-256. The package
transaction is `MAS_PACKAGE_TRANSACTION v4`: it also journals the device/inode
identity of every transaction-owned package root and temporary identity file,
and constrains cleanup intent to deterministic transaction-owned siblings. It
receives that DTO, rechecks the source and manifest before staging and before
moving the prior `/Applications` bundle, validates the staged copy, and
requires the installed fingerprint and root identity to equal validated
staging. Package rollback precedes runtime-root restore; every failure retains
or restores pre-existing state and fails closed. An injected validator is a
test seam only; the production command uses the full validator.
This repository boundary does not reserve disk capacity, prevent arbitrary
same-UID shell deletion, establish CI or branch protection, or prove a real
MAS package/sign/install/launch. Those remain separate owner-authorized gates.

### Attempt 12 incident classification

Attempt 12 is classified as unrecoverable loss caused by an unauthorized shape
of repository-authorized MAS cleanup: approximately 829 MB of attempt-created
runtime state was mixed with approximately 37 MB of pre-existing state, and the
aggregate fell from approximately 37,632 KB to approximately 24 KB. The owner
confirmed that no external or manual backup exists. No reconstruction is
claimed. The attempt produced no accepted readiness evidence, all package,
install, launch, and external gates remain closed, and no retry is authorized.
The preservation boundary above is a lasting correction required before any
future gate.

### R5 repository owner decisions

The R5 sandbox acceptance evidence is monthly only and must come from a real
Apple sandbox purchase or an explicit user-selected Restore Purchases action.
The retained fixture adapter and its historical canary path remain available
for repository tests, but a fixture or synthetic successful purchase is not
purchase acceptance evidence. Annual catalog objects and annual behavior remain
intact.

On the real path, StoreKit transaction material stays inside the trusted native
host/plugin orchestration until the server verifies the Apple-signed JWS. The
server derives the billing identity from Apple-verified `originalTransactionId`,
hashes it before persistence, and rejects client-supplied lineage, entitlement,
state, or `appAccountToken` claims. The renderer never receives signed
transactions or secrets. V1 has no Meetless login or account identity.

Restore is an explicit user action and never runs during startup. A restored
installation enrolls its distinct Keychain-backed Mac against the shared
lineage, does not automatically revoke another Mac, and remains bounded to
three distinct Macs. Device management is anonymous and exposes only “This
Mac”, “Another Mac”, enrollment date, last active time, and explicit revoke.

RevenueCat webhooks use HMAC-only authentication in hosted-development and
production. Verification covers the exact `timestamp.raw_body` bytes with
bounded replay tolerance; accepted events are idempotent lifecycle/reconciliation
signals only, and Apple verification remains entitlement authority. Signed
transactions, receipts, secrets, and raw original transaction identifiers are
never logged or durably persisted.

## Consequences

- Existing direct-DMG signing, notarization, Gatekeeper, install-path, and DMG
  proof do not establish Mac App Store readiness.
- Package layout, entitlements, helper inheritance, writable paths, network
  access, TCC attribution, and child-process behavior require fresh sandbox
  validation.
- Managed transcription requires an observable Premium/quota gate and recovery
  path; Ask, BYOK transcription, recording, and evidence access cannot be held
  hostage by purchase-service availability.
- App Store Connect must own the subscription group, products, trial, pricing,
  agreements, tax/banking state, privacy metadata, screenshots, and review
  submission.
- RevenueCat must own the matching app, products, entitlement, offering, and
  project ID. Sandbox purchase and restore evidence are required before upload.

## Verification

The minimum proof is:

1. policy tests proving Ask and BYOK remain free while managed transcription
   fails closed without entitlement, quota, or an enrolled device;
2. native adapter tests for offerings, active entitlement, purchase, restore,
   cancellation, and unavailable service;
3. a fake-backed vertical proof for verified subscription lineage, three-device
   enrollment/revocation, monthly and trial quota, duration validation,
   idempotent settlement, expiry, and 24-hour cleanup;
4. a sandbox-signed package validation proving the exact App Sandbox entitlement
   closure and In-App Purchase capability/configuration;
5. an Apple sandbox purchase and restore on the packaged app;
6. App Store Connect upload/build processing evidence; and
7. App Review submission and eventual store URL as separate external evidence.
