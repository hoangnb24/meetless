# Native macOS Meeting Recorder — Context

**Feature slug:** native-macos-meeting-recorder
**Date:** 2026-04-21
**Exploring session:** complete
**Scope:** Deep

---

## Feature Boundary

Build a brand-new local-first native macOS app that records whole-system meeting audio plus microphone input, shows a realtime transcript during recording, and saves sessions locally into a history/detail workflow without adding cloud dependencies or reusing the repo's prior product implementation.

**Domain type(s):** SEE | RUN | ORGANIZE

---

## Locked Decisions

These are fixed. Planning must implement them exactly. No creative reinterpretation.

### Capture Model
- **D1** V1 captures `system audio + microphone` and preserves them as separate inputs from the start.
  *Rationale: The product should distinguish meeting audio from the user's own voice from day one.*

- **D15** If one input source fails during recording, the app keeps recording with the surviving source and shows a clear degraded-state warning.

- **D16** Recording starts against `whole-system meeting audio + microphone`; v1 does not include per-app or per-window capture targeting.

### Transcript Experience
- **D2** The realtime transcript uses source-style labels on each chunk, presented as `Meeting` vs `Me`.

- **D3** The session detail transcript is read-only in v1; no transcript editing is included.

- **D12** V1 does not run a final post-recording transcription pass after capture stops.

- **D23** When a meeting ends, the app saves the realtime transcript snapshot exactly as it existed during recording so saved sessions can later open with a transcript, even if imperfect.
  *Rationale: This preserves the original success criterion that saved sessions open into a detail view with transcript content while keeping v1 lightweight.*

### Session Model
- **D4** Session history uses a simple list with `title, date/time, duration, and transcript preview` as the primary row content.

- **D5** If recording ends unexpectedly, the app auto-saves a partial session and shows it in history with an incomplete status.

- **D7** Saved sessions default to a timestamp-based title such as `Meeting Apr 21, 10:30 AM`.

- **D8** The session detail screen is transcript plus metadata only in v1; there is no playback UI.

- **D9** Session history is browse-only in v1, with no search or filters.

- **D10** Saved sessions are local-only in v1; there is no export or sharing workflow.

- **D11** The raw captured audio is the primary durable saved artifact for a session; transcript is a derived product view rather than the sole source of record.

- **D19** Users can delete saved sessions from history and local storage in v1.

### App Shell and Controls
- **D13** V1 is a standard windowed macOS app with straightforward navigation between home, history, and session detail.

- **D14** Recording controls are a simple `Start/Stop` flow only in v1.

- **D17** The home screen emphasizes a prominent record action with minimal surrounding content.

### Permissions and Onboarding
- **D6** First launch uses a minimal home screen with a record button; permissions are requested only when needed rather than through guided onboarding.

- **D20** If required macOS permissions are missing when the user hits Record, the app blocks recording and shows a focused permission repair flow.

- **D21** That repair flow should lead with System Settings deep links and only short in-app guidance.

### Explicit Exclusions for V1
- **D22** V1 does not include any normal user-facing manual retranscription UI.

### Superseded During Exploring
- **D18** Earlier in the discussion, the transcript was briefly treated as unavailable on later reopen unless manually retranscribed. This was superseded by **D23** and is no longer active.

### Agent's Discretion
- Planning and implementation can choose the concrete Swift package boundaries, persistence schema, internal concurrency model, and macOS UI composition details as long as they respect the locked product behavior above.
- Planning should stay Apple Silicon first for v1 unless primary-source research surfaces a concrete blocker.
- This feature is explicitly greenfield. Downstream agents may inspect the current workspace for constraints, but must not port, adapt, or inherit architecture from the repo's prior Rust or Swift implementation.

---

## Specific Ideas & References

- The high-level product remains: local recording, realtime transcript while recording, session history, and session detail with transcript plus metadata.
- Privacy-first and local-first are core product requirements.
- The stack is already locked for downstream work: Swift, SwiftUI with AppKit bridges only where macOS-specific behavior requires them, ScreenCaptureKit for capture, and whisper.cpp for local speech-to-text.
- The user asked for deep planning first, with special attention on:
  - audio capture path
  - whisper.cpp integration shape in a Swift app
  - realtime transcript event flow
  - local persistence and history/session-detail model
  - macOS packaging and app-bundle concerns

---

## Existing Code Context

From the quick codebase scout during exploring.
Downstream agents: read these files before planning to avoid inventing repo state that does not exist.

### Reusable Assets
- `AGENTS.md` — repo workflow guardrails; requires Khuym startup, scout, and handoff discipline.
- `.codex/khuym_status.mjs` — read-only scout entrypoint for onboarding/state inspection.
- `.khuym/state.json` — machine-readable workflow state that downstream Khuym steps should keep aligned.
- `.khuym/STATE.md` — human-readable workflow state summary.

### Established Patterns
- Greenfield product codebase: no existing app source files or reusable macOS implementation files were present during the exploring scout.
- This means planning should design the app from first principles rather than adapting current workspace product code.

### Integration Points
- `history/native-macos-meeting-recorder/CONTEXT.md` — source of truth for the feature.
- `.khuym/state.json` and `.khuym/STATE.md` — must be kept aligned as the feature moves into planning and later gates.

---

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `AGENTS.md` — repo-specific Khuym workflow and handoff rules.
- `history/native-macos-meeting-recorder/CONTEXT.md` — locked product contract for this greenfield app.

---

## Outstanding Questions

### Deferred to Planning
- [ ] Determine the exact ScreenCaptureKit capture topology for whole-system audio plus microphone while keeping the two sources distinguishable as `Meeting` vs `Me` and degrading gracefully when one source fails. — Requires current Apple documentation and implementation research.
- [ ] Determine the Swift-to-whisper.cpp integration boundary, lifecycle model, and packaging shape for a local macOS app bundle. — Requires upstream whisper.cpp and macOS build/runtime research.
- [ ] Determine how the realtime transcript snapshot, raw audio artifacts, session metadata, and incomplete-session recovery should be stored locally. — Requires architecture and persistence design work.
- [ ] Determine the most appropriate SwiftUI/AppKit navigation and permission-repair composition for a standard windowed macOS app. — Requires macOS UX and platform-behavior research.
- [ ] Determine the lightest credible app/module/package layout for a greenfield Swift macOS project using the locked stack. — Requires architecture planning.

---

## Deferred Ideas

- Exporting transcript or session bundles — deferred beyond v1.
- Search and filtering in history — deferred beyond v1.
- Playback UI in session detail — deferred beyond v1.
- Per-app or per-window recording target selection — deferred beyond v1.
- Guided onboarding before first recording — deferred beyond v1.
- User-facing retranscription actions — deferred beyond v1.

---

## Handoff Note

CONTEXT.md is the single source of truth for this feature.

- **planning** reads: locked decisions, code context, canonical refs, deferred-to-planning questions
- **validating** reads: locked decisions (to verify plan-checker coverage)
- **reviewing** reads: locked decisions (for UAT verification)

Decision IDs (D1, D2...) are stable. Reference them by ID in all downstream artifacts.
