# Discovery Report: Meetless UI/UX Revamp

**Date**: 2026-04-24
**Feature**: `meetless-ui-ux-revamp`
**Parent context**: `history/native-macos-meeting-recorder/CONTEXT.md`
**Design contract**: `history/native-macos-meeting-recorder/design/design.json`

---

## Institutional Learnings

`history/learnings/critical-patterns.md` does not exist in this repo.

Relevant prior project memory, rechecked against live repo state:

- The recorder behavior is real and should be preserved: record, stop, saved session listing, detail loading, delete, and local-only persistence already exist.
- The UI still carries proof-shell language and review-era helper surfaces that are now out of step with the approved target design.
- The verified automated command surface is `xcodebuild test -project Meetless.xcodeproj -scheme Meetless -destination 'platform=macOS'`.

---

## Current UI Map

| Surface | Current File(s) | What It Does Today | Design Gap |
|---------|------------------|--------------------|------------|
| App shell | `MeetlessApp/App/MeetlessRootView.swift`, `AppModel.swift`, `AppScreen.swift` | Uses a `NavigationStack`, segmented toolbar picker, gradient background, and direct view switching through `AppModel` | Target wants one coherent macOS shell with soft gray sidebar, sparse toolbar, white content canvas, and compact navigation |
| Record / Home | `MeetlessApp/Features/Home/HomeView.swift`, `HomeViewModel.swift` | Shows a large proof card, long implementation copy, smoke transcription UI, shell highlights, and direct buttons to history/detail | Target wants a centered ready state, one Start action, quiet local status, and no proof/debug surfaces in the primary UI |
| Active Recording | `RecordingStatusBanner.swift`, `RecordingViewModel.swift` | Shows a large status banner, source status cards, `Meeting`/`Me` labels, latest event text, and transcript cards | Target wants recording dot, timer, Stop, waveform/audio activity, compact health strip, and transcript rows without primary source lanes |
| Saved Sessions | `HistoryView.swift`, `HistoryViewModel.swift` | Shows large cards, honesty copy, row contract copy, and row cards with preview blocks | Target wants compact saved-session table/list with rows, hairline separators, status, detail, delete, count, and local footer |
| Session Detail | `SessionDetailView.swift` | Shows transcript, metadata, saved notices, and source health as stacked cards; transcript rows expose source labels | Target wants Back/Delete toolbar actions, transcript on the left, metadata rail on the right, compact notices, and no playback/editing/source-lane cards |

---

## Target Design Interpretation

The approved design is a compact native macOS utility. It should feel like a daily-use recorder, not a product demo or architecture proof.

Practical design rules from `design.json` and `target-ui-design.png`:

- One persistent shell across Record, active Recording, Saved Sessions, and Session Detail.
- Soft gray sidebar, white main canvas, compact toolbar, hairline separators.
- Short labels and sparse helper text.
- Recording health appears through state dots, timer, waveform, concise labels, and warnings only when needed.
- Keep the local-first trust signal visible but quiet.
- Preserve the two-source recording model underneath, but do not expose `Meeting` / `Me` source lanes in the primary UI.
- No export, sharing, playback, transcript editing, search, filters, or marketing-style content.

---

## Existing Behavior To Preserve

- `AppModel` owns screen selection, saved-session selection, history refresh, and delete coordination.
- `RecordingViewModel` owns Start/Stop, blocked permission state, active recording polling, transcript chunks, repair actions, and smoke transcription internals.
- `HistoryViewModel` maps saved session summaries into row data with title, date, duration, preview, status, and warning notices.
- `SessionDetailViewModel` maps persisted detail into metadata items and read-only transcript rows.
- `SessionRepository` and capture/transcription services are out of scope unless UI integration exposes a genuine behavior bug.

---

## Discovery Constraints

`gkg` was not reachable for this session and Swift coverage is limited for this repo, so discovery used direct file inspection with `rg`, `find`, and `sed`.

The app already has a test target and the project lists `Meetless` and `MeetlessTests`, though `xcodebuild -list` emitted sandbox-local simulator/cache warnings before completing.

---

## Recommended Planning Shape

This should be a UI-only revamp with three phases:

1. Give the app one coherent shell.
2. Make Record and active Recording match the approved target.
3. Make Saved Sessions and Session Detail compact and scan-friendly.

Phase 1 must come first because every later screen depends on the shared shell, spacing, navigation, and toolbar decisions. Changing individual screens before the shell would create duplicated layout work and make visual consistency harder to verify.
