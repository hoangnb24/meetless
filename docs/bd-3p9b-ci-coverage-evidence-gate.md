# bd-3p9b — CI gate for coverage-matrix completeness and e2e evidence presence

Date: 2026-03-07  
Related bead: `bd-3p9b`  
Gate entrypoint: `scripts/gate_coverage_certification.sh`

## Purpose

Make coverage/evidence claims enforceable in CI by failing when either:

1. required matrix truth data is incomplete, or
2. required retained e2e evidence roots/log artifacts are missing or malformed.

This gate converts policy from advisory to blocking.

## Inputs checked by the gate

- canonical downstream matrix (`docs/bd-39i6-canonical-downstream-matrix.csv`)
- critical-surface matrix (`docs/bd-39i6-critical-surface-coverage-matrix.csv`)
- anti-bypass certifying-claim output (`gate_anti_bypass_claims.sh`)
- required domain bead statuses (`--required-beads`)
- required e2e evidence roots (`--required-evidence-root lane_id=/abs/path`)

## Evidence-root contract enforced

For each required evidence root, the gate verifies:

- root directory exists
- required files exist (default):
  - `evidence_contract.json`
  - `status.txt`
  - `summary.csv`
  - `summary.json`
  - `paths.env`
- `logs/` exists and is non-empty
- `evidence_contract.json` has non-empty `phases`
- `status.txt` includes `status=`
- `summary.csv` has `phase_id` + `status` headers and at least one row

Failures here are hard blockers (`required_evidence_missing_or_malformed`).

## Verdict model

- `true`: certifying coverage claim is allowed
- `unproven`: no hard blockers, but soft blockers remain (`partial`, `covered-with-seams`, or explicit remaining gaps)
- `false`: hard blockers remain (anti-bypass fail, uncovered matrix rows, required beads open, or invalid required evidence roots)

## CI usage

Example strict invocation:

```bash
scripts/gate_coverage_certification.sh \
  --out-dir artifacts/ci/gate_coverage_certification/manual \
  --required-beads bd-tr8z,bd-diqp,bd-p77p,bd-39i6,bd-11vg,bd-2j49 \
  --required-evidence-root nm03=artifacts/ops/gate_default_user_journey_e2e/latest \
  --required-evidence-root nm06=artifacts/validation/bd-2kia/gate_packaged_stop_finalization_taxonomy/latest \
  --required-evidence-root nm07=artifacts/ops/gate_dmg_install_open/latest
```

## Outputs

Under the selected output directory:

- `summary.csv` (key/value summary)
- `status.txt`
- `status.json`
- `anti_bypass/` (nested anti-bypass gate outputs)

`status.json` includes detailed blocker and evidence-root diagnostics for CI triage.
