# Approach: Gemini Session Notes

## Recommended Approach

Phase 3 should finish the feature as one visible user journey. First, close the Phase 2 `.wave` review follow-up so every repository-valid audio artifact can reach Gemini. Then add a global settings surface for the Gemini API key, wire Session Detail to the existing orchestrator, and render the saved Summary plus simple Action Items once generation succeeds.

The app boundary should stay simple: `AppModel` coordinates repositories, Keychain, and Gemini orchestration; `SessionDetailViewModel` exposes button state, confirmation copy, progress/error copy, and saved notes; SwiftUI only renders those states. This fits the locked decisions and keeps failed provider calls from mutating local session bundles.

Key decisions:

| Decision | Choice | Rationale |
|---|---|---|
| Settings location | Add a global Settings/Preferences route in the existing shell. | D4 says the key is global, not per-session. |
| Key persistence | Continue using `KeychainGeminiAPIKeyStore`; settings only loads/saves/deletes through the protocol. | The secret storage seam already exists and is tested. |
| Generate trigger | Session Detail button calls app-level generation only after user confirmation. | D9 requires explicit confirmation every upload. |
| Button availability | Disable Generate when notes already exist, while loading, while generating, or when the selected session cannot be generated. | D7 and D8 require no regeneration and retryable failures only. |
| Visible output | Show `Summary` and `Action Items`; keep `hiddenGeminiTranscript` out of the main UI. | D5 and D6 define v1 output. |
| Error surface | Show retryable, user-safe copy for missing key, missing audio, auth/provider/client/parser/persistence failures. | D8 requires unchanged sessions and a path to retry. |
| `.wave` handling | Map `.wave` to `audio/wav` in the Gemini MIME mapper. | Repository validation already accepts `.wave`; provider mapping should match. |

Alternatives considered:

- Put the API key field inside Session Detail: rejected because D4 makes it global and users should not re-enter it per session.
- Generate automatically after key save: rejected because D9 requires per-upload confirmation.
- Show the Gemini transcript in a collapsible panel: rejected for v1 by D5.
- Implement regeneration or overwrite: rejected for v1 by D7.

## Risk Map

| Component | Risk | Reason | Validation |
|---|---|---|---|
| `.wave` MIME follow-up | LOW | One mapper case plus request-builder coverage. | Focused Gemini request-builder test. |
| Settings UI/key state | MEDIUM | New shell route, Keychain error handling, and secret masking. | View-model/unit coverage where possible plus build test. |
| AppModel generation wiring | MEDIUM | Async user action crosses selected session, key store, repository, and service. | Tests around view-model/app state where practical; full Xcode test gate. |
| Session Detail notes UI | MEDIUM | Dense layout can crowd transcript and metadata at minimum window size. | Minimum-size preview/manual UAT, screenshot if available, and code review for layout constraints. |
| Confirmation/progress/error states | MEDIUM | A missed state could upload without consent or leave stale UI after failure. | UAT matrix for confirm/cancel/success/failure/already-generated. |
| Hidden transcript/source labels | MEDIUM | Generated text is persisted; visible paths must not expose hidden transcript or internal labels. | Parser coverage plus display-path audit in review. |

HIGH-risk spikes: none for Phase 3. Phase 2 already de-risked the external Gemini contract; Phase 3 is integration and UI over existing service seams.

Files/order/learnings/open questions:

- `MeetlessApp/Services/GeminiSessionNotes/GeminiSessionNotesClient.swift` - close `.wave` MIME mismatch first.
- `MeetlessTests/GeminiSessionNotesClientTests.swift` - add request-builder coverage for `.wave`.
- `MeetlessApp/App/AppScreen.swift`, `MeetlessApp/App/MeetlessRootView.swift`, `MeetlessApp/App/AppModel.swift` - add settings route and app-level service wiring.
- `MeetlessApp/Features/SessionDetail/SessionDetailView.swift` - add Generate action, confirmation, progress/error state, and notes display.
- `MeetlessTests/*` - extend tests where state can be exercised without fragile UI automation.
- `history/learnings/critical-patterns.md` - requires shell-first sequencing and source-label display audit.
- [ ] Validate whether new Swift files need explicit `project.pbxproj` entries or keep Phase 3 UI types in existing files.
- [ ] Validate UI fit at the declared minimum window size before review.
