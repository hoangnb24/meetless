# bd-v502 — Failure-Path Packaged E2E Matrix with Retained Diagnostics

Bead: `bd-v502`

## Purpose

Provide one deterministic packaged-failure matrix lane that always emits all required scenario rows and fails when any required row disappears.

This lane is intentionally machine-checkable first: the matrix parser classifies each scenario and verifies the expected failure class and outcome code.

## Entry Point

```bash
scripts/gate_packaged_failure_matrix.sh
```

Useful options:

```bash
scripts/gate_packaged_failure_matrix.sh --skip-build
scripts/gate_packaged_failure_matrix.sh --out-dir artifacts/validation/bd-v502/manual-smoke --skip-build
```

## Required Scenario IDs

The gate requires these deterministic scenario IDs on every run:

1. `permission-denial-preflight`
2. `missing-invalid-model`
3. `missing-runtime-binary`
4. `runtime-preflight-failure`
5. `stop-timeout-class`
6. `partial-artifact-forced-kill`

If any required ID is missing, the parser marks the run failed.

## Scenario Classification Targets

| Scenario ID | Expected failure class | Expected outcome code |
| --- | --- | --- |
| `permission-denial-preflight` | `permission_denial` | `permission_denied` |
| `missing-invalid-model` | `missing_or_invalid_model` | `missing_or_invalid_model` |
| `missing-runtime-binary` | `missing_runtime_binary` | `missing_runtime_binary` |
| `runtime-preflight-failure` | `runtime_preflight_failure` | `runtime_preflight_failure` |
| `stop-timeout-class` | `stop_timeout` | `stop_timeout` |
| `partial-artifact-forced-kill` | `partial_artifact` | `partial_artifact_session` |

## Retained Outputs

For a run rooted at `<out-dir>`, key outputs are:

- `<out-dir>/artifacts/failure_matrix.csv`
- `<out-dir>/artifacts/failure_matrix.json`
- `<out-dir>/artifacts/failure_matrix_status.txt`
- `<out-dir>/artifacts/failure_matrix_status.json`
- `<out-dir>/scenarios/<scenario-id>/scenario_meta.json`
- `<out-dir>/scenarios/<scenario-id>/execution.json`
- `<out-dir>/scenarios/<scenario-id>/stdout.log`
- `<out-dir>/scenarios/<scenario-id>/stderr.log`

The lane also renders a shared shell evidence contract root:

- `<out-dir>/evidence_contract.json`
- `<out-dir>/summary.csv`
- `<out-dir>/summary.json`
- `<out-dir>/status.txt`
- `<out-dir>/paths.env`

That keeps this bead aligned with `bd-2grd` + `bd-8ydu` retained-evidence expectations.

## Gating Semantics

The gate fails if any of these conditions occurs:

1. required scenario IDs are missing,
2. observed failure class mismatches expected class,
3. observed outcome code mismatches expected outcome code,
4. scenario expected a non-zero exit but did not get one,
5. parser reports malformed/missing scenario artifacts.

This enforces the acceptance criterion that required failure-path rows cannot silently disappear.
