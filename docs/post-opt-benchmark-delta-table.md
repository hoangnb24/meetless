# Post-Optimization Baseline vs Post-Opt Delta Table

Bead: `bd-nxug`  
Date: 2026-03-04

## Evidence Inputs

Baseline anchors:

- `docs/phase1-baseline-anchors.md`
- compatibility baseline: `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- default-pressure baseline: `artifacts/bench/gate_backlog_pressure/20260302T074649Z/summary.csv`
- historical induced drop-path reference: values frozen in `docs/phase1-baseline-anchors.md` (`dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95_ms=240`)

Post-opt evidence:

- compatibility lane (`bd-3fnd`): `artifacts/bench/gate_v1_acceptance/20260304T034250Z/summary.csv`
- default-pressure lane (`bd-1w6i`): `artifacts/bench/gate_backlog_pressure/20260304T034834Z/summary.csv`
- induced lane (`bd-1a7y`): `artifacts/bench/gate_backlog_pressure/20260304T035146Z/summary.csv`
- aggressive rerun ladder (`bd-2762`): `artifacts/bench/gate_backlog_pressure/aggressive_20260304T035732Z/attempt_results.csv`
- near-live soak post-opt lane (`bd-2ptm`): `artifacts/bench/gate_d/20260304T034759Z/summary.csv`

## Lane Validity State

| Lane | Validity | Reason |
|---|---|---|
| Compatibility (`gate_v1_acceptance`) | valid for timing + tuple parity | baseline/post both `live-stream`, stable emit timing populated |
| Default pressure (`gate_backlog_pressure`) | valid for buffered-no-drop parity | baseline/post both classify `buffered-no-drop` |
| Induced pressure (`bd-1a7y`) | invalid for drop-path improvement claims | post run stayed `buffered-no-drop` |
| Aggressive reruns (`bd-2762`) | unresolved for drop-path exercise | 3/3 attempts stayed `buffered-no-drop` |

## Near-Live Soak Delta Synthesis (`bd-1ady`)

Primary synthesis:
- `docs/gate-near-live-soak-drift-deltas.md`

Integrated outcome:
- baseline-comparable surfaces preserve parity (`failure_count=0`, threshold booleans all true, `gate_pass=true`)
- post-opt drift ratios are within soak thresholds:
  - latency drift ratio `1.095201 <= 1.25`
  - memory growth ratio `1.002526 <= 1.30`
  - lag drift ratio `1.000000 <= 1.50`
- full numeric baseline-vs-post-opt drift deltas remain partially unavailable because the baseline `gate_d` summary artifact referenced in `docs/gate-d-report.md` is not currently retained in this workspace

## Delta Table

Formulas are the frozen formulas from `docs/phase1-baseline-anchors.md`.

| Metric Family | Metric | Baseline | Post-Opt | Delta | Status |
|---|---|---:|---:|---:|---|
| Compatibility timing | first stable timing (ms) | `2120` | `2120` | `0` | valid |
| Compatibility timing | first stable ratio | `1.000` anchor | `1.000` | `0.000` | valid |
| Compatibility tuple | runtime tuple (`mode/taxonomy/selector`) | `live-stream/live-stream/--live-stream` | same | none | valid |
| Default pressure | submitted | `78` | `34` | `-44` | valid (classification parity retained) |
| Default pressure | dropped_oldest | `0` | `0` | `0` | valid |
| Default pressure | drop_ratio | `0.000000` | `0.000000` | `0.000000` | valid |
| Default pressure | lag_p95_ms | `0` | `0` | `0` | valid |
| Induced drop-path reference | dropped_oldest | `14` | `0` | `-14` | **incomplete** (post lane not drop-path) |
| Induced drop-path reference | drop_ratio | `0.466667` | `0.000000` | `-0.466667` | **incomplete** (post lane not drop-path) |
| Induced drop-path reference | lag_p95_ms | `240` | `0` | `-240` | **incomplete** (post lane not drop-path) |
| Aggressive rerun ladder | drop-path observed | baseline expectation: eventually yes | `false` (`3/3 buffered-no-drop`) | n/a | unresolved blocker-grade |

## User-Perceived Responsiveness (Where Available)

From manifest `first_emit_timing_ms` surfaces:

| Lane | first_any | first_partial | first_final | first_stable | Interpretation |
|---|---:|---:|---:|---:|---|
| compatibility baseline (`20260301T130355Z` cold) | `1180` | `1180` | `2120` | `2120` | anchor |
| compatibility post-opt (`20260304T034250Z` cold) | `1180` | `1180` | `2120` | `2120` | parity |
| default-pressure baseline (`20260302T074649Z`) | `940` | `940` | `2120` | `2120` | anchor |
| default-pressure post-opt (`20260304T034834Z`) | `940` | `940` | `2120` | `2120` | parity |
| induced post-opt (`20260304T035146Z`) | `940` | `940` | `2120` | `2120` | no timing regression, but no drop-path |

## Per-Channel Fairness / Skew Context

JSONL transcript event distribution snapshots:

- baseline default: partial (`mic=35`, `system=35`), final (`mic=4`, `system=4`)
- post default: partial (`mic=13`, `system=13`), final (`mic=4`, `system=4`)
- post induced: partial (`mic=13`, `system=13`), final (`mic=4`, `system=4`)
- aggressive attempt-03: partial (`mic=56`, `system=56`), final (`mic=4`, `system=4`)

Interpretation:

- no observed mic/system skew in these deterministic runs (channel counts remained symmetric)
- pressure-profile objective (drop-path exercise) remained unresolved despite symmetric per-channel emission

## Mechanism-Level / Drift Coverage Status

- hot-path I/O churn and diagnostic counter deltas: documented separately (`docs/hot-path-diagnostics-before-after.md`, `bd-a9fh`)
- near-live soak drift deltas: complete with baseline-retention caveat (`docs/gate-near-live-soak-drift-deltas.md`, `bd-1ady`)

These feeds remain required inputs for final go/no-go synthesis (`bd-1e0t`, `bd-1wza`).

## Conclusion

Current post-opt benchmark deltas show:

1. timing and runtime tuple parity are stable versus frozen anchors
2. buffered-no-drop behavior remains stable under default and induced-profile runs
3. drop-path improvement claims are **incomplete** because true drop-path behavior was not re-exercised (including aggressive reruns)
4. near-live soak thresholds remain green post-opt; numeric drift deltas are partially constrained by baseline artifact retention gaps

This document intentionally does not claim queue-drop improvement success.
