# Runtime/Public Contract Inventory

Date: 2026-03-02
Bead: `bd-2rq5`
Status: phase-A freeze artifact

## Purpose

This document freezes the current public/runtime surface that downstream humans, gates, wrappers, and future agents already depend on.

It is intentionally about behavior, labels, field names, and artifact meaning, not about internal module layout.

## Project Snapshot

Current product purpose:

- capture macOS system + microphone audio through ScreenCaptureKit
- run `transcribe-live` in one of three runtime selectors
- emit operator-visible terminal output plus machine-readable JSONL/manifest artifacts
- validate behavior with deterministic gate harnesses and packaged-app smoke flows

Current architecture snapshot:

- capture transport lives under `recordit::live_capture` and the lower-level callback/runtime docs in `docs/architecture.md` and `docs/realtime-contracts.md`
- `src/bin/transcribe_live.rs` is the current public CLI entrypoint and also the main runtime orchestrator
- public contract truth currently lives in help text, JSONL rows, manifest keys, terminal summary ordering, Make targets, packaged wrappers, and gate scripts

## Compatibility Classes

Use these classes for all changes proposed after phase A:

| Class | Meaning | Allowed changes |
|---|---|---|
| `Frozen` | Current consumers already rely on this spelling/meaning/order. | Additive expansion only. Removal, rename, or semantic drift is breaking. |
| `Additive-only` | Existing keys/values are frozen, but new sibling keys/rows/options may be added. | Add new optional fields, new optional flags, new docs. |
| `Provisional/internal` | Useful today, but not the compatibility boundary for v1. | May refactor freely if frozen surfaces stay intact. |

## SwiftUI↔Rust Readiness Boundary Contract

Canonical readiness vocabulary is now tracked in:

- `contracts/readiness-contract-ids.v1.json`
- `docs/runtime-boundary-ownership-contract.md`

Compatibility rule:

- existing readiness IDs and their class semantics are `Frozen` within `v1`
- adding new readiness IDs is `Additive-only` if existing IDs/classes keep their meaning
- renaming/removing IDs or reclassifying existing IDs is breaking and requires a new versioned contract file

## Legacy CLI Contract

Contract owner: `transcribe-live`

Compatibility rule:

- existing flag names, existing enum values, and documented selector incompatibilities are `Frozen`
- new flags are allowed only if they are additive and do not reinterpret existing flags
- help-text examples are guidance, but the spelled flags and accepted values are contract

### Input and Output Flags

| Flags | Current meaning | Current default / notes | Class |
|---|---|---|---|
| `--duration-sec` | requested runtime duration | `10` | `Frozen` |
| `--input-wav` | runtime input WAV path | default fixture in representative mode; progressive scratch capture artifact in `--live-stream` | `Frozen` |
| `--out-wav` | canonical session WAV artifact path | `artifacts/transcribe-live.wav`; materialized on successful runtime completion | `Frozen` |
| `--out-jsonl` | runtime JSONL artifact path | `artifacts/transcribe-live.jsonl` | `Frozen` |
| `--out-manifest` | runtime or preflight manifest path | `artifacts/transcribe-live.manifest.json` | `Frozen` |
| `--sample-rate` | capture/output sample rate | `48000` | `Frozen` |

### ASR and Language Flags

| Flags | Accepted values / meaning | Current default / notes | Class |
|---|---|---|---|
| `--asr-backend` | `whispercpp`, `whisperkit`, `moonshine` | `whispercpp` | `Frozen` |
| `--asr-model` | explicit backend model path | backend-specific file/dir validation applies | `Frozen` |
| `--asr-language` | language code | `en` | `Frozen` |
| `--asr-threads` | ASR worker threads | `4` | `Frozen` |
| `--asr-profile` | `fast`, `balanced`, `quality` | `balanced` | `Frozen` |

### VAD Flags

| Flags | Accepted values / meaning | Current default / notes | Class |
|---|---|---|---|
| `--vad-backend` | `webrtc`, `silero` | `silero` | `Frozen` |
| `--vad-threshold` | floating-point threshold in `[0.0, 1.0]` | `0.50` | `Frozen` |
| `--vad-min-speech-ms` | minimum speech before emit | `250` | `Frozen` |
| `--vad-min-silence-ms` | minimum silence before finalize | `500` | `Frozen` |

### Cleanup Queue Flags

| Flags | Current meaning | Current default / notes | Class |
|---|---|---|---|
| `--llm-cleanup` | enable finalized-segment cleanup lane | opt-in | `Frozen` |
| `--llm-endpoint` | cleanup endpoint URL | none | `Frozen` |
| `--llm-model` | cleanup model id | none | `Frozen` |
| `--llm-timeout-ms` | per-request timeout | `1000` | `Frozen` |
| `--llm-max-queue` | cleanup queue capacity | `32` | `Frozen` |
| `--llm-retries` | cleanup retry count | `0` | `Frozen` |

### Runtime Selector and Live Tuning Flags

| Flags | Current meaning | Current default / notes | Class |
|---|---|---|---|
| `--live-chunked` | select representative-chunked path | preserves `runtime_mode=live-chunked` for compatibility | `Frozen` |
| `--live-stream` | select true concurrent live runtime | mutually exclusive with `--live-chunked` | `Frozen` |
| `--chunk-window-ms` | live chunk window | `2000`; valid only for live selectors | `Frozen` |
| `--chunk-stride-ms` | live chunk stride | `500`; valid only for live selectors | `Frozen` |
| `--chunk-queue-cap` | bounded live ASR work queue | `4`; valid only for live selectors | `Frozen` |
| `--live-asr-workers` | dedicated live ASR worker concurrency | `2`; live modes only | `Frozen` |
| `--keep-temp-audio` | retain temp live audio shards | debug-oriented, but spelled flag is public | `Frozen` |
| `--transcribe-channels` | `separate`, `mixed`, `mixed-fallback` | `separate` | `Frozen` |
| `--speaker-labels` | exactly two comma-separated labels | `mic,system` | `Frozen` |
| `--benchmark-runs` | representative benchmark run count | `3` | `Frozen` |

### Diagnostics and Companion Modes

| Flags | Current meaning | Current default / notes | Class |
|---|---|---|---|
| `--model-doctor` | run model/backend diagnostics and exit | incompatible with `--replay-jsonl` | `Frozen` |
| `--replay-jsonl` | replay readable transcript from prior JSONL | incompatible with live selectors | `Frozen` |
| `--preflight` | run structured preflight diagnostics and write manifest | compatible with live selectors; incompatible with replay | `Frozen` |
| `-h`, `--help` | print contract help text | no positional args allowed | `Frozen` |

### Validation Rules That Are Part of the CLI Contract

- `--live-stream` and `--live-chunked` are mutually exclusive.
- `--live-stream` and `--live-chunked` are incompatible with `--replay-jsonl`.
- `--live-stream` and `--live-chunked` are compatible with `--preflight`.
- `--model-doctor` is incompatible with `--replay-jsonl`.
- chunk-tuning flags are meaningful only for live selectors.
- unknown flags and positional arguments fail with exit code `2` and point the user back to `--help`.

## Runtime Mode Matrix

These labels are the current compatibility anchor for mode-aware tooling.

| Taxonomy mode | Selector | Runtime artifact value (`runtime_mode`) | Status | `--replay-jsonl` | `--preflight` | `--chunk-*` tuning | Class |
|---|---|---|---|---|---|---|---|
| `representative-offline` | `<default>` | `representative-offline` | `implemented` | compatible | compatible | forbidden | `Frozen` |
| `representative-chunked` | `--live-chunked` | `live-chunked` | `implemented` | incompatible | incompatible | compatible | `Frozen` |
| `live-stream` | `--live-stream` | `live-stream` | `implemented` | incompatible | incompatible | compatible | `Frozen` |

Additional rule:

- `runtime_mode_taxonomy`, `runtime_mode_selector`, and `runtime_mode_status` are additive compatibility fields that must now travel together with `runtime_mode`.

## Runtime JSONL Contract

Canonical reference: `docs/live-jsonl-event-contract.md`

Compatibility rule:

- existing `event_type` names, required keys, and replay semantics are `Frozen`
- adding new optional keys to an existing row shape is `Additive-only`
- adding a new control-event family is allowed only if replay-safe and non-breaking to current parsers

### Transcript Event Families

| `event_type` | Required stable keys | Notes | Class |
|---|---|---|---|
| `partial` | `event_type`, `channel`, `segment_id`, `start_ms`, `end_ms`, `text`, `asr_backend`, `vad_boundary_count` | incremental preview | `Frozen` |
| `final` | same as above | stable live/representative output | `Frozen` |
| `llm_final` | transcript keys plus `source_final_segment_id` when derived | cleanup/refinement output | `Frozen` |
| `reconciled_final` | transcript keys plus `source_final_segment_id` when derived | canonical correction output after reconciliation | `Frozen` |

### Control Event Families

| `event_type` | Required stable keys | Current purpose | Class |
|---|---|---|---|
| `vad_boundary` | `event_type`, `channel`, `boundary_id`, `start_ms`, `end_ms`, `source`, `vad_backend`, `vad_threshold` | expose boundary closure inputs | `Frozen` |
| `mode_degradation` | `event_type`, `channel`, `requested_mode`, `active_mode`, `code`, `detail` | expose fallback/degradation explicitly | `Frozen` |
| `trust_notice` | `event_type`, `channel`, `code`, `severity`, `cause`, `impact`, `guidance` | operator-facing trust calibration | `Frozen` |
| `lifecycle_phase` | `event_type`, `channel`, `phase`, `transition_index`, `entered_at_utc`, `ready_for_transcripts`, `detail` | explicit runtime phase tracking | `Frozen` |
| `reconciliation_matrix` | `event_type`, `channel`, `required`, `applied`, `trigger_count`, `trigger_codes` | why reconciliation did or did not run | `Frozen` |
| `asr_worker_pool` | `event_type`, `channel`, worker telemetry fields | ASR pool visibility | `Frozen` |
| `chunk_queue` | `event_type`, `channel`, queue counters and lag fields | backlog pressure visibility | `Frozen` |
| `cleanup_queue` | `event_type`, `channel`, queue counters, retries, timeout, drain state | cleanup-lane visibility | `Frozen` |

### JSONL Sequencing and Replay Invariants

- JSONL is append-only and incrementally emitted during runtime, not only at closeout.
- Lifecycle rows appear before transcript rows for active runtime.
- Durability checkpoints occur every `24` lines and at lifecycle/stage boundaries.
- Replay consumes transcript events plus `trust_notice`.
- Replay ignores other control-event families, but those rows still matter for gates and audits.
- Transcript merge ordering is deterministic: `start_ms`, `end_ms`, event rank, `channel`, `segment_id`, `source_final_segment_id`, `text`.

The invariants above are `Frozen`. New replay-ignored control rows are `Additive-only`.

## Manifest Contract

Canonical references:

- `docs/session-manifest-schema.md`
- `src/bin/transcribe_live.rs` manifest writer

Compatibility rule:

- current top-level key names and the listed nested child keys are `Frozen`
- new top-level or nested keys are allowed if additive and if current key semantics do not drift

### Stable Runtime Manifest Top-Level Fields

The current runtime manifest (`kind=transcribe-live-runtime`) is expected to preserve these top-level keys:

- `kind`
- `generated_at_utc`
- `input_wav`
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

Removing or renaming any key above is breaking. Adding new siblings is allowed.

### Critical Nested Objects

| Object | Critical stable child keys | Why it is protected | Class |
|---|---|---|---|
| `live_config` | `live_chunked`, `chunk_window_ms`, `chunk_stride_ms`, `chunk_queue_cap` | live selector/tuning truth | `Frozen` |
| `lifecycle` | `current_phase`, `ready_for_transcripts`, `transitions[]` with `phase`, `transition_index`, `entered_at_utc`, `detail` | active/draining/shutdown proofs | `Frozen` |
| `vad` | `backend`, `threshold`, `min_speech_ms`, `min_silence_ms`, `boundary_count` | boundary-generation semantics | `Frozen` |
| `terminal_summary` | `live_mode`, `render_mode`, `stable_line_policy`, `stable_line_count`, `stable_lines_replayed`, `stable_lines` | terminal audit mirror | `Frozen` |
| `first_emit_timing_ms` | `first_any`, `first_partial`, `first_final`, `first_stable` | gates depend on active-runtime emission proof | `Frozen` |
| `ordering_metadata` | `event_sort_key`, `stable_line_sort_key`, `stable_line_event_types`, `event_count` | replay determinism | `Frozen` |
| `benchmark` | `run_count`, `wall_ms_p50`, `wall_ms_p95`, `partial_slo_met`, `final_slo_met`, `summary_csv`, `runs_csv` | benchmark artifact truth | `Frozen` |
| `reconciliation` | `required`, `applied`, `trigger_count`, `trigger_codes` | canonical review decision path | `Frozen` |
| `asr_worker_pool` | `prewarm_ok`, `submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `failed`, `retry_attempts`, `temp_audio_deleted`, `temp_audio_retained` | worker-pool truth surface | `Frozen` |
| `chunk_queue` | `enabled`, `max_queue`, `submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `drain_completed`, `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms` | backlog-pressure gates depend on these names | `Frozen` |
| `cleanup_queue` | `enabled`, `max_queue`, `timeout_ms`, `retries`, `submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `timed_out`, `failed`, `retry_attempts`, `pending`, `drain_budget_ms`, `drain_completed` | cleanup-lane audit surface | `Frozen` |
| `trust` | `degraded_mode_active`, `notice_count`, `notices[]` | degraded-success interpretation depends on it | `Frozen` |
| `event_counts` | `vad_boundary`, `transcript`, `partial`, `final`, `llm_final`, `reconciled_final` | gates and replay checks use these counters | `Frozen` |
| `session_summary` | `session_status`, `duration_sec`, `channel_mode_requested`, `channel_mode_active`, `transcript_events`, `chunk_queue`, `chunk_lag`, `trust_notices`, `degradation_events`, `cleanup_queue`, `artifacts` | machine-readable mirror of terminal close-summary | `Frozen` |

### Preflight Manifest

The preflight manifest (`kind=transcribe-live-preflight`) is also public and currently depends on:

- output artifact paths: `out_wav`, `out_wav_semantics`, `out_jsonl`, `out_manifest`
- model resolution fields such as `asr_model_resolved` and `asr_model_source`
- mode fields: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
- structured PASS/WARN/FAIL preflight check results

This surface is `Frozen` for current packaged and debug diagnostics.

## Terminal Summary Contract

Canonical references:

- `build_startup_banner_lines(...)` in `src/bin/transcribe_live/app.rs`
- `build_live_close_summary_lines(...)` in `src/bin/transcribe_live/app.rs`
- `docs/near-live-terminal-contract.md`

Compatibility rule:

- startup-banner field names and field order are `Frozen`
- close-summary field names and field order are `Frozen`
- wording inside remediation prose may evolve if the stable machine-facing codes and summary keys stay intact

### Deterministic Startup-Banner Field Order

The current startup banner emits exactly this order:

1. `runtime_mode`
2. `runtime_mode_taxonomy`
3. `runtime_mode_selector`
4. `runtime_mode_status`
5. `channel_mode_requested`
6. `duration_sec`
7. `input_wav`
8. `artifacts` (`out_wav`, `out_jsonl`, `out_manifest`)

### Deterministic Close-Summary Field Order

The current close-summary emits exactly this order:

1. `session_status`
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. `transcript_events` (`partial`, `final`, `llm_final`, `reconciled_final`)
6. `chunk_queue` (`submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `drain_completed`)
7. `chunk_lag` (`lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
8. `trust_notices` (`count`, `top_codes`)
9. `degradation_events` (`count`, `top_codes`)
10. `cleanup_queue`
11. `artifacts` (`out_wav`, `out_jsonl`, `out_manifest`)

Additional terminal/runtime invariants:

- `session_status` is currently `ok` when trust notices are empty, otherwise `degraded`
- `failed` is the operator health class for non-zero exits before successful close-summary emission
- runtime result prints `run_status` and `remediation_hints` so operators get a concise next-action surface without parsing raw JSON
- live runtime suppresses duplicate stable-line replay at closeout
- `terminal_summary.live_mode=true` for `--live-chunked` and `--live-stream`
- `terminal_summary.stable_line_policy` is currently `final-only`

## Make Targets and Packaged Wrappers

Compatibility rule:

- existing user-facing Make targets and their artifact-root assumptions are `Frozen`
- implementation inside the target is `Provisional/internal` as long as target name, intent, and artifact contract stay stable

### Debug and Validation Entry Points

| Entry point | Current contract | Artifact / wrapper assumption | Class |
|---|---|---|---|
| `make transcribe-live` | debug wrapper for legacy CLI contract | prints absolute artifact paths before execution | `Frozen` |
| `make transcribe-live-stream` | debug wrapper for `--live-stream` | uses progressive `input_wav` plus canonical `out_wav` closeout | `Frozen` |
| `make capture-transcribe` | capture first, then transcribe | capture failure short-circuits transcribe | `Frozen` |
| `make transcribe-preflight` | debug preflight companion path | writes preflight manifest | `Frozen` |
| `make transcribe-model-doctor` | debug model/backend diagnostics | no runtime artifacts required to pass | `Frozen` |
| `make smoke`, `smoke-offline`, `smoke-near-live`, `smoke-near-live-deterministic` | smoke bundles | root paths under `artifacts/smoke/...` | `Frozen` |

### Gate Entry Points

| Entry point | Current contract | Output root | Class |
|---|---|---|---|
| `make gate-backlog-pressure` | deterministic live-stream backlog gate | `artifacts/bench/gate_backlog_pressure/<timestamp>/` | `Frozen` |
| `make gate-transcript-completeness` | reconciliation completeness under backlog | `artifacts/bench/gate_transcript_completeness/<timestamp>/` | `Frozen` |
| `make gate-v1-acceptance` | cold/warm live-stream plus backlog/trust acceptance | `artifacts/bench/gate_v1_acceptance/<timestamp>/` | `Frozen` |
| `make gate-packaged-live-smoke` | signed-app live-stream smoke | `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/` | `Frozen` |
| `make gate-d-soak` | deterministic near-live soak harness | `artifacts/bench/gate_d/<timestamp>/` | `Frozen` |

### Packaged-App Entry Points

| Entry point | Current contract | Artifact-root assumption | Class |
|---|---|---|---|
| `make run-transcribe-app` | primary packaged beta entrypoint | root `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/` | `Frozen` |
| `make run-transcribe-live-stream-app` | packaged explicit `--live-stream` wrapper | same packaged root, live input/output paths printed up front | `Frozen` |
| `make run-transcribe-preflight-app` | packaged preflight companion path | manifest path under packaged root | `Frozen` |
| `make run-transcribe-model-doctor-app` | packaged model-doctor companion path | live selector may still be passed through `TRANSCRIBE_ARGS=--live-stream` | `Frozen` |

## Gate Scripts and Tests That Already Assume This Contract

These are the current executable consumers of the frozen surface.

### Gate Scripts

| Script | Current assumptions that are now contractual |
|---|---|
| `scripts/gate_backlog_pressure.sh` | `transcribe-live --live-stream` exists; fake capture fixture env var works; manifest lives at `runtime.manifest.json`; JSONL lives at `runtime.jsonl`; output summary writes `gate_pass` and threshold rows |
| `scripts/gate_backlog_pressure_summary.py` | manifest contains runtime mode fields, `chunk_queue`, `trust`, `degradation_events`, `first_emit_timing_ms`, `terminal_summary`, `event_counts`; JSONL contains `chunk_queue` control rows |
| `scripts/gate_v1_acceptance.sh` | cold/warm live-stream runs plus nested backlog gate are the v1 acceptance shape; artifact layout under `cold/`, `warm/`, and `backlog_pressure/` is stable |
| `scripts/gate_v1_acceptance_summary.py` | runtime mode truth, first stable emit truth, `out_wav` artifact truth, backlog summary booleans, and profile-aware backlog surface semantics are stable |
| `scripts/gate_transcript_completeness.sh` | `--replay-jsonl` is available; backlog summary metadata is forwarded into transcript-completeness evaluation; `reconciled_final` rows can be removed or kept for before/after replay comparison |
| `scripts/gate_transcript_completeness_summary.py` | transcript completeness is profile-aware: `drop-path` uses reconciliation evidence/codes, while `buffered-no-drop` validates stable-final parity without false-positive trust/degradation signaling |
| `scripts/gate_packaged_live_smoke.sh` | signed app binary path is stable; packaged root containment is enforced; packaged live-stream writes `session.input.wav`, `session.wav`, `session.jsonl`, and `session.manifest.json` |
| `scripts/gate_packaged_live_smoke_summary.py` | manifest contains `kind`, runtime mode fields, `terminal_summary`, `trust`, `degradation_events`, `session_summary.artifacts`, `jsonl_path`, `event_counts`, and `first_emit_timing_ms` |
| `scripts/gate_d_soak.sh` / `gate_d_summary.py` | representative-chunked path keeps `--live-chunked`; manifest contains chunk queue, cleanup queue, trust/degradation, reconciliation, and capture telemetry counters |

### Representative Source Tests

Representative tests in `src/bin/transcribe_live.rs` that already pin the contract:

- `help_text_documents_runtime_mode_taxonomy`
- `runtime_mode_compatibility_matrix_includes_live_stream_implemented_row`
- `runtime_manifest_includes_ordered_event_timeline`
- `preflight_manifest_includes_runtime_mode_taxonomy_fields`
- `runtime_artifacts_remain_compatible_across_runtime_mode_selectors`
- `runtime_jsonl_chunk_queue_event_includes_lag_metrics`
- `runtime_jsonl_emits_lifecycle_phase_events_in_order`
- `runtime_jsonl_places_active_phase_before_first_transcript_event`
- `incremental_runtime_sink_emits_stable_transcript_during_active_phase`
- `live_capture_materialization_paths_follow_runtime_mode_semantics`

These tests are not the whole contract, but they are already executable evidence that several parts of it are live.

## What Is Breaking vs Additive vs Internal

### Breaking

- removing or renaming an existing CLI flag
- changing accepted enum spellings such as `live-stream`, `live-chunked`, `mixed-fallback`, `whispercpp`
- changing `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, or `runtime_mode_status` semantics
- renaming a JSONL `event_type` or removing required keys from current event families
- removing or renaming any stable manifest key listed above
- changing close-summary field order or key names
- changing current Make target names, gate output roots, or packaged session file names without a migration layer

### Additive

- adding a new optional CLI flag
- adding a new optional manifest key or new optional nested child key
- adding a new optional JSONL field to an existing row shape
- adding a new gate summary row while preserving current rows
- adding new docs or new validation tests

### Provisional/Internal

- Rust module boundaries, helper names, and internal type names
- exact implementation of scheduling, queue internals, and writer plumbing if artifacts stay identical
- exact prose inside `detail`, `cause`, `impact`, and `guidance` fields, as long as stable codes and overall meaning remain intact
- numeric threshold tuning in gates such as min/max drop ratios and lag targets
- benchmark values and performance envelopes themselves; the field names are protected, but the measured numbers are runtime outputs, not schema promises

## Immediate Follow-On Beads Unblocked

This inventory should now be sufficient input for:

- `bd-bhe0` defining the compatibility-boundary policy
- `bd-1qfx` freezing a deterministic golden artifact matrix against these surfaces
