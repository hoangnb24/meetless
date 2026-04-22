# Phase Plan: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**Based on**:
- `history/native-macos-meeting-recorder/CONTEXT.md`
- `history/native-macos-meeting-recorder/discovery.md`
- `history/native-macos-meeting-recorder/approach.md`

---

## 1. Feature Summary

This feature builds a brand-new native macOS app that can record whole-system meeting audio plus the user’s microphone, show a live local transcript during recording, and save each session locally so it later appears in history and opens in a detail view. The work is phased because there are two different kinds of progress we need to make: first we have to prove the hard local recording and transcription loop, and then we have to turn that raw capability into a dependable saved-session product. The final phase is about hardening the app so the first two phases feel stable on real Macs instead of only working as a lab demo.

---

## 2. Why This Breakdown

- Phase 1 must happen first because nothing else matters until one recording can actually start, produce labeled live transcript chunks, and save its raw session locally.
- History, detail, delete, and incomplete-session recovery are intentionally separate because they become much simpler once the session bundle shape exists.
- Packaging polish, degraded-state UX, and Apple-Silicon tuning stay later because they are important, but they should improve a real loop rather than guess at one.

---

## 3. Phase Overview Table

| Phase | What Changes In Real Life | Why This Phase Exists Now | Demo Walkthrough | Unlocks Next |
|-------|----------------------------|---------------------------|------------------|--------------|
| Phase 1: First Live Recording Loop | A user can press Record, grant permissions if needed, see `Meeting` and `Me` transcript chunks appear, stop the session, and leave behind a saved local session bundle | This is the product’s core truth; without it, history and detail views have nothing real to show | Start recording, speak into the mic while system audio plays, watch labeled chunks appear, stop, verify saved files | Saved-session UI and recovery work |
| Phase 2: Saved Sessions Feel Like a Product | Prior sessions appear in history, open into detail, show transcript plus metadata, and can be deleted; incomplete sessions surface visibly | Once session bundles are real, we can turn them into the browse-and-open product surface the user asked for | Record twice, reopen both from history, inspect detail, delete one, verify incomplete session handling | Release hardening and polish |
| Phase 3: Real-Mac Hardening | The app handles permission repair, degraded-source warnings, packaging details, and Apple-Silicon performance well enough to feel dependable | This phase makes the proven product loop usable outside the happy path | Start from a cold machine state, repair permissions, record under a degraded source scenario, and confirm the app still behaves predictably | Validation/review toward ship readiness |

---

## 4. Phase Details

### Phase 1: First Live Recording Loop

- **What Changes In Real Life**: the app can perform one complete local recording session from start to stop, with live source-labeled transcript updates and durable raw audio saved under a session id.
- **Why This Phase Exists Now**: it proves the hardest integration seam in the whole feature: ScreenCaptureKit capture, `whisper.cpp` integration, live transcript flow, and local save behavior all working together.
- **Stories Inside This Phase**:
  - Story 1: App shell and native transcription boundary — the app boots, loads a bundled model through the isolated `whisper.cpp` bridge, and can prove local transcription from inside the macOS app process.
  - Story 2: Dual-source recording pipeline — the app starts one recording session and turns system audio plus microphone input into independent normalized source streams.
  - Story 3: Live transcript and session save — those source streams produce `Meeting` and `Me` transcript chunks during recording, and stop/save leaves behind a usable local session bundle.
- **Demo Walkthrough**: Launch the app, press Record, grant missing permissions, let meeting audio play while speaking into the microphone, watch labeled chunks appear on screen within a short delay, press Stop, and confirm the session folder now contains metadata, transcript snapshot, and one durable audio file per source.
- **Unlocks Next**: history, session detail, deletion, and incomplete-session surfacing can now be built against real saved session data instead of mocks.

### Phase 2: Saved Sessions Feel Like a Product

- **What Changes In Real Life**: the user can leave the live recording screen and still treat past meetings as real saved items: browse them, open them, inspect transcript plus metadata, and delete them.
- **Why This Phase Exists Now**: phase 1 creates the raw session artifact; phase 2 turns that artifact into the actual product surface promised in the success criteria.
- **Stories Inside This Phase**:
  - Story 1: History list from local sessions — the app discovers saved session bundles and presents them as a simple scan-friendly history list.
  - Story 2: Session detail from persisted snapshot — opening a session shows the read-only transcript and related metadata that were saved during recording.
  - Story 3: Incomplete and delete flows — incomplete sessions are surfaced clearly and sessions can be removed from history and local storage.
- **Demo Walkthrough**: Record a completed session and an interrupted one, relaunch the app, verify both appear in history with appropriate status, open each detail view, and delete one from the list while the other remains intact.
- **Unlocks Next**: hardening work can focus on behavior quality instead of missing core product surfaces.

### Phase 3: Real-Mac Hardening

- **What Changes In Real Life**: the app behaves well when permissions are missing, when one audio source fails, and when Apple-Silicon performance or packaging details matter.
- **Why This Phase Exists Now**: these are essential quality steps, but they are only valuable once the basic recording and saved-session flows already exist.
- **Stories Inside This Phase**:
  - Story 1: Permission repair feels intentional — blocked recording states guide the user to System Settings and explain what has to happen next.
  - Story 2: Degraded recording remains honest and usable — if one source fails, the app continues with the surviving source and makes that state visible.
  - Story 3: Packaging and performance close the gap to a shippable v1 — model bundling, bridge build reproducibility, and Apple-Silicon tuning are tightened up.
- **Demo Walkthrough**: Start from a machine with missing permissions, walk through repair, then run a recording where one source is unavailable and confirm the session still saves correctly with clear degraded status and acceptable live responsiveness.
- **Unlocks Next**: validation, review, and a realistic path toward shipping the first version.

---

## 5. Phase Order Check

- [x] Phase 1 is obviously first
- [x] Each later phase depends on or benefits from the one before it
- [x] No phase is just a technical bucket with no user/system meaning

---

## 6. Approval Summary

- **Current phase to prepare next**: `Phase 1 - First Live Recording Loop`
- **What the user should picture after that phase**: one complete recording can happen locally inside the new macOS app, with live `Meeting` and `Me` transcript chunks and a saved session bundle on disk.
- **What will not happen until later phases**: polished history/detail browsing, deletion/incomplete recovery UX, and the full permission/degraded-state hardening still wait until later phases.
