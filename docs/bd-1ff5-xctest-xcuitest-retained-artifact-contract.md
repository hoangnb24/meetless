# bd-1ff5 — Retained-artifact contract for XCTest / XCUITest / app-launched verification

Date: 2026-03-06
Related bead: `bd-1ff5`
Shared retained-evidence base contract: `docs/bd-2grd-e2e-evidence-contract.md`
Current CI producer: `scripts/ci_recordit_xctest_evidence.sh`
Current lane renderer: `scripts/render_xctest_evidence_contract.py`
Current lane-matrix slice: `docs/bd-13pv-xctest-xcuitest-app-launched-matrix.md`

## Purpose

Define the concrete retained-artifact contract for Recordit app-level `xcodebuild` verification lanes so downstream validators, evidence indices, and triage tooling can consume one truthful layout instead of reverse-engineering ad-hoc logs.

This document does **not** replace the shared contract from `bd-2grd`. It narrows that shared contract into the current XCTest/XCUITest/app-launched shape already emitted by `scripts/ci_recordit_xctest_evidence.sh` and `scripts/render_xctest_evidence_contract.py`.

## Scope boundary

This contract covers the retained evidence written under one `scripts/ci_recordit_xctest_evidence.sh` run root, typically:

```text
artifacts/ci/xctest_evidence/<stamp>/
```

It covers three closely related verification dimensions:

- pure XCTest app-level lanes
- XCUITest automation lanes
- app-launched verification that currently runs as the `uitest_*` phases inside the XCUITest lane

It does **not** claim that the current lane already produces every artifact we may eventually want. The contract below is intentionally honest about what is retained today versus what remains future work.

## Canonical retained root layout

One complete retained root currently has this concrete shape:

```text
<root>/
  logs/
    prepare_runtime_inputs.log
    build_for_testing.log
    unit_tests.log
    responsiveness_budget_gate.log
    discover_xctestrun.log
    uitest_onboarding_happy_path.log
    uitest_permission_recovery.log
    uitest_live_run_summary.log
    uitest_runtime_recovery.log
  xcresult/
    build_for_testing.xcresult/
    recordit_app_tests.xcresult/
    responsiveness_budget_gate.xcresult/
    uitest_onboarding_happy_path.xcresult/
    uitest_permission_recovery.xcresult/
    uitest_live_run_summary.xcresult/
    uitest_runtime_recovery.xcresult/
  status.csv
  status.json
  summary.csv
  summary.json
  responsiveness_budget_summary.csv
  responsiveness_budget_summary.json
  contracts/
    lane_matrix.json
    xctest/
      evidence_contract.json
      status.txt
      summary.csv
      summary.json
      paths.env
    xcuitest/
      evidence_contract.json
      status.txt
      summary.csv
      summary.json
      paths.env
```

Notes:

- root-level `status.csv` / `summary.csv` remain the legacy aggregate outputs for the whole CI lane
- lane-scoped manifests live under `contracts/xctest/` and `contracts/xcuitest/`
- `lane_matrix.json` is the machine-readable index that links the lane manifests together
- screenshots and rich XCTest attachments are currently retained inside the `.xcresult` bundles rather than exploded into a standalone `screenshots/` tree at the root

## Shared invariants inherited from `bd-2grd`

Each lane-scoped contract manifest must still satisfy the shared retained-evidence rules from `docs/bd-2grd-e2e-evidence-contract.md`:

- `contract_name=recordit-e2e-evidence`
- `contract_version=1`
- lane type must be either `xctest-evidence` or `xcuitest-evidence`
- `generated_at_utc` must be UTC RFC3339 / ISO 8601 with `Z`
- every phase must retain a combined log path and stable phase metadata
- every referenced path must remain within the evidence root
- `result_bundle_relpath` must point at a directory when present

## Lane definitions

### `xctest-evidence`

Scenario id:
- `recorditapp-ci-xctest`

Required retained phases:
- `prepare_runtime_inputs`
- `build_for_testing`
- `unit_tests`
- `responsiveness_budget_gate`

Phase-to-artifact contract:

| Phase | Required | Combined log | Result bundle | Primary artifact | Extra artifacts |
| --- | --- | --- | --- | --- | --- |
| `prepare_runtime_inputs` | yes | `logs/prepare_runtime_inputs.log` | none | none | none |
| `build_for_testing` | yes | `logs/build_for_testing.log` | `xcresult/build_for_testing.xcresult/` | none | none |
| `unit_tests` | yes | `logs/unit_tests.log` | `xcresult/recordit_app_tests.xcresult/` | none | none |
| `responsiveness_budget_gate` | yes | `logs/responsiveness_budget_gate.log` | `xcresult/responsiveness_budget_gate.xcresult/` | `responsiveness_budget_summary.csv` | `responsiveness_budget_summary.json` |

Interpretation notes:

- `responsiveness_budget_gate` is both a test lane and an artifact-producing phase
- the responsiveness CSV/JSON pair is the canonical retained summary for app responsiveness thresholds
- the renderer currently maps `stdout_relpath` and `stderr_relpath` to the same combined log path because the producer does not yet split streams

### `xcuitest-evidence`

Scenario id:
- `recorditapp-ci-xcuitest`

Required retained phases when present:
- `build_for_testing`
- `discover_xctestrun`
- `uitest_onboarding_happy_path`
- `uitest_permission_recovery`
- `uitest_live_run_summary`
- `uitest_runtime_recovery`

Phase-to-artifact contract:

| Phase | Required | Combined log | Result bundle | Primary artifact | Extra artifacts |
| --- | --- | --- | --- | --- | --- |
| `build_for_testing` | yes | `logs/build_for_testing.log` | `xcresult/build_for_testing.xcresult/` | none | none |
| `discover_xctestrun` | yes | `logs/discover_xctestrun.log` when discovery runs as a retained step | none | none | none |
| `uitest_onboarding_happy_path` | policy-driven | `logs/uitest_onboarding_happy_path.log` | `xcresult/uitest_onboarding_happy_path.xcresult/` | none | none |
| `uitest_permission_recovery` | policy-driven | `logs/uitest_permission_recovery.log` | `xcresult/uitest_permission_recovery.xcresult/` | none | none |
| `uitest_live_run_summary` | policy-driven | `logs/uitest_live_run_summary.log` | `xcresult/uitest_live_run_summary.xcresult/` | none | none |
| `uitest_runtime_recovery` | policy-driven | `logs/uitest_runtime_recovery.log` | `xcresult/uitest_runtime_recovery.xcresult/` | none | none |

Interpretation notes:

- the UI phases become required when `STRICT_UI_TESTS=1`; otherwise they remain retained but optional
- `discover_xctestrun` is the contract boundary between build output discovery and UI execution
- `discover_xctestrun` failures classify as `contract_failure`, because UI execution could not even begin
- app-launched verification currently lives inside the `uitest_*` phases rather than as a third standalone lane type

## App-launched verification contract

The current truthful posture is:

- there is **no third manifest** yet named `app-launched-evidence`
- app launch attempts are retained through the `xcuitest-evidence` lane
- each `uitest_*` phase represents a real `xcodebuild test-without-building ...` app launch attempt with a retained `.xcresult`

Downstream consumers should therefore treat the following as the canonical app-launched retained surface today:

- manifest: `contracts/xcuitest/evidence_contract.json`
- lane summary: `contracts/xcuitest/summary.json`
- retained launch bundles: `xcresult/uitest_*.xcresult/`
- retained launch logs: `logs/uitest_*.log`

If a future bead promotes app-launched verification into its own dedicated lane type, that should be introduced as a new contract surface rather than silently changing the meaning of `xcuitest-evidence`.

## Required `paths.env` posture

Every lane-scoped `paths.env` must include the shared base entries written by the renderer:

- `EVIDENCE_ROOT=<retained root path>`
- `ARTIFACT_ROOT=<retained artifact root path>`
- `STATUS_TXT=<status.txt path>`
- `SUMMARY_CSV=<summary.csv path>`
- `SUMMARY_JSON=<summary.json path>`
- `MANIFEST=<evidence_contract.json path>`

These values may be emitted as absolute paths by the renderer or as safe relative paths in tracked fixtures, but they must resolve to the exact retained files for that lane.

The current CI producer also writes these additional lane-relevant entries for both lane manifests:

- `DERIVED_DATA_PATH=<absolute xcodebuild DerivedData root>`
- `DESTINATION=<xcodebuild destination string>`
- `RUNTIME_INPUT_DIR=<absolute prepared runtime input root>`
- `STRICT_UI_TESTS=<0|1>`

These entries are the minimum needed to explain which build products, destination, and prebuilt runtime staging inputs produced the retained evidence.

## Status and classification rules specific to app-level lanes

The current renderer behavior establishes these truthful rules:

- `pass` row -> `status=pass`, `exit_classification=success`
- successful UI rows whose retained combined log shows bootstrap retry markers -> `status=warn`, `exit_classification=flake_retried`, and a non-empty retry note
- `discover_xctestrun` failure -> `status=fail`, `exit_classification=contract_failure`
- other retained failures -> `status=fail`, `exit_classification=product_failure`

This means a lane can legitimately aggregate to `warn` when the final UI run succeeded but required bootstrap retry recovery.

## Truthful current limitations

The contract must stay honest about these current limitations:

- combined logs are retained, but split stdout/stderr files are **not** yet produced; `stdout_relpath` and `stderr_relpath` currently alias `log_relpath`
- screenshots and UI attachments are retained only through `.xcresult` bundles, not as first-class root-level files
- app-launched verification is represented through `xcuitest-evidence`, not a dedicated third lane
- root-level `status.csv` / `summary.csv` remain whole-run aggregates, so lane-specific consumers should prefer `contracts/<lane>/summary.json` and `contracts/lane_matrix.json`

Downstream tools must not over-claim beyond those truths.

## Downstream consumer guidance

This contract is designed to unblock:

- `bd-13tm` — validator enforcement across shell and XCTest/XCUITest evidence roots
- `bd-1ngy` — cross-lane evidence index and triage mapping
- `bd-2t10` — a broader orchestrator that can consume lane manifests instead of bespoke root parsing

Immediate usage rules:

- consumers that need one quick app-level index should read `contracts/lane_matrix.json`
- consumers that need full lane fidelity should read `contracts/xctest/evidence_contract.json` and `contracts/xcuitest/evidence_contract.json`
- consumers that need app-launched evidence today should follow the `xcuitest-evidence` manifest and the retained `uitest_*` `.xcresult` bundles
- validators must allow combined-log aliasing for stdout/stderr until a later bead introduces true split-stream capture

## Focused validation references

The current contract shape is backed by these existing checks:

```bash
python3 -m unittest tests.test_render_xctest_evidence_contract
python3 -m py_compile scripts/render_xctest_evidence_contract.py tests/test_render_xctest_evidence_contract.py
bash -n scripts/e2e_evidence_lib.sh scripts/ci_recordit_xctest_evidence.sh
```

These checks validate that:

- the renderer emits validator-compatible `xctest-evidence` and `xcuitest-evidence` manifests
- responsiveness artifacts are surfaced as primary/extra retained artifacts for the XCTest lane
- flake-retried UI passes degrade to lane/phase `warn` rather than pretending to be clean passes
- custom contract output relpaths continue to work for lane-scoped retained manifests
