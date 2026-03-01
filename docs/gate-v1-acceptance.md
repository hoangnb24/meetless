# Gate: V1 Acceptance

This gate codifies the operator-visible v1 acceptance bar for true live-stream mode.
It composes deterministic fake-live cold/warm runs with the existing backlog-pressure gate
so one `summary.csv` answers the core release question without ad hoc interpretation.

## Run

```bash
scripts/gate_v1_acceptance.sh
```

Artifacts are written to:

- `artifacts/bench/gate_v1_acceptance/<timestamp>/cold/`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/warm/`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/backlog_pressure/`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/summary.csv`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/status.txt`

## Acceptance Bar

`summary.csv` publishes the following booleans and overall `gate_pass`.

Cold/warm live-stream behavior:

1. `cold_runtime_mode_ok=true`
2. `cold_runtime_mode_status_ok=true`
3. `cold_first_stable_emit_ok=true`
4. `cold_terminal_live_mode_ok=true`
5. `warm_runtime_mode_ok=true`
6. `warm_runtime_mode_status_ok=true`
7. `warm_first_stable_emit_ok=true`
8. `warm_terminal_live_mode_ok=true`
9. `cold_artifact_truth_ok=true`
10. `warm_artifact_truth_ok=true`

Pressure/trust behavior:

11. `backlog_pressure_thresholds_ok=true`
12. `backlog_degradation_signal_ok=true`
13. `backlog_trust_signal_ok=true`
14. `backlog_pressure_profile_known_ok=true`
15. `backlog_surface_ok=true`
16. `backlog_gate_pass=true`

Interpretation:

- cold/warm first-stable checks are based on runtime contract evidence:
  runtime mode/taxonomy/selector must match `live-stream`, and first stable emit must be surfaced via manifest timing or stable transcript rows
- artifact truth checks require manifest `out_wav_materialized=true`, non-zero `out_wav_bytes`,
  and a materialized output file at the manifest path
- backlog pressure checks are delegated to `scripts/gate_backlog_pressure.sh`, which already
  proves profile-specific pressure behavior under induced load:
  - `drop-path`: degradation/trust notices must be present
  - `buffered-no-drop`: zero degradation/trust notices are expected and required

This keeps the v1 decision grounded in deterministic machine-readable evidence rather than
manual log inspection.
