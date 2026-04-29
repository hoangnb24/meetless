# Approach: Meetless UI/UX Revamp

**Date**: 2026-04-24
**Feature**: `meetless-ui-ux-revamp`
**Based on**:
- `history/native-macos-meeting-recorder/ui-ux-revamp/discovery.md`
- `history/native-macos-meeting-recorder/CONTEXT.md`
- `history/native-macos-meeting-recorder/design/design.json`

---

## Gap Analysis

| Area | Have | Need | Gap Size |
|------|------|------|----------|
| Shell | Working window with segmented navigation | Persistent sidebar, sparse toolbar, white canvas, local footer | Medium |
| Record ready state | Functional Start/Stop entry point with proof content | Minimal ready state with one primary Start action and compact local status | Medium |
| Active recording | Working status and transcript UI | Timer/waveform/Stop panel plus compact transcript rows and concise warnings | Medium |
| Saved sessions | Functional browse/open/delete UI | Compact table-style rows and quiet status/count footer | Medium |
| Session detail | Functional read-only detail UI | Transcript plus metadata rail with toolbar Back/Delete | Medium |
| Behavior preservation | Mature view models and services | Visual restructuring without product-scope expansion | Low to Medium |

---

## Recommended Approach

Treat the revamp as a visual and interaction restructuring pass over the existing app. Keep `AppModel`, view models, recording services, session repository, and persistence behavior intact unless a UI integration issue forces a small adapter.

Build the shared shell first, then move the Record/Recording screen into the new shell, then convert Saved Sessions and Session Detail. This keeps every phase demonstrable and avoids mixing view composition changes with recording, persistence, whisper, or capture logic.

---

## Component Direction

Create or refactor toward these SwiftUI pieces:

- `MeetlessShellView`: sidebar, toolbar, and main canvas.
- `SidebarNavigation`: Record / Sessions / Settings-style navigation rows.
- `LocalStatusFooter`: small green dot and `Local` text.
- `MeetlessDesignTokens`: colors, spacing, typography helpers, divider styles.
- `RecordReadyView`: ready state with Start and compact local status.
- `ActiveRecordingPanel`: recording dot, elapsed timer, Stop, waveform, health strip.
- `WaveformMeterView`: restrained visual activity indicator.
- `TranscriptRowsView`: reusable timestamp/text transcript rows without primary source lane badges.
- `SessionsTableView`: compact saved-session rows.
- `SessionDetailMetadataRail`: right-side metadata column.

---

## Alternatives Considered

### Option A: Rewrite each screen independently

Rejected because it would duplicate sidebar, toolbar, spacing, row, and status decisions across screens.

### Option B: Change behavior and UI together

Rejected because the product behavior is already valuable and verified. This revamp should not reopen capture, persistence, whisper, or saved-session contracts.

### Option C: Hide all degraded/source detail entirely

Rejected because the app still needs honest permission and degraded recording signals. The correct move is to remove source lanes from primary UI while keeping concise warning states available.

---

## Risk Map

| Component | Risk | Reason | Validation Need |
|-----------|------|--------|-----------------|
| Shared shell | Medium | Changes navigation presentation and toolbar ownership | Verify screen switching, history refresh, detail open/delete |
| Record ready state | Low | Mostly visual simplification around existing Start action | Verify Start still triggers permission/recording flow |
| Active recording panel | Medium | Must hide primary source lanes without hiding real blocked/degraded states | Verify blocked, recording, stopped, transcript states |
| Saved sessions table | Medium | Must preserve browse/open/delete behavior and warning notices | Verify saved rows, delete confirmation, empty/loading/error states |
| Session detail two-column layout | Medium | Must preserve read-only transcript and metadata while dropping cards/source badges | Verify detail load, delete, metadata, transcript rows |

No high-risk behavior or data-model change is planned. Any attempt to modify recording, capture, whisper, or repository behavior should be treated as a validation concern before execution.

---

## Proposed File Structure

```text
MeetlessApp/
  App/
    MeetlessRootView.swift
    AppModel.swift
    AppScreen.swift
  Design/
    MeetlessDesignTokens.swift
    StatusDot.swift
  Components/
    MeetlessShellView.swift
    SidebarNavigation.swift
    LocalStatusFooter.swift
    TranscriptRowsView.swift
  Features/
    Home/
      HomeView.swift
      RecordReadyView.swift
    Recording/
      RecordingStatusBanner.swift
      ActiveRecordingPanel.swift
      WaveformMeterView.swift
    History/
      HistoryView.swift
      SessionsTableView.swift
    SessionDetail/
      SessionDetailView.swift
      SessionDetailMetadataRail.swift
```

Exact folders can shift to match local style during implementation, but the ownership split should stay clear: shared shell/components first, feature surfaces second.

---

## Institutional Learnings Applied

- Preserve the narrow V1 product contract: local-first recording, realtime transcript, saved sessions, read-only detail, delete, and no export/playback/edit/search/filter scope.
- Use the live repo state over old assumptions: the app now has real recording/session behavior, so this is a revamp of existing surfaces, not greenfield UI scaffolding.
- Keep Khuym phase gates strict: after this planning pass, invoke `khuym:validating` before implementation.
