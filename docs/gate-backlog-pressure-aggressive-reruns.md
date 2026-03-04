# Backlog Pressure Aggressive Rerun Ladder

Bead: `bd-2762`  
Date: 2026-03-04

## Trigger

`bd-1a7y` induced-lane run stayed `buffered-no-drop`:

- artifact root: `artifacts/bench/gate_backlog_pressure/20260304T035146Z`
- verdict: `gate_pass=true`, `pressure_profile=buffered-no-drop`
- key metrics: `submitted=34`, `dropped_oldest=0`, `drop_ratio=0.000000`, `lag_p95_ms=0`

Because no drop-path was exercised, queue-drop reduction claims remained incomplete.

## Escalation Ladder (Defined Before Attempts)

Stop conditions:

1. stop immediately when `pressure_profile=drop-path` is observed
2. stop immediately on runtime/contract failure
3. stop after 3 aggressive attempts (ceiling) and mark outcome unresolved

Attempt profiles:

| Attempt | Duration | Chunk Window | Chunk Stride | Queue Cap | Drop Ratio Target | Lag Target |
|---|---:|---:|---:|---:|---|---|
| `01` | `4s` | `1600ms` | `80ms` | `1` | `0.05..0.95` | `>=1ms` |
| `02` | `6s` | `2200ms` | `50ms` | `1` | `0.05..0.95` | `>=1ms` |
| `03` | `8s` | `2800ms` | `30ms` | `1` | `0.05..0.95` | `>=1ms` |

All attempts used:

```bash
scripts/gate_backlog_pressure.sh \
  --out-dir <attempt-dir> \
  --duration-sec <dur> \
  --chunk-window-ms <window> \
  --chunk-stride-ms <stride> \
  --chunk-queue-cap <cap> \
  --min-drop-ratio 0.05 \
  --max-drop-ratio 0.95 \
  --min-lag-p95-ms 1
```

## Attempt Evidence

Base artifact directory:

- `artifacts/bench/gate_backlog_pressure/aggressive_20260304T035732Z`
- ladder table source: `artifacts/bench/gate_backlog_pressure/aggressive_20260304T035732Z/attempt_results.csv`

Per-attempt outcomes:

| Attempt | Out Dir | Gate | Profile | Submitted | Enqueued | Dropped Oldest | Drop Ratio | Lag P95 | First Stable |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| `01` | `.../attempt-01` | `pass` | `buffered-no-drop` | `44` | `44` | `0` | `0.000000` | `0` | `2120` |
| `02` | `.../attempt-02` | `pass` | `buffered-no-drop` | `66` | `66` | `0` | `0.000000` | `0` | `2120` |
| `03` | `.../attempt-03` | `pass` | `buffered-no-drop` | `120` | `120` | `0` | `0.000000` | `0` | `2120` |

`summary.csv` and `status.txt` are available under each attempt directory.

## Final Outcome

- `DROP_PATH_OBSERVED=false`
- ladder ceiling reached (`3/3` attempts)
- outcome: **unresolved drop-path exercise (blocker-grade)**

## Blocker Rationale

Even under cap-1 queue and increasingly aggressive window/stride/duration settings:

- `dropped_oldest` stayed `0`
- `drop_ratio` stayed `0.000000`
- `lag_sample_count`/`lag_p95_ms` stayed `0`

Interpretation:

- deterministic pressure/saturation evidence exists (`high_water` reached queue cap in attempts),
- but the workload still did not enter a true drop-path regime.

## Implication for Downstream Benchmark Work

- `bd-2762` is complete because the escalation ladder and stop conditions were executed and documented.
- queue-drop improvement claims remain incomplete for downstream deltas until a future lane produces `pressure_profile=drop-path` with non-zero drop/lag signals.
