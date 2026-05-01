# Meetless

Meetless is a native macOS meeting recorder for local-first capture, transcription,
saved sessions, and optional Gemini-generated session notes.

The app records a meeting into two separate audio sources:

- `Meeting`: ScreenCaptureKit system audio.
- `Me`: ScreenCaptureKit microphone capture.

Both sources are normalized for local transcription, written into a local session
bundle, and shown as one committed transcript timeline. Saved sessions can be
reopened from the Sessions screen, reviewed as read-only transcript snapshots, and
enriched with a permanent Gemini summary plus simple action-item bullets.

## Requirements

- macOS 15 or newer.
- Xcode with the macOS SDK.
- Git submodule support for the pinned `whisper.cpp` dependency.
- Screen Recording and Microphone permissions for runtime recording.
- A Gemini API key for optional session-note generation.

## Project Layout

- `Meetless.xcodeproj` - Xcode project with the `Meetless` app and
  `MeetlessTests` test target.
- `MeetlessApp/App` - SwiftUI app entrypoint, shell navigation, app-level state,
  and Gemini settings UI.
- `MeetlessApp/Features` - Record, Sessions, and Session Detail screens.
- `MeetlessApp/Services/Capture` - ScreenCaptureKit capture session for system
  audio and microphone input.
- `MeetlessApp/Services/AudioPipeline` - audio normalization and per-source WAV
  writing during active recording.
- `MeetlessApp/Services/SessionRepository` - local session bundle persistence,
  transcript snapshots, audio artifact resolution, AAC compression, and generated
  notes storage.
- `MeetlessApp/Services/GeminiAPIKeyStore` - Keychain-backed Gemini API key
  storage.
- `MeetlessApp/Services/GeminiSessionNotes` - Gemini Files API upload,
  `gemini-2.5-flash` generation, structured response parsing, and orchestration.
- `MeetlessPackages/WhisperCppBridge` - Swift-facing bridge around the bundled
  `whisper.cpp` framework and model.
- `Vendor/whisper.cpp` - pinned upstream whisper dependency.
- `scripts` - bootstrap, framework build, and DMG packaging commands.
- `docs` - release and distribution documentation.
- `history` - Khuym feature context, phase contracts, reviews, and learnings.

## Setup

Initialize and build the pinned whisper framework:

```zsh
./scripts/bootstrap-whisper.sh
```

The bootstrap command initializes `Vendor/whisper.cpp` when needed and then runs
the framework build. To rebuild the framework after the submodule is present:

```zsh
./scripts/build-whisper-xcframework.sh
```

The Release app expects these bundled resources:

- `MeetlessApp/Resources/Models/ggml-tiny.en.bin`
- `MeetlessApp/Resources/Samples/jfk.wav`
- `Vendor/whisper.cpp/build-apple/whisper.xcframework`

## Build And Test

List available schemes:

```zsh
xcodebuild -list -project Meetless.xcodeproj
```

Build the app:

```zsh
xcodebuild \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -configuration Debug \
  build
```

Run the test suite:

```zsh
xcodebuild test \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -destination 'platform=macOS'
```

Focused test examples:

```zsh
xcodebuild test \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -destination 'platform=macOS' \
  -only-testing:MeetlessTests/SessionRepositoryTests

xcodebuild test \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -destination 'platform=macOS' \
  -only-testing:MeetlessTests/GeminiSessionNotesClientTests
```

## Runtime Behavior

Meetless is sandboxed and carries these entitlements:

- `com.apple.security.app-sandbox`
- `com.apple.security.device.audio-input`
- `com.apple.security.network.client`

Recording start evaluates Screen Recording and Microphone access. Screen
Recording changes require quitting and reopening the app before recording can
proceed. Microphone changes can be retried in the running app.

The app stores saved sessions under the user's Application Support directory:

```text
~/Library/Application Support/Meetless/Sessions/<session-id>/
```

A saved session bundle contains:

- `session.json` - manifest, status, source health, audio artifact names,
  transcript snapshot state, and optional generated-notes pointer.
- `transcript.json` - committed transcript chunks as saved by the local
  transcription pipeline.
- `meeting.m4a` and `me.m4a` - compressed source audio after successful stop.
- `meeting.wav` and `me.wav` - durable fallback artifacts when AAC compression
  does not complete.
- `generated-notes.json` - hidden Gemini transcript, visible summary, and simple
  action-item bullets when notes have been generated.

Finished WAV artifacts are compressed to AAC `.m4a` at 48 kbps. The original WAV
file remains the durable source of record when compression fails.

## Gemini Session Notes

The Settings screen stores a Gemini API key in macOS Keychain. Session Detail
uses the saved key to generate notes for a selected saved session.

The v1 notes flow has a fixed product contract:

- The user confirms every upload before saved audio leaves the Mac.
- Both saved source audio artifacts are uploaded separately.
- Gemini uses `gemini-2.5-flash`.
- The client uses the Gemini Files API resumable upload protocol:
  start upload, read `X-Goog-Upload-URL`, upload/finalize bytes, then call
  `generateContent`.
- The visible result contains `Summary` and `Action Items`.
- The Gemini transcript is persisted for audit/debug/future use and is hidden
  from the Session Detail UI.
- Notes are permanent for v1. Generate is disabled after notes exist.
- Failed generation keeps the saved session unchanged and shows a retryable
  error.

Supported upload artifact extensions are `.m4a`, `.wav`, and `.wave`.

## Debug And Review Helpers

Print the redacted storage-root label at app startup:

```zsh
xcodebuild \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -configuration Debug \
  -derivedDataPath .derived \
  build

MEETLESS_PRINT_STORAGE_ROOT=1 \
.derived/Build/Products/Debug/Meetless.app/Contents/MacOS/Meetless
```

The app prints `MEETLESS_RUNTIME_STORAGE_ROOT=redacted` plus a container label,
not the user's absolute Application Support path.

Force transcript snapshot write failure for review injection:

```zsh
MEETLESS_FORCE_TRANSCRIPT_SNAPSHOT_UPDATE_FAILURE=1 \
.derived/Build/Products/Debug/Meetless.app/Contents/MacOS/Meetless
```

This path is for local validation of incomplete/lagging snapshot honesty
markers. Generated-notes failure injection is exposed through test-only override
seams.

## Packaging

Create a DMG:

```zsh
./scripts/package-dmg.sh
```

The packaging script runs tests by default, builds the Release app, verifies the
bundled model and embedded whisper framework, checks the app signature, creates a
compressed DMG in `.dist/`, and verifies the DMG.

Packaging environment options:

- `SKIP_TESTS=1` - skip the pre-package `xcodebuild test` step.
- `DMG_NAME=<name>.dmg` - choose the output name under `.dist/`.
- `DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)"` -
  sign the Release build with Developer ID and hardened runtime.
- `NOTARY_KEYCHAIN_PROFILE=Meetless-Notary` - submit, staple, and validate the
  DMG with Apple's notary service.

Internal Developer ID DMG:

```zsh
SKIP_TESTS=1 \
DMG_NAME="Meetless-internal-$(date +%Y%m%d-%H%M).dmg" \
DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)" \
./scripts/package-dmg.sh
```

Fully notarized DMG:

```zsh
DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)" \
NOTARY_KEYCHAIN_PROFILE="Meetless-Notary" \
./scripts/package-dmg.sh
```

See `docs/release-dmg.md` for install notes, signing checks, and notary setup.

## Agent Workflow

This repository is Khuym-onboarded. Start substantial agent work by reading
`AGENTS.md` and running:

```zsh
node .codex/khuym_status.mjs --json
```

If planning or execution begins, read `history/learnings/critical-patterns.md`
and the active feature context under `history/<feature>/`.
