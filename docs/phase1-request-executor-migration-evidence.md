# Phase 1 Request-Executor Migration Evidence

Bead: `bd-1nsx`

## Scope

This evidence note covers the request-surface migration for `LiveAsrExecutor` and the compatibility adapter that preserves existing path-backed behavior while keeping PCM-window inputs explicit and non-silent.

## Acceptance Mapping

1. `LiveAsrExecutor` accepts `LiveAsrRequest` end-to-end and preserves path-backed behavior.
   - `src/live_asr_pool.rs` defines `LiveAsrRequest`, request/job adapters, and `LiveAsrExecutor::transcribe(&LiveAsrRequest)`.
   - `src/bin/transcribe_live/asr_backend.rs` consumes `LiveAsrRequest` through the backend adapter.
   - `src/bin/transcribe_live/runtime_live_stream.rs` and `src/bin/transcribe_live/runtime_representative.rs` submit request objects via `submit_request(...)`.

2. Tests cover request construction, adapter translation, success, and explicit error surfaces.
   - Path-backed round-trip and queue submission are covered in `live_asr_pool` unit tests.
   - Backend adapter path extraction and PCM rejection are covered in `transcribe-live` unit tests.
   - Representative final-buffering flow remains green after the request migration.

3. No external contract drift was observed on the validation surfaces exercised here.
   - Contract/modular stability tests remain green.
   - Legacy entrypoint compatibility remains green.

## Validation Evidence

### Request / adapter unit surface

Command:

```bash
cargo test --lib live_asr_pool -- --nocapture
```

Result: pass

Key assertions exercised:
- `live_asr_job_round_trips_through_typed_request_path_variant`
- `pcm_window_variant_preserves_window_metadata_and_rejects_legacy_conversion`
- `submit_request_accepts_path_variant_without_changing_legacy_behavior`

Failure breadcrumbs:
- adapter downgrade failures include `segment_id` and `pcm_window`
- queue-submission behavior remains visible through `LiveAsrService` result collection

### Backend adapter surface

Command:

```bash
cargo test --bin transcribe-live asr_backend::tests -- --nocapture
```

Result: pass

Key assertions exercised:
- `adapter_request_extracts_path_from_path_variant`
- `adapter_request_rejects_pcm_window_until_backend_pcm_is_wired`

Failure breadcrumbs:
- backend adapter error explicitly identifies path-backed input requirement and the segment id

### Representative compatibility surface

Command:

```bash
cargo test --bin transcribe-live final_buffering_retries_without_queue_drop -- --nocapture
```

Result: pass

What this proves:
- representative/final-buffering flow still drains path-backed ASR jobs successfully
- queue behavior remains compatible for the buffered representative path

### Contract / stability surfaces

Commands:

```bash
cargo test --test modular_stability_contract -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
```

Result: pass

What this proves:
- modular seams and extracted runtime boundaries remain stable
- legacy entrypoints and compatibility expectations remain intact after the request migration

### Static scan

Command:

```bash
ubs src/live_asr_pool.rs src/bin/transcribe_live/asr_backend.rs
```

Result:
- `src/live_asr_pool.rs`: existing test-only warning inventory; no critical findings reported
- `src/bin/transcribe_live/asr_backend.rs`: no critical findings reported

## Conclusion

`bd-1nsx` acceptance criteria are satisfied by the current tree: the executor/request migration is live, path-backed compatibility remains explicit, PCM-window fallback is intentionally non-silent, and the exercised contract surfaces stayed green.

---

## Addendum: `bd-27aa` Worker-Local Scratch WAV Reuse Evidence

Date: 2026-03-04

### Acceptance Mapping

1. Worker-local scratch reuse with deterministic lifecycle is implemented.
   - `src/bin/transcribe_live/asr_backend.rs` now uses thread-local `PcmScratchContext` (`PCM_SCRATCH_CONTEXT`) with one worker scratch path (`worker-<thread>.wav`) under process-local temp scope.
   - Materialization overwrites the same file each request and uses a reusable in-memory sample buffer.

2. Scratch security/privacy semantics are enforced in code paths.
   - `validate_pcm_scratch_target(...)` rejects symlink and non-file targets.
   - `safe_delete_pcm_scratch_path(...)` is fail-closed for unsafe/non-file/error metadata paths.
   - Failure outcomes mark scratch retention for review via `record_pcm_request_outcome(false)` and `Drop` handling.

3. Tests cover normal/retry/failure flows with actionable breadcrumbs.
   - `pcm_scratch_materialization_reuses_worker_local_path_and_overwrites_contents`
   - `pcm_scratch_retry_flow_reuses_path_and_keeps_latest_overwrite`
   - `pcm_scratch_cleanup_retains_failed_worker_artifact_for_review`
   - `pcm_scratch_refuses_to_overwrite_symlink_target`
   - Assertions include explicit failure text for segment/path safety conditions.

### Validation Evidence

Commands:

```bash
cargo test --bin transcribe-live asr_backend::tests -- --nocapture
cargo test --bin transcribe-live pcm_scratch_ -- --nocapture
```

Result: pass
