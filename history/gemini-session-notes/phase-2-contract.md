# Phase Contract: Phase 2 - Gemini Upload And Structured Result

## What This Phase Changes

Meetless gains a mockable Gemini notes service that can take a selected saved session, upload both saved audio artifacts to Gemini, request one combined meeting transcript, summary, and simple action-item bullets, then parse the structured JSON response into `GeneratedSessionNotes`. The service does not add the Session Detail button or Settings UI yet. It proves the risky external/provider path behind tests so Phase 3 can wire the user experience without inventing network behavior in SwiftUI.

## Why Now

- Phase 1 already created secure key storage, generated-notes persistence, and path-safe audio artifact resolution.
- The remaining risk is whether Gemini upload and structured parsing can fail cleanly without mutating saved sessions.
- `bd-227` must be resolved before the upload service spreads repository-owned display/provider metadata into Phase 2 consumers.

## Entry State

- Phase 1 review passed.
- `GeminiAPIKeyStoring` exists.
- `SessionRepository` can load/save generated notes and resolve both saved audio artifacts.
- One non-blocking review bead remains open: `bd-227`.

## Exit State

- Repository audio-artifact output exposes only bundle-owned facts; Gemini/provider MIME mapping and UI display copy live outside `SessionRepository`.
- A `GeminiSessionNotesGenerating` service exists with injectable transport/client boundaries.
- The Gemini client can upload both resolved saved audio artifacts and call `generateContent` with a structured JSON schema.
- Successful responses parse into hidden transcript, summary, and simple action-item bullets.
- Invalid key, upload failure, generation failure, malformed JSON, missing response fields, missing audio, and already-generated sessions return clear retryable/non-retryable errors without changing the session bundle.
- Tests prove success persists only after a complete valid result and failures leave `generated-notes.json` absent.

## Demo Walkthrough

Service-level proof:

- Run the focused Gemini/session tests.
- Fixture transport sees two upload requests, one structured `generateContent` request, and no UI dependency.
- Success fixture saves generated notes; reopening the session returns summary/action bullets while hidden transcript remains stored.
- Failure fixtures do not create `generated-notes.json` and preserve the existing manifest.

## Story Sequence

| Story | What Happens | Why Now | Unlocks | Done Looks Like |
|---|---|---|---|---|
| Story 1: Clean upload boundary | Move MIME/provider/display metadata out of repository output. | This prevents persistence code from owning Gemini or UI copy before upload wiring begins. | Gemini service can own provider mapping cleanly. | `bd-227` is closed; repository tests assert storage facts only; service tests own MIME/display mapping. |
| Story 2: Gemini transport and request builder | Add an injectable Gemini client/transport that uploads both files and builds the structured generate request. | External API calls are the highest-risk integration in the feature. | Fixture-based service success/failure tests. | Tests inspect upload/generate endpoints, headers, file URI parts, model string, and JSON schema without a real network call. |
| Story 3: Structured result parser | Parse Gemini's JSON response into `GeneratedSessionNotes` and reject malformed or semantically empty output. | Persistence should only receive a complete result. | Non-mutating save orchestration. | Parser tests cover valid output, malformed JSON, missing transcript/summary/actions, empty summary, and source-label scrub expectations. |
| Story 4: Generation orchestrator | Compose key loading, session audio resolution, Gemini generation, and atomic note save. | This is the service contract Phase 3 will call. | UI can add Generate/progress states next phase. | Tests prove success saves once and all failure paths keep the saved session unchanged. |

## Out Of Scope / Success / Pivot Signals

- Out: Settings UI, Generate button, confirmation dialog, progress UI, visible Summary/Action Items panel, real-key manual smoke.
- Success: focused and full tests pass; Phase 2 has no P1 review findings; Phase 3 can call one service method.
- Pivot: official Gemini API behavior requires a different model, upload lifecycle, or response shape than fixture assumptions; validation should require a small live-key spike before UI work.
