# bd-13pv — XCTest/XCUITest app-launched evidence matrix slice

## Summary
This slice extends the existing `scripts/ci_recordit_xctest_evidence.sh` driver so it retains two lane-scoped contract manifests in addition to the legacy root-level `status.csv` and `summary.csv` outputs.

The new retained artifacts are written under `contracts/` inside the CI evidence root:

- `contracts/xctest/evidence_contract.json`
- `contracts/xctest/status.txt`
- `contracts/xctest/summary.csv`
- `contracts/xctest/summary.json`
- `contracts/xctest/paths.env`
- `contracts/xcuitest/evidence_contract.json`
- `contracts/xcuitest/status.txt`
- `contracts/xcuitest/summary.csv`
- `contracts/xcuitest/summary.json`
- `contracts/xcuitest/paths.env`
- `contracts/lane_matrix.json`

## Why this slice matters
`bd-13pv` needs one complete Recordit.app verification matrix with retained, machine-readable evidence instead of ad-hoc logs only.

Before this slice:
- the CI driver archived combined logs and `.xcresult` bundles
- aggregate CSV/JSON existed only at the whole-run root
- XCTest and XCUITest results could not be lined up with the shared retained-artifact contract used by the shell lanes
- discovery of the generated `.xctestrun` bundle was not retained as a first-class evidence phase on successful runs

After this slice:
- the same evidence root now exposes lane-scoped manifests for XCTest and XCUITest
- downstream consumers can reason about phase-level status, retained bundles, and per-lane overall status without parsing the root aggregate CSV shape
- the root-level `contracts/lane_matrix.json` gives one concise machine-readable index of the retained lane manifests
- the xctest driver now retains split `stdout` and `stderr` artifacts in addition to the compatibility combined step log
- `.xctestrun` discovery is always retained with an explicit phase log instead of only showing up implicitly or on failure
- the shell entrypoint is now covered by automated success-path and missing-`.xctestrun` failure-path regressions, so discovery failures keep a truthful retained contract instead of collapsing during rendering

## Lane mapping
The renderer infers phase contracts from the existing `status.csv` rows.

### `xctest-evidence`
Scenario id:
- `recorditapp-ci-xctest`

Mapped phases:
- `prepare_runtime_inputs`
- `build_for_testing`
- `unit_tests`
- `responsiveness_budget_gate`

Special handling:
- `responsiveness_budget_gate` points `primary_artifact_relpath` at `responsiveness_budget_summary.csv`
- `responsiveness_budget_summary.json` is retained as an extra artifact

### `xcuitest-evidence`
Scenario id:
- `recorditapp-ci-xcuitest`

Mapped phases:
- `build_for_testing`
- `discover_xctestrun`
- `uitest_onboarding_happy_path`
- `uitest_permission_recovery`
- `uitest_live_run_summary`
- `uitest_runtime_recovery`

App-launched verification note:
- the app-launched verification dimension currently lives inside the `xcuitest-evidence` lane rather than a third standalone lane type
- each `uitest_*` phase is a real app-launch attempt with retained `.xcresult` output
- this keeps the matrix aligned with the current driver surface while still giving downstream beads a stable app-launched evidence path to consume

## Exit-classification rules
The renderer intentionally keeps the classification logic simple and deterministic.

- `pass` rows become `status=pass`, `exit_classification=success`
- `discover_xctestrun` failures become `exit_classification=contract_failure`
- other failures become `exit_classification=product_failure`
- successful UI rows whose retained combined log contains bootstrap retry markers become `status=warn`, `exit_classification=flake_retried`, with retry notes retained in the phase manifest
- `summary.json` phase counts are raw phase-status aggregates, not a second encoding of lane severity; a `warn` lane can legitimately show `warn_phase_count=1` for a flake-retried UI phase or `failed_phase_count=1` when only an optional phase failed while all required phases still passed

## Retained logging shape
The CI driver now retains three log artifacts per executed step:

- `log_relpath`: combined compatibility log with `[stdout]` / `[stderr]` prefixes
- `stdout_relpath`: retained step stdout stream
- `stderr_relpath`: retained step stderr stream

Renderer compatibility rule:
- if an older `status.csv` lacks `stdout_path` / `stderr_path`, the renderer backfills both stream paths from the combined `log_path`
- that lets the new contract reader accept both legacy and upgraded CI evidence roots honestly

## Validation
Focused validation for this slice:

```bash
python3 -m unittest tests.test_ci_recordit_xctest_evidence_driver tests.test_render_xctest_evidence_contract
python3 -m py_compile tests/test_ci_recordit_xctest_evidence_driver.py scripts/render_xctest_evidence_contract.py tests/test_render_xctest_evidence_contract.py
bash -n scripts/e2e_evidence_lib.sh scripts/ci_recordit_xctest_evidence.sh
```

Additional targeted checks used during implementation:

```bash
ubs scripts/e2e_evidence_lib.sh scripts/ci_recordit_xctest_evidence.sh scripts/render_xctest_evidence_contract.py tests/test_render_xctest_evidence_contract.py
```
