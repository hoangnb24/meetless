# bd-2rq5 Runtime/Public Surface Inventory

Status: phase-A freeze baseline for current `recordit` behavior

Last reviewed: 2026-03-02

## Purpose

This document inventories the externally consumed surfaces that currently behave like contracts.
It does not redesign them. It records current truth so later refactors can distinguish:

- `compatibility commitment`: changing or removing the surface is breaking for downstream users, scripts, gates, or replay tooling
- `additive-safe`: adding new fields/events/targets is acceptable if existing behavior stays intact
- `internal-only`: useful for maintainers, but not currently promised as a stable external surface

## Source Of Truth

Current truth is spread across:

- `src/bin/transcribe_live.rs`
- `src/live_capture.rs`
- `src/live_stream_runtime.rs`
- `src/live_asr_pool.rs`
- `Makefile`
- `README.md`
- `docs/state-machine.md`
- `docs/live-jsonl-event-contract.md`
- `docs/session-manifest-schema.md`
- `docs/near-live-terminal-contract.md`
- gate scripts under `scripts/`

This inventory centralizes those surfaces and classifies their stability.

## 1. Public Entry Points

| Surface | Current truth | Classification | Why |
|---|---|---|---|
| `transcribe-live` binary | Primary runtime/product surface; dispatches `help`, `preflight`, `model-doctor`, `replay-jsonl`, or runtime execution | compatibility commitment | Docs, Make targets, gates, packaged app, and tests all depend on this name and behavior |
| `SequoiaTranscribe.app` signed runtime | Packaged beta operator entrypoint via `make run-transcribe-app` | compatibility commitment | Explicit packaged operator path and smoke gate contract depend on it |
| `sequoia_capture` binary | Capture-only debug/support surface | compatibility commitment | README and Make targets document it; capture telemetry scripts consume its output |
| Probe binary in `src/main.rs` | Engineering inspection surface | additive-safe | Observable and documented, but not central to operator compatibility |
| Benchmark/transport stress binaries | Engineering harnesses | internal-only | Useful tooling, but not treated as user-facing product contract |

## 2. CLI Flag Contract

### `transcribe-live`

The following named flags are part of the current public contract:

- `--duration-sec`
- `--input-wav`
- `--out-wav`
- `--out-jsonl`
- `--out-manifest`
- `--sample-rate`
- `--asr-backend`
- `--asr-model`
- `--asr-language`
- `--asr-threads`
- `--asr-profile`
- `--vad-backend`
- `--vad-threshold`
- `--vad-min-speech-ms`
- `--vad-min-silence-ms`
- `--llm-cleanup`
- `--llm-endpoint`
- `--llm-model`
- `--llm-timeout-ms`
- `--llm-max-queue`
- `--llm-retries`
- `--live-chunked`
- `--live-stream`
- `--chunk-window-ms`
- `--chunk-stride-ms`
- `--chunk-queue-cap`
- `--live-asr-workers`
- `--keep-temp-audio`
- `--transcribe-channels`
- `--speaker-labels`
- `--benchmark-runs`
- `--model-doctor`
- `--replay-jsonl`
- `--preflight`
- `-h`, `--help`

Classification: `compatibility commitment`

Current validation semantics that are also part of the contract:

- `--live-stream` and `--live-chunked` are mutually exclusive
- chunk tuning flags require a live mode
- `--preflight` is compatible with both live selectors
- `--replay-jsonl` is incompatible with both live selectors
- `--model-doctor` is incompatible with `--replay-jsonl`
- `--model-doctor` is incompatible with `--preflight`
- explicit `--asr-model` is fail-fast and does not fall through to defaults

Classification: `compatibility commitment`

### `sequoia_capture`

Positional argument contract:

- `<duration_seconds>`
- `<output_path>`
- `<sample_rate_hz>`
- `<sample_rate_mismatch_policy>`
- `<callback_contract_mode>`

Policy values:

- mismatch policy: `adapt-stream-rate`, `strict`
- callback mode: `warn`, `strict`

Classification: `compatibility commitment`

## 3. Environment Variables

| Variable | Current role | Classification |
|---|---|---|
| `RECORDIT_ASR_MODEL` | model resolution fallback for `transcribe-live` | compatibility commitment |
| `RECORDIT_WHISPERCPP_CLI_PATH` | whispercpp helper resolution | additive-safe |
| `RECORDIT_WHISPERKIT_CLI_PATH` | whisperkit helper resolution | additive-safe |
| `RECORDIT_FAKE_CAPTURE_FIXTURE` | deterministic fake capture source for tests/gates | compatibility commitment |
| `RECORDIT_FAKE_CAPTURE_RESTART_COUNT` | fake-capture continuity/restart simulation | additive-safe |
| `RECORDIT_FAKE_CAPTURE_REALTIME` | fake-capture timing behavior | additive-safe |
| `DYLD_LIBRARY_PATH=/usr/lib/swift` | required host launch environment in debug flows | additive-safe |

## 4. Runtime Mode Contract

Current mode matrix:

| Selector | `runtime_mode` artifact value | `runtime_mode_taxonomy` | Replay | Preflight | Chunk tuning |
|---|---|---|---|---|---|
| `<default>` | `representative-offline` | `representative-offline` | compatible | compatible | forbidden |
| `--live-chunked` | `live-chunked` | `representative-chunked` | incompatible | incompatible | compatible |
| `--live-stream` | `live-stream` | `live-stream` | incompatible | incompatible | compatible |

Classification:

- exact labels above: `compatibility commitment`
- adding future taxonomy/status metadata fields: `additive-safe`

Important compatibility rule:

- taxonomy mode `representative-chunked` intentionally keeps artifact label `live-chunked`

That rule is a `compatibility commitment` because gates/docs/tests explicitly rely on it.

## 5. Artifact Path And Semantic Contract

### Runtime artifacts

- `--input-wav`
  - representative modes: runtime input fixture/captured WAV
  - `--live-stream`: progressive scratch capture artifact that grows during runtime
- `--out-wav`
  - canonical session WAV artifact
  - materialized on successful runtime completion
  - in `--live-stream`, materialized from the progressive `--input-wav` scratch artifact during closeout
- `--out-jsonl`
  - append-only runtime event stream, emitted incrementally in live execution
- `--out-manifest`
  - session manifest for runtime or preflight

Classification: `compatibility commitment`

### Packaged artifact root defaults

- root: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`
- representative packaged defaults:
  - `session.wav`
  - `session.jsonl`
  - `session.manifest.json`
- packaged live wrapper defaults:
  - `<session-stem>.input.wav`
  - `<session-stem>.wav`
  - `<session-stem>.jsonl`
  - `<session-stem>.manifest.json`

Classification: `compatibility commitment`

## 6. JSONL Event Contract

### Transcript events

Current transcript event types:

- `partial`
- `final`
- `llm_final`
- `reconciled_final`

Required transcript row keys:

- `event_type`
- `channel`
- `segment_id`
- `start_ms`
- `end_ms`
- `text`

Current additive transcript row keys:

- `source_final_segment_id`
- `asr_backend`
- `vad_boundary_count`

Classification:

- event types above: `compatibility commitment`
- required keys above: `compatibility commitment`
- additional future keys on existing rows: `additive-safe`

### Control event families

Current control event types:

- `vad_boundary`
- `mode_degradation`
- `trust_notice`
- `lifecycle_phase`
- `reconciliation_matrix`
- `asr_worker_pool`
- `chunk_queue`
- `cleanup_queue`

Current expectations:

- control events generally use `channel="control"`
- `vad_boundary` uses `channel="merged"`
- replay only consumes transcript events plus `trust_notice`
- unknown non-transcript control rows are effectively ignorable by replay

Classification:

- existing control event family names: `compatibility commitment`
- adding new control event families while preserving current ones: `additive-safe`

### Ordering and durability

Current JSONL write sequence:

1. early lifecycle rows
2. VAD boundaries
3. transcript rows
4. degradation rows
5. trust rows
6. trailing lifecycle rows
7. reconciliation/asr-worker/chunk-queue/cleanup-queue rows

Current durability behavior:

- data checkpoints every 24 lines
- stage-boundary checkpoints
- explicit finalize

Classification:

- lifecycle-before-first-transcript and incremental growth in live mode: `compatibility commitment`
- exact internal checkpoint frequency (`24`) : `additive-safe`

## 7. Runtime Manifest Contract

### Manifest kinds

- runtime manifest: `kind=transcribe-live-runtime`
- preflight manifest: `kind=transcribe-live-preflight`
- both currently use `schema_version="1"`

Classification: `compatibility commitment`

### Critical runtime manifest fields

Top-level fields currently consumed by docs, gates, or tests:

- `schema_version`
- `kind`
- `generated_at_utc`
- `asr_backend`
- `asr_model`
- `asr_model_source`
- `asr_model_checksum_sha256`
- `asr_model_checksum_status`
- `input_wav`
- `input_wav_semantics`
- `out_wav`
- `out_wav_semantics`
- `out_wav_materialized`
- `out_wav_bytes`
- `channel_mode`
- `channel_mode_requested`
- `runtime_mode`
- `runtime_mode_taxonomy`
- `runtime_mode_selector`
- `runtime_mode_status`
- `live_config`
- `lifecycle`
- `speaker_labels`
- `event_channels`
- `vad`
- `transcript`
- `readability_defaults`
- `transcript_per_channel`
- `terminal_summary`
- `first_emit_timing_ms`
- `queue_defer`
- `ordering_metadata`
- `events`
- `benchmark`
- `reconciliation`
- `asr_worker_pool`
- `chunk_queue`
- `cleanup_queue`
- `degradation_events`
- `trust`
- `event_counts`
- `session_summary`
- `jsonl_path`

Classification:

- existing fields above: `compatibility commitment`
- adding new top-level fields while preserving existing semantics: `additive-safe`

### Critical nested runtime manifest fields

Nested structures currently treated as contract surfaces:

- `terminal_summary.live_mode`
- `terminal_summary.render_mode`
- `terminal_summary.stable_line_policy`
- `terminal_summary.stable_line_count`
- `terminal_summary.stable_lines_replayed`
- `terminal_summary.stable_lines`
- `first_emit_timing_ms.first_any`
- `first_emit_timing_ms.first_partial`
- `first_emit_timing_ms.first_final`
- `first_emit_timing_ms.first_stable`
- `ordering_metadata.event_sort_key`
- `ordering_metadata.stable_line_sort_key`
- `ordering_metadata.stable_line_event_types`
- `reconciliation.required`
- `reconciliation.applied`
- `reconciliation.trigger_codes`
- `asr_worker_pool.prewarm_ok`
- `asr_worker_pool.submitted`
- `asr_worker_pool.enqueued`
- `asr_worker_pool.dropped_queue_full`
- `asr_worker_pool.processed`
- `asr_worker_pool.succeeded`
- `asr_worker_pool.failed`
- `asr_worker_pool.retry_attempts`
- `asr_worker_pool.temp_audio_deleted`
- `asr_worker_pool.temp_audio_retained`
- `chunk_queue.enabled`
- `chunk_queue.max_queue`
- `chunk_queue.submitted`
- `chunk_queue.enqueued`
- `chunk_queue.dropped_oldest`
- `chunk_queue.processed`
- `chunk_queue.pending`
- `chunk_queue.high_water`
- `chunk_queue.drain_completed`
- `chunk_queue.lag_sample_count`
- `chunk_queue.lag_p50_ms`
- `chunk_queue.lag_p95_ms`
- `chunk_queue.lag_max_ms`
- `trust.degraded_mode_active`
- `trust.notice_count`
- `trust.notices`
- `event_counts.partial`
- `event_counts.final`
- `event_counts.llm_final`
- `event_counts.reconciled_final`
- `session_summary.session_status`
- `session_summary.duration_sec`
- `session_summary.channel_mode_requested`
- `session_summary.channel_mode_active`
- `session_summary.transcript_events`
- `session_summary.chunk_queue`
- `session_summary.chunk_lag`
- `session_summary.trust_notices`
- `session_summary.degradation_events`
- `session_summary.cleanup_queue`
- `session_summary.artifacts`

Classification: `compatibility commitment`

### Preflight manifest contract

Current preflight manifest structure:

- `schema_version`
- `kind`
- `generated_at_utc`
- `overall_status`
- `config`
- `checks`

Current preflight `config` fields treated as contract:

- input/output paths and semantics
- ASR backend/model request/resolution/checksum fields
- runtime mode fields
- chunk tuning fields
- `sample_rate_hz`

Classification: `compatibility commitment`

## 8. Terminal Output Contract

Current operator-facing terminal behavior:

- interactive TTY:
  - partial overwrite updates during active runtime
  - stable lines printed as segments close
- non-TTY:
  - no overwrite-style partial spam
  - deterministic stable lines only
- live summary suppresses replay of stable lines already rendered during active runtime

Current close-summary field order:

1. `session_status`
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. transcript event counts
6. chunk queue summary
7. chunk lag summary
8. trust notices summary
9. degradation events summary
10. cleanup queue summary
11. artifact paths

Classification: `compatibility commitment`

Readability defaults:

- merged line format: `[MM:SS.mmm-MM:SS.mmm] <channel>: <text>`
- per-channel format: `[MM:SS.mmm-MM:SS.mmm] <text>`
- near-overlap annotation: `(overlap<=120ms with <channel>)`

Classification: `compatibility commitment`

## 9. Capture Telemetry Contract

Capture telemetry and summary surfaces currently exposed by `live_capture` and capture wrappers:

- output path and duration metadata
- target/output sample-rate fields
- per-stream chunk counts
- output frame count
- restart count
- transport counters:
  - `capacity`
  - `ready_depth_high_water`
  - `in_flight`
  - `enqueued`
  - `dequeued`
  - `slot_miss_drops`
  - `fill_failures`
  - `queue_full_drops`
  - `recycle_failures`
- callback contract counters:
  - `missing_audio_buffer_list`
  - `missing_first_audio_buffer`
  - `missing_format_description`
  - `missing_sample_rate`
  - `non_float_pcm`
  - `chunk_too_large`
- sample-rate policy summary and resample counters
- capture degradation event array

Classification: `compatibility commitment`

Reason: mixed-rate regression and live continuity review already depend on these fields.

## 10. Trust And Degradation Code Families

Current degradation/trust families treated as contract surfaces:

- degradation codes
  - `fallback_to_mixed`
  - `live_capture_interruption_recovered`
  - `live_capture_continuity_unverified`
  - `live_capture_transport_degraded`
  - `live_capture_callback_contract_degraded`
  - `live_chunk_queue_drop_oldest`
  - `live_chunk_queue_backpressure_severe`
  - `reconciliation_applied_after_backpressure`
- trust codes
  - `mode_degradation`
  - `continuity_recovered_with_gaps`
  - `continuity_unverified`
  - `capture_transport_degraded`
  - `capture_callback_contract_degraded`
  - `chunk_queue_backpressure`
  - `chunk_queue_backpressure_severe`
  - `reconciliation_applied`
  - cleanup queue warnings when present

Classification:

- existing code names above: `compatibility commitment`
- adding new codes while preserving existing ones: `additive-safe`

## 11. Makefile Target Contract

Current documented targets that behave like public wrappers:

- build/debug:
  - `build`
  - `build-release`
  - `probe`
  - `capture`
  - `transcribe-live`
  - `transcribe-live-stream`
  - `capture-transcribe`
  - `transcribe-preflight`
  - `transcribe-model-doctor`
- smoke/gates:
  - `smoke`
  - `smoke-offline`
  - `smoke-near-live`
  - `smoke-near-live-deterministic`
  - `gate-backlog-pressure`
  - `gate-transcript-completeness`
  - `gate-v1-acceptance`
  - `gate-packaged-live-smoke`
  - `gate-d-soak`
- packaged:
  - `run-transcribe-app`
  - `run-transcribe-live-stream-app`
  - `run-transcribe-preflight-app`
  - `run-transcribe-model-doctor-app`
  - `bundle-transcribe`
  - `sign-transcribe`
- capture app/support:
  - `bundle`
  - `sign`
  - `verify`
  - `run-app`
  - `reset-perms`

Classification:

- existing target names and documented semantics above: `compatibility commitment`
- adding new targets: `additive-safe`

Important wrapper behaviors currently treated as contract:

- transcribe wrappers print absolute artifact paths before execution
- packaged live selectors stay attached to the current terminal
- packaged live runs stage explicit model assets into the container root
- packaged wrappers print concise post-run session summary

Classification: `compatibility commitment`

## 12. Gate Artifact Contract

All current gates use:

- `summary.csv` as canonical machine-readable evidence
- `status.txt` as quick operator envelope

Classification: `compatibility commitment`

Current gate tracks and expected surfaces:

| Gate | Key outputs | Critical expected fields |
|---|---|---|
| `gate_backlog_pressure` | `runtime.manifest.json`, `runtime.jsonl`, `summary.csv`, `status.txt` | runtime mode labels, `chunk_queue.*`, trust/degradation codes, `first_emit_timing_ms.first_stable`, `terminal_summary.live_mode`, `gate_pass` |
| `gate_transcript_completeness` | backlog artifacts plus replay outputs, `summary.csv`, `status.txt` | `reconciled_final`, reconciliation trust/degradation codes, replay readability sections, `gate_pass` |
| `gate_v1_acceptance` | cold/warm manifests + JSONL, backlog summary, `summary.csv`, `status.txt` | first stable emit during active runtime, artifact truth, backlog surface interpretation, `gate_pass` |
| `gate_packaged_live_smoke` | packaged runtime artifacts, `summary.csv`, `status.txt` | packaged live-stream labels, transcript surface presence, terminal live mode, path truth, `gate_pass` |
| `gate_d_soak` | repeated run manifests/telemetry, `runs.csv`, `summary.csv`, `status.txt` | live-chunked mode label, queue visibility, continuity/capture telemetry, artifact truth, `gate_pass` |

## 13. Tests That Currently Freeze The Contract

Tests that already lock contract behavior:

- CLI/taxonomy parser and help tests in `src/bin/transcribe_live.rs`
- runtime manifest and JSONL schema/order tests in `src/bin/transcribe_live.rs`
- terminal rendering and close-summary ordering tests in `src/bin/transcribe_live.rs`
- queue pressure, reconciliation, trust/degradation tests in `src/bin/transcribe_live.rs`
- capture config and telemetry tests in `src/live_capture.rs`
- true live integration test in `tests/live_stream_true_live_integration.rs`

Classification: `compatibility commitment`

Reason: once a surface is asserted in tests and consumed by docs/gates, changing it is no longer an internal-only refactor.

## 14. Internal Architecture Map

These modules matter for maintainability, but their boundaries are not yet public compatibility promises:

- `recordit::live_capture`
- `recordit::live_stream_runtime`
- `recordit::live_asr_pool`
- `recordit::capture_api`
- `recordit::rt_transport`

Classification: `internal-only`

Internal algorithm details that should remain refactorable as long as observable output stays compatible:

- exact worker scheduling implementation
- internal coordinator/finalizer interfaces
- queue eviction implementation details beyond exposed telemetry and documented drop policy
- specific helper function names and file layout

## 15. Change Classification Rules

Use these rules for future review:

- Breaking:
  - rename/remove a documented CLI flag
  - change a current runtime mode label or selector meaning
  - rename/remove existing JSONL event types or required keys
  - remove or rename existing manifest fields used by docs/gates/tests
  - change terminal close-summary field order
  - rename/remove current Makefile wrapper targets
  - change `summary.csv` / `status.txt` gate output shape or `gate_pass` semantics
- Additive:
  - add new JSONL control rows while preserving replay compatibility
  - add new manifest fields without removing or redefining existing ones
  - add new Make targets or diagnostics wrappers
  - add new trust/degradation codes without renaming existing ones
- Internal-only:
  - reorganize module/file boundaries
  - replace internal queue/scheduler implementation
  - optimize capture/runtime internals without altering emitted artifacts or operator behavior

## 16. Phase-A Conclusion

The repo already has a real public contract surface. The most important commitments are:

- `transcribe-live` flag and dispatch behavior
- runtime mode labels and compatibility rules
- JSONL event family names and replay assumptions
- manifest kinds and key nested fields
- terminal close-summary ordering and live replay suppression
- Makefile wrapper names and packaged artifact-root semantics
- gate `summary.csv` / `status.txt` evidence shape

Those surfaces should be treated as frozen for phase A. Later work may extend them additively, but should not silently redefine them.
