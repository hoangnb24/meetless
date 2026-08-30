# 0005 Distribute Meetless Through The Mac App Store With RevenueCat

Date: 2026-08-30

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

Recording, transcription, meeting reading, and citation playback remain free.
Meeting-scoped Ask is available only while the RevenueCat entitlement
`premium` is active. The app offers:

- `com.meetless.app.premium.monthly` at the intended US price of `$9.99`;
- `com.meetless.app.premium.annual` at the intended US price of `$79.99`; and
- a seven-day introductory free trial configured in App Store Connect.

Storefront prices and localized presentation come from StoreKit/RevenueCat,
not hard-coded UI strings. The default RevenueCat offering contains monthly
and annual packages. The app supports purchase and restore. A missing,
unconfigured, or unreachable purchase service never grants Premium.

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
- Ask requires an observable Premium gate and recovery path; recording and
  evidence access cannot be held hostage by purchase-service availability.
- App Store Connect must own the subscription group, products, trial, pricing,
  agreements, tax/banking state, privacy metadata, screenshots, and review
  submission.
- RevenueCat must own the matching app, products, entitlement, offering, and
  project ID. Sandbox purchase and restore evidence are required before upload.

## Verification

The minimum proof is:

1. policy tests proving free features remain available and Ask fails closed
   without `premium`;
2. native adapter tests for offerings, active entitlement, purchase, restore,
   cancellation, and unavailable service;
3. a sandbox-signed package validation proving the exact App Sandbox entitlement
   closure and In-App Purchase capability/configuration;
4. an Apple sandbox purchase and restore on the packaged app;
5. App Store Connect upload/build processing evidence; and
6. App Review submission and eventual store URL as separate external evidence.
