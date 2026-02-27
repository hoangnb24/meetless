# Session Telemetry Contract

This document defines how operators and benchmark tooling should interpret end-to-end telemetry for a transcription session.

## Stage Coverage

Use these artifacts together:

1. Capture stage artifact
   - `artifacts/<capture-stem>.telemetry.json` from `sequoia_capture`
   - fields:
     - `generated_unix`
     - `transport` (`ready_depth_high_water`, drop/failure counters, enqueue/dequeue)
     - `callback_contract` (contract violation counters)
     - `degradation_events` (timestamped source/count/recovery action records)

2. ASR + merge + cleanup stage artifact
   - `artifacts/transcribe-live*.manifest.json` from `transcribe-live`
   - fields:
     - `generated_at_utc`
     - `benchmark` (ASR latency SLO signals)
     - `event_counts` + transcript event stream (merge behavior)
     - `cleanup_queue` (queue pressure, retry, timeout, drain state)

## Telemetry Summary Rules

For a complete session health readout:

1. Capture reliability
   - treat any non-zero `transport` drop/failure counters as degradation.
   - map each capture degradation to `degradation_events[*].recovery_action`.

2. ASR latency
   - use `benchmark.wall_ms_p95` and SLO booleans for regression gating.

3. Merge integrity
   - validate deterministic ordering through replay and channel-tagged event stream.

4. Cleanup isolation
   - use `cleanup_queue` counters to confirm ASR-critical path isolation under cleanup load.

## Timestamp Attribution

- Capture degradation/recovery signals are timestamped via `degradation_events[*].generated_unix`.
- Transcription runtime artifacts are timestamped via `generated_at_utc`.
- When correlating multi-stage regressions, align capture and transcribe artifacts by run start window and artifact path pairing.
