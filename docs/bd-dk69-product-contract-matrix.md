# bd-dk69: Product Contract Matrix (Spec Clauses -> Shipped Artifact Obligations)

Date: 2026-03-05

## Purpose

This matrix prevents "implemented in modules" from being mistaken for "shipped to users" by
requiring three explicit proof classes per UX clause:

1. Implementation obligation (code/module ownership)
2. App-level validation obligation (XCTest/XCUITest or equivalent app-surface proof)
3. Release/distribution obligation (DMG/signing/notarization/rehearsal evidence)

Canonical sources:
- `plan/recordit-user-interfaces-journey.md`
- `docs/adr-005-recordit-default-entrypoint.md`
- `docs/bd-2n6m-traceability-matrix.md`

## Proof Class Definitions

| Proof Class | Meaning | Typical Evidence |
|---|---|---|
| `Implementation` | Behavior exists in code with owning module(s) | `app/**` modules + targeted smoke/integration coverage |
| `AppValidation` | Behavior is proven in app-target validation | XCTest/XCUITest targets/results (or explicitly tracked gap bead) |
| `ReleaseEvidence` | User-distribution lane proves the behavior in release flow | release checklist, signing/notarization logs, DMG/rehearsal artifacts |

## Contract Matrix

| Clause ID | UX Clause (Spec) | Implementation Obligation | AppValidation Obligation | ReleaseEvidence Obligation | Proof Class Status |
|---|---|---|---|---|---|
| UX-US-01 | DMG-first install and launch without terminal | `Recordit.app` default policy + packaging cutover tasks (`bd-1gx5`, `bd-slew`, `bd-d987`) | App target launch/install validation lane (`bd-3sko`, `bd-8du2`, `docs/bd-3sko-xctest-xcuitest-closeout.md`) | DMG checklist + signing/notarization + rehearsal (`docs/bd-b2qv-release-checklist.md`, `docs/bd-1uik-ga-signing-notarization-plan.md`, `docs/bd-55np-release-rehearsal-report.md`) | Implementation: `Covered` AppValidation: `Covered` ReleaseEvidence: `Covered (beta lane)` |
| UX-US-02 | First launch onboarding for permissions/model setup | `app/AppShell/*`, `app/Preflight/*`, `app/Services/FileSystemModelResolutionService.swift` | Onboarding XCUITest obligations (`bd-1aqk`, `bd-3c0x`) + app integration suite (`bd-8du2`) | Rehearsal/support evidence (`docs/bd-55np-release-rehearsal-report.md`, `bd-1b1k`) | Implementation: `Covered` AppValidation: `Covered` ReleaseEvidence: `Partial` |
| UX-US-03 | In-window start/stop/review workflow | `app/ViewModels/RuntimeViewModel.swift`, `app/Navigation/*`, process lifecycle integration | Runtime XCUITest path (`bd-b4h6`, `bd-2ghc`) + app integration target (`bd-8du2`) | Release rehearsal references runtime lifecycle proof + failure handling (`docs/bd-55np-release-rehearsal-report.md`, `docs/bd-3b1j-rollback-support-runbook.md`) | Implementation: `Covered` AppValidation: `Covered` ReleaseEvidence: `Partial` |
| UX-US-04 | Mode selection (`Live Transcribe` vs `Record Only`) | Runtime/pending services (`app/ViewModels/RuntimeViewModel.swift`, `app/Services/PendingSessionTranscriptionService.swift`) | App-level mode-switch validation in integration/XCUITest lanes (`bd-8du2`, `bd-b4h6`) | Rehearsal and support docs encode mode-specific validation/remediation (`docs/bd-55np-release-rehearsal-report.md`, `bd-1b1k`) | Implementation: `Covered` AppValidation: `Partial` ReleaseEvidence: `Partial` |
| UX-US-05 | Offline record-now/transcribe-later continuity | Pending transition and notification services (`bd-xknj`, `bd-125h`, `bd-2i3h`) | Sessions-summary XCUITest obligations (`bd-2ghc`) + app target tests (`bd-8du2`) | Release/support matrix must include offline fallback and recovery (`bd-55np`, `bd-1b1k`) | Implementation: `Covered` AppValidation: `Planned` ReleaseEvidence: `Planned` |
| UX-ARCH-01 | UI consumes structured artifacts (no terminal parsing) | JSONL/manifest service boundaries (`app/Services/FileSystemJsonlTailService.swift`, `app/Services/JsonlEventSurfaceMapper.swift`) | App integration target validates boundary adherence (`bd-8du2`) | Release runbook references artifact contracts, not terminal text parsing (`docs/runtime-contract-inventory.md`) | Implementation: `Covered` AppValidation: `Planned` ReleaseEvidence: `Partial` |
| UX-STATUS-01 | Final status is manifest-driven (`OK/Degraded/Failed`) | Manifest mapping and bounded finalization (`app/RuntimeStatus/ManifestFinalStatusMapper.swift`, runtime stop/finalization flows) | App-level assertions for stop/finalize + recovery (`bd-b4h6`, `bd-3c0x`) | Rehearsal and rollback docs capture manifest-driven go/no-go semantics (`docs/bd-3b1j-rollback-support-runbook.md`) | Implementation: `Covered` AppValidation: `Planned` ReleaseEvidence: `Partial` |
| UX-SEC-01 | Export/privacy diagnostics are explicit and deterministic | Export view model + diagnostics schema/redaction docs (`bd-2hxr`, `bd-1tuy`, `bd-2snv`) | App-level export journey validation (`bd-2ghc`) | Release/support docs must include privacy-safe support workflow (`bd-1b1k`, `bd-55np`) | Implementation: `Covered` AppValidation: `Planned` ReleaseEvidence: `Planned` |
| UX-ACC-01 | Accessibility IDs/focus/shortcuts are first-class | Accessibility contracts + bindings (`bd-3lkr`, `bd-1ud0`) | XCTest/XCUITest accessibility verification (`bd-8du2`, `bd-3sko`) | Release readiness checklist includes accessibility proof links before GA signoff (`bd-55np`) | Implementation: `Partial` AppValidation: `Planned` ReleaseEvidence: `Planned` |

## Operating Rule

Do not mark a UX clause "shipped" unless all three proof classes are satisfied or a
waiver is explicitly documented with owner/date and rollback conditions.
