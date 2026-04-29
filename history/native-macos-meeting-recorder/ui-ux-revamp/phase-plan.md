# Phase Plan: Meetless UI/UX Revamp

**Date**: 2026-04-24
**Feature**: `meetless-ui-ux-revamp`
**Design Contract**: `history/native-macos-meeting-recorder/design/design.json`

---

## Feature Summary

Meetless already has the core local-first recording and saved-session behavior. This revamp changes how the app feels in daily use: compact, calm, native, and focused around the approved target design.

The work is split so the shared shell lands first, then the recording surfaces move into it, then saved-session browsing and detail reading are tightened. That order keeps behavior stable while the UI changes around it.

---

## Phase Overview

| Phase | What Changes In Real Life | Why This Phase Exists Now | Demo Walkthrough | Unlocks Next |
|-------|----------------------------|---------------------------|------------------|--------------|
| Phase 1: One Coherent App Shell | The app stops feeling like separate proof screens and starts feeling like one native macOS utility | Every screen needs the same sidebar, toolbar, local status, canvas, spacing, and selection language before individual views are polished | Launch the app, switch between Record and Sessions from the sidebar, open detail, and see the same shell hold every surface | Record/Recording views can be rebuilt against stable layout primitives |
| Phase 2: Record And Recording Become Compact | Ready and active recording states match the approved target: Start, timer, Stop, waveform, transcript rows, concise status | These are the most important daily-use moments, and they benefit directly from the shell | Press Start, see the active recording panel, watch transcript rows appear, press Stop, and return to ready state | Saved-session surfaces can reuse transcript rows and status primitives |
| Phase 3: Saved Sessions And Detail Become Scan-Friendly | Saved sessions become a compact table/list and detail becomes transcript plus metadata rail | Once the shared components exist, history/detail can become faster to scan without changing repository behavior | Browse sessions, open one, read transcript, inspect metadata, delete one, and stay inside the same compact shell | Validation and review can focus on visual completeness and behavior preservation |

---

## Phase Details

### Phase 1: One Coherent App Shell

- **What Changes**: all current views sit in the approved shell: soft gray sidebar, sparse toolbar, white main canvas, hairline separators, compact navigation rows, and quiet local footer.
- **Stories**:
  - Story 1: Route navigation through the sidebar shell.
  - Story 2: Add shared visual primitives.
  - Story 3: Fit existing views inside the shell without behavior drift.
- **Demo**: a user can launch Meetless, switch Record/Sessions from the sidebar, open a detail view, go back, and never see the segmented proof toolbar or gradient shell.
- **Status**: approved for current-phase preparation.

### Phase 2: Record And Recording Become Compact

- **What Changes**: the home screen becomes a ready state and the active recording screen becomes a compact control panel with timer, waveform, Stop, health strip, and transcript rows.
- **Stories**:
  - Story 1: Make Record Ready Quiet.
  - Story 2: Add Compact Recording Readouts.
  - Story 3: Replace The Large Recording Banner.
- **Demo**: a user starts recording from the ready state, sees clear recording health without source-lane cards, then stops and returns to a calm ready state.

### Phase 3: Saved Sessions And Detail Become Scan-Friendly

- **What Changes**: history becomes a compact session list and detail becomes a reading surface with transcript rows and a metadata rail.
- **Stories**:
  - Story 1: Make Saved Sessions A Compact List.
  - Story 2: Make Detail A Reading View.
  - Story 3: Keep Saved Warnings Quiet And Honest.
- **Demo**: a user can scan saved meetings, open one, read the transcript and metadata, delete it if needed, and never encounter playback/export/edit/search/filter UI.

---

## Order Check

- [x] Phase 1 is first because it defines the shared shell every other view uses.
- [x] Phase 2 follows because Record/Recording is the primary daily-use flow.
- [x] Phase 3 follows because history/detail can reuse shell, row, transcript, and status primitives from earlier phases.
- [x] No phase changes recording, capture, whisper, persistence, export, playback, editing, search, or filters.

---

## Current Phase To Prepare

Phase 1 and Phase 2 are complete. Prepare `Phase 3 - Saved Sessions And Detail Become Scan-Friendly` for `khuym:validating`.
