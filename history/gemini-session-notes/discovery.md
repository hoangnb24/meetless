# Discovery Report: Gemini Session Notes

**Date:** 2026-05-01
**Feature:** `gemini-session-notes`
**CONTEXT.md:** `history/gemini-session-notes/CONTEXT.md`

## Institutional Learnings

- Critical pattern: shell/shared-surface changes should land before individual screen polish because SwiftUI navigation, toolbar, and feature views share ownership boundaries.
- Critical pattern: generated and persisted user-facing copy must not leak internal `Meeting` / `Me` source labels. Audit buttons, banners, notes panels, warnings, and persisted display text.
- Domain learning: saved sessions treat audio as the durable source of record and transcript as a derived view. Gemini notes should fit that model rather than replacing the local transcript snapshot.

## Architecture Snapshot

| Area | Purpose | Key Files |
|---|---|---|
| App shell | Owns screen routing, sidebar navigation, toolbar, and top-level view-model wiring. | `MeetlessApp/App/AppModel.swift`, `MeetlessApp/App/AppScreen.swift`, `MeetlessApp/App/MeetlessRootView.swift` |
| Saved sessions | Lists saved bundles and opens selected details. | `MeetlessApp/Features/History/HistoryView.swift`, `MeetlessApp/Features/History/HistoryViewModel.swift` |
| Session detail | Shows selected session transcript, metadata, notices, source health, delete action, and will own the visible Generate and notes experience. | `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` |
| Session storage | Creates, loads, finalizes, deletes, resolves audio artifacts, and persists generated notes inside local bundles. | `MeetlessApp/Services/SessionRepository/SessionRepository.swift` |
| Gemini key storage | Stores the user's Gemini API key behind a Keychain-backed, injectable seam. | `MeetlessApp/Services/GeminiAPIKeyStore/GeminiAPIKeyStore.swift`, `MeetlessTests/GeminiAPIKeyStoreTests.swift` |
| Gemini notes service | Uploads both saved audio files, requests structured output, parses generated notes, and saves only after full success. | `MeetlessApp/Services/GeminiSessionNotes/GeminiSessionNotesClient.swift`, `MeetlessTests/GeminiSessionNotesClientTests.swift` |
| Tests | Current unit tests cover repository persistence, API key storage, Gemini request building, parsing, and orchestration failure rollback. | `MeetlessTests/SessionRepositoryTests.swift`, `MeetlessTests/GeminiSessionNotesClientTests.swift`, `MeetlessTests/TestSupport.swift` |

Entry points:

- User starts from `Sessions`, opens a row with `AppModel.openSessionDetail(for:)`, then `SessionDetailView` displays the detail view model.
- `SessionDetailView` currently has `Back` and `Delete`; Phase 3 adds `Generate`, confirmation, progress, retryable errors, and persisted notes display.
- `AppModel` currently owns `SessionRepository`, `HistoryViewModel`, and `SessionDetailViewModel`. Phase 3 should add the Gemini key/settings state and notes orchestration at this app boundary rather than inside SwiftUI views.

Model after:

- `SessionRepository` remains the bundle authority.
- `KeychainGeminiAPIKeyStore` remains the secret authority.
- `GeminiSessionNotesOrchestrator` remains the generation authority.
- `SessionDetailViewModel` receives UI-ready state: key availability, generation status, retryable error copy, saved summary, and action-item bullets.

## Constraints

- Runtime/framework: native macOS SwiftUI app in `Meetless.xcodeproj`; current verification surface is `xcodebuild test -project Meetless.xcodeproj -scheme Meetless -destination 'platform=macOS'`.
- Dependency health: `gkg` is reachable and indexed, but returned no Swift definitions for the target paths, so direct Swift inspection remains required.
- Existing app minimum size is 960 x 680; the detail view already uses a two-column transcript plus metadata rail, so the notes UI must budget width carefully.
- `Meetless.xcodeproj` uses explicit PBX groups and source entries; any new Swift file needs project-file wiring unless implementation stays inside existing files.
- Failed Gemini generation must leave the session unchanged. Phase 2 already enforces this in the orchestrator; Phase 3 must not save partial UI output.
- Current audio artifacts may be `.m4a`, `.wav`, or repository-valid `.wave`. Phase 2 review found `.wave` is not mapped by the Gemini MIME mapper yet.
- Security: the Gemini API key is a user secret. Do not store it in session bundles, logs, `UserDefaults`, or plain app config.
- D9 requires confirmation every time before sending saved audio to Gemini; the service must not be called until the user confirms.

## External Research

- Phase 2 already validated the Gemini REST direction for v1: stable `gemini-2.5-flash`, Files API upload for saved audio, and structured JSON output.
- No new external library is needed for Phase 3. The work is native SwiftUI, existing Keychain wrapper, existing repository API, and existing Gemini orchestration.

## Summary For Synthesis

Have: secure key storage seam, generated-notes persistence, audio artifact resolution, mockable Gemini upload/generation, parser, orchestrator, and tests that protect failure rollback.

Need: the actual user path: global key settings, session Generate button, every-upload confirmation, progress and retryable errors, persisted Summary and Action Items display, and disabled Generate after notes exist.

Constraints/warnings:

- Close the open `.wave` MIME follow-up before or alongside UI wiring so repository-valid sessions do not fail at the provider boundary.
- Keep the Gemini transcript hidden from the v1 detail UI.
- Use normal meeting language in every visible string; avoid raw `Meeting` / `Me` source labels.
- Add UI state at the app/view-model boundary so SwiftUI remains a renderer of already-decided product states.
