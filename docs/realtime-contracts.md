# Real-Time Callback Contract and Recovery Matrix

## Callback Contract (Recorder/Probe)

The ScreenCaptureKit callback path must remain deterministic and non-blocking:

1. No disk I/O in callback handlers.
2. No blocking waits (`recv`, locks, sleeps) in callback handlers.
3. No unbounded queue growth; all callback handoff uses fixed-capacity preallocated slots.
4. Any sample-format contract violation is counted and mapped to an explicit recovery action.

Enforcement points:
- `src/rt_transport.rs` tracks pressure and drops (`slot_miss_drops`, `queue_full_drops`, `ready_depth_high_water`, `in_flight`).
- `src/bin/sequoia_capture.rs` tracks callback contract violations:
  - `missing_audio_buffer_list`
  - `missing_first_audio_buffer`
  - `missing_format_description`
  - `missing_sample_rate`
  - `non_float_pcm`
  - `chunk_too_large`
- `src/bin/sequoia_capture.rs` telemetry also records `sample_rate_policy` with mismatch mode, input rates, and per-channel resampling counters.

## Cleanup Queue Contract (Transcribe)

Finalized-segment cleanup is an optional post-processing lane and must never block ASR event emission:

1. Only `final` transcript events are eligible for cleanup.
2. Cleanup submission uses bounded non-blocking enqueue (`try_send` on a fixed-capacity queue).
3. Queue-full submissions are dropped and counted instead of waiting.
4. Per-request execution is constrained by `--llm-timeout-ms` and `--llm-retries`.
5. Runtime drain is budgeted; unfinished cleanup work is reported as pending rather than delaying transcript completion indefinitely.

Operational knobs:
- `--llm-cleanup`
- `--llm-endpoint`
- `--llm-model`
- `--llm-timeout-ms`
- `--llm-max-queue`
- `--llm-retries`

Telemetry/artifact surface:
- terminal summary prints cleanup queue totals (`submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `timed_out`, `failed`, `retry_attempts`, `pending`, `drain_completed`)
- runtime JSONL emits a terminal `cleanup_queue` control event
- runtime manifest persists the same cleanup queue summary under `cleanup_queue`

## Error to Recovery Matrix

| Error Class | Detection | Recovery Action |
|---|---|---|
| Callback slot unavailable | `slot_miss_drops` increment | `DropSampleContinue` |
| Ready queue full | `queue_full_drops` increment | `DropSampleContinue` |
| Missing audio buffer list | callback contract counter | `DropSampleContinue` |
| Missing first audio buffer | callback contract counter | `DropSampleContinue` |
| Missing format description | callback contract counter | `DropSampleContinue` |
| Missing sample rate | callback contract counter | `DropSampleContinue` |
| Non-float PCM | callback contract counter | `FailFastReconfigure` |
| Chunk exceeds slot capacity | callback contract counter | `DropSampleContinue` |
| Stream interruption with restarts remaining | idle-gap + restart budget | `RestartStream` |
| Stream interruption with restart budget exhausted | idle-gap + restart budget | `FailFastReconfigure` |
| Sample-rate mismatch in `strict` mode | policy check | `FailFastReconfigure` |
| Sample-rate mismatch in `adapt-stream-rate` mode | policy check + worker resampling to canonical output rate | `AdaptOutputRate` |

## Validation

Current contract/recovery logic is validated with:
- transport unit tests (`cargo test --lib`)
- recorder policy tests (`DYLD_LIBRARY_PATH=/usr/lib/swift cargo test --bin sequoia_capture -- --nocapture`)
- transport stress harness (`cargo run --quiet --bin transport_stress -- --iterations 50000 --capacity 128 --payload-bytes 2048 --consumer-delay-micros 20`)
