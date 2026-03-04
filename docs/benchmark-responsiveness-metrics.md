# Benchmark Responsiveness Metrics

Bead: `bd-i1ft`  
Date: 2026-03-04

## Objective

Add user-perceived responsiveness metrics to benchmark analysis using existing artifacts only (no contract changes).

## Artifact Inputs

- compatibility baseline (cold): `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.{manifest.json,jsonl}`
- compatibility post-opt (cold): `artifacts/bench/gate_v1_acceptance/20260304T034250Z/cold/runtime.{manifest.json,jsonl}`
- default-pressure baseline: `artifacts/bench/gate_backlog_pressure/20260302T074649Z/runtime.{manifest.json,jsonl}`
- default-pressure post-opt: `artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.{manifest.json,jsonl}`
- induced post-opt: `artifacts/bench/gate_backlog_pressure/20260304T035146Z/runtime.{manifest.json,jsonl}`
- aggressive attempt-03: `artifacts/bench/gate_backlog_pressure/aggressive_20260304T035732Z/attempt-03/runtime.{manifest.json,jsonl}`

## Extraction Formulas

1. `first_partial_timing_ms = manifest.first_emit_timing_ms.first_partial`
2. `first_final_timing_ms = manifest.first_emit_timing_ms.first_final`
3. `first_stable_timing_ms = manifest.first_emit_timing_ms.first_stable`
4. `partial_cadence_jitter_p95_ms(channel) = p95(diff(sorted(partial.start_ms[channel])))`
5. `first_stable_skew_ms = abs(first_stable_start_ms(mic) - first_stable_start_ms(system))`

## Metric Table

| Lane | first_any | first_partial | first_final | first_stable | partial_gap_p95_mic | partial_gap_p95_system | first_stable_skew |
|---|---:|---:|---:|---:|---:|---:|---:|
| compat baseline cold | `1180` | `1180` | `2120` | `2120` | `3200` | `3200` | `0` |
| compat post-opt cold | `1180` | `1180` | `2120` | `2120` | `3200` | `3200` | `0` |
| default baseline | `940` | `940` | `2120` | `2120` | `2480` | `2480` | `0` |
| default post-opt | `940` | `940` | `2120` | `2120` | `3200` | `3200` | `0` |
| induced post-opt | `940` | `940` | `2120` | `2120` | `3200` | `3200` | `0` |
| aggressive attempt-03 | `940` | `940` | `2120` | `2120` | `1700` | `1700` | `0` |

## Delta Interpretation

Timing deltas (baseline vs post-opt):

- compatibility lane: first-partial/final/stable deltas are all `0 ms` (neutral)
- default-pressure lane: first-partial/final/stable deltas are all `0 ms` (neutral)
- induced lane: first-partial/final/stable remained `940/2120/2120` (neutral timing, but lane classification remained buffered-no-drop)

Cadence/skew interpretation:

- first-stable skew remained `0 ms` across lanes (no mic/system skew observed)
- partial cadence jitter changed by lane/profile (for example default `2480 -> 3200`), but final/stable timing stayed neutral
- jitter changes should be interpreted with event-volume context, not alone

## Event-Volume Context

Transcript event counts from JSONL (per channel):

| Lane | partial_mic | partial_system | final_mic | final_system |
|---|---:|---:|---:|---:|
| compat baseline cold | `8` | `8` | `4` | `4` |
| compat post-opt cold | `4` | `4` | `4` | `4` |
| default baseline | `35` | `35` | `4` | `4` |
| default post-opt | `13` | `13` | `4` | `4` |
| induced post-opt | `13` | `13` | `4` | `4` |
| aggressive attempt-03 | `56` | `56` | `4` | `4` |

This indicates:

- final/stable availability remained constant while partial cadence density varied by profile
- responsiveness regressions are not indicated by first-stable timing or channel skew in current evidence

## Anomaly Notes

- induced and aggressive lanes remained `buffered-no-drop`, so responsiveness metrics there are valid as responsiveness observations but not as drop-path-quality proof.
- queue-drop improvement claims remain governed by `bd-2762` unresolved outcome.

## Cross-Links

- delta synthesis using these metrics: `docs/post-opt-benchmark-delta-table.md` (`bd-nxug`)
- induced/aggressive lane classification evidence: `docs/gate-backlog-pressure-induced-post-opt-evidence.md`, `docs/gate-backlog-pressure-aggressive-reruns.md`
