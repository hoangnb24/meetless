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
- `packaging/Info.plist`: bundle metadata and privacy usage descriptions
- `packaging/entitlements.plist`: sandbox and privacy entitlements
- `docs/research.md`: API/TCC/platform research
- `docs/architecture.md`: real-time pipeline and interleave spec

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
cargo run --bin sequoia_capture -- [duration_seconds] [output_path] [sample_rate_hz]
```
- `duration_seconds` optional, default `10`
- `output_path` optional, default `artifacts/hello-world.wav`
- `sample_rate_hz` optional, default `48000`

## Output Paths
- `make capture` / direct `cargo run --bin sequoia_capture`: output path is resolved from the current shell working directory.
- `make run-app`: app is sandboxed, so relative paths resolve inside container storage.

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
