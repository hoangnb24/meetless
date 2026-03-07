# bd-34yb — Comprehensive non-mock critical-journey verification lanes

Date: 2026-03-07
Related bead: `bd-34yb`
Parent epic: `bd-204a`
Key upstream sources:
- `docs/bd-2elo-canonical-test-inventory-and-realism-matrix.md`
- `docs/bd-39i6-critical-surface-coverage-matrix.md`
- `docs/bd-39i6-critical-path-test-realism-inventory.md`
- `docs/bd-2mbp-no-mock-critical-path-policy.md`
- `docs/bd-k993-coverage-claim-policy.md`
- `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`
- `docs/bd-2gw4-release-posture-and-build-context-parity.md`

## Purpose

Define the **minimum comprehensive non-mock verification suite** for Recordit’s critical journeys.

This feature does not replace unit tests, smoke tests, scripted XCUITest, fixture-backed Rust integration tests, or packaged smoke gates. Those lanes remain valuable for fast regression detection and bounded contract coverage.

What this feature adds is a higher bar:

> the smallest set of lanes that must exist before the project can truthfully claim that its critical journeys are covered beyond seam-heavy simulation.

## Non-mock means more than “no Mock class”

For this suite, a lane is **not** considered non-mock if it relies on any of the currently known realism-capping seams from `docs/bd-2mbp-no-mock-critical-path-policy.md` and `docs/bd-39i6-critical-surface-coverage-matrix.md`.

A lane is disqualified from the comprehensive suite if it depends on any of the following:

- `RECORDIT_UI_TEST_MODE`
- `AppEnvironment.preview()`
- `Mock*`, `Stub*`, `Static*`, or `Scripted*` service substitution for the critical path being claimed
- `/usr/bin/true` or similar placeholder runtime/model overrides
- `RECORDIT_FAKE_CAPTURE_FIXTURE`
- frozen manifests, JSONL, or session roots standing in for the journey’s primary product output
- temp-filesystem-only stand-ins when the claim is about packaged or installed product behavior

Interpretation rule:
- a lane may still be useful and retained-rich while using one of these seams
- that lane simply does **not** count toward the comprehensive non-mock suite

## What this suite must prove

The suite is intentionally scoped to the journeys users and release owners actually care about:

1. the app can be launched in its real product posture
2. the first-run and returning-user paths behave correctly without preview/UI-test-mode shortcuts
3. the app can enter the correct live or record-only mode based on real readiness
4. a real session can be created, finalized, and consumed by downstream product surfaces
5. the packaged and installed artifact path behaves correctly, not just the Xcode path
6. the release surface can be validated without downgrading to docs-only or fixture-only evidence

## Required suite-wide invariants

Every lane in the comprehensive suite must satisfy all of the following:

- runs in an explicitly named context: `developer`, `packaged-local`, or `release-candidate`
- retains evidence that can be interpreted through `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`
- names any remaining realism constraint directly instead of hiding it behind a pass result
- fails closed for missing prerequisites that invalidate the claim; silent downgrade-to-skip is not sufficient for certification-level wording
- proves one whole journey or one whole release surface, not a narrow sub-step marketed as end-to-end

## Minimum comprehensive lane set

The table below defines the minimum lane set for truthful non-mock critical-journey coverage.

| Lane ID | Required journey or surface | Required execution context | What the lane must prove | Disallowed seams | Current nearest evidence | Current status | Primary follow-on beads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NM-01` | production app first launch and onboarding progression | `developer` app context or stronger | launch `Recordit.app`, resolve real startup wiring, complete onboarding progression, and land in the intended runtime shell without preview or UI-test-mode environment swaps | `RECORDIT_UI_TEST_MODE`, `AppEnvironment.preview()`, `Stub*` onboarding/runtime services | `app/RecorditAppUITests/RecorditAppUITests.swift`, `app/AppShell/onboarding_completion_smoke.swift`, newer production-backed XCTest work in `app/RecorditAppTests/RecorditAppTests.swift` | `partial` | `bd-2ph4`, `bd-tr8z`, `bd-29ig` |
| `NM-02` | live-blocked fallback to Record Only in production app path | `developer` app context or stronger | show that real readiness results drive the correct fallback affordances and that Record Only actually launches without simulation seams | scripted preflight envelopes, UI-test-mode fixtures, preview DI | `app/RecorditAppUITests/RecorditAppUITests.swift`, `app/Preflight/preflight_gating_smoke.swift` | `partial` | `bd-tr8z`, `bd-2a08`, `bd-826y`, `bd-2arj` |
| `NM-03` | production app live start → stop → finalize journey | `developer` app context or `packaged-local` | resolve bundled runtime/model inputs, launch the real runtime, capture/transcribe through the intended mode, stop cleanly, and retain final session artifacts | mock runtime services, placeholder binaries, fake capture, synthetic final manifests | production-backed slices emerging in `app/RecorditAppTests/RecorditAppTests.swift`; packaged smoke in `scripts/gate_packaged_live_smoke.sh` | `partial` | `bd-2ph4`, `bd-ufhs`, `bd-diqp`, `bd-p77p` |
| `NM-04` | returning-user startup and readiness ownership | `developer` app context or stronger | prove that startup self-check, runtime/model lookup, and readiness messaging come from the real production path and remain coherent on startup for returning users | preview environment startup wiring, mock readiness providers, manual path injection that bypasses bundled lookup semantics | `app/AppShell/AppEnvironment.swift`, `app/AppShell/AppShellViewModel.swift`, `app/RuntimeProcessLayer/runtime_binary_readiness_smoke.swift`, packaged verifier scripts | `partial` | `bd-29ig`, `bd-2a08`, `bd-ufhs`, `bd-diqp` |
| `NM-05` | real session persistence, history/search, and export consumption | `developer` app context or `packaged-local` | consume session artifacts created by a real upstream lane and prove history/search/export surfaces work against those retained outputs | fixture-only session roots, `MockSessionLibraryService`, synthetic JSONL/manifests standing in for real app-created sessions | `app/Services/real_filesystem_session_integration_smoke.swift`, `app/Services/session_search_index_smoke.swift`, `app/Exports/export_smoke.swift` | `partial` | `bd-10ou`, `bd-11vg` |
| `NM-06` | packaged local app path | `packaged-local` | validate the signed `dist/Recordit.app` artifact, bundled runtime/model payloads, launch-plan semantics, and at least one real journey through the packaged app boundary | Xcode-only proof, fake packaged layout, compatibility-only runtime overrides, fake capture if the claim includes live behavior | `scripts/verify_recordit_release_context.sh`, `scripts/gate_packaged_live_smoke.sh`, `scripts/gate_v1_acceptance.sh` | `partial` | `bd-3mag`, `bd-diqp`, `bd-ufhs`, `bd-13tm` |
| `NM-07` | installed DMG journey | `release-candidate` or RC-equivalent install context | mount DMG, inspect layout, drag-install or otherwise install, launch installed app, and retain diagnostics for first-launch behavior | docs-only/manual instructions standing in for execution, unpackaged app shortcuts, fixture-only install simulation | `scripts/create_recordit_dmg.sh`, `README.md`, release-posture docs | `partial` | `bd-3co8`, `bd-13pv`, `bd-13tm` |
| `NM-08` | release signing, notarization, and Gatekeeper acceptance | `release-candidate` | validate the artifact intended for shipment with retained sign/notarize/staple/Gatekeeper evidence | docs-only checklists or local unsigned/dev-only artifacts used as if they were RC proof | `docs/bd-2gw4-release-posture-and-build-context-parity.md`, release-context and notarization runbooks | `partial` | `bd-1k50`, `bd-3p9b`, downstream release beads |

## The suite’s realism ceiling rule

The comprehensive suite is only as strong as its weakest required lane.

That means:
- if any required row above remains only `partial`, the suite is still `partial`
- if a row is green but still depends on a disallowed seam, that row does not count
- retained evidence quality improves diagnosability, but does not by itself raise the suite’s realism ceiling

## Strong claims that this suite would unlock

Only after **all required lanes** exist in truthful form may the project use stronger wording for the corresponding scope.

### Allowed only when the minimum suite is complete

- `real-environment verified` for the specific covered journey
- `end-to-end verified` for the named journey or release surface
- `comprehensive non-mock critical-journey coverage` for the scoped suite represented here

### Still disallowed until the full suite is complete

- `full coverage`
- `fully verified`
- `complete product verification`
- any wording that implies DMG/install/release proof when `NM-07` or `NM-08` is still partial

## How existing lanes should be used relative to this suite

### Still valuable, but not counted toward completion by themselves

- Rust unit and contract tests
- Swift module smoke executables
- XCUITest lanes running under `RECORDIT_UI_TEST_MODE`
- packaged smoke lanes using deterministic fake capture
- docs and runbooks defining release posture

These lanes should remain in the repo because they:
- catch regressions earlier and faster
- provide detailed retained evidence for diagnosis
- narrow the search space before a heavier non-mock lane is run

### Counted only when they shed the seam that caps them

Some current lanes are close enough to become comprehensive-suite members once they remove the remaining realism blocker.

Examples:
- app-level XCTest lanes can graduate when they stay on `AppEnvironment.production()` and avoid mock/scripted critical-path services
- packaged smoke lanes can graduate when they prove the claimed journey without fake capture or compatibility-only shortcuts
- release-context verification can graduate when it is executed on the actual RC artifact with retained release evidence

## Recommended execution order

The minimum suite should be built in this order so each new lane compounds rather than duplicates effort.

1. **Production-backed app-shell lanes first**
   - land `NM-01`, `NM-02`, `NM-03`, and `NM-04`
   - this establishes truthful app/runtime ownership before install/release work builds on top
2. **Real retained-session consumer lane second**
   - land `NM-05`
   - this proves that outputs from the real journey are usable by later product surfaces
3. **Packaged-local lane third**
   - land `NM-06`
   - this ties the production app journey to the artifact the team actually distributes locally
4. **Installed/RC lanes last**
   - land `NM-07` and `NM-08`
   - these are the final upgrade from local product proof to install and ship proof

## Downstream implications

This suite definition should drive the next major coverage beads:

- `bd-sy9l` should use the `NM-01` through `NM-08` rows as the minimum matrix skeleton for the critical journeys
- `bd-2t10` should orchestrate around these required lanes instead of treating every existing test surface as equal
- `bd-1k50` should convert these lane IDs into nightly and release-candidate gating tiers
- `bd-11vg` should report gaps against this suite, not against broad repo test counts
- `bd-2ptr` and `bd-2mbp` should continue to block seam-heavy lanes from being miscounted as comprehensive coverage

## Decision

The project now has a concrete answer to “what would comprehensive non-mock verification actually require?”

It requires the minimum lane set above, with explicit banned seams, retained evidence, and context-specific proof.

Until those lanes exist, the truthful project posture remains:
- broad verification coverage exists
- many critical surfaces are still only covered with seams or partial proof
- the repo should describe progress in terms of these lane gaps, not blanket completeness claims
