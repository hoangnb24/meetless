# Phase Gate Consolidated Report (bd-qjf)

Date: 2026-02-28  
Status: pass (current evidence set)

## Purpose

Provide one synthesis point for phase-next reliability gates so future ADRs, packaging decisions, and regressions can cite a single pass/fail source instead of scanning multiple independent gate docs.

## Consolidated Machine-Readable Rollup

- `artifacts/validation/bd-qjf.phase-gates.csv`

This rollup references each gate's canonical `summary.csv` and normalized pass field.

## Gate Matrix

| Gate | Why it matters | Summary artifact | Pass field | Current result |
|---|---|---|---|---|
| Mixed-rate capture regression (`bd-2nh`) | Protects capture-path adaptation and transport health under rate mismatch | `artifacts/bench/mixed_rate/20260228T144157Z/summary.csv` | `scenario_pass` | `true` |
| Near-live backlog pressure (`bd-2w8`) | Verifies bounded queue degradation + trust/degradation signaling under induced pressure | `artifacts/bench/gate_backlog_pressure/20260228T153738Z/summary.csv` | `gate_pass` | `true` |
| Transcript completeness under backlog (`bd-sta`) | Proves reconciliation improves readability/completeness after backlog drops | `artifacts/bench/gate_transcript_completeness/20260228T154256Z/summary.csv` | `gate_pass` | `true` |
| Near-live soak (`bd-23u`) | Verifies sustained near-live runtime stability and artifact truth over repeated runs | `artifacts/bench/gate_d/20260228T154530Z/summary.csv` | `gate_pass` | `true` |

Phase decision rule:
- phase is considered passing only if all gate rows above are passing.

Current phase result:
- `phase_pass=true` (all four gate rows pass in `artifacts/validation/bd-qjf.phase-gates.csv`)

## Threshold Snapshot By Gate

### Mixed-rate regression

Source: `docs/mixed-rate-regression.md`

Required:
- `policy=adapt-stream-rate`
- `mismatch_observed=true`
- `adaptation_observed=true`
- `transport_healthy=true`
- `scenario_pass=true`

Observed (`20260228T144157Z`):
- `mismatch_observed=true`
- `adaptation_observed=true`
- `transport_healthy=true`
- `scenario_pass=true`

### Near-live backlog pressure

Source: `docs/gate-backlog-pressure.md`

Required:
- queue pressure observed (`dropped_oldest > 0`)
- queue saturation (`high_water >= max_queue`)
- bounded drop ratio (`min_drop_ratio <= drop_ratio <= max_drop_ratio`)
- lag floor met (`lag_p95_ms >= min_lag_p95_ms`)
- degradation/trust/reconciliation signals present
- JSONL includes `event_type=chunk_queue`
- `gate_pass=true`

Observed (`20260228T153738Z`):
- `dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95_ms=240`
- all threshold booleans true
- `gate_pass=true`

Historical baseline note:
- this observation is the frozen induced-pressure reference used by `docs/phase1-baseline-anchors.md`
- current accepted default profile is `buffered-no-drop`, so do not reuse this row as a default-pressure expectation

### Transcript completeness under backlog

Source: `docs/gate-transcript-completeness.md`

Required:
- reconciliation events and reconciliation signaling present
- backlog drop observed
- completeness gain and post-reconciliation completeness thresholds met
- replay sections and chunk_queue control event present
- `gate_pass=true`

Observed (`20260228T154256Z`):
- `pre_completeness=0.571429`
- `post_completeness=1.000000`
- `completeness_gain=0.428571`
- all threshold booleans true
- `gate_pass=true`

### Near-live soak

Source: `docs/gate-d-report.md`

Required:
- soak duration, reliability, latency drift, and memory drift thresholds pass
- near-live mode truth, chunk visibility/drain, continuity signal, out-wav truth, and lag drift thresholds pass
- `gate_pass=true`

Observed (`20260228T154530Z`):
- `run_count=2`, `failure_count=0`
- all threshold booleans true
- `gate_pass=true`

Post-opt observed (`20260304T034759Z`):
- `run_count=483`, `failure_count=0`
- all threshold booleans true
- `gate_pass=true`
- drift ratios from summary metrics:
  - latency drift ratio `1.095201` (`<= 1.25`)
  - memory growth ratio `1.002526` (`<= 1.30`)
  - lag drift ratio `1.000000` (`<= 1.50`)

Baseline-vs-post-opt interpretation (`bd-1ady`):
- baseline-comparable soak verdict surfaces remain parity-green (no reliability or threshold regression)
- numeric baseline-vs-post-opt drift deltas are partially unavailable because the historical baseline `summary.csv` referenced by `docs/gate-d-report.md` is not retained locally
- canonical synthesis: `docs/gate-near-live-soak-drift-deltas.md`

## Pass/Fail Interpretation

- If any gate summary reports a failing pass field, phase reliability is failing and should block downstream packaging decisions.
- On failure, first investigate the failing gate's local `status.txt` / `summary.csv` and linked runtime artifacts before changing global thresholds.
