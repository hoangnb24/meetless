# Hot-Path Diagnostics Before vs After (B1.10)

Bead: `bd-a9fh`  
Date: 2026-03-04

## Scope

This note publishes mechanism-level before/after counters for:

1. scratch/temp write volume
2. request mode distribution (`Path` vs `PcmWindow`)
3. pump cadence and forced-decision diagnostics

## Inputs

Baseline artifact root (frozen default-pressure anchor):

- `artifacts/bench/gate_backlog_pressure/20260302T074649Z`

Post-opt artifact root (default-pressure post-opt evidence):

- `artifacts/bench/gate_backlog_pressure/20260304T034834Z`

Generated outputs:

- `artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.csv`
- `artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.json`

## Repro Command

```bash
scripts/hot_path_diagnostics_delta.py \
  --baseline-root artifacts/bench/gate_backlog_pressure/20260302T074649Z \
  --post-root artifacts/bench/gate_backlog_pressure/20260304T034834Z \
  --baseline-label baseline_default \
  --post-label post_default \
  --out-csv artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.csv \
  --out-json artifacts/bench/hot_path_diagnostics/20260304T041318Z/delta.json
```

## Delta Table

| Metric | Baseline | Post-Opt | Delta (post-baseline) | Source Provenance |
|---|---:|---:|---:|---|
| scratch/temp write estimate (`scratch_writes_est`) | 78 | 34 | -44 | baseline: `fallback.manifest.temp_audio_deleted_plus_retained`; post: `stdout.hot_path_scratch` |
| scratch reuse overwrites (`scratch_reuse_overwrites_est`) | n/a | 32 | n/a | baseline missing in legacy artifact; post: `stdout.hot_path_scratch` |
| request distribution `Path` (`request_input_path`) | 78 | 0 | -78 | baseline: manifest-derived fallback; post: `stdout.hot_path_transport` |
| request distribution `PcmWindow` (`request_input_pcm_window`) | 0 | 34 | +34 | baseline: manifest-derived fallback; post: `stdout.hot_path_transport` |
| pump chunk decisions (`pump_chunk_decisions`) | n/a | 1100 | n/a | baseline legacy artifact has no explicit pump breadcrumb; post: `stdout.hot_path_pump` |
| pump forced decisions (`pump_forced_decisions`) | n/a | 4 | n/a | baseline legacy artifact has no explicit pump breadcrumb; post: `stdout.hot_path_pump` |
| pump forced shutdown triggers (`pump_forced_shutdown_triggers`) | n/a | 4 | n/a | baseline legacy artifact has no explicit pump breadcrumb; post: `stdout.hot_path_pump` |
| chunk queue drain completed (`chunk_queue_drain_completed`) | true | true | n/a | `manifest.chunk_queue.drain_completed` on both |

## Interpretation

1. Scratch/temp churn dropped materially in the default-pressure lane (`78 -> 34`, delta `-44`), with post-opt writes now coming from reusable scratch-path instrumentation rather than per-request temp-path cleanup.
2. Request transport shifted from path-backed to PCM-window-backed (`Path 78 -> 0`, `PcmWindow 0 -> 34`) in the compared lane, matching the intended hot-path direction.
3. Pump/forced-decision counters are directly available post-opt (`chunk_decisions=1100`, `forced_decisions=4`, `forced_shutdown_triggers=4`) but are not present in the frozen pre-opt artifact format; this is recorded explicitly as legacy observability gap, not silently imputed.

## Notes On Fallbacks

For legacy baseline artifacts that predate `hot_path_*` fields:

- `request_input_path` fallback = `temp_audio_deleted + temp_audio_retained`
- `request_input_pcm_window` fallback = `submitted - request_input_path`
- `scratch_writes_est` fallback = `temp_audio_deleted + temp_audio_retained`

These fallback rules are encoded in:

- `scripts/hot_path_diagnostics_delta.py`

## Benchmark Workflow Linkage

This note closes the mechanism-level gap previously called out in:

- `docs/post-opt-benchmark-delta-table-v2.md`

It should be cited by downstream reporting/go-no-go beads that need hard evidence for hot-path mechanism shifts.
