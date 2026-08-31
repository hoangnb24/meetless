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

## Offer

- Monthly subscription: intended US price `$9.99`.
- Annual subscription: intended US price `$79.99`.
- Introductory trial: seven days with five hours of managed transcription.

Monthly and annual subscribers receive 50 hours of managed transcription in
each subscription-anchored monthly quota period. Annual subscribers receive a
new 50-hour allowance each month rather than the full annual allowance at once.
Unused allowance does not roll over. Changing products or restoring a purchase
does not reset the current quota period. A configured allowance change applies
only to the next period; an already-started period keeps its assigned limit.

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
meeting evidence remain on the user's Mac.
