# Soak Baseline vs Post-Opt Drift Deltas

Bead: `bd-1ady`  
Date: 2026-03-04

## Scope

Compute baseline-vs-post-opt drift deltas for near-live soak evidence and classify regressions with explicit follow-up recommendations.

## Evidence Inputs

Baseline soak evidence:
- `docs/gate-phase-next-report.md` (`Near-live soak` row + observed snapshot for `20260228T154530Z`)
- `docs/gate-d-report.md` (Gate D threshold definitions and baseline validation reference)

Post-opt soak evidence:
- `docs/gate-near-live-soak-post-opt-evidence.md`
- `artifacts/bench/gate_d/20260304T034759Z/summary.csv`
- `artifacts/bench/gate_d/20260304T034759Z/status.txt`

## Baseline Availability Notes

Historical baseline artifact path is documented as:
- `artifacts/bench/gate_d/20260228T154530Z/summary.csv`

That raw baseline summary is not present in the current workspace. Available baseline fields are therefore the values explicitly recorded in docs:
- `gate_pass=true`
- `run_count=2`
- `failure_count=0`
- all threshold booleans true

This is sufficient for gate-level and reliability deltas, but not for exact numeric p50/p95 drift deltas against the historical run.

## Delta Table (Baseline vs Post-Opt)

| Metric | Baseline Evidence | Post-Opt Evidence | Delta | Status | Notes |
|---|---:|---:|---:|---|---|
| `gate_pass` | `true` | `true` | none | stable | no gate-level regression |
| `failure_count` | `0` | `0` | `0` | stable | no reliability regression |
| `run_count` | `2` | `483` | `+481` | improved | much larger soak sample size than baseline validation run |
| Threshold booleans (`duration/reliability/latency/memory/mode/queue/drain/out_wav/continuity/lag`) | all `true` | all `true` | none | stable | threshold envelope preserved |

## Post-Opt Drift Ratios (Gate D Internal)

Using `artifacts/bench/gate_d/20260304T034759Z/summary.csv`:

- latency drift ratio:
  - `manifest_wall_ms_p95_p95 / manifest_wall_ms_p95_p50 = 782.0775081 / 714.09475 = 1.095201`
  - threshold ceiling: `<= 1.25`
  - result: pass
- memory growth ratio:
  - `max_rss_kb_p95 / max_rss_kb_p50 = 200964505.6 / 200458240.0 = 1.002526`
  - threshold ceiling: `<= 1.30`
  - result: pass
- lag drift ratio:
  - `chunk_lag_p95_ms_p95 / chunk_lag_p95_ms_p50 = 4000 / 4000 = 1.000000`
  - threshold expectation: stable lag drift (`threshold_lag_drift_ok=true`)
  - result: pass

## Regression Classification

| Finding | Severity | Why | Follow-Up |
|---|---|---|---|
| No comparable gate-level regression observed | `none` | baseline/post gate and reliability signals are stable | no blocker action required |
| Missing historical raw soak summary for full numeric delta parity | `medium` | prevents exact baseline-to-post numeric drift deltas for p50/p95 families | preserve historical `20260228T154530Z/summary.csv` in repo artifacts/docs or re-materialize equivalent baseline reference snapshot |

## Decision Context Integration

- Near-live soak evidence is non-regressive on all comparable baseline fields and preserves threshold integrity.
- Post-opt soak run significantly expands sample coverage (`2 -> 483` runs) while retaining zero failures.
- Remaining decision caveat is evidentiary completeness (historical raw soak summary availability), not a runtime stability failure.

This result should be consumed alongside:
- `docs/post-opt-benchmark-delta-table-v2.md`
- `docs/gate-near-live-soak-post-opt-evidence.md`
