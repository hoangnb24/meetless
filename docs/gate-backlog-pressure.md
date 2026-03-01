# Gate: Live-Stream Backlog Pressure

This gate codifies live-stream queue pressure behavior under intentional load.
It is deterministic and host-independent: it runs `transcribe-live --live-stream`
through the shared fake-capture runtime path (`RECORDIT_FAKE_CAPTURE_FIXTURE`)
with a fixed stereo fixture.

## Run

```bash
scripts/gate_backlog_pressure.sh
```

Optional tuning:

```bash
scripts/gate_backlog_pressure.sh \
  --chunk-window-ms 1200 \
  --chunk-stride-ms 120 \
  --chunk-queue-cap 2 \
  --min-drop-ratio 0.15 \
  --max-drop-ratio 0.80 \
  --min-lag-p95-ms 240
```

Artifacts are written to:

- `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.manifest.json`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.jsonl`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/summary.csv`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/status.txt`

## Acceptance Bar

`summary.csv` writes threshold booleans and `gate_pass`.

The scenario must prove pressure is real and surfaced truthfully for one of two valid pressure profiles:

1. pressure observed: `submitted > 0`
2. queue saturation: `high_water >= max_queue`
3. JSONL includes `event_type=chunk_queue`
4. runtime mode truth: `runtime_mode=live-stream`, taxonomy `live-stream`, selector `--live-stream`, status `implemented`
5. stable first-emit evidence present (`first_emit_timing_ms.first_stable > 0`)
6. transcript surface present (`event_counts` and/or JSONL transcript rows)
7. terminal summary reports live mode (`terminal_summary.live_mode=true`)

Profile-specific checks:

8. `pressure_profile=drop-path`:
   `min_drop_ratio <= dropped_oldest/submitted <= max_drop_ratio`,
   `lag_p95_ms >= min_lag_p95_ms`,
   degradation/trust/reconciliation signals present
9. `pressure_profile=buffered-no-drop`:
   drop/lag thresholds are non-binding for this profile and
   degradation/trust signals must remain absent (no false-positive backpressure alarms)

This keeps backlog pressure as a measured quality gate rather than an undefined edge case.
