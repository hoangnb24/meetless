# Sequoia Capture Research (macOS 15, Rust, ScreenCaptureKit)

Date: 2026-02-27
Host SDK checked: `MacOSX15.5.sdk`

## Scope and Constraints
- Target: macOS 15+ only.
- Mic + system audio must both come from ScreenCaptureKit.
- No `cpal`/CoreAudio workaround for microphone capture.

## Phase 1

### Prompt 1: ScreenCaptureKit mic+system validation

Status: **API behavior confirmed from SDK headers and validated by runtime capture in this project.**

Confirmed:
- `SCStreamConfiguration` exposes `captureMicrophone` on macOS 15+.
- `SCStreamOutputType` has separate tags for `Audio` and `Microphone`.
- `SCStreamOutputTypeAudio` buffers use `sampleRate`/`channelCount` from stream config.
- `SCStreamOutputTypeMicrophone` buffers use the selected microphone device's native format.
- `SCStream` exposes a `synchronizationClock`, so outputs are in a shared clock domain.

Evidence:
- SDK header:
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:25`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:26`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:31`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:357`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:450`
- Rust probe in this repo:
  - `src/main.rs` (adds separate handlers for `Audio` and `Microphone`, logs per-buffer PTS and format details)

Answer to the core question:
- System audio and microphone do **not** arrive as one merged `CMSampleBuffer`.
- They arrive as separate callback streams distinguished by `SCStreamOutputType::Audio` and `SCStreamOutputType::Microphone`.
- Timestamp domain should be common (shared stream clock), but Apple does not promise "identical timestamp values per callback". Treat them as separately chunked streams and align by PTS.

Runtime validation sample:
- Recorder execution:
  - `dist/SequoiaCapture.app/Contents/MacOS/SequoiaCapture 10 artifacts/hello-world.wav 48000`
- Result:
  - `WAV written: artifacts/hello-world.wav (mic chunks: 1874, system chunks: 1005, frames: 483851)`

### Prompt 2: Acoustic echo cancellation (AEC)

Status: **No ScreenCaptureKit-level AEC control was found; treat mic feed as unprocessed capture path for architecture planning.**

Confirmed:
- ScreenCaptureKit exposes mic capture toggle and device selection, but no AEC/voice-processing knob.
- Apple voice processing controls exist in VoiceProcessing Audio Unit APIs (separate subsystem), not in ScreenCaptureKit.

Evidence:
- ScreenCaptureKit config surface (no AEC property):
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:355`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:360`
- Voice processing properties live in AudioToolbox VoiceProcessing unit:
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/AudioToolbox.framework/Headers/AudioUnitProperties.h:2610`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/AudioToolbox.framework/Headers/AudioUnitProperties.h:2635`

Inference (explicit):
- If speakers are open (no headphones), acoustic bleed into mic is expected and can cause apparent double audio in final mix (direct system feed + room pickup).
- Severity depends on output volume, mic gain, and room acoustics.

Recommendation:
- Sprint default: require headphones for clean recordings.
- If speaker use is mandatory, add a post-filter DSP pass (or separate voice-processing pipeline) as a later sprint.

## Phase 2

### Prompt 3: Sequoia TCC monthly/recurring screen-capture prompt

Status: **Confirmed that Sequoia introduces the private-window-picker bypass alert flow and month-limited allowance UX.**

Confirmed from Apple Developer Forums thread:
- Prompt wording includes bypassing the private window picker and direct screen/audio access.
- User-facing options shown include `Allow for one month` and `Open System Settings`.
- Apple DTS accepted answer: only two ways to avoid that alert are:
  1. Persistent Content Capture entitlement (`com.apple.developer.persistent-content-capture`) for qualifying screen-sharing products.
  2. Use `SCContentSharingPicker` (user case-by-case selection).

Inference for CLI:
- A generic terminal-launched CLI cannot suppress this prompt itself.
- In managed enterprise contexts, a policy key named `forceBypassScreenCaptureAlert` exists under `com.apple.applicationaccess` (observed in local managed preference data), which indicates suppression is policy/MDM controlled, not app-controlled.

Terminal/iTerm UX flow (practical):
1. First capture attempt triggers Screen Recording authorization path for host app context.
2. After screen permission exists, Sequoia may still show private-picker bypass alert for direct capture mode.
3. With mic enabled, a microphone consent prompt is separate and requires `NSMicrophoneUsageDescription` in bundle metadata.

### Prompt 4: Content filter requirement and clamshell/display sleep behavior

Status: **API constraint confirmed; no-display scenarios are risky for reliable system-audio capture.**

Confirmed:
- `SCContentFilter` constructors require a display or a window anchor.
- There is no pure "audio-only without capture source" filter constructor.
- Error codes include `NoDisplayList`, `NoCaptureSource`, and `SystemStoppedStream`.

Evidence:
- Filter constructors (display/window anchored):
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:146`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h:154`
- Stream/system stop errors:
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCError.h:28`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCError.h:29`
  - `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCError.h:35`

Real-world report signal:
- Apple developer thread reports `SCStreamErrorSystemStoppedStream` after display disconnect scenarios.

Conclusion:
- "Headless closed-lid with no active display" is not a safe assumption.
- Design for: at least one active display context and stream restart logic on sleep/disconnect.

### Prompt 5: Info.plist, entitlements, signing

Status: **Build/sign/package flow implemented in this repo (see Makefile + packaging files).**

Confirmed requirements:
- `NSMicrophoneUsageDescription` key for microphone permission prompt.
- `NSScreenCaptureUsageDescription` key for screen/system-audio recording prompt context.
- For sandboxed distribution, include entitlements for audio input and screen recording access.

Implemented artifacts:
- `app/RecorditApp/Info.plist` (Recordit.app privacy usage descriptions)
- `packaging/Info.plist` (legacy SequoiaCapture metadata)
- `packaging/entitlements.plist`
- `Makefile` targets to build `.app`, add Swift runtime `rpath`, sign, verify, run via bundle context, and reset TCC grants (`reset-perms`).

## Phase 3

### Prompt 6: Real-time safety architecture

Assessment:
- Callback thread should not block or allocate heavily.
- `crossbeam-channel` is acceptable for prototype throughput but not the strictest RT guarantee.
- `rtrb` is preferred for deterministic, fixed-capacity SPSC lock-free transfer in production.

Recommended production pattern:
- Callback thread:
  - No mutex, no heap allocation.
  - Copy/pack PCM into preallocated ring slots.
  - Push write index into ring.
- Worker thread:
  - Pop chunks.
  - PTS align mic/system.
  - Interleave stereo and write WAV.

### Prompt 7: Stereo interleave specification

Target output:
- Interleaved stereo WAV, `f32`, 48 kHz.
- Channel mapping:
  - Left (ch1): microphone
  - Right (ch2): system/meeting audio

Math/spec:
- Convert each source buffer to mono first.
- For planar input with `N` channels:
  - `mono[i] = (1/N) * sum(ch[k][i])`
- For interleaved input with `N` channels:
  - `mono[i] = (1/N) * sum(frame[i*N + k])`
- Timeline alignment by PTS:
  - `start_index = round((pts - base_pts) * sample_rate)`
- Interleave at write:
  - `out[2*i] = mic[i]`
  - `out[2*i+1] = sys[i]`

Implemented prototype:
- `src/bin/sequoia_capture.rs` captures mic+system from SCK and writes stereo WAV with this mapping.

## Deliverables Status

1. Hello-world WAV recorder path: **validated**
- Binary: `src/bin/sequoia_capture.rs`
- Output default: `artifacts/hello-world.wav`
- Signed app run output location for relative paths: `~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav`

2. Architecture diagram: **implemented**
- `docs/architecture.md`

3. Packaging/build/sign script: **implemented**
- `Makefile` + `packaging/*`

4. ScreenCaptureKit test runtime path: **implemented**
- Problem: `cargo test --bin sequoia_capture` aborts without Swift runtime lookup path (`libswift_Concurrency.dylib` not found).
- Contract: repository-level Cargo env sets `DYLD_LIBRARY_PATH=/usr/lib/swift` in `.cargo/config.toml`.
- Canonical local/CI command:
  - `cargo test --bin sequoia_capture -- --nocapture`

## Sources
- ScreenCaptureKit captureMicrophone docs:
  - https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone
- ScreenCaptureKit capturesAudio docs:
  - https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio
- ScreenCaptureKit microphoneCaptureDeviceID docs:
  - https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/microphonecapturedeviceid
- Apple DTS discussion of Sequoia private picker bypass alert:
  - https://developer.apple.com/forums/thread/765103
- NSMicrophoneUsageDescription key:
  - https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription
- App Sandbox audio input entitlement:
  - https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
- App Sandbox screen recording entitlement:
  - https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.screen-recording
- Persistent Content Capture entitlement:
  - https://developer.apple.com/documentation/bundleresources/entitlements/com_apple_developer_persistent-content-capture
- Developer report on system stopping stream with display disconnect:
  - https://developer.apple.com/forums/thread/786041
- Developer report on macOS 15.4 audio+microphone regression symptoms:
  - https://developer.apple.com/forums/tags/screencapturekit
