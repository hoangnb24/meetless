# bd-1nqb: Recordit.app Build-System Strategy Decision

Date: 2026-03-05
Status: Accepted
Related bead: `bd-1nqb`
Superseding policy context: `docs/adr-005-recordit-default-entrypoint.md`
Release posture context: `docs/bd-1mep-v1-release-posture.md`

## Decision

Use an **Xcode project/app-target workflow** as the canonical build system for
`Recordit.app` (user-facing app), with `xcodebuild` as the CI/test driver.

`SwiftPM` remains useful for package/module reuse and non-app smoke tooling, but
is not the primary app packaging workflow.

This build-system decision does **not** imply App Sandbox as the v1 release
posture. Xcode is the canonical app build/test toolchain; the v1 release posture
is defined separately by `docs/bd-1mep-v1-release-posture.md`.

## Why This Decision

Current repository reality:
- checked-in `Recordit.xcodeproj` now exists for the app target and scheme-driven workflow
- there is still no `Package.swift`-based app-packaging workflow for a signed GUI target
- transitional packaging history still includes Makefile-driven Rust bundling surfaces (especially `SequoiaTranscribe.app`) that must remain non-default

Product-direction requirement:
- `docs/adr-005-recordit-default-entrypoint.md` defines `Recordit.app` as the
  canonical user-facing default

Given those constraints, Xcode app targets are the shortest path to reliable:
- macOS app lifecycle + entitlements/plists/signing
- XCTest/XCUITest integration (`bd-8du2`, `bd-3sko`, `bd-1aqk`, `bd-b4h6`)
- notarization/Gatekeeper-ready release automation

## Tradeoff Summary

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Xcode app target + `xcodebuild` | Native macOS app packaging/signing/notarization support; first-class XCTest/XCUITest; stable scheme-based CI | Requires project/scheme maintenance and `xcodebuild` discipline | **Chosen** |
| SwiftPM app workflow as primary | Simple package graph for Swift modules; good CLI ergonomics | Weaker fit for full macOS app distribution/signing/XCUITest lanes; more custom glue needed for release-grade app packaging | Not chosen as primary |

## Implementation Constraints (Local + CI)

1. Canonical app build/test path must be `xcodebuild`-driven once `Recordit.app`
   target exists (`bd-3vwh` / `bd-1e1h`).
2. Make targets should wrap `xcodebuild` (not bypass it) for app build/run
   ergonomics (`bd-ph9o`, `bd-1gx5`).
3. CI must use deterministic `xcodebuild` invocation with explicit scheme,
   destination, and derived-data path so results are reproducible.
4. App-level proof must come from XCTest/XCUITest artifacts, not only module-level
   smoke binaries (`bd-8du2`, `bd-3sko`).
5. Legacy `SequoiaTranscribe.app` scripts remain compatibility/fallback-only and
   must stay explicitly non-default per ADR-005.
6. Xcode-based app packaging must be interpreted in the release context defined by
   `docs/bd-1mep-v1-release-posture.md`, not as implicit proof that the product
   should ship with App Sandbox enabled.

## Required Follow-On Work

1. Create `Recordit.app` @main target and scheme (`bd-3vwh`).
2. Build real app target wiring (`bd-1e1h`).
3. Add `make build-recordit-app` / `make run-recordit-app` wrappers (`bd-ph9o`).
4. Retarget packaging/signing/notarization to Recordit artifact paths (`bd-1gx5`,
   `bd-yu7n`, `bd-slew`).
5. Land app-level XCTest/XCUITest lanes (`bd-8du2`, `bd-3sko`, `bd-1aqk`,
   `bd-b4h6`, `bd-3c0x`).

## Non-Goals for This Bead

- Creating the actual `.xcodeproj` / app target
- Rewriting all packaging scripts in this change
- Declaring release-readiness for Recordit.app distribution

This bead locks the strategy so downstream implementation can proceed without
build-system ambiguity.
