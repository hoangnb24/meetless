# Session Manifest Schema and Benchmark Interpretation Guide (bd-oe2)

Date: 2026-02-27  
Schema version: `1`

## Scope

This document defines the current manifest contracts emitted by `transcribe-live` and how to interpret benchmark outcomes without re-deriving context from code.

Manifest kinds covered:

1. `transcribe-live-runtime`
2. `transcribe-live-preflight`

## Versioning Contract

- Every manifest MUST include:
  - `schema_version` (string)
  - `kind` (string)
  - `generated_at_utc` (UTC timestamp)
- Consumers MUST reject unknown `schema_version` values by default, or run in explicit compatibility mode.
- Backward-compatible additions:
  - new top-level/object fields may be added
  - existing required fields must keep semantic meaning for a given `schema_version`
- Breaking changes require a schema version bump.

## Runtime Manifest (`kind=transcribe-live-runtime`)

Canonical example:

- `artifacts/validation/bd-z21.runtime.manifest.json`

Top-level required fields:

- identity/config:
  - `schema_version`, `kind`, `generated_at_utc`
  - `asr_backend`, `asr_model`, `asr_model_source`
  - `asr_model_checksum_sha256`, `asr_model_checksum_status`
  - `input_wav`
- `out_wav`
- `out_wav_semantics` (`"canonical session WAV artifact for the run"`)
- `out_wav_materialized` (bool; runtime write/copy truth)
- `out_wav_bytes` (u64; artifact byte size when materialized, else `0`)
- channel/mode:
  - `channel_mode_requested`, `channel_mode`
  - `speaker_labels`, `event_channels`
- quality pipeline:
  - `vad` (boundary detection parameters + count)
  - `transcript`
  - `readability_defaults` (line-format and overlap policy contract)
  - `transcript_per_channel`
  - `events` (ordered transcript event timeline: `partial`, `final`, `llm_final`, `reconciled_final`)
- performance/reliability:
  - `benchmark` (`wall_ms_p50/p95`, SLO booleans, summary/runs artifact paths)
  - `chunk_queue` (near-live chunk queue pressure + drop-oldest semantics + lag stats: `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
  - `cleanup_queue` (queue pressure + drain semantics)
  - `degradation_events`
  - `trust` (structured trust notices)
  - `event_counts`
- linkage:
  - `jsonl_path`

### `trust` object contract

- `degraded_mode_active` (bool)
- `notice_count` (int)
- `notices[]` objects with:
  - `code`
  - `severity`
  - `cause`
  - `impact`
  - `guidance`

### Model checksum status contract

`asr_model_checksum_status` is required wherever `asr_model_*` fields are emitted.

Current status values:

- `available`: checksum computed successfully for a file-backed model path
- `unavailable_directory`: resolved model path is a directory (checksum intentionally omitted)
- `unavailable_not_file`: resolved model path is neither regular file nor directory
- `unavailable_unresolved`: model path did not resolve in the current preflight/runtime context
- `unavailable_checksum_error`: model path resolved but checksum computation failed

## Preflight Manifest (`kind=transcribe-live-preflight`)

Canonical example:

- `artifacts/validation/bd-2p6.preflight.manifest.json`

Top-level required fields:

- `schema_version`
- `kind`
- `generated_at_utc`
- `overall_status` (`PASS|WARN|FAIL`)
- `config`:
  - `out_wav`, `out_wav_semantics`, `out_jsonl`, `out_manifest`
  - `asr_backend`
  - `asr_model_requested`, `asr_model_resolved`, `asr_model_source`
  - `asr_model_checksum_sha256`, `asr_model_checksum_status`
  - `sample_rate_hz`
- `checks[]` objects:
  - `id`
  - `status`
  - `detail`
  - `remediation`

## Example Schema Snapshot Artifact

Machine-readable schema snapshot from current examples:

- `artifacts/validation/bd-oe2.manifest-schema-examples.json`

This artifact captures top-level and key nested field sets for runtime and preflight manifests to support CI/schema drift checks.

## Benchmark Interpretation Guide

### Pass/Fail Gates

Use these in order:

1. Runtime execution validity:
  - all scenario runs succeed (`success_count == run_count` in harness summary)
  - no loader/runtime invocation anomalies (for direct binary runs on this host, preserve Swift runtime path)
2. Latency SLO:
  - use `benchmark.wall_ms_p95` and SLO booleans (`partial_slo_met`, `final_slo_met`)
3. Degradation/trust:
  - inspect `degradation_events[]` and `trust.notices[]`
  - any non-empty trust notices should be treated as a calibrated degraded run, not a silent pass
4. Queue isolation:
  - inspect near-live `chunk_queue` counters (`dropped_oldest`, `high_water`, `lag_p95_ms`) for backlog pressure severity
  - inspect `cleanup_queue` counters (`dropped_queue_full`, `failed`, `timed_out`, `pending`, `drain_completed`)

### Comparison Rules

Only compare runs when these are aligned:

- same `schema_version`
- same `kind` and artifact track
- same corpus version and sample set
- same backend/model/mode profile
- same run-count strategy (`benchmark.run_count`)

For cross-run comparisons, prefer:

- `wall_ms_p95` for guardrails
- `wall_ms_p50` for central tendency
- trust/degradation and cleanup counters for qualitative interpretation

### Caveats

1. Invalid harness runs (for example loader-context failures) can show misleadingly low latency/RSS and must be excluded.
2. Cleanup-enabled runs may maintain ASR SLO while still producing degraded trust state; trust notices are part of pass/fail interpretation.
3. Near-live reconciliation can improve post-session transcript completeness after queue pressure; interpret `reconciled_final` coverage with `chunk_queue` degradation counters rather than treating live-path drops as silent success.
4. Warm-up effects can skew early samples; inspect per-run series when p95 tails diverge.

## Referenced Benchmark Evidence

- Gate C validated runs:
  - `artifacts/bench/gate_c/dual_t4_dyld/20260227T122726Z/summary.csv`
  - `artifacts/bench/gate_c/mixed_t4_dyld/20260227T122735Z/summary.csv`
- Cleanup benchmark:
  - `artifacts/bench/cleanup/20260227T124016Z/cleanup_summary.csv`
  - `artifacts/bench/cleanup/20260227T124016Z/threshold_evaluation.csv`
