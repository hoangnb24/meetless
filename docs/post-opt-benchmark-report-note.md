# Post-Optimization Benchmark Delta Report Note

Bead: `bd-1e0t`  
Date: 2026-03-04

## Purpose

Publish a reviewer-ready benchmark delta note that consolidates baseline/post-opt evidence, states explicit pass/fail outcomes, and captures caveats needed for go/no-go interpretation.

## Evidence Index

Baseline anchors and formulas:
- `docs/phase1-baseline-anchors.md`

Core post-opt lane evidence:
- `docs/gate-v1-acceptance-post-opt-evidence.md`
- `docs/gate-backlog-pressure-post-opt-evidence.md`
- `docs/gate-backlog-pressure-induced-post-opt-evidence.md`
- `docs/gate-backlog-pressure-aggressive-reruns.md`

Expanded metric-family evidence:
- `docs/benchmark-responsiveness-metrics.md`
- `docs/hot-path-diagnostics-before-after.md`
- `docs/soak-baseline-vs-post-opt-drift-deltas.md`

Current synthesis table:
- `docs/post-opt-benchmark-delta-table-v2.md`

## Metric Family Delta Summary

| Metric Family | Baseline/Target | Post-Opt Observation | Verdict | Evidence |
|---|---|---|---|---|
| Compatibility timing + mode truth | `first_stable<=2332`, tuple `live-stream/live-stream/--live-stream` | cold/warm first-stable `2120`, tuple unchanged | pass | `gate_v1_acceptance/20260304T034250Z/summary.csv` via `docs/gate-v1-acceptance-post-opt-evidence.md` |
| Default pressure bounded behavior | `buffered-no-drop`, zero trust/degradation escalation, queue shape parity | `dropped_oldest=0`, `drop_ratio=0`, trust/degradation empty, thresholds true | pass | `gate_backlog_pressure/20260304T034834Z/summary.csv` via `docs/gate-backlog-pressure-post-opt-evidence.md` |
| Induced drop-path reduction claim | historical induced anchor: `dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95=240`; lane must actually exercise drop-path | induced lane + aggressive ladder remained `buffered-no-drop` with zero drop/lag | **fail (claim incomplete)** | `docs/gate-backlog-pressure-induced-post-opt-evidence.md`, `docs/gate-backlog-pressure-aggressive-reruns.md` |
| Responsiveness (user-perceived) | no regression in first-partial/final/stable and no channel skew | timing deltas are `0 ms` for compatibility/default lanes; `first_stable_skew=0` across lanes | pass | `docs/benchmark-responsiveness-metrics.md` |
| Hot-path churn/diagnostics | mechanism shift should reduce avoidable path/temp churn and expose diagnostics | `scratch_writes_est 78->34`, `Path 78->0`, `PcmWindow 0->34`; pump counters present post-opt | pass with caveat | `docs/hot-path-diagnostics-before-after.md` |
| Near-live soak drift | preserve gate reliability/drift thresholds under sustained run | `gate_pass=true`, `failure_count=0`, `run_count 2->483`, internal drift ratios within ceilings | pass with caveat | `docs/soak-baseline-vs-post-opt-drift-deltas.md` |

## Pass/Fail Verdict

Per acceptance-threshold interpretation:

1. Compatibility/default-lane non-regression: **PASS**
2. Responsiveness/churn/soak evidence integration: **PASS** (with documented evidence gaps)
3. Drop-path improvement proof against historical induced anchor: **FAIL / INCOMPLETE**

Overall report verdict for this bead:
- **COMPLETE AS REPORT NOTE**
- **Optimization-improvement claim status: unresolved** until a true post-opt drop-path lane is exercised and compared against the induced anchor formulas.

## Caveats and Interpretation Notes

1. Do not treat zero-drop induced/aggressive outcomes as queue-drop improvement success; lane class stayed `buffered-no-drop`.
2. `docs/soak-baseline-vs-post-opt-drift-deltas.md` documents a medium-severity evidence gap: historical raw soak summary (`20260228T154530Z`) is referenced but not present in the current workspace for full numeric p50/p95 baseline parity.
3. Hot-path pump counters are directly comparable post-opt but partially unavailable in legacy baseline artifact format; this is recorded as provenance-limited, not inferred parity.

## Unresolved Risk Items (For Decision Beads)

- `R-B1-001` (Critical): benchmark claim invalidation risk from lane misclassification/baseline drift remains open when drop-path is not exercised.
- `R-P1-003` / `R-P1-004` (High): trust/degradation semantic stability and callback-contract degradation risks remain decision inputs outside this report note.

Source: `docs/reliability-risk-register.md`.

## Reviewer Repro Commands

```bash
make gate-v1-acceptance
make gate-backlog-pressure
scripts/gate_backlog_pressure.sh --chunk-window-ms 1200 --chunk-stride-ms 120 --chunk-queue-cap 2 --min-drop-ratio 0.15 --max-drop-ratio 0.80 --min-lag-p95-ms 240
make gate-d-soak
```

For mechanism-level delta reproduction:

```bash
scripts/hot_path_diagnostics_delta.py \
  --baseline-root artifacts/bench/gate_backlog_pressure/20260302T074649Z \
  --post-root artifacts/bench/gate_backlog_pressure/20260304T034834Z \
  --out-csv artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.csv \
  --out-json artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.json
```

## Decision Handoff

This note is ready input for:
- `bd-1wza` (record optimization readiness decision)

Decision guidance:
- treat compatibility/default/soak/responsiveness as non-regressive,
- keep drop-path reduction claim unresolved until evidence class changes from `buffered-no-drop` to true drop-path.
