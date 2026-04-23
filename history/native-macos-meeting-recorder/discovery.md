# Discovery Report: Native macOS Meeting Recorder

**Date**: 2026-04-23
**Feature**: `native-macos-meeting-recorder`
**CONTEXT.md reference**: `history/native-macos-meeting-recorder/CONTEXT.md`
**Planning refresh**: after Phase 2 execution, for Phase 3 preparation

---

## Institutional Learnings

> Read during Phase 0 from `history/learnings/`

### Critical Patterns (Always Applied)

- None applicable. `history/learnings/critical-patterns.md` does not exist in this repo.

### Domain-Specific Learnings

No prior learnings for this domain.

---

## Agent A: Architecture Snapshot

> Source: `node .codex/khuym_status.mjs --json`, `gkg` repo topology, bead graph inspection, and local file inspection

`gkg` is reachable and indexed for this repo, but Swift definition coverage is still limited in this session. Discovery therefore used `gkg` for the repo-level read and local file inspection for the concrete Phase 3 seams.

### Relevant Packages / Modules

| Package / Module | Purpose | Key Files |
|------------------|---------|-----------|
| App shell | Owns screen selection, selected saved session state, and cross-screen refresh/delete coordination | `MeetlessApp/App/AppModel.swift`, `MeetlessApp/App/MeetlessRootView.swift` |
| Recording coordination | Owns the live recording state machine, transcript coordination, live status banner data, and stop/finalize behavior | `MeetlessApp/Features/Recording/RecordingViewModel.swift`, `MeetlessApp/Features/Recording/RecordingStatusBanner.swift` |
| Saved-session product surfaces | Consume persisted metadata and warning notices in history and detail | `MeetlessApp/Features/History/HistoryView.swift`, `MeetlessApp/Features/History/HistoryViewModel.swift`, `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` |
| Persistence boundary | Owns bundle manifests, transcript snapshots, read/list/load/delete APIs, and saved-session notice derivation | `MeetlessApp/Services/SessionRepository/SessionRepository.swift` |
| Capture + platform privacy seam | Owns artifact scratch paths, capture lifecycle logs, and the runtime storage/privacy story | `MeetlessApp/Services/Capture/ScreenCaptureSession.swift`, `MeetlessApp/Services/AudioPipeline/SourceAudioPipeline.swift` |
| Project/runtime packaging | Owns signing, entitlements, and the absence or presence of XCTest targets | `Meetless.xcodeproj/project.pbxproj` |

### Current Product State

- The repo now contains a buildable Phase 2 product slice: the app can record, save local session bundles, browse history, open read-only session detail, and delete saved sessions.
- The saved-session warning surfaces already exist in both History and Session Detail. `PersistedSessionSummary` and `PersistedSessionDetail` already derive `SavedSessionNotice` values from saved status and source statuses.
- The live recording surface already has a degraded-state visual language through `RecordingStatusBanner` and `SourcePipelineStatus`.
- The remaining open work is concentrated in five review beads, all of which line up with Phase 3 hardening rather than a missing product feature:
  - `bd-2ap`
  - `bd-15x`
  - `bd-3sy`
  - `bd-2w7`
  - `bd-1ov`

### Most Important Phase 3 Seams

```text
Story 1 seam
  RecordingViewModel.swift
    -> retry exhaustion and snapshot-write handling
    -> SessionRepository manifest / snapshot persistence
    -> existing saved-session notice surfaces

Story 2 seam
  Meetless.xcodeproj/project.pbxproj
    -> add XCTest target and working `xcodebuild test` path
  MeetlessTests/
    -> focused pure-Swift regression coverage

Story 3 seam
  Meetless.xcodeproj/project.pbxproj
    -> signing + sandbox settings
  MeetlessApp/... Logger calls
    -> redact full artifact paths from public logs
```

The high-value reality check is that Phase 3 does not need a new user flow. It needs the existing recording and saved-session flow to become more honest, more testable, and more privacy-aligned.

---

## Agent B: Pattern Search

> Source: local file inspection

### Existing Patterns To Reuse

| Area | Existing Pattern | Why It Matters For Phase 3 |
|------|------------------|----------------------------|
| Live source health | `SourcePipelineStatus` already models `.ready`, `.monitoring`, `.blocked`, and `.degraded` | The transcript-lane retry-exhaustion fix should reuse this instead of inventing a second live health model |
| Saved-session honesty | `SavedSessionNoticeFactory` already converts saved status and source statuses into warning/info notices | Saved-session hardening should feed this path instead of building a new warning surface |
| File IO ownership | `SessionRepository` remains the single manifest/snapshot boundary | Snapshot-write failure and saved metadata honesty should stay here |
| UI warning surfaces | History, Session Detail, and the recording banner already render warning cards/badges | Phase 3 should deepen those existing surfaces, not redesign them |
| Logging infrastructure | The app already uses `Logger` with stable categories | Privacy work can be a targeted redaction pass rather than a logging rewrite |

### Missing Patterns That Phase 3 Must Add

- No persisted honest marker yet when a transcript lane gives up after retry exhaustion.
- No visible persisted marker yet when `transcript.json` refresh fails during recording.
- No test target or working `xcodebuild test` path.
- No explicit entitlements file and no effective sandbox enforcement because code signing is disabled.
- Public logs still expose full artifact directory paths and session-local storage details.

### Practical Bead-Shaping Constraint

Several remaining tasks touch the same high-conflict files:

- `MeetlessApp/Features/Recording/RecordingViewModel.swift`
- `MeetlessApp/Services/SessionRepository/SessionRepository.swift`
- `Meetless.xcodeproj/project.pbxproj`

That makes the open review beads poor candidates for fully parallel execution. Planning should expose a mostly serial dependency chain so workers do not fight over the same state and project files.

---

## Agent C: Constraints Analysis

> Source: locked decisions, current code, `xcodebuild -list`, project settings, and open bead graph

### Locked Product Constraints That Matter Most In Phase 3

| Decision | Meaning For Phase 3 |
|----------|---------------------|
| `D15` | If one source becomes unreliable, the app keeps the surviving work alive but must clearly surface degraded state |
| `D23` | The saved transcript must still be the exact snapshot visible during recording, even when it is partial or imperfect |
| `D11` | Raw audio stays the durable source of record, so persistence honesty matters when transcript saving degrades |
| `D10` | Saved sessions are local-only, which raises the importance of real sandbox/privacy alignment |
| `D3` / `D8` | Hardening should not drift into transcript editing or playback UI while fixing trust gaps |

### Concrete Technical Constraints

| Constraint | Evidence | Planning Impact |
|-----------|----------|-----------------|
| No automated test target exists yet | `xcodebuild -list -project Meetless.xcodeproj` shows only the `Meetless` target and scheme | Story 2 needs real project-file work, not just test code |
| App Sandbox is enabled but code signing is disabled | `Meetless.xcodeproj/project.pbxproj` sets `ENABLE_APP_SANDBOX = YES` and `CODE_SIGNING_ALLOWED = NO` in Debug and Release | Story 3 must treat signing/entitlements as a real configuration fix, not documentation only |
| Public logs still expose artifact directory paths | `ScreenCaptureSession.swift` and `RecordingViewModel.swift` log `artifactDirectoryURL.path` with `privacy: .public` | Privacy hardening is still visibly incomplete |
| Saved-session notice surfaces already exist | History and Session Detail render `SavedSessionNotice` warnings today | Story 1 should feed the current notice path instead of rebuilding UI |

### Open Review Follow-Ups That Define Phase 3

| Bead | What It Means In Planning Terms |
|------|--------------------------------|
| `bd-2ap` | Honest source-lane degradation must survive retry exhaustion |
| `bd-15x` | Honest transcript snapshot persistence failures must survive disk-write problems |
| `bd-3sy` | The most fragile recording/persistence invariants need executable regression coverage |
| `bd-2w7` | The local-first privacy story needs actual signed sandbox settings, not just build flags |
| `bd-1ov` | Logs should remain useful without exposing full local artifact paths |

---

## Agent D: External Research

> Source: none required beyond the current repo state and project settings

No new upstream library or platform research was required for this planning refresh. The Phase 3 work is about hardening the app that already exists in this repo.

---

## Open Questions

> Items that discovery surfaced for synthesis to resolve.

- [ ] Should Story 1 express the two honesty gaps through one expanded persisted-notice path or separate metadata fields that are both later converted into notices?
- [ ] Which focused pure-Swift seams are the highest-value first tests: transcript coordination, session repository manifests, or stop/finalize state transitions?
- [ ] What is the lightest credible entitlements setup for this repo so sandbox verification is real without expanding the app’s product scope?
- [ ] How should public logs keep enough identifiers for debugging once artifact paths are redacted?

---

## Summary for Synthesis (Phase 3 Input)

**What we have**: a buildable Phase 2 app with real recording, local bundle persistence, saved-session browse/open/delete, and existing warning surfaces.

**What we need**: a hardening pass that closes the two remaining saved-session honesty gaps, adds automated regression coverage, and aligns signing/logging defaults with the product’s local-first privacy promise.

**High-signal reality checks**:

- Phase 3 is review-driven, not product-surface-driven.
- The remaining work clusters around shared files, so the bead graph should show deliberate ordering.
- The existing warning surfaces are already good enough; the real work is feeding them honest state.
- `project.pbxproj` is now a first-class Phase 3 file because both tests and signing depend on it.
