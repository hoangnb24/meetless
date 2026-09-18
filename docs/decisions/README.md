# Decisions

> **Current status — 2026-09-18:** [ADR0008](0008-desktop-managed-ai-pivot.md)
> records E1 policy and subsequent bounded E2 code/build/install/OpenAI/TestFlight
> authority, with no experience cost ceiling. Human selected `gpt-5.6-luna`,
> accepted disclosed OpenAI retention, and authorized Sandbox deploy/config.
> Non-conflicting safety constraints and the pause outside
> E2 remain; this is not App Review, production deployment, or release authority.

Historical MAS build/install/relaunch instructions are retained in the
[development guide](../macos-development.md); they are not current operating
authorization. Historical coordinator and transaction instructions are not the
ordinary development route.

The following lasting decisions remain recorded. Continuation must respect
ADR0008's bounded authority and the remaining ADR0007 pause:

- [0008: Desktop managed-AI pivot (E1 policy approved)](0008-desktop-managed-ai-pivot.md)
- [0007: Pause V1/App Store development pending product direction](0007-stop-v1-pending-product-direction.md)
- [0001: Maintain Paseo separately and pin it in Meetless](0001-maintained-paseo-fork.md)
- [0002: Distribute Meetless directly as a notarized macOS DMG (superseded)](0002-direct-notarized-macos-dmg.md)
- [0003: Meetless runtime isolation and host ownership](0003-meetless-runtime-isolation-and-host-ownership.md)
- [0004: Recording host and capture permission boundary](0004-recording-host-and-capture-permission-boundary.md)
- [0005: Distribute Meetless through the Mac App Store with RevenueCat (historical, suspended)](0005-mac-app-store-and-revenuecat.md)
- [0006: MAS development desktop integration (historical, suspended)](0006-mas-development-desktop-integration.md)
