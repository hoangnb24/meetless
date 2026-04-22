# Discovery Report: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**CONTEXT.md reference**: `history/native-macos-meeting-recorder/CONTEXT.md`

---

## Institutional Learnings

> Read during Phase 0 from `history/learnings/`

### Critical Patterns (Always Applied)

- None applicable. `history/learnings/critical-patterns.md` does not exist in this repo.

### Domain-Specific Learnings

No prior learnings for this domain.

---

## Agent A: Architecture Snapshot

> Source: local file tree inspection, Khuym scout, grep fallback

`gkg` is unavailable for this repo because the scout reports no supported source files yet. Discovery therefore used local file inspection plus primary-source platform research instead of gkg topology tools.

### Relevant Packages / Modules

| Package/Module | Purpose | Key Files |
|----------------|---------|-----------|
| Repo workflow only | Khuym routing and handoff state | `AGENTS.md`, `.khuym/state.json`, `.khuym/STATE.md` |
| Feature context | Locked product decisions from exploring | `history/native-macos-meeting-recorder/CONTEXT.md` |

### Entry Points

- **Current repo state**: no app target, no Swift package, no Xcode project, and no existing product code.
- **Implication**: this feature must be planned as a true greenfield macOS app. There is nothing in the repo to model the implementation after beyond Khuym workflow artifacts.

### Key Files to Model After

- `history/native-macos-meeting-recorder/CONTEXT.md` — fixed product contract for the new app
- `AGENTS.md` — workflow guardrails for planning, validation, and later execution

---

## Agent B: Pattern Search

> Source: local inspection only

### Similar Existing Implementations

| Feature/Component | Location | Pattern Used | Reusable? |
|-------------------|----------|--------------|-----------|
| None | N/A | Repo contains no existing app code | No |

### Reusable Utilities

- None in product code. The repo currently contains only Khuym workflow/state files.

### Naming Conventions

- No product-side naming convention exists yet.
- Planning should therefore choose a simple, macOS-native structure instead of inventing a heavy modular architecture to match code that is not present.

---

## Agent C: Constraints Analysis

> Source: repo scout, local environment inspection, Apple documentation, upstream `whisper.cpp`

### Runtime & Framework

- **Language**: Swift
- **UI**: SwiftUI with AppKit bridges only where macOS-specific behavior requires them
- **Capture framework**: ScreenCaptureKit
- **Transcription engine**: `whisper.cpp`
- **Distribution target for v1 planning**: Apple Silicon first

### Existing Dependencies (Relevant to This Feature)

| Package | Version | Purpose |
|---------|---------|---------|
| `br` | local CLI present | Bead creation later in planning |
| `bv` | local CLI present | Graph inspection later in planning/validating |
| `cass` | local CLI present | Session search if needed later |
| `cm` | local CLI present | Memory retrieval if needed later |

### New Dependencies Needed

| Package | Reason | Risk Level |
|---------|--------|------------|
| `whisper.cpp` | Local offline speech-to-text engine | HIGH — new native C/C++ dependency |
| Xcode macOS app project | SwiftUI app shell and signing/capabilities | MEDIUM — new project scaffold |

### Build / Quality Requirements

There is no build system in the repo yet. Based on current Apple and upstream docs, the planning baseline should assume:

- Xcode 16 or later
- macOS 15 or later if we want the current documented ScreenCaptureKit sample path with separate `.audio` and `.microphone` stream outputs in one capture stack
- App Sandbox enabled
- microphone usage description in `Info.plist`
- screen recording permission flow handled at runtime

### Database / Storage

- No persistence layer exists yet.
- Because history is browse-only in v1 and the repo is greenfield, file-backed session bundles are a viable first persistence model.
- A database is not forced by current scope; adding one now would be anticipatory complexity.

---

## Agent D: External Research

> Source: official Apple docs and upstream `whisper.cpp` docs/code

### Library Documentation

| Library | Version / Snapshot | Key Docs |
|---------|--------------------|----------|
| ScreenCaptureKit | Apple docs crawled Apr 2026 | Framework overview, `SCStream`, `SCStreamConfiguration`, current sample app |
| App Sandbox / macOS permissions | Apple docs crawled Apr 2026 | microphone authorization, sandbox entitlements |
| `whisper.cpp` | upstream README at stable `v1.8.1` and current example code | README, XCFramework workflow, SwiftUI example, C API usage |

### Primary-Source Findings

#### 1. ScreenCaptureKit can deliver separate system-audio and microphone buffers

- Apple’s current sample for “Capturing screen content in macOS” shows a single `SCStream` adding outputs for `.screen`, `.audio`, and `.microphone`.
- Apple’s current ScreenCaptureKit updates page explicitly describes microphone capture through `SCStreamOutputTypeMicrophone`.
- `SCStreamConfiguration` currently exposes both `capturesAudio` and `captureMicrophone`, plus `microphoneCaptureDeviceID`.

Why this matters:
- This supports the planned `Meeting` vs `Me` source split without inventing a second capture stack.
- It makes a macOS-15-first design materially simpler than mixing ScreenCaptureKit for system audio with a separate AVFoundation microphone pipeline.

#### 2. Screen recording and microphone permissions are distinct and operationally important

- Apple’s current ScreenCaptureKit sample notes that the first run prompts for Screen Recording permission and that the app must be restarted after the user grants it before capture works.
- Apple’s authorization guide for media capture on macOS confirms explicit microphone permission is required and must be backed by `NSMicrophoneUsageDescription`.
- Apple’s App Sandbox docs confirm microphone capture needs the audio-input entitlement.

Why this matters:
- The permission repair flow must treat Screen Recording as a blocking prerequisite and tell the user that a restart/relaunch may be required.
- The first usable recording flow depends on both runtime permission handling and correct signing/capability setup.

#### 3. `whisper.cpp` is viable for a native Swift app, but it should be isolated from the app target

- Upstream README describes Apple Silicon optimization through NEON, Accelerate, Metal, and optional Core ML.
- Upstream README documents an XCFramework workflow and shows a SwiftPM binary target example for Apple platforms.
- Upstream `whisper.swiftui` example explicitly recommends building an XCFramework first, then embedding it into the app.
- That same example warns that pushing `-O3 -DNDEBUG` into the app project is “not ideal in real world” and suggests isolating the C/C++ build settings instead of letting them bleed into the whole app.

Why this matters:
- The cleanest app architecture is not “compile whisper.cpp directly inside the main app target.”
- The bridge should live behind its own wrapper target or local package boundary.

#### 4. `whisper.cpp` runtime access should be serialized per context

- Upstream Swift example wraps the `whisper` context in a Swift `actor` and includes the explicit note: “Don’t access from more than one thread at a time.”
- The example resolves model files from the app bundle and creates a long-lived `WhisperContext` per loaded model.

Why this matters:
- The app should not share one mutable context across concurrent `Meeting` and `Me` transcription work.
- If we want two sources to progress independently, the safest default is one isolated transcription worker per source, each with its own context.

#### 5. Model packaging is a product decision, not just a dev convenience

- Upstream README lists approximate model sizes and memory footprints, with `base.en` at 142 MiB on disk and about 388 MB memory, and `small.en` substantially larger.
- Upstream README documents optional Core ML encoder generation, but that adds an extra generated model bundle and first-run compilation cost on device.

Why this matters:
- Bundling a model is viable, but model size and memory become first-order constraints if the app keeps one live transcription context per source.
- Core ML should be treated as an optimization path, not a mandatory day-one requirement.

### Known Gotchas / Anti-Patterns

- **Gotcha**: treating Screen Recording permission like normal microphone permission
  - Why it matters: Apple’s sample notes capture won’t work until after permission is granted and the app is restarted.
  - How to avoid: build a blocked repair flow that opens System Settings, explains the restart requirement, and rechecks readiness on relaunch.

- **Gotcha**: building `whisper.cpp` directly into the app target
  - Why it matters: upstream explicitly calls out that app-wide C flags are not a good real-world setup.
  - How to avoid: isolate the native bridge in a wrapper target or local package around an XCFramework.

- **Gotcha**: assuming one `whisper` context can safely serve multiple concurrent streams
  - Why it matters: upstream example treats the context as single-threaded and actor-isolated.
  - How to avoid: serialize access strictly, or use one context per source worker.

- **Anti-pattern**: adding Core ML generation and downloadable model management before the first live recording loop works
  - Common mistake: front-loading packaging and performance polish before proving the capture/transcription event flow.
  - Correct approach: start with one bundled pinned model and Metal-capable build, then benchmark whether Core ML is needed.

---

## Open Questions

> Items that were not fully resolvable through research alone.

- [ ] Does a single display-scoped ScreenCaptureKit stream behave exactly as desired for “whole-system meeting audio” on the target macOS version, especially on multi-display setups?
- [ ] What bundled model choice gives the best live dual-source tradeoff on Apple Silicon for v1: `base.en`, a quantized `base.en`, or a smaller English model?
- [ ] Is transcript durability better served by a single snapshot JSON file, or by an append-only event log plus final snapshot compaction for incomplete-session recovery?

---

## Summary for Synthesis (Phase 2 Input)

**What we have**: a greenfield repo with no app code, a fully locked product contract, and strong primary-source evidence that ScreenCaptureKit plus `whisper.cpp` is viable for the chosen stack.

**What we need**: a minimal native macOS architecture that isolates the `whisper.cpp` boundary, supports separate `Meeting` and `Me` live transcription flows, and persists raw audio plus transcript snapshots locally without overengineering.

**Key constraints from research**:
- Current Apple docs support separate `.audio` and `.microphone` outputs in a single ScreenCaptureKit-based pipeline.
- Screen Recording permission is blocking and operationally different from microphone permission.
- `whisper.cpp` should be isolated behind its own wrapper boundary, and context access should remain serialized.

**Institutional warnings to honor**:
- No prior institutional learnings for this domain.

---

## Sources

- Apple ScreenCaptureKit overview: https://developer.apple.com/documentation/screencapturekit/
- Apple sample, “Capturing screen content in macOS”: https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos
- Apple `SCStream` docs: https://developer.apple.com/documentation/screencapturekit/scstream
- Apple `SCStreamConfiguration` docs: https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration
- Apple ScreenCaptureKit updates: https://developer.apple.com/documentation/Updates/ScreenCaptureKit
- Apple media capture authorization on macOS: https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos
- Apple audio-input entitlement: https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.device.audio-input
- Apple App Sandbox overview: https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox
- `whisper.cpp` upstream README: https://github.com/ggml-org/whisper.cpp
- `whisper.cpp` SwiftUI example README: https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.swiftui/README.md
