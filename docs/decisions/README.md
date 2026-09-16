# Decisions

> **Current status — 2026-09-16:** Current V1 and Mac App Store development is
> paused pending the owner's final shutdown-or-pivot decision.
> [ADR0007](0007-stop-v1-pending-product-direction.md) is the current authority
> for whether
> work may continue. Earlier ADRs remain useful historical records and continue
> to preserve safety, ownership, privacy, and data-boundary constraints; they
> do not authorize new builds, deployments, provider experiments, or release
> submissions while the decision is pending.

Historical MAS build/install/relaunch instructions are retained in the
[development guide](../macos-development.md); they are not current operating
authorization. Historical coordinator and transaction instructions are not the
ordinary development route.

The following lasting decisions remain recorded. If work resumes, it must also
inherit the current continuation boundary in ADR0007:

- [0007: Pause V1/App Store development pending product direction](0007-stop-v1-pending-product-direction.md)
- [0001: Maintain Paseo separately and pin it in Meetless](0001-maintained-paseo-fork.md)
- [0002: Distribute Meetless directly as a notarized macOS DMG (superseded)](0002-direct-notarized-macos-dmg.md)
- [0003: Meetless runtime isolation and host ownership](0003-meetless-runtime-isolation-and-host-ownership.md)
- [0004: Recording host and capture permission boundary](0004-recording-host-and-capture-permission-boundary.md)
- [0005: Distribute Meetless through the Mac App Store with RevenueCat (historical, suspended)](0005-mac-app-store-and-revenuecat.md)
- [0006: MAS development desktop integration (historical, suspended)](0006-mas-development-desktop-integration.md)
