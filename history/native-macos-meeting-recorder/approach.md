# Approach: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**Based on**:
- `history/native-macos-meeting-recorder/discovery.md`
- `history/native-macos-meeting-recorder/CONTEXT.md`

---

## 1. Gap Analysis

> What exists vs. what the feature requires.

| Component | Have | Need | Gap Size |
|-----------|------|------|----------|
| macOS app shell | None | SwiftUI macOS app target with windowed navigation | New |
| Recording flow | None | Start/Stop recording screen with dual audio sources | New |
| Transcription engine | None | `whisper.cpp` bridge plus live transcription workers | New |
| Realtime transcript model | None | Source-labeled live chunk flow for `Meeting` and `Me` | New |
| Local persistence | None | Durable per-session storage for raw audio, metadata, and transcript snapshot | New |
| History/detail UI | None | Browse list, session detail, delete flow | New |
| Permissions UX | None | On-demand permission check and repair flow | New |
| Packaging/runtime assets | None | Bundled model strategy plus native bridge build | New |

The repo has no implementation surface to extend. Every product-facing component is greenfield, which means the design can stay clean if we keep the module count low and isolate only the truly special boundary: `whisper.cpp`.

---

## 2. Recommended Approach

Build a single native macOS SwiftUI app target, keep most product code inside that target, and isolate `whisper.cpp` behind one dedicated wrapper package or framework boundary. Use a single ScreenCaptureKit-driven capture service to emit separate system-audio and microphone sample streams, normalize each source into transcription-ready PCM, run one actor-isolated `whisper` worker per source, and merge those emitted transcript chunks into a live session timeline labeled `Meeting` and `Me`. Persist each recording as a self-contained session bundle in the app’s sandbox container, with one manifest, one transcript snapshot, and one durable audio file per source. This is the lightest credible path because it matches the locked stack exactly, keeps the SwiftUI app simple, and contains the native C/C++ complexity in one place instead of spreading it through the whole project.

### Why This Approach

- It honors `D1`, `D2`, and `D15` by keeping the two audio sources independent all the way from capture through transcription and persistence.
- It honors `D23` without adding a heavyweight post-processing system by treating the live transcript timeline as the thing that gets persisted.
- It matches current Apple docs, which show ScreenCaptureKit delivering separate `.audio` and `.microphone` outputs from one stream.
- It matches upstream `whisper.cpp` guidance, which favors XCFramework-style Apple integration and serialized access to each whisper context.
- It avoids prematurely adding Core Data, SwiftData, a background job system, or a multi-package app architecture before the first recording loop exists.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Minimum deployment target | `macOS 15+` for v1 planning | Current Apple sample and documented microphone stream path are cleanest there; avoids mixing capture frameworks in phase 1 |
| UI architecture | SwiftUI app with `NavigationStack`, thin `@MainActor` view models, AppKit only for macOS-specific openings and app behavior | Keeps product code native and light |
| Capture topology | One ScreenCaptureKit session configured for system audio plus microphone, with separate output handling per source | Best fit for `Meeting` vs `Me` labels |
| Transcription topology | One `WhisperSourceWorker` actor per source, each owning its own whisper context | Aligns with upstream thread-safety constraints and avoids one source blocking the other |
| Realtime transcript behavior | Chunked near-realtime updates, not token-by-token UI streaming | More stable, lower UI churn, easier to persist exactly as seen |
| Persistence model | File-backed session bundles under app sandbox `Application Support` | Browse-only history does not justify a database yet |
| Durable audio format | One transcription-ready PCM file per source (`meeting.wav`, `me.wav`) | Simple future retranscription path, preserves source separation |
| Session history model | Enumerate session manifests and sort by start time | Fits `D4` and `D9` without search infrastructure |
| `whisper.cpp` integration | Local wrapper around a pinned `whisper.xcframework`, not direct compilation into main app target | Keeps native flags, headers, and vendor lifecycle contained |
| Core ML usage | Optional later optimization, not required for the first usable version | Metal-capable Apple Silicon path is simpler; Core ML adds packaging and first-run complexity |

### Recommended Runtime Shape

```text
SwiftUI View
  -> RecordingViewModel
    -> RecordingCoordinator
      -> PermissionGate
      -> CaptureEngine (ScreenCaptureKit)
      -> SourceAudioPipeline[Meeting]
        -> PCMNormalizer
        -> SourceFileWriter
        -> WhisperSourceWorker
      -> SourceAudioPipeline[Me]
        -> PCMNormalizer
        -> SourceFileWriter
        -> WhisperSourceWorker
      -> TranscriptCoordinator
      -> SessionRepository
```

### Proposed Product Modules

#### App shell and navigation

- `MeetlessApp` bootstraps the main window.
- Root navigation stays simple:
  - Home
  - History
  - Session detail
- Home is recording-first per `D17`.
- Navigation stays single-column with `NavigationStack`, not a sidebar-first shell, because `D13` explicitly prefers a straightforward windowed app.

#### Capture pipeline

- `PermissionGate` checks Screen Recording readiness and microphone readiness before recording starts.
- `CaptureEngine` owns `SCStream`, its configuration, and source-specific sample handler queues.
- `SourceAudioPipeline` receives `CMSampleBuffer` values, stamps them with monotonic local time, converts them into 16 kHz mono PCM float buffers for transcription, and writes aligned PCM audio to disk.
- The system audio path maps to `Meeting`; the microphone path maps to `Me`.
- If one source stops producing usable audio, the other stays alive and the session enters a degraded state per `D15`.

#### Transcription engine boundary

- `WhisperCppBridge` exposes a small Swift-native API:
  - load model
  - transcribe incremental window
  - unload model
  - report configuration/benchmark metadata
- `WhisperSourceWorker` is an actor owning one live context.
- The bridge should not know about SwiftUI, sessions, or persistence. It only turns PCM windows into transcript results.

#### Realtime transcript state flow

- Each source worker emits transcript chunks with:
  - source label
  - start/end timestamps
  - text
  - confidence/quality metadata if later available
- `TranscriptCoordinator` merges those source-local emissions into one ordered transcript timeline for the UI.
- The UI only shows committed chunks, not highly volatile token streams.
- `SessionRepository` periodically snapshots the transcript timeline so that incomplete sessions are still recoverable.

#### Local persistence

- Use one session directory per recording:

```text
Application Support/Meetless/Sessions/{session-id}/
  session.json
  transcript.json
  meeting.wav
  me.wav
```

- `session.json` stores session metadata:
  - id
  - title
  - startedAt / endedAt
  - duration
  - status (`completed` / `incomplete`)
  - source health summary
  - transcript preview
  - model/build metadata
- `transcript.json` stores the persisted live transcript snapshot required by `D23`.
- Delete is implemented as a folder delete plus history refresh.

#### Session history/detail model

- History reads manifests only, not the raw audio files.
- Row content matches `D4`: title, date/time, duration, transcript preview.
- Detail view loads `session.json` plus `transcript.json`, and does not show playback controls per `D8`.
- Partial sessions appear with incomplete status per `D5`.

#### Permissions and onboarding

- No dedicated onboarding flow.
- Pressing Record triggers readiness checks.
- If blocked:
  - show the specific missing permissions
  - open System Settings via `NSWorkspace`
  - explain that Screen Recording changes may require relaunch
  - provide Retry after return

#### Packaging / integration shape for `whisper.cpp`

- Keep `whisper.cpp` pinned under `Vendor/whisper.cpp` or another clearly third-party path.
- Build a local `whisper.xcframework` from that pinned source during bootstrap/setup.
- Wrap the framework in `WhisperCppBridge`, which exports only the Swift-facing transcription API.
- Bundle one pinned default English model inside the app product for v1.
- Do not front-load runtime model download, export flows, or manual retranscription UI.

### Why This Is The Lightest Credible Path

- One app target plus one isolated native bridge is much simpler than a many-package clean architecture, but still protects the app from vendor-build sprawl.
- File-backed session bundles are enough for browse-only history and easier to recover than an overbuilt database layer.
- Chunk-level live transcription is believable product behavior without the complexity of unstable token streaming or a second final-pass transcription system.
- macOS-15-first scope meaningfully reduces capture complexity while staying within the user’s Apple-Silicon-first guidance.

---

## 3. Alternatives Considered

### Option A: Everything in one app target, including direct `whisper.cpp` compilation

- Description: compile the C/C++ sources directly into the main macOS app target and keep all Swift code in one target.
- Why considered: it is the shortest path to “something builds.”
- Why rejected: upstream explicitly warns against letting `whisper` compile flags bleed into the whole app project, and this would make vendor updates, build settings, and native troubleshooting messier than necessary.

### Option B: Use separate capture frameworks for mic and system audio

- Description: ScreenCaptureKit for system audio, AVFoundation or Core Audio for microphone capture.
- Why considered: older macOS support could be broader.
- Why rejected: current Apple docs support a cleaner single-framework path, and the locked stack already chose ScreenCaptureKit for capture. Pulling in a second capture stack early increases synchronization and failure-mode complexity.

### Option C: Full multi-package architecture plus database-backed persistence

- Description: split domain, application, infrastructure, UI, and storage into multiple local packages and persist sessions in SQLite or SwiftData from day one.
- Why considered: strong separation and future growth.
- Why rejected: the repo has no existing app code, the v1 history is browse-only, and the extra layers would slow delivery before the product loop is proven.

### Option D: More ambitious transcript pipeline with final post-meeting reprocessing

- Description: live transcript during recording plus an automatic final transcription pass after stop.
- Why considered: better accuracy and cleaner final transcript.
- Why rejected: directly violates `D12`, which excludes a final pass in v1.

---

## 4. Risk Map

| Component | Risk Level | Reason | Verification Needed |
|-----------|------------|--------|---------------------|
| ScreenCaptureKit dual-source capture topology | **HIGH** | New framework usage, mission-critical path, operational behavior can vary with permissions and display selection | Spike in validating |
| Live dual-source transcription workers | **HIGH** | Two concurrent source streams, two whisper contexts, latency/memory tradeoffs | Spike in validating |
| `whisper.cpp` packaging boundary | **HIGH** | New native dependency, XCFramework integration, build reproducibility risk | Spike in validating |
| Session persistence and incomplete recovery | **HIGH** | Must satisfy `D5`, `D11`, and `D23` without losing transcript/audio on interrupted sessions | Spike in validating |
| History/detail UI | **LOW** | Straightforward SwiftUI list/detail flow once persistence exists | Normal verification |
| Delete flow | **LOW** | Local file removal against session bundles | Normal verification |
| Permission repair UI | **MEDIUM** | UI itself is simple, but must correctly reflect macOS permission reality | Focused manual verification |
| Degraded-state warning when one source fails | **MEDIUM** | Requires source-health monitoring and correct UX state | Focused manual verification |

### Risk Classification Reference

```text
Pattern in codebase?        -> NO, repo is greenfield
External dependency?        -> YES for whisper.cpp = HIGH
Blast radius > 5 files?     -> YES for capture/transcription/persistence = HIGH
Otherwise                   -> MEDIUM or LOW depending on isolation
```

### HIGH-Risk Summary (for `khuym:validating`)

- `ScreenCaptureKit dual-source capture`: prove that one recording flow can emit stable `Meeting` and `Me` sample pipelines on the planned macOS target.
- `Dual whisper workers`: prove that one context per source delivers acceptable latency and memory on Apple Silicon with the planned model class.
- `whisper packaging`: prove that a local XCFramework-based wrapper builds cleanly and loads a bundled model inside a macOS app target.
- `Session durability`: prove that interrupted recordings still leave enough persisted metadata/audio/transcript state to appear in history as incomplete sessions.

---

## 5. Proposed File Structure

```text
Meetless.xcodeproj

MeetlessApp/
  App/
    MeetlessApp.swift
    AppModel.swift
    NavigationDestination.swift
  Features/
    Home/
      HomeView.swift
      HomeViewModel.swift
    Recording/
      RecordingView.swift
      RecordingViewModel.swift
      RecordingStatusBanner.swift
    History/
      HistoryView.swift
      HistoryViewModel.swift
      SessionRowView.swift
    SessionDetail/
      SessionDetailView.swift
      SessionDetailViewModel.swift
    Permissions/
      PermissionRepairView.swift
  Core/
    Models/
      Session.swift
      SessionStatus.swift
      TranscriptChunk.swift
      AudioSource.swift
    Services/
      RecordingCoordinator.swift
      TranscriptCoordinator.swift
      PermissionGate.swift
  Infrastructure/
    Capture/
      CaptureEngine.swift
      ScreenCaptureSession.swift
      SourceAudioPipeline.swift
      PCMNormalizer.swift
    Persistence/
      SessionRepository.swift
      SessionBundleLayout.swift
      SessionManifestStore.swift
      TranscriptSnapshotStore.swift
      AudioFileWriter.swift
    Platform/
      SystemSettingsOpener.swift
      AppRelaunchAdvisor.swift
  Resources/
    Assets.xcassets
    Models/
      ggml-base.en.bin

Packages/
  WhisperCppBridge/
    Package.swift
    Sources/
      WhisperCppBridge/
        WhisperContext.swift
        WhisperSourceWorker.swift
        WhisperModelLocator.swift
        WhisperBridgeTypes.swift

Vendor/
  whisper.cpp/

Scripts/
  bootstrap-whisper.sh
  build-whisper-xcframework.sh
```

### Module Ownership

- **App target code**: all SwiftUI views, view models, coordination, capture orchestration, and persistence
- **Swift package**: only `WhisperCppBridge`
- **Wrapper code**: Swift-facing wrapper over the `whisper` C API inside `Packages/WhisperCppBridge`
- **Resources**: app assets plus bundled default model
- **Runtime/model assets**: pinned model file and optional later Core ML encoder artifact

---

## 6. Dependency Order

```text
Layer 1: App scaffold + whisper bridge + session models
Layer 2: Capture engine + PCM normalization + file writing
Layer 3: Source transcription workers + transcript coordinator
Layer 4: Recording UI + permission repair + stop/save flow
Layer 5: History/detail/delete + incomplete-session surfacing
Layer 6: Performance and packaging hardening
```

### Parallelizable Groups

- Group A: app scaffold, session model definitions, and whisper bridge skeleton
- Group B: capture pipeline and session bundle persistence
- Group C: live transcript coordinator and recording UI
- Group D: history/detail/delete once session bundles exist

---

## 7. Institutional Learnings Applied

No prior institutional learnings relevant to this feature.

---

## 8. Open Questions for Validating

- [ ] Confirm the best display/filter strategy for “whole-system meeting audio” on a macOS-15-first app.
- [ ] Benchmark the first bundled model choice for two simultaneous source workers on Apple Silicon.
- [ ] Confirm whether transcript persistence should be snapshot-only or event-log-plus-snapshot for reliable incomplete-session recovery.

---

## Sanity Check Against Alternatives

### Simpler Alternative

Build a single-target app, store everything in ad hoc files, and compile `whisper.cpp` directly into the app.

Why it lost:
- simpler only on day one
- worse isolation for the highest-risk dependency
- harder to keep build settings, vendor updates, and performance flags contained

### More Ambitious Alternative

Build a multi-package app with database-backed indexing, playback, model management, and offline retranscription pipelines from the start.

Why it lost:
- front-loads features explicitly excluded by `D8`, `D9`, `D10`, `D12`, and `D22`
- creates more code before the core recording/transcription loop is proven
- adds operational complexity without helping the first believable demo

### Consistency Check

- Stack remains exactly `Swift + SwiftUI/AppKit bridges + ScreenCaptureKit + whisper.cpp`.
- The plan is explicitly greenfield and does not inherit architecture from any prior Rust or Swift app in the workspace.
- Unnecessary complexity has been removed by limiting package extraction to the native transcription boundary only.
