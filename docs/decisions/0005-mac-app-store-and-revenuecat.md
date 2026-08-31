# 0005 Distribute Meetless Through The Mac App Store With RevenueCat

Date: 2026-08-30; amended 2026-08-31

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

### Managed-transcription account and quota

The backend derives one billing and quota account from server-verified App
Store subscription lineage. RevenueCat App User ID, renderer entitlement state,
and a client-selected subscriber ID are lookup data, not authorization proof.
The account may enroll at most three Macs. Each installation proves possession
of a distinct revocable device key held by the trusted native host in Keychain.
Restore on a new Mac binds that device to the existing account and shared quota;
it does not reset quota or automatically revoke another Mac. V1 backend
enrollment is macOS-host only, and Family Sharing is disabled.

Monthly and annual products receive 180,000 seconds in each
subscription-anchored monthly period; annual allowance is released one monthly
period at a time and unused allowance does not roll over. The seven-day trial
receives 18,000 seconds. Product changes and restore do not reset a current
period. Each period snapshots its configured limit, so a later reduction cannot
change an already-started period.

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
