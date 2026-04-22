# Spike Findings: bd-2o8

## Question

Can one ScreenCaptureKit session provide stable `Meeting` and `Me` source streams for whole-system audio plus microphone?

## Verdict

YES

## Evidence

- Apple’s current ScreenCaptureKit docs and sample show one `SCStream` configured with separate `.audio` and `.microphone` outputs, which matches the planned `Meeting` vs `Me` split.
- Apple’s sample for capturing screen content in macOS notes that Screen Recording permission is required and the app must be restarted after permission is granted before capture works.
- The local machine matches the planned baseline for this path: `Xcode 16.4`, `Swift 6.1.2`, and `arm64-apple-macosx15.0`.

## Constraints

- Keep the Phase 1 baseline at `macOS 15+`; that is the cleanest documented path for a single-framework system-audio-plus-microphone capture design.
- Treat Screen Recording and microphone permission as separate checks.
- The blocked repair flow must open System Settings, explain the restart/relaunch requirement for Screen Recording, and retry on relaunch.
- Phase 1 should optimize for one believable whole-system capture path first; multi-display edge behavior can stay outside the Phase 1 proof loop.

## Impact On Phase 1

- `bd-303` should explicitly own the System Settings repair flow and relaunch messaging.
- `bd-2az` should assume two source streams coming from one capture session, not a mixed-framework fallback design.

## Sources

- https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos
- https://developer.apple.com/documentation/Updates/ScreenCaptureKit
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone
