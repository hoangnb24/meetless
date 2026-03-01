# LIVE_TRANS: True Concurrent Live Capture + Transcription

## Summary

`--live-stream` is now a true concurrent runtime path. Capture, scheduling, ASR submission, transcript emission, and artifact updates happen during active runtime instead of post-capture replay.

This document is the shipped-state runbook/contract reference for live-stream behavior.

## Shipped Behavior

For `transcribe-live --live-stream`:

- capture starts immediately
- runtime transitions `warmup -> active -> draining -> shutdown`
- transcript events (`partial`, `final`, optional `reconciled_final`) emit during `active`
- stable transcript evidence is available before shutdown (`first_stable` timing + stable transcript rows)
- `--input-wav` is the progressive live scratch artifact (grows during runtime)
- `--out-wav` is the canonical session artifact materialized on successful closeout
- JSONL and manifest are deterministic and machine-readable

Representative modes remain intact:

- `representative-offline` (`<default>`)
- `representative-chunked` (`--live-chunked`)

## Runtime Architecture (Live-Stream)

### Capture path

- `run_streaming_capture_session(...)` feeds runtime chunks/events incrementally
- fake capture harness supports deterministic fixture replay and real-time pacing via:
  - `RECORDIT_FAKE_CAPTURE_FIXTURE`
  - `RECORDIT_FAKE_CAPTURE_RESTART_COUNT`
  - `RECORDIT_FAKE_CAPTURE_REALTIME`

### Coordinator + scheduler

- `LiveStreamCoordinator<StreamingVadScheduler,...>` drives phase state and ordered emissions
- scheduler tracks per-channel VAD state and emits partial/final/reconcile jobs deterministically
- live-stream VAD threshold mapping is calibrated to scheduler per-mille activity scale

### ASR service

- `LiveAsrService` handles queueing + execution lifecycle
- queue policy prioritizes final lane and keeps capture non-blocking
- runtime surfaces worker/queue telemetry in JSONL + manifest

### Runtime JSONL emission

- live-stream runtime writes lifecycle/transcript lines incrementally during execution
- final report write preserves deterministic artifact contract at closeout
- lifecycle ordering preserves `active` before first transcript row in final JSONL contract

## Artifact Contract

### `input_wav`

- progressive live scratch WAV for `--live-stream`
- expected to grow during active capture

### `out_wav`

- canonical session WAV
- materialized from mode-aware source on successful closeout

### `out_jsonl`

Includes lifecycle phases, transcript family events, queue/degradation/trust surfaces, and reconciliation state.

### `out_manifest`

Includes:

- runtime mode taxonomy fields
- event counts + transcript surfaces
- `first_emit_timing_ms` (`first_any`, `first_partial`, `first_final`, `first_stable`)
- queue telemetry (`asr_worker_pool`, `chunk_queue`, `cleanup_queue`)
- trust/degradation + reconciliation surfaces
- session summary artifact mirror

## Validation Evidence

Primary packaged operator validation:

```bash
make gate-packaged-live-smoke
```

Machine-readable pass indicators:

- `status=pass`
- `detail=packaged_live_smoke_thresholds_satisfied`
- `gate_pass=true`
- `runtime_first_stable_emit_ok=true`
- `runtime_transcript_surface_ok=true`
- `runtime_terminal_live_mode_ok=true`

Current debug/CI validation surfaces:

- `make gate-backlog-pressure`
- `make gate-transcript-completeness`
- `make gate-v1-acceptance`

## Deterministic Integration Assertions

Live-stream regression coverage should continue asserting:

- stable transcript emission occurs during `active` (not post-capture replay)
- runtime JSONL grows before shutdown when live-stream is running
- live-stream `input_wav` grows during active capture
- representative/offline modes remain unchanged unless explicitly scoped

## Operator Commands

Debug live-stream:

```bash
make transcribe-live-stream \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Packaged entrypoint (primary):

```bash
make run-transcribe-app \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_ARGS=--live-stream
```

Packaged smoke gate:

```bash
make gate-packaged-live-smoke
```

## Invariants / Non-Goals

- `--live-stream` and `--live-chunked` stay mutually exclusive
- `--live-stream` remains incompatible with `--preflight` and `--replay-jsonl`
- moonshine adapter remains out-of-scope for live-stream runtime in this phase
- deterministic machine-readable artifacts are part of product correctness, not optional diagnostics

## Follow-On Calibration

Some pressure-oriented thresholds are still being tuned under true live behavior (`bd-t3kw` lane). Keep docs aligned to shipped contract fields and gate outputs as those thresholds are finalized.
