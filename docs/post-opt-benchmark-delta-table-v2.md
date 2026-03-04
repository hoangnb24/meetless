# Post-Optimization Benchmark Delta Table (v2)

Bead: `bd-nxug`  
Date: 2026-03-04

## Scope And Inputs

Frozen baseline source:
- `docs/phase1-baseline-anchors.md`

Post-opt evidence sources:
- `docs/gate-v1-acceptance-post-opt-evidence.md`
- `docs/gate-backlog-pressure-post-opt-evidence.md`
- `docs/gate-backlog-pressure-induced-post-opt-evidence.md`
- `docs/gate-backlog-pressure-aggressive-reruns.md`
- `docs/gate-near-live-soak-post-opt-evidence.md`
- `docs/soak-baseline-vs-post-opt-drift-deltas.md`

Raw artifact links used in this table:
- `artifacts/bench/gate_v1_acceptance/20260304T034250Z/summary.csv`
- `artifacts/bench/gate_backlog_pressure/20260304T034834Z/summary.csv`
- `artifacts/bench/gate_backlog_pressure/20260304T035146Z/summary.csv`
- `artifacts/bench/gate_backlog_pressure/aggressive_20260304T035732Z/attempt_results.csv`
- `artifacts/bench/gate_d/20260304T034759Z/summary.csv`

## Lane Validity Matrix

| Lane | Baseline Anchor | Post-Opt Artifact | Observed Class | Valid For Drop-Reduction Claim? | Notes |
|---|---|---|---|---|---|
| Compatibility (`B1.02`) | `compat-live-first-stable` | `gate_v1_acceptance/20260304T034250Z/summary.csv` | compatibility | no | validates mode-truth + first-stable timing |
| Default pressure (`B1.03`) | `default-pressure-buffered-no-drop` | `gate_backlog_pressure/20260304T034834Z/summary.csv` | buffered-no-drop | no | validates default queue/trust/degradation envelope |
| Induced pressure (`B1.04`) | `historical-drop-path-reference` | `gate_backlog_pressure/20260304T035146Z/summary.csv` | buffered-no-drop | **no (incomplete)** | induced command did not reach drop-path |
| Aggressive ladder (`B1.05`) | `historical-drop-path-reference` | `aggressive_20260304T035732Z/attempt_results.csv` | buffered-no-drop (all attempts) | **no (unresolved)** | 3/3 aggressive attempts still zero-drop |

## Delta Table

| Metric | Baseline | Post-Opt | Delta | Formula Output | Interpretation | Evidence |
|---|---:|---:|---:|---:|---|---|
| Cold first-stable timing (ms) | 2120 | 2120 | 0 | ratio `1.000` | no regression | `gate_v1_acceptance/20260304T034250Z/summary.csv` (`cold_first_stable_timing_ms`) |
| Warm first-stable timing (ms) | 2120 | 2120 | 0 | ratio `1.000` | no regression | same summary (`warm_first_stable_timing_ms`) |
| First-stable guardrail ceiling (ms) | 2332 | 2120 | -212 | pass | within 10% ceiling | formula from `phase1-baseline-anchors.md` |
| Runtime mode truth tuple | `live-stream/live-stream/--live-stream` | `live-stream/live-stream/--live-stream` | parity | pass | compatibility preserved | `gate_v1_acceptance/20260304T034250Z/summary.csv` |
| Default lane dropped_oldest | 0 | 0 | 0 | parity | expected buffered-no-drop behavior preserved | `gate_backlog_pressure/20260304T034834Z/summary.csv` |
| Default lane drop_ratio | 0.000000 | 0.000000 | 0.000000 | parity | expected buffered-no-drop behavior preserved | same summary |
| Default lane lag_p95_ms | 0 | 0 | 0 | parity | no lag inflation in default lane | same summary |
| Historical induced dropped_oldest comparison | 14 | 0 | -14 | reduction ratio `1.000` | **invalid as success claim** (post-opt lane not drop-path) | induced summary + lane validity matrix |
| Historical induced drop_ratio comparison | 0.466667 | 0.000000 | -0.466667 | reduction ratio `1.000` | **invalid as success claim** (post-opt lane not drop-path) | induced summary + lane validity matrix |
| Historical induced lag_p95_ms comparison | 240 | 0 | -240 | contextual | indicates no exercised drop-path pressure, not improvement proof | induced summary + aggressive ladder |

## Near-Live Soak Drift Summary (`bd-1ady`)

Dedicated soak comparison note:
- `docs/soak-baseline-vs-post-opt-drift-deltas.md`

Summary outcome:
- baseline-vs-post comparison shows no gate-level reliability regression (`gate_pass=true`, `failure_count=0`)
- post-opt soak coverage is materially larger (`run_count 2 -> 483`)
- post-opt internal drift ratios remain within Gate D ceilings (`latency=1.095201`, `memory=1.002526`, `lag=1.000000`)
- caveat: historical raw baseline summary (`20260228T154530Z`) is referenced in docs but absent in current workspace, so exact numeric baseline deltas for p50/p95 families remain partially evidence-limited

## Required But Currently Unavailable / Incomplete

| Required Metric Class | Availability | Reason | Next Bead |
|---|---|---|---|
| Mechanism-level hot-path churn counters (Path/PcmWindow distribution, scratch writes, pump cadence) | complete with legacy-baseline caveat | published in `docs/hot-path-diagnostics-before-after.md` with reproducible extractor output (`artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.csv`) and explicit provenance/fallback labels | `bd-a9fh` |
| User-perceived responsiveness deltas beyond first-stable (expanded metrics) | incomplete | dedicated responsiveness synthesis pending | `bd-i1ft` |
| Per-channel fairness/skew benchmark deltas | partially available | reliability tests prove fairness invariants, but benchmark delta rollup not yet published as metric table | `bd-i1ft` |
| Drop-path reduction claim against historical induced anchor | unresolved | induced + aggressive reruns stayed `buffered-no-drop` | follow-on induced profile work after `bd-2762` outcome |

## Final Determination For `bd-nxug`

- Compatibility and default-pressure deltas are complete and show no regression.
- Induced-pressure drop-path delta comparison is explicitly **incomplete/unresolved** because no post-opt run reached drop-path classification.
- Near-live soak drift synthesis (`bd-1ady`) indicates stable gate-level behavior with expanded sample coverage and no new blocker-grade runtime regressions.
- This table intentionally avoids optimistic queue-drop improvement claims and keeps the blocker state explicit for downstream reporting.
