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

### Validate Transcription CLI Contract (signed app mode)
```bash
make run-transcribe-app ASR_MODEL=models/ggml-base.en.bin
```
Builds/signs `dist/SequoiaTranscribe.app` (signed app mode for `transcribe-live`) and launches it via `open -W`.
The target prints absolute container-scoped artifact destinations before launch and passes those absolute paths to the CLI.

### Run Transcription Preflight (signed app mode)
```bash
make run-transcribe-preflight-app ASR_MODEL=models/ggml-base.en.bin
```
Runs the same preflight diagnostics in signed app context and writes results into the configured manifest path.
Default signed preflight manifest path:
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/transcribe-live.manifest.json`

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
Resets ScreenCapture and Microphone grants for `com.recordit.sequoiacapture`.

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
  - `--transcribe-channels`
  - `--speaker-labels`
  - `--benchmark-runs`
  - `--replay-jsonl`
- backend values:
  - `whispercpp` (primary)
  - `whisperkit` (fallback)
  - `moonshine` (placeholder; adapter not wired yet)
- model resolution precedence:
  - `--asr-model <path>` (explicit override, highest priority)
  - `RECORDIT_ASR_MODEL` environment variable
  - backend defaults (sandbox container model path, then repo-local model defaults)
  - whispercpp expects a **file** path; whisperkit expects a **directory** path
  - preflight/runtime manifests expose both resolved path and source (`asr_model_resolved`, `asr_model_source`)
- channel mode values:
  - `separate`
  - `mixed`
  - `mixed-fallback` (prefers separate but falls back to mixed when dual-channel inputs are unavailable)
- mode/degradation artifact policy:
  - runtime manifest records both `channel_mode_requested` and active `channel_mode`
  - runtime JSONL emits `event_type=mode_degradation` when fallback/degradation occurs
  - runtime JSONL emits `event_type=trust_notice` with cause/impact/guidance for user-facing trust calibration
  - runtime manifest includes a `degradation_events` array with stable `code` + `detail`
  - runtime manifest includes a structured `trust` object (`degraded_mode_active`, `notice_count`, `notices`)
  - replay output prints trust notices so audit reads preserve degraded-mode context
- readability default contract:
  - merged transcript line format: `[MM:SS.mmm-MM:SS.mmm] <channel>: <text>`
  - per-channel transcript line format: `[MM:SS.mmm-MM:SS.mmm] <text>`
  - near-simultaneous cross-channel finals are deterministic: keep canonical sort order and annotate the later line with `(overlap<=120ms with <channel>)`
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

## Output Paths
- `make capture` / direct `cargo run --bin sequoia_capture`: output path is resolved from the current shell working directory.
- `make run-app`: app is sandboxed, so relative paths resolve inside container storage.
- `make transcribe-live` and `make run-transcribe-app`: both pass absolute artifact paths and print them before execution.
- `make transcribe-preflight` and `make run-transcribe-preflight-app`: run deterministic preflight checks and persist checklist outcomes in the manifest output.
- Signed transcribe targets default to container-scoped absolute destinations under:
  - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/`

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
