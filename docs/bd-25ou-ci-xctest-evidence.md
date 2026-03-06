# bd-25ou — CI lane for XCTest/XCUITest evidence archiving

## Summary
Added a deterministic CI lane that runs app-level XCTest/XCUITest commands, captures logs and `.xcresult` bundles per step, and publishes machine-readable pass/fail summaries.

## Delivered
- `scripts/ci_recordit_xctest_evidence.sh`
  - deterministic artifact root:
    - `artifacts/ci/xctest_evidence/<stamp>/`
  - per-step logs:
    - `logs/<step>.log`
  - per-step result bundles:
    - `xcresult/<step>.xcresult`
  - machine-readable status outputs:
    - `status.csv` (step, required flag, exit code, result, log path, result bundle path)
    - `summary.csv` (aggregate pass/fail counters + overall status)
  - pass/fail policy:
    - required steps (build-for-testing + unit tests) fail the job on error
    - UI-test steps are configurable via `CI_STRICT_UI_TESTS` (`0` default, `1` strict)
- `.github/workflows/recordit-xctest-evidence.yml`
  - macOS workflow (`workflow_dispatch` + PR path trigger)
  - runs `scripts/ci_recordit_xctest_evidence.sh`
  - uploads artifact folder using run-id/attempt stamp
- `README.md`
  - added `XCTest/XCUITest Evidence Lane (CI/Local)` command and controls

## Local validation
Executed:
```bash
XCTEST_EVIDENCE_STAMP=local-bd25ou CI_STRICT_UI_TESTS=0 scripts/ci_recordit_xctest_evidence.sh
```

Produced:
- `artifacts/ci/xctest_evidence/local-bd25ou/status.csv`
- `artifacts/ci/xctest_evidence/local-bd25ou/summary.csv`
- `artifacts/ci/xctest_evidence/local-bd25ou/logs/*.log`
- `artifacts/ci/xctest_evidence/local-bd25ou/xcresult/*.xcresult`

Observed summary:
- `steps_total=6`
- `steps_failed=4`
- `required_failed=0`
- `overall_status=pass`

UI test failures in this headless environment are captured deterministically in logs and result bundles with explicit exit code `65` and runner bootstrap crash details (`Early unexpected exit ... signal kill before starting test execution`).

## Pass/fail criteria (machine-readable)
- Required-fail when any required step fails:
  - `build_for_testing`
  - `unit_tests`
- Optional/strict UI behavior:
  - `CI_STRICT_UI_TESTS=0` -> UI-test failures archived but non-blocking
  - `CI_STRICT_UI_TESTS=1` -> UI-test failures become required-fail
