# 0005 Distribute Meetless Through The Mac App Store With RevenueCat

Date: 2026-08-30; amended 2026-09-13

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

Stop only saves local audio; saved without a transcript is normal completion.
The user selects **Transcribe** separately for each recording, with cloud
disclosure and consent in that flow. Premium, previous consent, relaunch, and
quota reset never start upload or transcription automatically. Missing Premium
offers purchase or restore in the recording context. A successful purchase
updates Premium without manual Refresh, but the user must select Transcribe
again; the app does not resume the earlier request automatically.

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
finalized. Cost analysis and an explicit product-owner decision are required
before choosing the paid allowance; no number is approved. Production must fail closed and remain undeployable without an
explicit configured subscriber allowance. A non-production hosted canary may
use an explicitly labeled test allowance, never product authority. Annual
allowance is released one monthly period at a time and unused allowance does
not roll over. The seven-day trial receives 18,000 seconds total during the
seven-day trial. Product changes and restore do not reset a current period.
Each period snapshots its configured limit, so a later reduction cannot change
an already-started period.

Before upload, the remaining managed allowance must cover the whole recording.
If it does not, explain the limit, do not process a partial recording, and retain
local audio for a later explicit attempt when allowance is available.

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

The owner decision of 2026-09-13 retains both the saved local MP3 and canonical
WAV for every retained recording, including after successful transcription.
Neither quota exhaustion, failure, cancellation, nor elapsed time deletes these
local files; they are deleted only with the user's recording or meeting
deletion. This supersedes any earlier 24-hour local-WAV retention rule. Keeping
source audio available does not change the one-logical-job, idempotent billing,
or explicit Transcribe rules, and does not authorize automatic reruns,
transcript overwrite, or a new paid re-transcription flow.

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

Backend-managed audio chunks, orphan uploads, provider output, and transcripts
in transit have a maximum 24-hour TTL. This backend expiry does not apply to
the retained local MP3 or canonical WAV. A job lease lasts at most six hours. Audio
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
not change the free Ask or user-supplied/BYOK paths. On 2026-09-14 the owner
selected US East (`aws-us-east-1`) for cloud production.
The owner also selected separate hosted backends for Apple Sandbox
(TestFlight/App Review) and Production, with isolated billing/quota data. The
server must verify the Apple environment before granting access; client
environment hints alone are never authorization. Endpoint routing and webhook
dispatch must preserve this separation. The existing development deployment
and its data remain intact. The exact sandbox target is still to be recorded.
Deployment, credentials, and provider calls remain owner/external gates.

The V1 **Transcribe** route is Meetless-managed
transcription. The app sends the saved recording to the Meetless Convex
deployment, and a Convex backend action calls OpenAI Transcription using the
Meetless-owned provider credential. That credential is backend-only: it is not
embedded in the app, stored in the app Keychain, or read through the native
OpenAI transcription capability. The enrolled Mac's Keychain-backed device key
may sign managed-auth challenges but cannot authorize or execute provider calls
by itself.

When a valid user-supplied provider/API key exists, the routing boundary selects
BYOK before managed transcription and bypasses RevenueCat entitlement and
managed quota. V1 defers its settings and credential-entry UI; the shipped
Transcribe action has no provider choice and uses the Premium managed Convex
route. Recording, saving, and playback remain free. This delivery scope does
not remove future free BYOK policy or change Ask and citation behavior.

### Runtime and data boundary

The Mac App Store package must preserve ADR0003 and ADR0004 ownership where
compatible with App Sandbox. Writable product state moves inside the app
container unless the user explicitly chooses an export destination through an
App-Sandbox-compatible flow. The app must not assume unrestricted access to
`~/Documents/meetings/` in the store build.

Owner approval, 2026-09-13: the host may request read/write access to the
selected coding agent's existing configuration/authentication resources through
the macOS system chooser and persist security-scoped app bookmarks. The parent
may carry `com.apple.security.files.user-selected.read-write` and
`com.apple.security.files.bookmarks.app-scope`; runtime children retain sandbox
inheritance. Restore granted scopes before launching those children. This does
not authorize whole-home access, copying credentials, or moving Meetless's
product state or isolated Paseo state. Folder access alone does not prove
provider authentication, including access to macOS Keychain entries.

Owner approval, 2026-09-15: the same host-owned chooser/bookmark mechanism
may select and remember the user's existing Codex executable when discovery
fails in the Store app. Keep executable and configuration grants separate;
restore both before child startup and use the selected absolute executable
through Paseo's command override. This does not authorize bundling/downloading
Codex, broad directory grants, credential copies or shell/global PATH changes.
Actual executable launch, model loading and an Ask response must be checked on
the Apple-distributed candidate before accepting this repair.

Executable media tools are not writable product state. In the Mac App Store
build, the runtime executes ffmpeg and ffprobe only from the host-verified,
signed app-bundle media closure, with the inherited child App Sandbox
entitlements. It validates the complete sibling `bin`/`lib` closure before use
and must not execute a copied or updated binary from the writable app container.
The direct-DMG media update snapshot remains owned by ADR0002 and is not changed
by this MAS-specific rule. A previously created container snapshot may remain
as preserved runtime data, but it is not an executable input and this decision
does not authorize its cleanup.

The trusted host owns the native RevenueCat/StoreKit adapter. The renderer sees
only typed product, entitlement, purchase, restore, and error results through an
authenticated host boundary. API keys, receipts, transaction details, and raw
native errors do not enter ordinary logs or durable meeting state. RevenueCat's
public Apple SDK key is supplied at build time and may be embedded in the app;
secret keys are forbidden from the bundle and repository.

### Local MAS development loop

The owner-approved development route is the simple loop accepted on 2026-09-10:
`npm run dev:mas` builds and signs, validates and publishes the artifact to
ignored durable storage, replaces the installed development app, opens it
through LaunchServices, and verifies the real Meetless plugin. Ordinary
relaunch uses `npm run dev:mas:launch`, without build, install, or data reset.
See [the current development guide](../macos-development.md) before operating
an app or runtime.

The fresh loop recursively deletes the canonical app-container runtime. It is
permitted only for disposable test state whose reset the owner has authorized.
An earlier reset authorization does not make later recordings disposable.
Use `npm run dev:mas:update` to preserve data, with retained app/runtime backups
and the stable host lock held during replacement; `-- --reuse-current` revalidates
and installs the existing candidate without rebuilding. Do not fall back to the
legacy coordinator or invent a transaction framework.
Legacy session remnants block the simple route and require separately scoped
disposition. This decision grants no deletion of recordings, retained evidence,
Keychain, TCC, purchase state, or unrelated container state.

The [historical execution snapshot](../plans/history/v1-paseo-foundation-through-2026-09-12.md#human-authorized-simplified-mas-development-flow-2026-09-10)
retains the superseded coordinator/recovery work and its incident context.
Its transaction-v3 proposal and automatic recovery design were explicitly
rejected. Historical run instructions and one-time reset permissions are not
current operating instructions. Active work and any unresolved session are
recorded in [the active plan](../plans/active/v1-paseo-foundation.md).

### Release and security validation remains required

Simplifying development does not weaken strict release/App Store validation.
Complete read-only artifact validation remains required before installation,
with the installed signed closure rechecked before launch. The exact candidate, manifest and installed signed closure still require their
existing validation: package inputs and pinned dependencies; licenses/notices;
symlinks and load paths; signer, profile, entitlements, Mach-O and Electron;
installation contract and marker; and the expected RevenueCat public SDK key.
Preserve exact artifact identity and provenance through packaging, installation
and the actual consumer. A fixture or successful startup is not production
acceptance; use the [production-evidence rule](../patterns/production-evidence.md).
Store purchase, restore, upload and publication remain separate evidence gates.

The current interactive macOS account and deliberate same-UID processes remain
trusted for the development boundary. Detect malformed, stale, partial, path,
identity, permission and artifact changes; this is not protection against a
malicious same-UID process rewriting a self-consistent package and its evidence.
This limit does not relax receipt opacity, artifact validation, signature
rechecks or fail-closed handling of ambiguous state. New trust anchors or
release/security policy require separate owner authority.

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

### Production preparation decisions — 2026-09-14

The owner approved 1,800 seconds for each store-testing Sandbox allocation,
including trial; production remains 28,800 seconds per monthly allocation and
18,000 seconds for the trial. Accelerated Sandbox clocks and snapshotted
period limits remain unchanged. This supersedes historical unfinalized paid
allowance wording above; product/monetization.md holds the current offer.

For background subscription reconciliation, use authenticated RevenueCat
webhook delivery as the trigger and verify current subscription/renewal status
with Apple before acknowledging successful reconciliation. Use any raw Apple
lookup identifier and signed material only transiently in memory. Persist only
normalized verified state and privacy-safe idempotency records; never pass raw
transaction IDs or JWS to a durable scheduler. Temporary Apple failures return
a retryable non-success response so RevenueCat can redeliver. The owner accepts
manual recovery after the provider's delivery retries are exhausted; indefinite
automatic recovery is not required for this V1 path. RevenueCat remains a
signal, and Apple remains entitlement authority. This decision authorizes the
implementation, not a claim that real webhook/Apple verification already passed.

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
