# Sequoia Capture

Sequoia Capture is a macOS 15+ Rust project that records:
- system audio from ScreenCaptureKit
- microphone audio from ScreenCaptureKit `captureMicrophone`
- a stereo WAV with channel mapping `L=mic`, `R=system`

## Requirements
- macOS 15+
- Xcode command line tools
- Rust toolchain

## Capture Model
- Capture source is ScreenCaptureKit only.
- Microphone capture is enabled through `SCStreamConfiguration.captureMicrophone`.
- System audio and microphone arrive as separate ScreenCaptureKit output streams and are aligned by PTS in the recorder pipeline.

## Project Layout
- `src/main.rs`: probe binary (stream/output/timestamp inspection)
- `src/bin/sequoia_capture.rs`: WAV recorder binary
- `src/bin/transcribe_live.rs`: transcription CLI contract and config validation entrypoint
- `packaging/Info.plist`: bundle metadata and privacy usage descriptions
- `packaging/entitlements.plist`: sandbox and privacy entitlements
- `docs/research.md`: API/TCC/platform research
- `docs/architecture.md`: real-time pipeline and interleave spec
- `docs/adr-001-backend-decision.md`: backend decision and explicit fallback triggers
- `docs/adr-002-lock-free-transport.md`: callback transport architecture decision
- `docs/adr-003-cleanup-boundary-policy.md`: cleanup isolation and policy decision
- `docs/adr-004-packaged-entrypoint.md`: packaged beta entrypoint decision and rationale
- `docs/beads-governance.md`: issue decomposition and traceability governance

## Commands

### Build
```bash
make build
```
Builds debug binaries.

### Probe (debug)
```bash
make probe CAPTURE_SECS=8
```
Runs `src/main.rs` and prints output-type/timestamp metadata.

### Record WAV (debug)
```bash
make capture CAPTURE_SECS=10 OUT=artifacts/hello-world.wav SAMPLE_RATE=48000
```
Runs the debug recorder binary directly.

### Run Representative Transcription Runtime (debug)
```bash
make transcribe-live ASR_MODEL=models/ggml-base.en.bin
```
Validates CLI flags, runs representative ASR transcription against `--input-wav` (auto-generated locally if missing), emits `partial`/`final` events to terminal + JSONL, computes VAD boundaries, and writes runtime manifest + mode-specific latency benchmark artifacts.

### Run True Live-Stream Runtime (debug)
```bash
make transcribe-live-stream ASR_MODEL=models/ggml-base.en.bin
```
Runs the `--live-stream` runtime selector and prints absolute paths for captured input + emitted artifacts before execution. In this mode, `--input-wav` is the progressive scratch capture artifact that grows during runtime, while `--out-wav` is the canonical session WAV materialized on successful closeout.

Common overrides:
- `TRANSCRIBE_LIVE_STREAM_SECS`
- `TRANSCRIBE_LIVE_STREAM_INPUT_WAV`
- `TRANSCRIBE_LIVE_STREAM_OUT_WAV`, `TRANSCRIBE_LIVE_STREAM_OUT_JSONL`, `TRANSCRIBE_LIVE_STREAM_OUT_MANIFEST`
- `TRANSCRIBE_LIVE_STREAM_ARGS` (pass-through extra `transcribe-live` flags)

### Runtime Mode Quick Guide (operator first-read)

| Runtime taxonomy mode | Selector | Use this when | When stable transcript lines appear |
|---|---|---|---|
| `representative-offline` | `<default>` | deterministic artifact validation against an input WAV | mostly at end-of-run summary/replay surfaces |
| `representative-chunked` | `--live-chunked` | near-live scheduler validation on captured WAV (no true concurrent capture) | during runtime as boundaries close, with end summary for complete closeout |
| `live-stream` | `--live-stream` | true live capture + transcription during recording | during active runtime after warmup, then deterministic close summary |

Migration note for selector naming compatibility:
- [Legacy `--live-chunked` migration note](docs/live-chunked-migration.md)

Quick first-run path for true live mode:

```bash
make setup-whispercpp-model
make transcribe-live-stream ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

What to expect:

- `warmup` lifecycle starts first; transcript lines are not expected until runtime reaches `active`.
- once `active`, interactive terminals show low-noise partial updates and stable final lines as segments close.
- close summary is deterministic; if stable lines were already shown live, duplicate replay is suppressed.
- if summary reports degraded trust/degradation counters, use `reconciled_final` plus manifest trust/reconciliation fields for canonical review.

### One-Command Capture then Transcribe (debug)
```bash
make capture-transcribe
```
Runs `sequoia_capture` first and stops immediately on capture failure, then invokes `transcribe-live` on the captured WAV (`--asr-backend whispercpp` by default). The target prints absolute paths for input/output artifacts before execution.

Common overrides:
- `PIPELINE_SECS` (capture/transcribe duration)
- `PIPELINE_CAPTURE_WAV` (intermediate captured WAV used as `--input-wav`)
- `PIPELINE_OUT_WAV`, `PIPELINE_OUT_JSONL`, `PIPELINE_OUT_MANIFEST`
- `PIPELINE_CHANNEL_MODE` (`separate`, `mixed`, or `mixed-fallback`)
- `PIPELINE_ASR_MODEL` (optional explicit model path; if unset, transcribe-live uses its backend default resolution)
- `PIPELINE_ARGS` (pass-through extra `transcribe-live` flags)

### Run Transcription Preflight (debug)
```bash
make transcribe-preflight ASR_MODEL=models/ggml-base.en.bin
```
Runs structured PASS/WARN/FAIL prerequisite checks before capture/transcription startup and writes a preflight manifest to `--out-manifest`.

### Run Smoke Journeys (debug)
```bash
make smoke
```
Runs the CI-safe smoke bundle:
- `make smoke-offline` (deterministic offline journey)
- `make smoke-near-live-deterministic` (deterministic near-live fallback using a stereo fixture)

Host near-live smoke (machine-dependent, requires Screen Recording + Microphone permissions):
```bash
make smoke-near-live
```

Smoke artifact roots:
- offline: `artifacts/smoke/offline/`
- near-live host capture: `artifacts/smoke/near-live/`
- near-live deterministic fallback: `artifacts/smoke/near-live-deterministic/`

### Run Near-Live Reliability Soak Gate
```bash
make gate-d-soak
```
Runs the deterministic near-live soak harness (`scripts/gate_d_soak.sh`) and writes per-run artifacts plus `summary.csv` under `artifacts/bench/gate_d/<timestamp>/`.

### Run Near-Live Backlog Pressure Gate
```bash
make gate-backlog-pressure
```
Runs the deterministic backlog-pressure gate harness and writes artifacts under `artifacts/bench/gate_backlog_pressure/<timestamp>/`.

### Run Transcript Completeness Gate (Reconciliation Under Backlog)
```bash
make gate-transcript-completeness
```
Runs the reconciliation completeness gate under induced backlog and writes artifacts under `artifacts/bench/gate_transcript_completeness/<timestamp>/`.

### Run V1 Acceptance Gate (Cold/Warm First-Emit + Artifact/Trust Checks)
```bash
make gate-v1-acceptance
```
Runs deterministic cold/warm near-live checks plus backlog/trust checks and writes artifacts under `artifacts/bench/gate_v1_acceptance/<timestamp>/`.

### Run Packaged Live Smoke Gate (signed app, deterministic fake capture)
```bash
make gate-packaged-live-smoke
```
Runs the signed transcribe app executable in `--live-stream` mode with deterministic fake capture input and writes machine-readable evidence under:

- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`

Key packaged live checks:
- `runtime_first_stable_emit_ok=true`: first stable transcript evidence is present during active runtime
- `runtime_transcript_surface_ok=true`: manifest/JSONL transcript surfaces are populated
- `runtime_terminal_live_mode_ok=true`: terminal contract stayed in live mode without replay fallback
- `gate_pass=true`: packaged live-stream operator path satisfies the current acceptance bar

Reference: `docs/gate-packaged-live-smoke.md`.
Post-implementation verification checklist and evidence index: `docs/post-implementation-verification-checklist.md`.

### Run Packaged Beta Entrypoint (signed app mode, recommended)
```bash
make run-transcribe-app ASR_MODEL=models/ggml-base.en.bin
```
Builds/signs `dist/SequoiaTranscribe.app` (signed app mode for `transcribe-live`) and launches it via `open -W`.
This is the recommended packaged beta launch path and should be treated as the primary operator entrypoint.
The target prints absolute container-scoped artifact destinations before launch and prints a concise post-run session summary after the signed app exits.

For packaged diagnostics on the same path, use `make run-transcribe-preflight-app`.
For engineering-only development flows, keep using debug targets such as `make transcribe-live`, `make capture-transcribe`, and direct `cargo run`.
Decision record: `docs/adr-004-packaged-entrypoint.md`.

Packaged artifact destination defaults:
- root: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`
- session files:
  - `session.wav`
  - `session.jsonl`
  - `session.manifest.json`

Optional overrides:
- `TRANSCRIBE_APP_ARTIFACT_ROOT`
- `TRANSCRIBE_APP_SESSION_STEM`

Explicit packaged live-stream wrapper:

```bash
make run-transcribe-live-stream-app ASR_MODEL=models/ggml-base.en.bin
```

This keeps the same signed app entrypoint, prints the live input/output artifact paths before launch, and uses:

- `<root>/<session-stem>.input.wav`
- `<root>/<session-stem>.wav`
- `<root>/<session-stem>.jsonl`
- `<root>/<session-stem>.manifest.json`

Artifact semantics for this wrapper:
- `<session-stem>.input.wav`: progressive live scratch artifact written during capture
- `<session-stem>.wav`: canonical session artifact materialized after successful runtime shutdown/drain

Packaged live follow-on evidence path:

- `make gate-packaged-live-smoke` writes packaged live smoke evidence under `<root>/gates/gate_packaged_live_smoke/<timestamp>/...`
- reference: `docs/adr-004-packaged-entrypoint.md` (follow-on design section)

### Run Transcription Preflight (signed app mode diagnostics)
```bash
make run-transcribe-preflight-app ASR_MODEL=models/ggml-base.en.bin
```
Runs the same preflight diagnostics in signed app context and writes results into the configured manifest path.
Default signed preflight manifest path:
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/session.manifest.json`

### Run Transcription Model Doctor (signed app mode diagnostics)
```bash
make run-transcribe-model-doctor-app ASR_MODEL=models/ggml-base.en.bin
```
Runs model/backend diagnostics in the same signed app context used by packaged beta runs so model resolution and backend readiness can be verified without using debug-only entrypoints.

For live-stream prerequisite diagnostics in packaged context:
```bash
make run-transcribe-model-doctor-app \
  ASR_MODEL=models/ggml-base.en.bin \
  TRANSCRIBE_ARGS=--live-stream
```
Use this path for live-mode readiness checks; `--preflight` remains intentionally incompatible with `--live-stream`.

### Bundle + Sign
```bash
make sign SIGN_IDENTITY=-
make verify
```
Builds `dist/SequoiaCapture.app`, sets Swift runtime rpath, signs, and verifies entitlements/signature.

### Run Signed App Bundle
```bash
make run-app CAPTURE_SECS=10 OUT=artifacts/hello-world.wav SAMPLE_RATE=48000
```
Launches the app bundle via `open -W` and passes recorder arguments.

### Reset TCC for Bundle ID
```bash
make reset-perms
```
Resets ScreenCapture and Microphone grants for both:
- `com.recordit.sequoiatranscribe`
- `com.recordit.sequoiacapture`

### Clean
```bash
make clean
```
Removes build/output artifacts and runs `cargo clean`.

## Binary Arguments

### Probe binary (`src/main.rs`)
```bash
cargo run -- [duration_seconds]
```
- `duration_seconds` optional, default `8`

### Recorder binary (`src/bin/sequoia_capture.rs`)
```bash
cargo run --bin sequoia_capture -- [duration_seconds] [output_path] [sample_rate_hz] [sample_rate_mismatch_policy] [callback_contract_mode]
```
- `duration_seconds` optional, default `10`
- `output_path` optional, default `artifacts/hello-world.wav`
- `sample_rate_hz` optional, default `48000`
- `sample_rate_mismatch_policy` optional, default `adapt-stream-rate` (`adapt-stream-rate` or `strict`)
  - `adapt-stream-rate` keeps callback non-blocking and performs worker-side resampling to the requested output rate when mic/system native rates differ
  - `strict` fails fast when either stream rate differs from the requested target
- `callback_contract_mode` optional, default `warn` (`warn` or `strict`)
- telemetry artifact `<output_stem>.telemetry.json` includes `sample_rate_policy` with input rates and resampled chunk/frame counters

### Transcription CLI contract (`src/bin/transcribe_live.rs`)
```bash
cargo run --bin transcribe-live -- [--asr-model <local-model-path>] [flags...]
```
- key flags currently validated:
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
- `--out-wav` contract:
  - canonical session WAV artifact path for the run
  - always materialized on successful runtime execution
  - for `--live-stream`, materialized from the progressive `--input-wav` scratch artifact during successful runtime closeout
  - for representative modes, materialized according to the mode-specific input/output semantics described in the manifest
  - runtime manifest records `out_wav_materialized` and `out_wav_bytes` so artifact truth does not depend on reading the filesystem out-of-band
- backend values:
  - `whispercpp` (primary)
  - `whisperkit` (fallback)
  - `moonshine` (placeholder; adapter not wired yet)
- model resolution precedence:
  - `--asr-model <path>` (explicit override, highest priority)
  - explicit `--asr-model` is fail-fast: missing/invalid explicit paths do not fall through to defaults
  - `RECORDIT_ASR_MODEL` environment variable
  - backend defaults (sandbox container model path, then repo-local model defaults)
  - whispercpp expects a **file** path; whisperkit expects a **directory** path
  - preflight/runtime manifests expose both resolved path and source (`asr_model_resolved`, `asr_model_source`)
- model doctor:
  - run `cargo run --bin transcribe-live -- --model-doctor [--asr-backend ...] [--asr-model ...]`
  - PASS/WARN/FAIL report includes backend helper availability, model path resolution/kind, and model readability
  - use this as first-stop diagnostics before runtime execution when model/backend setup is uncertain
- channel mode values:
  - `separate`
  - `mixed`
  - `mixed-fallback` (prefers separate but falls back to mixed when dual-channel inputs are unavailable)
- near-live runtime contract:
  - default runtime mode is `representative-offline`
  - enable near-live contract with `--live-chunked`
  - runtime taxonomy is authoritative and currently split into:

    | Taxonomy mode | Current selector | `runtime_mode` artifact value | Primary operator intent | Transcript timing expectation | `--replay-jsonl` compatibility | `--preflight` compatibility |
    |---|---|---|---|---|---|---|
    | `representative-offline` | `<default>` | `representative-offline` | deterministic offline transcript contract validation | stable transcript lines are primarily end-of-run surfaces | compatible | compatible |
    | `representative-chunked` | `--live-chunked` | `live-chunked` | near-live queue/scheduler behavior validation on captured WAV | runtime stable lines emit as boundaries close; summary closes out full session | incompatible | incompatible |
    | `live-stream` | `--live-stream` | `live-stream` | true concurrent capture + transcription while recording | transcript emission starts after warmup enters `active` and continues during capture | incompatible | incompatible |

  - `--live-chunked` prepares runtime input via the shared in-process live capture runtime (`recordit::live_capture`) and then runs a rolling near-live scheduler over the captured WAV
  - rolling scheduler semantics: `2s` default window, `0.5s` default stride, deterministic chunk segment IDs, and tail-aligned final window coverage
  - boundary-scoped final segment IDs are normalized from deterministic boundary ordering (`start_ms`, `end_ms`, `source`, `id`) so IDs stay stable even if upstream boundary insertion order changes
  - near-live ASR work is routed through a bounded queue; when saturated, oldest queued chunk work is dropped to preserve non-blocking producer behavior
  - if chunk backlog caused drops, a post-session reconciliation pass emits `reconciled_final` events from canonical session audio to improve final completeness without hiding live-path degradation
  - `--chunk-window-ms` default `2000`
  - `--chunk-stride-ms` default `500`
  - `--chunk-queue-cap` default `4`
  - `--live-asr-workers` default `2`
  - `--chunk-stride-ms` must be `<= --chunk-window-ms`
  - live ASR channel work runs through a dedicated worker pool with explicit backend prewarm before the first live run
  - channel-slice temp WAVs default to `retain-on-failure` cleanup; add `--keep-temp-audio` to retain them on success for debugging
  - chunk tuning flags require `--live-chunked` or `--live-stream`
  - `--live-stream` and `--live-chunked` are mutually exclusive selectors
  - `--live-chunked` and `--live-stream` are incompatible with `--replay-jsonl` and `--preflight`
  - selector naming/deprecation guidance lives in [`docs/live-chunked-migration.md`](docs/live-chunked-migration.md)
- mode/degradation artifact policy:
  - runtime manifest records both `channel_mode_requested` and active `channel_mode`
  - runtime manifest records mode contracts as additive fields: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
  - runtime JSONL emits `event_type=mode_degradation` when fallback/degradation occurs
  - runtime JSONL emits `event_type=trust_notice` with cause/impact/guidance for user-facing trust calibration
  - runtime JSONL emits `event_type=asr_worker_pool` with prewarm, queue, and temp-audio cleanup counters
  - runtime JSONL emits `event_type=chunk_queue` with near-live queue pressure + lag counters
  - runtime JSONL is append-only and emitted incrementally during lifecycle progression (not only at shutdown)
  - in `live-stream`, lifecycle transitions and transcript events are emitted during active runtime so JSONL growth itself is evidence of true live behavior
  - runtime JSONL durability checkpoints call `sync_data()` every 24 lines and at stage boundaries
  - runtime manifest records `out_wav`, `out_wav_materialized`, and `out_wav_bytes` for canonical session artifact truth
  - runtime manifest includes a `degradation_events` array with stable `code` + `detail`
  - runtime manifest includes `asr_worker_pool` telemetry (`prewarm_ok`, `submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `failed`, `retry_attempts`, `temp_audio_deleted`, `temp_audio_retained`)
  - runtime manifest includes `chunk_queue` telemetry (`submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
  - runtime manifest includes a structured `trust` object (`degraded_mode_active`, `notice_count`, `notices`)
  - runtime manifest includes `session_summary`, a deterministic machine-consumable mirror of terminal close-summary fields (`session_status`, modes, transcript event counts, queue/lag, trust/degradation top codes, cleanup queue, artifacts)
  - runtime manifest `event_counts` includes transcript family counts (`partial`, `final`, `llm_final`, `reconciled_final`) for deterministic diagnostics
  - runtime manifest `first_emit_timing_ms` includes `first_any`, `first_partial`, `first_final`, and `first_stable` so gates can validate active-runtime emission without relying on raw JSONL row ordering
  - replay output prints trust notices so audit reads preserve degraded-mode context
- readability default contract:
  - terminal rendering is capability-aware:
    - interactive `TTY` shows low-noise partial overwrite updates using `[MM:SS.mmm-MM:SS.mmm] <channel> ~ <text>` and appends stable `final` lines as segments close
    - non-`TTY` logs suppress partial overwrite updates and emit deterministic stable `final` lines during active runtime
    - end-of-session summary avoids replaying those already-emitted live stable lines to reduce duplicate noise
  - terminal close-summary fields are emitted in deterministic order (`session_status`, `duration_sec`, mode fields, transcript event counts, queue/lag, trust/degradation, cleanup queue, artifacts)
  - merged transcript line format: `[MM:SS.mmm-MM:SS.mmm] <channel>: <text>`
  - per-channel transcript line format: `[MM:SS.mmm-MM:SS.mmm] <text>`
  - near-simultaneous cross-channel finals are deterministic: keep canonical sort order and annotate the later line with `(overlap<=120ms with <channel>)`
  - runtime manifest includes `terminal_summary` (`live_mode`, `stable_line_count`, `stable_lines_replayed`, `stable_lines`) aligned with end-of-session terminal behavior
  - runtime manifest persists ordered transcript events (`partial`, `final`, `llm_final`, `reconciled_final`) under `events`
  - runtime manifest includes `readability_defaults` + `transcript_per_channel` entries
- use `cargo run --bin transcribe-live -- --help` to print the full contract
- cleanup isolation policy:
  - finalized-segment cleanup is queued via non-blocking enqueue (`try_send`)
  - queue-full cleanup requests are dropped, never blocking ASR/final event emission
  - processed cleanup requests use `--llm-timeout-ms` and `--llm-retries` policy
  - prompt policy is constrained to readability cleanup only (no semantic expansion)
  - successful cleanup emits `llm_final` events with `source_final_segment_id` lineage to the original `final` segment
  - queue telemetry is emitted as `cleanup_queue` in both JSONL and runtime manifest outputs

Sample readable transcript output:
```text
[00:00.000-00:00.420] mic: hello from mic
[00:00.050-00:00.410] system: hello from system (overlap<=120ms with mic)
```

Replay example:
```bash
cargo run --bin transcribe-live -- --replay-jsonl artifacts/transcribe-live.runtime.jsonl
```

Benchmark artifacts are written under:
- `artifacts/bench/transcribe-live-single-channel/<timestamp>/summary.csv`
- `artifacts/bench/transcribe-live-single-channel/<timestamp>/runs.csv`
- `artifacts/bench/transcribe-live-dual-channel/<timestamp>/summary.csv`
- `artifacts/bench/transcribe-live-dual-channel/<timestamp>/runs.csv`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/summary.csv`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/summary.csv`

## Output Paths
- `make capture` / direct `cargo run --bin sequoia_capture`: output path is resolved from the current shell working directory.
- `make run-app`: app is sandboxed, so relative paths resolve inside container storage.
- `make transcribe-live`, `make transcribe-live-stream`, and `make run-transcribe-app`: all pass absolute artifact paths and print them before execution.
- `make run-transcribe-app` also prints a post-run session summary (manifest presence + trust/degradation counters when `jq` is available).
- `make transcribe-preflight` and `make run-transcribe-preflight-app`: run deterministic preflight checks and persist checklist outcomes in the manifest output.
- `make transcribe-model-doctor` and `make run-transcribe-model-doctor-app`: run model/backend diagnostics in debug and packaged contexts with the same operator-facing contract.
- Signed transcribe targets default to container-scoped absolute destinations under:
  - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`

Default `run-app` output for `OUT=artifacts/hello-world.wav`:
- `~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav`

Open the generated file:
```bash
open ~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav
```

Copy into repo-local `artifacts/`:
```bash
cp ~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav ./artifacts/hello-world.wav
```

## Permissions and UX
Running the signed app requests macOS privacy permissions for:
- Screen/Screen & System Audio Recording
- Microphone

On Sequoia, direct screen/audio access may also show the private-window-picker bypass prompt with an `Allow for one month` option.

## Notes
- The signed app exits automatically after `CAPTURE_SECS`; this is expected CLI behavior.
- At least one display must be available for the ScreenCaptureKit content filter.
# recordit
