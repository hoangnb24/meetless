# Runtime Golden Artifact Matrix (bd-1qfx)

Date: 2026-03-02  
Status: frozen Phase A baseline for runtime contract comparisons

## Purpose

This document freezes deterministic runtime artifact examples for:
- representative-offline path
- fake-capture live path

Machine-readable baseline:
- `artifacts/validation/bd-1qfx.golden-artifact-matrix.json`

Primary evidence inputs:
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/status.txt`
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- `artifacts/bench/gate_backlog_pressure/20260301T130103Z/status.txt`
- `artifacts/bench/gate_backlog_pressure/20260301T130103Z/summary.csv`

Related baseline freeze:
- `docs/phase1-baseline-anchors.md` defines how the frozen runtime examples here are consumed by Phase 1 and post-opt benchmark comparisons.

## Frozen Matrix Rows

| Row ID | Path type | Manifest | JSONL | Key expectations |
|---|---|---|---|---|
| `representative_offline_fallback` | representative-offline | `artifacts/smoke/offline/session.manifest.json` | `artifacts/smoke/offline/session.jsonl` | `runtime_mode=representative-offline`; event_counts `{vad_boundary:1, transcript:2}`; trust/degradation example: `mode_degradation` + `fallback_to_mixed`; no lifecycle-phase rows expected |
| `fake_capture_live_cold_clean` | fake-capture live | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.manifest.json` | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.jsonl` | mode triple must be `live-stream/live-stream/--live-stream`; lifecycle phases `warmup,active,draining,shutdown`; event_counts `{partial:16, final:8}`; first stable emit `2120ms`; trust/degradation empty |
| `fake_capture_live_warm_clean` | fake-capture live | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.manifest.json` | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.jsonl` | same invariants as cold clean lane (`first_stable_timing_ms=2120`, zero trust/degradation) |
| `fake_capture_live_backlog_profile_buffered_no_drop` | fake-capture live pressure profile | `artifacts/bench/gate_backlog_pressure/20260301T130103Z/runtime.manifest.json` | `artifacts/bench/gate_backlog_pressure/20260301T130103Z/runtime.jsonl` | mode triple unchanged; lifecycle phases unchanged; event_counts `{partial:70, final:8}`; trust/degradation empty for buffered-no-drop profile |

## Lifecycle and Event-Count Expectations

### Live rows (`fake_capture_live_*`)

Expected lifecycle order in JSONL:
1. `warmup`
2. `active`
3. `draining`
4. `shutdown`

Expected control-event family presence in JSONL:
- `asr_worker_pool`
- `chunk_queue`
- `cleanup_queue`
- `reconciliation_matrix`
- `vad_boundary`
- `lifecycle_phase`

Expected transcript event families in JSONL:
- `partial`
- `final`

Expected absence for clean matrix rows:
- no `trust_notice` rows
- no `mode_degradation` rows
- no `reconciled_final` rows

### Representative-offline row

Expected JSONL event families:
- `partial`
- `final`
- `vad_boundary`
- `mode_degradation`
- `trust_notice`
- `cleanup_queue`

Expected trust/degradation baseline:
- trust code: `mode_degradation`
- degradation code: `fallback_to_mixed`

## Trust/Degradation Code Examples

The matrix JSON includes two code-example sources:
1. deterministic offline fallback example (`mode_degradation`, `fallback_to_mixed`)
2. supplemental live-stream manifest example (`chunk_queue_backpressure`, `chunk_queue_backpressure_severe`, `reconciliation_applied`, plus corresponding degradation codes)

The supplemental live-stream row is kept as code-vocabulary reference. The four matrix rows above are the deterministic baseline for regression assertions.

## Intended Follow-On Use

This baseline is intended to be consumed by:
- `bd-1n5v` contract regression harness
- `bd-10uo` JSONL stable invariant assertions
- `bd-3ruu` manifest stable-key assertions

Any intentional breaking baseline updates must be documented with migration rationale and updated matrix expectations in the same change.
