# Post-Optimization Near-Live Soak Gate Evidence

Bead: `bd-2ptm`  
Date: 2026-03-04

## Run Context

Command:

```bash
make gate-d-soak
```

Resolved artifact root:

- `/Users/themrb/Documents/1_projects/recordit/artifacts/bench/gate_d/20260304T034759Z`

Primary artifacts:

- `artifacts/bench/gate_d/20260304T034759Z/status.txt`
- `artifacts/bench/gate_d/20260304T034759Z/summary.csv`
- `artifacts/bench/gate_d/20260304T034759Z/runs.csv`

## Gate Verdict

From `status.txt`:

- `status=completed`
- `detail=normal_exit`
- `generated_at_utc=2026-03-04T04:48:01Z`

From `summary.csv`:

- `gate_pass=true`
- `run_count=483`
- `success_count=483`
- `failure_count=0`
- `soak_seconds_target=3600`
- `soak_seconds_actual=3601`

## Drift/Stability Metrics

Key post-opt soak metrics captured for baseline/delta comparison:

- latency:
  - `real_ms_p50=7200.0`
  - `real_ms_p95=7669.0`
- memory:
  - `max_rss_kb_p50=200458240.0`
  - `max_rss_kb_p95=200964505.6`
- manifest wall-time drift:
  - `manifest_wall_ms_p95_p50=714.09475`
  - `manifest_wall_ms_p95_p95=782.0775080999999`
- chunk queue lag:
  - `chunk_lag_p95_ms_p50=4000.0`
  - `chunk_lag_p95_ms_p95=4000.0`

Operational continuity signals:

- `near_live_mode_count=483`
- `live_chunked_count=483`
- `out_wav_materialized_count=483`
- `chunk_queue_visible_count=483`
- `chunk_drain_complete_count=483`
- `capture_telemetry_readable_count=483`
- `total_capture_restarts=0`

Pressure/recovery telemetry (for downstream interpretation lanes):

- `total_chunk_submitted=7728`
- `total_chunk_dropped_oldest=2415`
- `chunk_drop_ratio=0.3125`
- `reconciliation_applied_runs=483`
- `total_trust_notices=2414`
- `total_degradation_events=1449`

## Threshold Outcomes

All threshold checks emitted by the soak summary are `true`:

- `threshold_soak_duration_ok`
- `threshold_harness_reliability_ok`
- `threshold_latency_drift_ok`
- `threshold_memory_growth_ok`
- `threshold_near_live_mode_ok`
- `threshold_chunk_queue_visibility_ok`
- `threshold_chunk_drain_ok`
- `threshold_out_wav_truth_ok`
- `threshold_continuity_signal_ok`
- `threshold_lag_drift_ok`

## Notes For Follow-On Beads

- This run supplies deterministic drift/stability evidence for post-opt near-live behavior.
- Use `summary.csv` + `runs.csv` as the source pair for downstream delta synthesis and release-readiness interpretation.
