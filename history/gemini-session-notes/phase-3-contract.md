# Phase Contract: Phase 3 - Session Detail Experience

## What This Phase Changes

Phase 3 turns the service foundation into the real product path. Users can save a Gemini API key in global settings, open a saved session, confirm that saved audio will be uploaded, generate notes, and later reopen the same session to see the saved Summary and Action Items. The hidden Gemini transcript remains persisted but not displayed in the main v1 UI.

## Why Now

- Phase 1 and Phase 2 already provide secure key storage, session-bundle persistence, audio resolution, Gemini upload, parser, and save-on-success orchestration.
- Without this phase, the Gemini feature exists only as service code and cannot be used from the app.
- The Phase 2 review follow-up must be closed before the visible Generate flow reaches users with repository-valid `.wave` audio.

## Entry State

- `history/gemini-session-notes/phase-2-review.md` says Phase 2 has no P1 blockers.
- `GeminiSessionNotesOrchestrator` can generate and save notes through injectable seams.
- `SessionDetailView` is read-only for transcript/metadata and does not yet expose Generate, confirmation, or notes display.
- `bd-1on` remains open for `.wave` MIME mapping.

## Exit State

- Global settings/preferences lets the user save, update, and delete the Gemini API key using the existing Keychain store.
- Session Detail shows a Generate action only when a selected session can attempt generation and no notes already exist.
- Every generation attempt requires explicit confirmation before audio upload.
- Generation shows progress and retryable, user-safe errors.
- Success persists notes in the selected session bundle and refreshes the visible detail.
- Reopening the session shows Summary and Action Items, hides the Gemini transcript, and disables Generate.
- `.wave`, `.wav`, and `.m4a` repository-valid audio artifacts map successfully for Gemini upload.

## Demo Walkthrough

Checklist proof:

- Open settings, save a Gemini API key, and return to Sessions.
- Open a saved session with audio artifacts.
- Click Generate and cancel the confirmation; verify no generation starts.
- Click Generate again, confirm upload, and see progress.
- On success, see Summary and Action Items on the Session Detail page.
- Leave and reopen the session; verify notes persist and Generate is disabled.
- Trigger a missing-key or provider failure fixture/path and verify the session remains unchanged with retryable error copy.

## Story Sequence

| Story | What Happens | Why Now | Unlocks | Done Looks Like |
|---|---|---|---|---|
| Story 1 | Close `.wave` upload compatibility gap. | A known Phase 2 mismatch should not ship into the visible Generate flow. | Safe provider boundary for all repository-valid audio extensions. | `.wave` maps to `audio/wav`; focused tests pass. |
| Story 2 | Add global Gemini settings/key state. | Users need a trusted place to manage the key before generating. | Session Detail can explain missing-key state and call generation when configured. | Save/update/delete key works through Keychain; errors are safe. |
| Story 3 | Wire Session Detail generation lifecycle. | D8 and D9 depend on controlled app-level async state. | Visible notes can be refreshed after success. | Confirm/cancel/progress/error states behave correctly and do not mutate on failure. |
| Story 4 | Display persisted notes and final disabled state. | This is the user-facing v1 value. | Final review/UAT. | Summary and Action Items persist; transcript stays hidden; Generate cannot overwrite. |

## Out Of Scope / Success / Pivot Signals

- Out: regeneration, overwrite confirmation, version history, action-item owners/due dates/status, visible Gemini transcript, transcript-only fallback, and audio merging.
- Success: full Xcode test suite passes and UAT covers settings, confirmation, cancel, success, reopen persistence, already-generated disabled state, and retryable failure.
- Pivot: if Keychain UI access cannot be made reliable in-app, stop and move key-management UX behind a smaller settings surface without changing the storage contract.
