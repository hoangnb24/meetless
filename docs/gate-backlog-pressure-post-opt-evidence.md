# Post-Optimization Gate Backlog Pressure (Default Lane) Evidence

Bead: `bd-1w6i`  
Date: 2026-03-04

## Run Context

Command:

```bash
make gate-backlog-pressure
```

Artifact root:

- `/Users/themrb/Documents/1_projects/recordit/artifacts/bench/gate_backlog_pressure/20260304T034834Z`

Primary status files:

- status: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/status.txt`
- summary: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/summary.csv`
- manifest: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.manifest.json`
- jsonl: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.jsonl`
- stdout: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.stdout.log`
- time: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.time.txt`

## Deterministic Verdict

- status: `pass` (`detail=backlog_pressure_thresholds_satisfied`)
- `gate_pass=true`
- lane class: `buffered-no-drop` (expected class for B1.03 default profile)

## Key Metrics (Observed)

From `summary.csv` and `runtime.manifest.json`:

- runtime mode tuple: `live-stream / live-stream / --live-stream`
- runtime mode status: `implemented`
- first stable timing: `2120 ms`
- chunk queue: `submitted=34`, `enqueued=34`, `dropped_oldest=0`, `drop_ratio=0.000000`
- queue shape: `high_water=2`, `max_queue=2`, `lag_p95_ms=0`, `lag_max_ms=0`
- trust/degradation: empty (`trust_codes=""`, `degradation_codes=""`)
- terminal live mode: `true`

Threshold rows:

- `threshold_queue_saturation_ok=true`
- `threshold_degradation_signal_ok=true`
- `threshold_trust_signal_ok=true`
- `threshold_runtime_mode_ok=true`
- `threshold_runtime_mode_status_ok=true`
- `threshold_first_stable_emit_ok=true`
- `threshold_terminal_live_mode_ok=true`

## Baseline Comparison

Baseline anchor source: `docs/phase1-baseline-anchors.md` (`default-pressure-buffered-no-drop`)

Baseline values:

- `pressure_profile=buffered-no-drop`
- `dropped_oldest=0`
- `drop_ratio=0.000000`
- `high_water=2`
- `max_queue=2`
- `lag_p95_ms=0`
- `first_stable_timing_ms=2120`
- trust/degradation empty

Post-opt comparison:

- profile parity: matched (`buffered-no-drop`)
- first-stable delta: `0 ms` (`2120 - 2120`)
- drop delta: `0` (`0 - 0`)
- drop-ratio delta: `0.000000`
- queue-shape parity: matched (`high_water=2`, `max_queue=2`, `lag_p95_ms=0`)
- trust/degradation parity: matched (no signals)
- informational only: `submitted/enqueued` changed from baseline (`78/78`) to current run (`34/34`) with no gating impact because lane class and protected threshold semantics remained unchanged

## Regression Notes

- No regression detected for the B1.03 default pressure lane.
- Evidence remains directly consumable for downstream delta/reporting beads (`bd-1a7y`, `bd-nxug`, `bd-1e0t`).
