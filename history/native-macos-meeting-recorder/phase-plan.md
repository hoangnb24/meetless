# Phase Plan: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**Based on**:
- `history/native-macos-meeting-recorder/CONTEXT.md`
- `history/native-macos-meeting-recorder/discovery.md`
- `history/native-macos-meeting-recorder/approach.md`

---

## 1. Feature Summary

This feature builds a brand-new native macOS app that records whole-system meeting audio plus the user’s microphone, shows a live local transcript during recording, and saves each session locally so it later appears in history and opens in a detail view. The work is phased because the product has three very different moments of truth: first the local capture/transcription loop has to be real, then saved sessions have to feel usable after the meeting ends, and finally the app has to become trustworthy enough to run outside a happy-path demo.

Phase 1 is now complete and reviewed. The next planning step is to turn those real saved bundles into a browseable saved-session product without reopening the already-proven recording architecture.

---

## 2. Why This Breakdown

- Phase 1 had to happen first because nothing else matters until one recording can actually start, produce labeled live transcript chunks, and save real local artifacts.
- Phase 2 is separate because a saved session only becomes a product when the user can browse it, reopen it, inspect it, and delete it.
- Phase 3 stays later because tests, signing, privacy/logging cleanup, and remaining hardening work are most valuable after the first two user-facing loops are already real.

---

## 3. Phase Overview Table

| Phase | What Changes In Real Life | Why This Phase Exists Now | Demo Walkthrough | Unlocks Next |
|-------|----------------------------|---------------------------|------------------|--------------|
| Phase 1: First Live Recording Loop | A user can press Record, grant permissions if needed, see `Meeting` and `Me` transcript chunks appear, stop the session, and leave behind a saved local session bundle | This is the product’s core truth; without it, history and detail views have nothing real to show | Start recording, speak into the mic while system audio plays, watch labeled chunks appear, stop, verify saved files | Saved-session UI and recovery work |
| Phase 2: Saved Sessions Feel Like a Product | Prior sessions appear in history, open into detail, show transcript plus metadata, and can be deleted; incomplete sessions are visible and the UI is ready to surface saved-session honesty markers | Once session bundles are real, we can turn them into the browse-and-open product surface the user asked for | Record twice, reopen both from history, inspect detail, delete one, verify incomplete-session presentation | Hardening and ship-readiness work |
| Phase 3: Hardening and Release Trust | The app has regression coverage, honest saved-session warning surfacing, enforced signing/sandbox behavior, and cleaner privacy/logging defaults | This phase makes the first two slices dependable enough to iterate and ship on real Macs | Run tests, verify signed sandboxed behavior, confirm saved-session warnings are honest, and inspect logs for privacy-safe identifiers | Final validation, review, and release readiness |

---

## 4. Phase Details

### Phase 1: First Live Recording Loop

- **What Changes In Real Life**: the app can perform one complete local recording session from start to stop, with live source-labeled transcript updates and durable raw audio saved under a session id.
- **Why This Phase Exists Now**: it proves the hardest integration seam in the whole feature: ScreenCaptureKit capture, `whisper.cpp` integration, live transcript flow, and local save behavior all working together.
- **Stories Inside This Phase**:
  - Story 1: App shell and native transcription boundary
  - Story 2: Dual-source recording pipeline
  - Story 3: Live transcript and session save
- **Demo Walkthrough**: Launch the app, press Record, grant missing permissions, let meeting audio play while speaking into the microphone, watch labeled chunks appear on screen within a short delay, press Stop, and confirm the session folder now contains metadata, transcript snapshot, and one durable audio file per source.
- **Unlocks Next**: history, session detail, deletion, and incomplete-session surfacing can now be built against real saved session data instead of mocks.
- **Status**: complete and review-cleared

### Phase 2: Saved Sessions Feel Like a Product

- **What Changes In Real Life**: the user can leave the live recording screen and still treat past meetings as real saved items: browse them, open them, inspect transcript plus metadata, and delete them.
- **Why This Phase Exists Now**: Phase 1 already creates the raw session artifact. Phase 2 turns that artifact into the actual saved-session product surface promised in the success criteria.
- **Stories Inside This Phase**:
  - Story 1: History list from local sessions
  - Story 2: Session detail from persisted snapshot
  - Story 3: Delete and saved-session honesty presentation
- **Demo Walkthrough**: Record a completed session and an interrupted one, relaunch the app, verify both appear in history with appropriate status, open each detail view, and delete one from the list while the other remains intact.
- **Unlocks Next**: hardening work can focus on quality, trust, and verification instead of missing core product surfaces.

### Phase 3: Hardening and Release Trust

- **What Changes In Real Life**: the app has the guardrails and operational trust needed for repeated use on real Macs instead of only manual happy-path demos.
- **Why This Phase Exists Now**: these are critical quality steps, but they are only valuable after the core recording loop and saved-session loop already exist.
- **Stories Inside This Phase**:
  - Story 1: Regression coverage protects the core loop
  - Story 2: Signing, sandboxing, and privacy defaults match the local-first promise
  - Story 3: Remaining degraded-state and performance hardening closes the trust gap
- **Demo Walkthrough**: Run the automated test path, verify signed/sandboxed storage behavior, confirm privacy-safe logs, and exercise degraded-session handling without losing saved-session honesty.
- **Unlocks Next**: final validation, review, and a realistic path toward shipping the first version.

---

## 5. Phase Order Check

- [x] Phase 1 is obviously first
- [x] Each later phase depends on or benefits from the one before it
- [x] No phase is just a technical bucket with no user/system meaning

---

## 6. Approval Summary

- **Current phase to prepare next**: `Phase 2 - Saved Sessions Feel Like a Product`
- **What the user should picture after that phase**: previously recorded meetings show up as real saved sessions that can be browsed, opened into transcript-plus-metadata detail, and deleted locally.
- **What will not happen until later phases**: test coverage, signing/sandbox enforcement, log/privacy cleanup, and remaining hardening work still wait for Phase 3.
