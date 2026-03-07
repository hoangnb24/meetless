# bd-3p9b: CI Gate for Matrix Completeness and E2E Evidence Presence

Date: 2026-03-07  
Related bead: `bd-3p9b`  
Parent feature: `bd-1ml1`

## Goal

Provide one CI/assertion gate that fails deterministically when:

1. required coverage-matrix rows/classifications are missing,
2. required e2e lanes do not emit required retained artifacts/scenarios,
3. certifying claim text appears while certification verdict is not `true`.

## Canonical Command

```bash
scripts/gate_coverage_matrix_evidence.sh \
  --default-journey-root <path-to-bd-78qy-evidence-root> \
  --failure-matrix-root <path-to-bd-v502-evidence-root>
```

Default output root:

```text
artifacts/ci/gate_coverage_matrix_evidence/<timestamp>/
```

## What It Enforces

1. **Matrix completeness checks**
   - validates required rows in:
     - `docs/bd-39i6-canonical-downstream-matrix.csv`
     - `docs/bd-39i6-critical-surface-coverage-matrix.csv`
   - requires non-empty realism/gap/follow-on classification fields.

2. **Required e2e evidence checks**
   - validates `bd-78qy` evidence root (`hybrid-e2e`) artifacts, including:
     - `evidence_contract.json`
     - `summary.csv`, `summary.json`, `status.txt`
     - `artifacts/default_user_journey_checks.csv`
   - validates `bd-v502` evidence root (`packaged-e2e`) artifacts, including:
     - `evidence_contract.json`
     - `summary.csv`, `summary.json`, `status.txt`
     - `artifacts/failure_matrix.csv`
     - `artifacts/failure_matrix_status.txt`
   - enforces deterministic required failure scenarios:
     - `permission-denial-preflight`
     - `missing-invalid-model`
     - `missing-runtime-binary`
     - `runtime-preflight-failure`
     - `stop-timeout-class`
     - `partial-artifact-forced-kill`

3. **Policy check for unsupported certifying claims**
   - runs `scripts/gate_coverage_certification.sh` to get the current verdict.
   - scans configured claim files for strong phrases (`full coverage`, `fully verified`, etc.).
   - fails if such phrases appear while certification verdict is not `true`.

## Output Contract

- `summary.csv`: key/value high-level pass/fail counts.
- `status.txt`: key/value quick status for shell/CI use.
- `status.json`: deterministic failure list with machine-readable codes.

Typical deterministic failure codes:
- `downstream_missing_row`
- `critical_missing_row`
- `default_journey_missing_artifact`
- `failure_matrix_missing_required_scenario`
- `failure_matrix_required_scenario_failed`
- `unsupported_certifying_claim_text`

## CI Usage Pattern

1. Produce required evidence roots with:
   - `scripts/gate_default_user_journey_e2e.sh`
   - `scripts/gate_packaged_failure_matrix.sh`
2. Run this gate with those roots.
3. Fail the job on non-zero exit; publish `status.json` as a retained artifact.
