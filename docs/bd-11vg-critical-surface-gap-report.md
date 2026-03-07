# bd-11vg — Critical-Surface Gap Report

Date: 2026-03-07
Source inputs:
- `docs/bd-39i6-critical-surface-coverage-matrix.md`
- `docs/bd-39i6-canonical-downstream-matrix.md`
- `docs/bd-39i6-canonical-downstream-matrix.csv`
- `docs/bd-2elo-canonical-test-inventory-and-realism-matrix.md`
- `docs/bd-34yb-comprehensive-non-mock-critical-journey-verification-lanes.md`
- `docs/bd-2mbp-no-mock-critical-path-policy.md`
- `docs/bd-k993-coverage-claim-policy.md`

## Purpose

This report is the canonical answer to the question: **where is coverage good enough for a bounded claim, where is it only partial, and where is there still no truthful lane at all?**

`bd-39i6` established the first realistic inventory. `bd-2elo` and `bd-34yb` now define the canonical source stack and the minimum comprehensive non-mock suite. This bead turns those inputs into the explicit gap report that downstream policy, CI, and scanner work can consume without inferring severity from prose.

## Snapshot

From the current canonical matrix plus the newly landed production-backed app-test lane:

- `16` critical surfaces tracked
- `10` surfaces are `covered-with-seams`
- `5` surfaces are `partial`
- `1` surface is `uncovered`

Important status shifts since the original seed:

- `production-app-journey` is no longer `uncovered`; it is now `partial` because `app/RecorditAppTests/RecorditAppTests.swift` contains production-backed `AppEnvironment.production()` coverage without `MockServices` for startup readiness, real runtime wiring, live-run completion, record-only sidecar flow, and structured startup self-check emission.
- `app-shell-runtime-lifecycle` should now also be treated as `partial` rather than only `covered-with-seams`, because the strongest current lane is no longer limited to scripted UI-test-mode or mock-backed lifecycle proof. It still remains incomplete for a full first-run/product-journey claim.

Interpretation rules:

- `covered-with-seams` means the repo has meaningful proof, but simulation seams materially limit what can be claimed. This is the gap-report form of **simulation-only coverage**, not real-environment verification.
- `partial` means some stronger product-facing or release-facing proof exists, but the strongest truthful claim is still incomplete.
- `uncovered` means no canonical lane currently proves the surface.

## Coverage Claim Blockers

These rows should block any claim of “full unit/integration/e2e coverage” until their state changes.

| severity | surface_key | current_status | why it blocks truthful coverage claims | next bead(s) |
|---|---|---|---|---|
| `critical` | `production-app-journey` | `partial` | A production-backed app-test lane now exists, but there is still no single retained lane that proves first launch/onboarding → readiness decision → live run or record-only flow → retained session review as one whole product journey. | `bd-10ou`, `bd-11vg`, `bd-sy9l` |
| `critical` | `dmg-install-open` | `partial` | Retained automated mount/install/open verification now exists, but it currently stops before onboarding and first live start/stop proof. | `bd-78qy`, `bd-13pv`, `bd-11vg` |
| `critical` | `playback-functional` | `uncovered` | Playback implementation exists, but no functional verification lane proves play/pause/seek behavior in app context. | `bd-10ou`, `bd-11vg` |
| `high` | `app-shell-runtime-lifecycle` | `partial` | Production-backed no-`MockServices` app-test proof now exists, but the strongest lane still stops short of a complete retained end-user journey through visible UI and installed artifact context. | `bd-p77p`, `bd-10ou`, `bd-11vg` |
| `high` | `packaged-local-app-path` | `partial` | Packaged smoke is strong, but it is not install proof and still depends on deterministic fake capture for live behavior. | `bd-3mag`, `bd-diqp`, `bd-13tm`, `bd-11vg` |
| `high` | `ui-automation-live-run` | `covered-with-seams` | Strong retained evidence exists, and UI parity coverage is getting richer, but the lane is still powered by `RECORDIT_UI_TEST_MODE`, scripted runtime/preflight behavior, and placeholder runtime overrides. | `bd-2ptr`, `bd-13tm`, `bd-11vg` |
| `high` | `live-runtime-streaming` | `covered-with-seams` | Real binaries are exercised, but fake capture and prerequisite-sensitive execution prevent true live-real claims. | `bd-2mbp`, `bd-11vg` |

## Evidence Quality Gaps

These rows are the main blockers for any claim that the project has **complete retained e2e evidence with detailed logging**.

| surface_key | evidence_quality | current limitation | downstream implication |
|---|---|---|---|
| `production-app-journey` | `local-test-only` | stronger no-mock app-test proof exists, but it is not yet one standardized retained journey root with first-run, readiness, runtime, and session-review evidence | `bd-13tm` and `bd-3p9b` still cannot certify this surface as a complete retained journey |
| `playback-functional` | `none` | no retained test lane found | coverage report must keep this explicit as uncovered |
| `release-signing-notarization` | `docs-only` | runbook exists, but no archived execution evidence exists for a concrete RC | docs cannot be counted as e2e proof |
| `dmg-install-open` | `retained-rich` | automated verifier now retains mount/layout/copy/open logs and contract artifacts | install/open is covered, but full first-run live journey remains partial |
| `session-history-search` | `local-test-only` | stronger no-mock temp-filesystem proof exists, but it still lacks packaged-app or retained product-journey evidence | e2e completeness claim would still overstate current reality |
| `export-actions` | `local-test-only` | stronger no-mock temp-filesystem proof exists, but export proof is still not retained as a product-journey evidence lane | downstream evidence contract still needs expansion beyond service-level proof |
| `ui-automation-live-run` | `retained-rich` | retained roots are strong, but the lane remains intentionally seamful and therefore cannot upgrade realism on evidence quality alone | downstream tooling must keep evidence richness and realism class separate |

## Stable Downstream Contract

Downstream beads should preserve these rules:

- `bd-2elo` is now the canonical umbrella inventory/matrix source stack; downstream docs should cite it first before drilling into narrower artifacts.
- `bd-34yb` now defines the minimum comprehensive non-mock suite as lane IDs `NM-01` through `NM-08`; downstream planning and gating work should map onto those rows instead of inventing new ad-hoc journey names.
- `bd-2mbp` defines the approved exception register in `docs/bd-2mbp-critical-path-exception-register.csv`; downstream tooling should consume it directly rather than infer temporary allowances from prose.
- `bd-1jc9` must treat any new critical-path mock/fake usage outside that register as drift.
- `bd-13tm` must enforce that `retained-rich` and `retained-partial` mean concrete, inspectable evidence roots rather than informal logs.
- `bd-3p9b` must fail or warn whenever a matrix row is `partial` or `uncovered` without a linked open bead and matching terminology downgrade.

## Recommended Next Expansion

The next useful slice for `bd-11vg` is machine-readable convergence, not another prose-only re-audit:

1. fan out each `surface_key` into explicit module/file owners and nearest-lane IDs
2. add stable fields for `claim_scope`, `nm_lane_id`, and `blocking_seam_family`
3. treat any row without a qualifying `NM-0x` target from `bd-34yb` as structurally incomplete for comprehensive-suite claims
4. keep row keys unchanged so downstream automation can diff future improvements rather than rewrite the schema

## Decision

The truthful current posture is:

- the repo now has meaningful production-backed app-test progress beyond the original seam-heavy baseline
- that progress upgrades some high-risk rows from `uncovered` or `covered-with-seams` to `partial`, but it does **not** close the comprehensive non-mock suite
- the main blockers remain whole-journey retained proof, DMG/install proof, playback proof, and RC-grade release evidence
