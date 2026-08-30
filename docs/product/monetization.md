# Meetless Premium

## Product boundary

Meetless keeps the trustworthy meeting evidence loop useful without payment.
Users can record, transcribe, read meetings, and play cited audio for free.

Meeting-scoped **Ask** requires an active RevenueCat `premium` entitlement. If
Premium is inactive or purchase status cannot be verified, the app preserves
the meeting and question draft, explains that Ask requires Premium, and offers
the paywall or restore path. It does not send the question to a model.

## Offer

- Monthly subscription: intended US price `$9.99`.
- Annual subscription: intended US price `$79.99`.
- Introductory trial: seven days.

The store is authoritative for localized prices, eligibility, billing terms,
renewal, and trial presentation. UI must display the values returned by
StoreKit/RevenueCat and must not imply a trial when the current customer is not
eligible.

## Required user controls

- View monthly and annual packages.
- Start a purchase from an explicit user action.
- Restore purchases.
- Dismiss the paywall without losing meeting context.
- Retry after a recoverable store error.
- Continue using every free feature when purchase services are unavailable.

Cancellation is not an error and never grants Premium. Restore or customer-info
refresh grants Ask only when the `premium` entitlement is active.
