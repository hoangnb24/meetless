# Phase Plan: Gemini Session Notes

## Feature Summary

This feature lets a user open a saved session, confirm that saved audio will be sent to Gemini, and generate a permanent meeting summary plus simple action-item bullets. The Gemini transcript is saved for audit/reuse but hidden from the main v1 Session Detail UI. The app also adds global Gemini API-key settings and keeps failed generation attempts from changing saved session data.

## Phase Overview

| Phase | What Changes | Why Now | Demo | Unlocks |
|---|---|---|---|---|
| Phase 1: Secure Notes Foundation | Complete. Meetless can save/read/delete a Gemini key, resolve a selected session's two audio artifacts, and persist/load generated-notes data without any real Gemini call. | This de-risked secrets and session-bundle mutation before network work touched user data. | Unit tests show Keychain wrapper behavior, repository tests show saved notes reopen and failed writes leave sessions unchanged. | Real Gemini client can plug into stable interfaces. |
| Phase 2: Gemini Upload And Structured Result | Complete. Meetless has a mockable Gemini client that uploads both session audio artifacts, requests structured JSON, parses transcript/summary/action items, and reports retryable errors. | The external integration was the riskiest piece and needed proof before UI polish. | Transport-fixture tests cover upload success, invalid key, network failure, malformed JSON, missing audio, and no session mutation on failure. | Session Detail can call a real generation flow with predictable states. |
| Phase 3: Session Detail Experience | Users see global Gemini settings, a Generate button in Session Detail, every-run upload confirmation, progress/error states, saved Summary and Action Items, and disabled Generate after success. | Storage and service contracts are stable, so the remaining work is the end-to-end product path. | Manual/UAT path: save key -> open session -> confirm upload -> generate -> reopen session -> notes persist -> Generate disabled. | Feature is ready for final review/closeout. |

## Phase 3 Story Preview

| Story | What Happens | Why Now | Done Looks Like |
|---|---|---|---|
| Story 1: Close upload compatibility gap | Repository-valid `.wave` audio maps to `audio/wav` during Gemini upload. | The visible Generate path should not expose a known Phase 2 provider-boundary mismatch. | `bd-1on` is closed; request-builder tests cover `.wave`. |
| Story 2: Global Gemini settings | User can open global settings, save/update/delete a Gemini API key, and see safe key status without exposing the secret. | D4 must be true before Session Detail can offer a useful Generate action. | Settings route loads current key state, saves trimmed key, deletes key, and reports Keychain failures safely. |
| Story 3: Generation state wiring | Session Detail has a Generate action that calls the orchestrator only for the selected session after confirmation. | D8/D9 require app-level state control, not a raw view button. | Confirm starts generation; cancel does nothing; progress and retryable errors are visible; failures leave notes unchanged. |
| Story 4: Saved notes display and disabled state | Generated Summary and Action Items appear on Session Detail and persist after reopening; Generate is disabled after success. | This is the v1 user value and D2/D5/D6/D7 closure. | Reopen shows saved notes; hidden transcript is not visible; Generate cannot overwrite. |

## Order Check

- [x] Phase 1 is obviously first because it creates the secure key and session-bundle contracts that later work depends on.
- [x] Phase 2 depends on Phase 1 service and persistence seams to keep external failures isolated.
- [x] Phase 3 depends on Phase 1 and Phase 2 so UI states can call stable services instead of inventing behavior in SwiftUI.
- [x] No phase is merely a technical bucket; each phase creates an observable product or system capability.

## Approval Summary

- Current phase to prepare next: Phase 3 - Session Detail Experience.
- Picture after that phase: a user can save a Gemini key, generate notes from a saved session with explicit upload consent, reopen the session, and see persisted Summary plus Action Items while Generate remains disabled.
- Deferred until later: regeneration/version history, owner/due-date task fields, visible Gemini transcript UI, transcript-only fallback, and audio merging.

Phase 2 has passed review with one non-blocking P2 follow-up. Planning is preparing Phase 3 from this approved phase plan and will hand off to `khuym:validating` for Phase 3.
