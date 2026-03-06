# bd-11vg — Critical-Surface Gap Report

Date: 2026-03-06
Source inputs:
- `docs/bd-39i6-critical-surface-coverage-matrix.md`
- `docs/bd-39i6-canonical-downstream-matrix.md`
- `docs/bd-39i6-canonical-downstream-matrix.csv`
- `docs/bd-5cz8-test-surface-inventory.csv`
- `docs/bd-39jy-mock-fixture-census.csv`

## Purpose

This report is the canonical answer to the question: **where is coverage good enough for a bounded claim, where is it only partial, and where is there still no truthful lane at all?**

`bd-39i6` established the first realistic inventory. This bead turns that inventory into an explicit gap report that downstream policy, CI, and scanner work can use without inferring severity from prose.

## Snapshot

From the current canonical matrix seed:

- `16` critical surfaces tracked
- `11` surfaces are `covered-with-seams`
- `3` surfaces are `partial`
- `2` surfaces are `uncovered`

Interpretation rules:

- `covered-with-seams` means the repo has meaningful proof, but simulation seams materially limit what can be claimed. This is the gap-report form of **simulation-only coverage**, not real-environment verification.
- `partial` means some evidence exists, but the strongest user-facing or release-facing claim is still incomplete.
- `uncovered` means no canonical lane currently proves the surface.

## Coverage Claim Blockers

These rows should block any claim of “full unit/integration/e2e coverage” until their state changes.

| severity | surface_key | current_status | why it blocks truthful coverage claims | next bead(s) |
|---|---|---|---|---|
| `critical` | `production-app-journey` | `uncovered` | No lane launches the production `AppEnvironment` without preview/UI-test-mode seams and completes onboarding → live run → session review. | `bd-2ph4`, `bd-10ou`, `bd-11vg` |
| `critical` | `dmg-install-open` | `partial` | DMG build exists, but there is still no retained automated mount/install/open verifier. | `bd-3co8`, `bd-13pv`, `bd-11vg` |
| `critical` | `playback-functional` | `uncovered` | Playback implementation exists, but no functional verification lane proves play/pause/seek behavior in app context. | `bd-10ou`, `bd-11vg` |
| `high` | `packaged-local-app-path` | `partial` | Packaged smoke is strong, but it is not install proof and still depends on deterministic fake capture. | `bd-3co8`, `bd-13tm`, `bd-11vg` |
| `high` | `ui-automation-live-run` | `covered-with-seams` | Strong retained evidence exists, but the lane is still powered by `RECORDIT_UI_TEST_MODE`, scripted runtime/preflight behavior, and `/usr/bin/true` overrides. | `bd-2ptr`, `bd-13tm`, `bd-11vg` |
| `high` | `live-runtime-streaming` | `covered-with-seams` | Real binaries are exercised, but fake capture and skip-on-missing-prerequisite behavior prevent true live-real claims. | `bd-2mbp`, `bd-11vg` |

## Evidence Quality Gaps

These rows are the main blockers for any claim that the project has **complete retained e2e evidence with detailed logging**.

| surface_key | evidence_quality | current limitation | downstream implication |
|---|---|---|---|
| `production-app-journey` | `none` | no canonical lane or retained evidence root exists | `bd-13tm` and `bd-3p9b` cannot certify this surface yet |
| `playback-functional` | `none` | no retained test lane found | coverage report must keep this explicit as uncovered |
| `release-signing-notarization` | `docs-only` | runbook exists, but no archived execution evidence exists for a concrete RC | docs cannot be counted as e2e proof |
| `dmg-install-open` | `docs-only` | build and manual steps exist without retained install/open logs | install-surface claims stay partial |
| `session-history-search` | `local-test-only` | logic proof exists without a standardized retained evidence root | e2e completeness claim would overstate current reality |
| `export-actions` | `local-test-only` | export logic is tested, but not retained as a product-journey evidence lane | downstream evidence contract needs expansion |

## Stable Downstream Contract

Downstream beads should preserve these rules:

- `bd-2mbp` must define the approved exception register against the exact seams already named in `main_bypass_or_limit`.
- `bd-1jc9` must treat any new critical-path mock/fake usage outside that register as drift.
- `bd-13tm` must enforce that `retained-rich` and `retained-partial` mean concrete, inspectable evidence roots rather than informal logs.
- `bd-3p9b` must fail or warn whenever a matrix row is `partial` or `uncovered` without a linked open bead and matching terminology downgrade.

## Next Expansion For This Bead

The next useful slice for `bd-11vg` is module-level expansion, not re-auditing the same surfaces again:

1. fan out each `surface_key` into the specific module/file owners that contribute to the claim
2. add a stable `claim_scope` field (`logic-only`, `service-level`, `product-journey`, `release-surface`)
3. keep row keys unchanged so downstream automation can diff future improvements rather than rewrite the schema
