# Phase Contract: Phase 1 - Secure Notes Foundation

## What This Phase Changes

Phase 1 gives Meetless the local foundation for Gemini session notes without making any real Gemini network request. The app gains a secure API-key storage seam, a generated-notes persistence model, and a repository-owned way to resolve the selected session's saved audio artifacts. After this phase, downstream work can plug in Gemini and UI states without guessing how secrets, saved notes, or audio files should be handled.

## Why Now

- Gemini notes depend on a user secret, so the secure key boundary must exist before any upload flow is built.
- Permanent generated output is locked by D2, and failure-safe persistence is locked by D8; repository behavior must be proven before UI or network work can mutate sessions.
- D3 requires both saved audio files, and current artifacts may be compressed M4A or fallback WAV depending on finalization outcome.

## Entry State

- `history/gemini-session-notes/CONTEXT.md`, `discovery.md`, `approach.md`, and `phase-plan.md` exist.
- Saved sessions can already persist `session.json`, `transcript.json`, and per-source audio artifacts.
- No Gemini API-key store, generated-notes schema, or public audio-artifact resolver exists yet.

## Exit State

- A Meetless-owned API-key store abstraction exists with a Keychain-backed implementation and test-double support.
- `SessionRepository` can load/save a permanent generated-notes result containing hidden Gemini transcript, visible summary, and simple action-item bullet strings.
- A selected session's two audio artifact URLs can be resolved through repository/service APIs using manifest filenames, including compressed M4A and WAV fallback cases.
- Failed generated-notes writes leave existing session files unchanged.
- Tests cover the new key store seam, generated-notes persistence, and audio artifact resolver.

## Demo Walkthrough

Automated proof:

- Run `xcodebuild test -project Meetless.xcodeproj -scheme Meetless -destination 'platform=macOS'`.
- Key-store tests demonstrate missing key, save, update, delete, and no plain key in session files.
- Repository tests demonstrate no generated notes for old sessions, saved notes reopen, failed writes preserve previous files, and audio artifact resolution returns both saved sources.

No end-user Generate button is expected in this phase. The demo is intentionally service-level because Phase 2 and Phase 3 own network and UI.

## Story Sequence

| Story | What Happens | Why Now | Unlocks | Done Looks Like |
|---|---|---|---|---|
| Story 1: Key storage seam | Add a Meetless-owned Gemini API-key store protocol, Keychain implementation, errors, and test-double coverage. | Secure global key storage is the prerequisite for any Gemini-enabled v1. | Service/UI work can check whether a key exists without knowing Keychain details. | Tests cover missing key, save, update, delete, and expected failure mapping. |
| Story 2: Session notes schema | Add generated-notes domain models plus repository read/write APIs that preserve old sessions and write atomically. | Permanent notes and unchanged-on-failure behavior are locked decisions. | Gemini client can persist a parsed result without owning bundle internals. | Tests cover absent notes, saved notes reopen, hidden transcript persistence, and failed write rollback. |
| Story 3: Audio artifact resolver | Add a repository/service API that returns both saved audio artifacts using manifest filenames and source metadata. | Gemini must receive both saved artifacts in Phase 2. | Gemini client can upload exact local files without hardcoding paths or extensions. | Tests cover M4A success, WAV fallback, and missing-artifact errors. |

## Out Of Scope / Success / Pivot Signals

- Out: real Gemini API calls, Files API upload, structured-output parsing, settings UI, Generate button, confirmation dialog, and visible notes panel.
- Success: Phase 2 can be planned against stable interfaces for key lookup, notes persistence, and artifact resolution.
- Pivot: if Keychain behavior cannot be tested reliably in the macOS test target, validating should require an implementation spike or a clearly isolated fallback before execution.

## Risk Check

- Keychain storage remains HIGH risk because it touches user secrets and macOS security APIs.
- Generated-notes persistence is MEDIUM risk because it changes session bundle schema.
- Audio artifact resolution is MEDIUM risk because existing bundles can reference different artifact filenames.
- This phase is validation-worthy only if tests prove secrets are not written to bundles/logs and failed notes writes do not mutate saved sessions.

## Validation Spike Result

- `bd-2zk` answered YES for the Keychain risk.
- Local Swift imported `Security` and completed a validation-only generic-password add, read, update, read, delete, and not-found check.
- The test item used service `com.meetless.validation.gemini-key` and account `codex-validation`, then was deleted.
- Execution constraint: implement an injectable Keychain wrapper, keep direct `SecItem*` calls out of SwiftUI view code, never log the key, and never store it in session bundles, `UserDefaults`, or plain config.
