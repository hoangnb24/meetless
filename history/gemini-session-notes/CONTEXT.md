# Gemini Session Notes - Context

**Feature slug:** gemini-session-notes
**Date:** 2026-05-01
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE | CALL | RUN | ORGANIZE

## Feature Boundary

Add Gemini-powered notes generation to saved session detail: users save a Gemini API key in global settings, confirm each audio upload, generate one permanent summary plus simple action-item bullets from the selected session's saved audio, and cannot regenerate notes in v1.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** Gemini-enabled v1 is in scope.
  - Rationale: The first release includes API key storage and sends saved session audio to Gemini Flash so generated notes can be better than the current local transcript snapshot.

- **D2:** Gemini output is saved permanently inside the selected session.
  - Rationale: Reopening a session later must show the generated result again.

- **D3:** Gemini v1 sends both saved audio files separately and asks Gemini to produce one combined meeting transcript plus speaker-aware summary and action items.
  - Rationale: Meetless preserves separate saved audio artifacts for the meeting/system side and the microphone/user side; v1 should use both rather than flattening them before upload.

- **D4:** Gemini API key management belongs in global app settings or preferences.
  - Rationale: Users save or update the key once, and Session Detail uses that saved key for generation.

- **D5:** Session Detail shows generated `Summary` and `Action Items` only.
  - Rationale: The Gemini transcript is saved for audit, debug, and future reuse, but hidden from the main v1 result surface.

- **D6:** V1 action items are simple text bullets only.
  - Rationale: No owner, due date, status, or task-management fields are required in the first release.

- **D7:** Once a session has generated notes, Generate is disabled in v1.
  - Rationale: V1 has no regeneration, overwrite, or version-history workflow.

- **D8:** If Gemini generation fails, Meetless keeps the saved session unchanged and shows a retryable error message.
  - Rationale: Failed external requests must not corrupt or partially mutate local saved session data.

- **D9:** V1 requires confirmation every time before sending saved audio to Gemini.
  - Rationale: This is the first feature that sends saved local meeting audio to an external model provider, so the user must explicitly acknowledge the upload each time.

### Agent's Discretion

Planning and implementation can choose the concrete storage schema, Gemini service boundary, prompt format, settings presentation, progress wording, and local error taxonomy as long as they preserve the locked product behavior above.

Planning must preserve the prior product-trust rule that internal source labels should not leak into user-facing copy. User-facing generated notes should use normal meeting language, not raw pipeline labels.

## Specific Ideas And References

- User entry point: tap `Sessions`, select a saved session, then use a button that acts as `Generate Summary` and `Action Items`.
- Advanced v1 scope: provide a place to save the user's Gemini key and use Gemini Flash with saved audio for better transcript-derived notes.
- The visible generated result is not a full transcript replacement in v1. The product value on the detail screen is the meeting summary and simple action-item bullets.

## Existing Code Context

From the quick scout. Downstream agents read these before planning.

### Reusable Assets

- `MeetlessApp/Design/MeetlessDesignTokens.swift` - shared typography, color, spacing, and radius tokens used by current SwiftUI screens.
- `MeetlessApp/Design/ShellPrimitives.swift` - reusable shell primitives such as dividers and layout elements for the current app surface.
- `MeetlessApp/Features/History/HistoryView.swift` - saved session list with row actions and delete confirmation patterns.
- `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` - selected-session detail surface, header action row, transcript pane, metadata rail, notice rows, and delete confirmation pattern.
- `MeetlessApp/Services/SessionRepository/SessionRepository.swift` - session bundle loading/saving, manifest shape, `transcript.json`, saved audio artifact paths, and existing transcript snapshot update behavior.

### Established Patterns

- Saved sessions are local bundle artifacts under the app's `Sessions` directory, with metadata and transcript snapshots loaded through `SessionRepository`.
- Session Detail is currently read-only for transcript and metadata, with small bordered action buttons in the header and compact right-rail metadata/notices.
- Existing failure and warning copy is shown in focused banners or notice rows without exposing internal capture-source implementation details.
- Prior UI revamp learning says future multi-screen UI work should sequence shared shell/settings surfaces before feature screens when files overlap.

### Integration Points

- `MeetlessApp/App/AppModel.swift` - likely app-level routing/state owner for adding a settings or preferences surface.
- `MeetlessApp/App/AppScreen.swift` - likely screen enumeration for any new settings/preferences route.
- `MeetlessApp/App/MeetlessRootView.swift` - current shell/navigation composition where a global settings entry may attach.
- `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` - visible Generate action, confirmation, generated notes panel, disabled state, and retryable error surface.
- `MeetlessApp/Services/SessionRepository/SessionRepository.swift` - persisted Gemini result storage and unchanged-on-failure transaction boundary.
- `MeetlessApp/Services/Capture/ScreenCaptureSession.swift` - source of the current saved audio topology; planning should confirm exact artifact names and source semantics before designing the Gemini request.

## Canonical References

- `AGENTS.md` - repo-specific Khuym workflow, communication preference, scout, and handoff rules.
- `history/native-macos-meeting-recorder/CONTEXT.md` - existing saved-session product contract and local-first baseline.
- `history/learnings/critical-patterns.md` - critical UI/source-label lessons promoted from prior Meetless work.
- `history/learnings/20260425-ui-revamp-source-boundaries.md` - detailed learning about shell-first UI sequencing and hiding internal source labels.
- `history/gemini-session-notes/CONTEXT.md` - source of truth for this feature.

## Outstanding Questions

### Deferred To Planning

- [ ] Determine the exact Gemini Flash API/model name, request shape, audio upload strategy, size limits, timeout behavior, and response parsing contract from current official Gemini documentation.
- [ ] Determine the safest macOS storage mechanism for the Gemini API key, with Keychain preferred if feasible for this app shape.
- [ ] Determine the precise session-bundle schema for permanently saving generated transcript, summary, and action items while keeping failed attempts from mutating the bundle.
- [ ] Determine how Session Detail should represent loading, missing-key, invalid-key, upload confirmation, success, already-generated disabled state, and retryable failure states without crowding the current transcript/metadata layout.
- [ ] Determine whether both saved audio files are always present for completed and incomplete sessions, and how the Generate button should behave when one or both artifacts are missing.

## Deferred Ideas

- Regeneration, overwrite confirmation, and generation version history - explicitly out of scope for v1 by D7.
- Owner, due date, status, reminders, export, or task-system handoff for action items - deferred beyond v1 by D6.
- Showing Gemini transcript in the main Session Detail UI - deferred beyond v1 by D5.
- Falling back to transcript-only generation when Gemini audio processing fails - deferred beyond v1 by D8.
- Merging saved audio into one file before Gemini upload - rejected for v1 by D3.

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs are stable. Planning reads locked decisions, code context, canonical references, and deferred-to-planning questions. Validating and reviewing use locked decisions for coverage and UAT.
