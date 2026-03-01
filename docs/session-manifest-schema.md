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
  - `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
  - `speaker_labels`, `event_channels`
- quality pipeline:
  - `vad` (boundary detection parameters + count)
  - `transcript`
  - `readability_defaults` (line-format and overlap policy contract)
  - `transcript_per_channel`
  - `terminal_summary` (deterministic mirror of emitted stable terminal lines)
  - `events` (ordered transcript event timeline: `partial`, `final`, `llm_final`, `reconciled_final`; see `docs/live-jsonl-event-contract.md`)
- performance/reliability:
  - `benchmark` (`wall_ms_p50/p95`, SLO booleans, summary/runs artifact paths)
  - `reconciliation` (`required`, `applied`, `trigger_count`, `trigger_codes`)
  - `asr_worker_pool` (prewarm status, bounded queue counters, temp-audio cleanup/retention counters)
  - `chunk_queue` (live-runtime chunk queue pressure + drop/defer semantics + lag stats: `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
  - `cleanup_queue` (queue pressure + drain semantics)
  - `degradation_events`
  - `trust` (structured trust notices)
  - `event_counts` (`vad_boundary`, `transcript`, `partial`, `final`, `llm_final`, `reconciled_final`)
  - `session_summary` (deterministic close-summary mirror for machine consumption)
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

### `reconciliation` object contract

- `required` (bool; trigger matrix required reconciliation work for this session)
- `applied` (bool; one or more `reconciled_final` events were actually emitted)
- `trigger_count` (int)
- `trigger_codes` (ordered string array)

Current trigger codes:

- `chunk_queue_drop_oldest`
- `continuity_recovered_with_gaps`
- `continuity_unverified`
- `shutdown_flush_boundary`

### Model checksum status contract

`asr_model_checksum_status` is required wherever `asr_model_*` fields are emitted.

Current status values:

- `available`: checksum computed successfully for a file-backed model path
- `unavailable_directory`: resolved model path is a directory (checksum intentionally omitted)
- `unavailable_not_file`: resolved model path is neither regular file nor directory
- `unavailable_unresolved`: model path did not resolve in the current preflight/runtime context
- `unavailable_checksum_error`: model path resolved but checksum computation failed

### `session_summary` object contract

`session_summary` is the machine-consumable mirror of the terminal close-summary ordering:

1. `session_status` (`ok` or `degraded` for successful runs)
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. `transcript_events` (`partial`, `final`, `llm_final`, `reconciled_final`)
6. `chunk_queue` (`submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `drain_completed`)
7. `chunk_lag` (`lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
8. `trust_notices` (`count`, `top_codes`)
9. `degradation_events` (`count`, `top_codes`)
10. `cleanup_queue` (`enabled`, `submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `timed_out`, `failed`, `retry_attempts`, `pending`, `drain_completed`)
11. `artifacts` (`out_wav`, `out_jsonl`, `out_manifest`)

`trust_notices.top_codes` and `degradation_events.top_codes` are deterministic summary sets: unique codes sorted lexicographically and capped at three entries.

### `terminal_summary` object contract

`terminal_summary` captures how the operator-facing transcript summary behaved without requiring terminal replay:

- `live_mode` (bool; `true` for `--live-chunked` or `--live-stream` runtime selectors)
- `stable_line_count` (int; number of deterministic stable transcript lines available at close)
- `stable_lines_replayed` (bool; `false` when live runtime already emitted stable lines during execution, `true` for non-live summary replay)
- `stable_lines` (ordered string array; exact stable transcript lines in deterministic summary order)

Interpretation rules:

- `live_mode=true` with `stable_lines_replayed=false` means operators already saw stable transcript lines during active runtime, so close-summary replay was intentionally suppressed.
- `live_mode=false` with `stable_lines_replayed=true` means the end summary is the primary operator-visible stable transcript surface.
- Use `terminal_summary.stable_lines` together with `events[]` when auditing readability regressions without requiring a TTY capture.

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
  - `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
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
  - interpret `trust.notices[].code` together with `reconciliation.trigger_codes` when deciding whether `final` or `reconciled_final` is the canonical review surface
4. Queue isolation:
  - inspect live-runtime `chunk_queue` counters (`dropped_oldest`, `high_water`, `lag_p95_ms`) for backlog pressure severity
  - inspect `cleanup_queue` counters (`dropped_queue_full`, `failed`, `timed_out`, `pending`, `drain_completed`)
5. Terminal/operator parity:
  - inspect `terminal_summary` to determine whether stable transcript lines were shown during runtime or replayed only at shutdown
  - use `session_summary` for machine-comparable closeout and `terminal_summary` for operator-visible line-level audit

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
3. Live-runtime reconciliation can improve post-session transcript completeness after queue pressure; interpret `reconciled_final` coverage with `chunk_queue` degradation counters rather than treating live-path drops as silent success.
4. Warm-up effects can skew early samples; inspect per-run series when p95 tails diverge.

## Event Timeline Notes

- Runtime manifest `events[]` mirrors transcript-bearing JSONL semantics from `docs/live-jsonl-event-contract.md`.
- `source_final_segment_id` is optional but expected on derived events (`llm_final`, `reconciled_final`) when lineage exists.
- `readability_defaults.ordering` encodes the deterministic transcript ordering key and includes lineage tie-breaks via `source_final_segment_id`.

## Referenced Benchmark Evidence

- Gate C validated runs:
  - `artifacts/bench/gate_c/dual_t4_dyld/20260227T122726Z/summary.csv`
  - `artifacts/bench/gate_c/mixed_t4_dyld/20260227T122735Z/summary.csv`
- Cleanup benchmark:
  - `artifacts/bench/cleanup/20260227T124016Z/cleanup_summary.csv`
  - `artifacts/bench/cleanup/20260227T124016Z/threshold_evaluation.csv`
