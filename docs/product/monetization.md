# Meetless Premium

## Product boundary

Meetless keeps the trustworthy meeting evidence loop useful without payment.
Users can record, read meetings, use meeting-scoped Ask, play cited audio, and
transcribe with a provider and API key they supply themselves without payment.

RevenueCat `premium` gates only **Meetless-managed transcription**, where
Meetless supplies and protects the transcription-provider credential. If
Premium is inactive, purchase status cannot be verified, or the managed quota
is exhausted, the app preserves the meeting and recording, explains why
managed transcription is unavailable, and offers the appropriate purchase,
restore, or quota-status path. Ask and user-supplied transcription remain
available.

## Transcription routing

**Transcribe** is an explicit action for each saved recording, with cloud
disclosure and consent in that flow. Stop only saves audio; saved without a
transcript is a normal completed state. Premium, previous consent, relaunch,
and a quota reset never start upload or transcription automatically.
Meetless selects the route at its trusted boundary:

| Available access | Route |
| --- | --- |
| A valid user-supplied provider/API key is configured | Use that BYOK route without Premium or managed quota. |
| No valid BYOK is configured and Premium is active | Use Meetless-managed transcription through Convex. |
| No valid BYOK is configured and Premium is inactive | Keep the audio local and offer purchase or restore; do not call a transcription provider. |
| Purchase status cannot be verified | Keep the audio local and expose recovery; do not grant managed access or call a transcription provider. |

The first release defers BYOK entry and credential-management UI, so its
**Transcribe** action uses the Premium managed route. Recording, saving, and
playback remain free. This delivery scope does not remove future free BYOK
precedence or change the free Ask and citation policy.

For the managed route, the app uploads to Meetless Cloud and Convex invokes
OpenAI Transcription using a Meetless-owned provider credential stored only in
the backend environment. The user does not choose a provider, supply a key, or
manage that credential. The app and its Keychain must not contain or read the
Meetless-owned OpenAI credential. A Keychain-held per-device signing key may be
used only to authenticate an enrolled Mac to Meetless Cloud; it is not a
transcription-provider credential.

## Managed transcription preparation

Recording and canonical timeline preparation may remain entirely local; V1 does
not impose a cloud duration cap on that work. Cloud preparation and upload
begin only after the user explicitly chooses Meetless-managed transcription for
the recording. Completing or saving a recording never uploads it automatically.

Both the saved local MP3 and canonical WAV remain with every retained recording,
including after successful transcription. Quota exhaustion, errors,
cancellation, and elapsed time do not delete either file; only the user's
recording or meeting deletion does. This local source retention preserves data
for explicit transcription or retry without changing the one-logical-job,
no-double-charge, or no-automatic-transcription rules. It does not authorize
transcript overwrite or a new paid re-transcription flow.

Before upload, check that remaining managed allowance covers the whole
recording. If it does not, explain the limit, do not process a partial recording,
and preserve local audio for a later explicit attempt when allowance is
available.

After that action, the one logical canonical timeline is physically segmented
into ordered upload/provider chunks of at most 10 minutes; the final chunk may
be shorter. Recording-internal capture chunks, these upload/provider chunks,
and the single logical billing timeline are distinct concepts. Physical
segmentation does not create multiple billable timelines or managed jobs.

Within one explicit transcription attempt, the backend sends each physical
part to OpenAI at most once and awaits that part's response within the bounded
provider action. If a part times out or otherwise cannot return successfully,
the logical transcription fails, the saved local audio remains intact, and the
app says that transcription cannot be completed. The backend must not
automatically resubmit a provider call whose outcome is uncertain, and V1 does
not add a separate per-part recovery product. This decision neither adds nor
removes the existing user-initiated Retry control; any change to that control
or its cost semantics requires new owner authority.

The backend accepts an immutable manifest for that logical timeline and
rejects missing, duplicate, or overlapping parts and non-contiguous sample
offsets or counts. It derives duration from accepted 16 kHz mono PCM16 sample
counts, reserves and settles quota once for the logical job, and makes retries
and recovery idempotent so they cannot double-charge. V1 managed transcription
does not provide diarization. There is no user-facing 60-minute managed-job
cap in V1; any later safety ceiling requires new owner authority.

## Offer

- Monthly subscription: intended US price `$9.99`.
- Annual subscription: intended US price `$79.99`.
- Introductory trial: seven days with five hours of managed transcription.

Monthly and annual subscribers receive **eight hours (28,800 seconds)** of
managed transcription in each subscription-anchored monthly quota period,
approved by the product owner for issue #11 on 2026-09-12. Production must fail
closed and remain undeployable unless this subscriber allowance is explicitly
configured. A non-production hosted canary may use an explicitly
labeled test allowance; that test value is never product authority. Annual
subscribers receive a new configured allowance each month rather than the full
annual allowance at once. Unused allowance does not roll over. Changing
products or restoring a purchase does not reset the current quota period. A
configured allowance change applies only to the next period; an already-
started period keeps its snapshotted limit.

Managed usage is charged in whole seconds from server-verified audio duration.
Retries of the same audio do not charge twice. A failed or cancelled job is not
charged unless the transcription provider already completed the work; a
completed result remains recoverable if the app disconnects before receiving
it.

The store is authoritative for localized prices, eligibility, billing terms,
renewal, and trial presentation. UI must display the values returned by
StoreKit/RevenueCat and must not imply a trial when the current customer is not
eligible.

## Required user controls

- View monthly and annual packages.
- Start a purchase from an explicit user action.
- Restore purchases.
- View the current managed-transcription allowance, usage, and reset date.
- View and revoke enrolled Macs when the three-device limit is reached.
- Dismiss the paywall without losing meeting context.
- Retry after a recoverable store error.
- Continue using every free feature when purchase services are unavailable.

When Transcribe is blocked by missing Premium, offer purchase or restore in the
recording context. A successful purchase updates Premium automatically without
manual Refresh. The user selects **Transcribe** again; the app does not resume
the earlier request automatically.

Cancellation is not an error and never grants Premium. Restore or customer-info
refresh grants managed transcription only when the `premium` entitlement is
active or the App Store reports an active grace period. One verified
subscription may enroll at most three Macs. Restoring on a new Mac shares the
same quota account and does not automatically revoke an existing Mac.

A managed job admitted while Premium is active may finish within its six-hour
job lease if the entitlement expires naturally. A refund or revocation stops
the managed job when observed. New jobs require active Premium, available
quota, and an enrolled Mac. Family Sharing is not supported for V1.

Managed audio and provider output are temporary backend data. The app states
that they are deleted within 24 hours; a result is deleted sooner after the app
acknowledges durable local publication. The durable transcript, citations, and
meeting evidence remain on the user's Mac. This backend 24-hour deletion rule
does not apply to the retained local MP3 or canonical WAV.
