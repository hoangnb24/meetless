# Discovery Report: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**CONTEXT.md reference**: `history/native-macos-meeting-recorder/CONTEXT.md`
**Planning refresh**: after Phase 1 execution and review completion

---

## Institutional Learnings

> Read during Phase 0 from `history/learnings/`

### Critical Patterns (Always Applied)

- None applicable. `history/learnings/critical-patterns.md` does not exist in this repo.

### Domain-Specific Learnings

No prior learnings for this domain.

---

## Agent A: Architecture Snapshot

> Source: `node .codex/khuym_status.mjs --json`, `gkg` repo topology, and local file inspection

`gkg` is now available for this repo and was useful for confirming the current app topology, but Swift definition coverage is still limited in this session. Discovery therefore used `gkg` for the high-level map and local file inspection for the concrete Phase 2 seams.

### Relevant Packages / Modules

| Package / Module | Purpose | Key Files |
|------------------|---------|-----------|
| App shell | Owns the window, current screen, and top-level model wiring | `MeetlessApp/App/MeetlessRootView.swift`, `MeetlessApp/App/AppModel.swift`, `MeetlessApp/App/AppScreen.swift` |
| Home + recording surface | Exposes the Phase 1 recorder and current status banner | `MeetlessApp/Features/Home/HomeView.swift`, `MeetlessApp/Features/Recording/RecordingViewModel.swift`, `MeetlessApp/Features/Recording/RecordingStatusBanner.swift` |
| Session persistence | Writes `session.json`, `transcript.json`, and per-source audio artifacts | `MeetlessApp/Services/SessionRepository/SessionRepository.swift`, `MeetlessApp/Services/AudioPipeline/SourceAudioPipeline.swift` |
| History shell | Placeholder browse screen with the final row contract already spelled out | `MeetlessApp/Features/History/HistoryView.swift`, `MeetlessApp/Features/History/HistoryViewModel.swift` |
| Session detail shell | Placeholder transcript-plus-metadata destination | `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` |

### Current Product State

- The repo is no longer greenfield. It now contains a buildable macOS app, a working recording flow, on-demand permission repair, transcript coordination, and durable session bundles.
- The app shell already has three destinations: Home, History, and Session Detail.
- `AppModel` currently owns only the selected screen and the Phase 1 `RecordingViewModel`. It does not yet track a selected saved session or coordinate list/detail refresh.
- `SessionRepository` is currently write-side only. It can begin, update, and finalize a bundle, but it does not yet expose read/list/load/delete APIs for saved sessions.
- History and detail are still honest shells. They were intentionally left thin so Phase 2 can attach real persisted-session behavior without rewriting the window structure.

### Most Important Phase 2 Seam

The saved-session product surface should attach to the existing session bundle contract instead of redefining storage:

```text
Application Support/Meetless/Sessions/{session-id}/
  session.json
  transcript.json
  meeting.wav
  me.wav
```

That means Phase 2 is primarily a read-side, navigation-state, and deletion pass over an existing persistence shape rather than a new storage design.

---

## Agent B: Pattern Search

> Source: local file inspection

### Existing Patterns To Reuse

| Area | Existing Pattern | Why It Matters For Phase 2 |
|------|------------------|----------------------------|
| Top-level state ownership | `AppModel` is the single window-level owner of navigation state and screen-scoped models | Saved-session selection should stay here instead of creating a second root coordinator |
| File IO boundary | `SessionRepository` is an actor and already owns session-bundle encoding and disk writes | Read/list/delete behavior should stay behind the same actor boundary |
| Persistence contract | `SessionRepository` writes timestamp titles, incomplete/completed status, transcript preview, source statuses, and transcript snapshots | History and detail should decode and display this shape directly |
| UI style | Lightweight SwiftUI screens with thin view models and no database layer | Phase 2 should stay browse-only and not overbuild data infrastructure |

### Missing Patterns That Phase 2 Must Add

- No public read model for session manifests or transcript snapshots
- No selected-session state in the app shell
- No history refresh lifecycle after the app launches or after a recording stops
- No delete flow
- No UI surface yet for incomplete or degraded saved-session honesty markers

### Reuse Boundary

Phase 2 should reuse:

- the existing session bundle format
- the existing single-window navigation shell
- the current `RecordingViewModel` as the source of new saved bundles

Phase 2 should not introduce:

- search or filters
- playback controls
- transcript editing
- export or sharing
- a database or sync layer

---

## Agent C: Constraints Analysis

> Source: current code, open bead graph, and locked decisions

### Locked Product Constraints That Matter Most In Phase 2

| Decision | Meaning For Phase 2 |
|----------|---------------------|
| `D3` | Session detail stays read-only; do not add transcript editing |
| `D4` | History rows must stay simple: title, date/time, duration, transcript preview |
| `D5` | Incomplete sessions must be visible rather than disappearing |
| `D8` | Session detail is transcript plus metadata only; no playback UI |
| `D9` | History stays browse-only; no search or filters |
| `D10` | Saved sessions remain local-only |
| `D19` | Delete from history/local storage is required in v1 |
| `D23` | Saved detail shows the exact live transcript snapshot that was committed during recording |

### Open Review Follow-Ups That Touch Phase 2

| Bead | Why It Matters |
|------|----------------|
| `bd-2ap` | Saved sessions should eventually surface when one transcript lane became partial after retry exhaustion |
| `bd-15x` | Saved sessions should eventually surface when transcript snapshot persistence degraded during recording |
| `bd-3sy` | Automated regression coverage is still missing but does not block planning the product shape |
| `bd-2w7` | Signing/sandbox hardening is still open but does not change the Phase 2 user flow |
| `bd-1ov` | Log redaction is important later but not a Phase 2 interaction design driver |

### Practical Constraint

Phase 2 should not invent new saved-session certainty. If degraded transcript coverage or snapshot-write failure metadata is present, history/detail should surface it. If that metadata is not present yet, the Phase 2 structure should leave room for it rather than hard-coding a falsely clean story.

---

## Agent D: External Research

> Source: none required beyond the current repo and previously validated Phase 1 decisions

No new external-library or platform research was required for this Phase 2 planning refresh. The remaining work is primarily about reading, presenting, and deleting the session bundles already proven in Phase 1.

---

## Open Questions

> Items that discovery surfaced for synthesis to resolve.

- [ ] Should the public read-side model live directly in `SessionRepository`, or should the app introduce a second saved-session store on top of it?
- [ ] Where should the selected saved session live so Home, History, and Detail stay coordinated without overbuilding navigation?
- [ ] How should Phase 2 consume future degraded-session honesty markers from `bd-2ap` and `bd-15x` without duplicating their write-side logic?
- [ ] What is the lightest refresh strategy so new recordings appear in history without adding a background watcher?

---

## Summary for Synthesis (Phase 2 Input)

**What we have**: a real Phase 1 recorder that writes durable local session bundles and already owns the app shell, permission repair, and transcript snapshot contract.

**What we need**: a read-side and UI pass that turns those bundles into a browseable history list, a real transcript-plus-metadata detail screen, and a delete flow that keeps incomplete or degraded saved-session state honest.

**High-signal reality checks**:

- The app structure is already in place; Phase 2 should deepen it rather than re-architect it.
- `SessionRepository` is the natural place to keep file IO ownership.
- The biggest missing seam is selected-session and read-model state, not capture or transcription.
- The current review follow-ups around degraded transcript honesty should be treated as real dependencies for the final saved-session experience instead of hand-waved away.
