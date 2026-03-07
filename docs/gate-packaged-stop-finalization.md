# Gate: Packaged Stop/Finalization Taxonomy

This lane verifies stop/finalization outcome taxonomy on **signed packaged runtime artifacts** by
running scenarios against the embedded runtime binary in `dist/Recordit.app`:

- `dist/Recordit.app/Contents/Resources/runtime/bin/recordit`

Scenario matrix:

1. `graceful_stop_live`
2. `fallback_record_only_offline`
3. `early_stop_live_interrupt`
4. `partial_artifact_forced_kill`

Each scenario retains deterministic logs and artifacts, then classifies canonical outcome fields:

- `outcome_classification`: `empty_root|partial_artifact|finalized_failure|finalized_success`
- `outcome_code`: `empty_session_root|partial_artifact_session|finalized_failure|finalized_success|finalized_degraded_success`

## Run

```bash
scripts/gate_packaged_stop_finalization_taxonomy.sh
```

Skip build/sign if you already have a signed bundle in `dist/Recordit.app`:

```bash
scripts/gate_packaged_stop_finalization_taxonomy.sh --skip-build
```

## Outputs

Default root:

- `artifacts/validation/bd-2kia/gate_packaged_stop_finalization_taxonomy/<timestamp>/`

Primary evidence artifacts:

- `summary.csv` (scenario-level machine-readable result rows)
- `summary.json` (same data + gate rollup)
- `status.txt` / `status.json` (PASS/FAIL envelope)
- `scenarios/<scenario-id>/stdout.log`
- `scenarios/<scenario-id>/stderr.log`
- `scenarios/<scenario-id>/session/*`
- `release_context_verification/*` (when release-context phase is enabled)

## Pass Criteria

Gate status is `pass` only when all scenario rows satisfy:

1. expected canonical `outcome_code`
2. expected `runtime_mode` (`live-stream` or `representative-offline`)
3. expected manifest presence/absence for the scenario
4. no scenario runner error

If release-context verification is enabled, its phase must also succeed.
