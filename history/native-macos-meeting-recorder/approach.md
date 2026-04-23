# Approach: Native macOS Meeting Recorder

**Date**: 2026-04-23
**Feature**: `native-macos-meeting-recorder`
**Based on**:
- `history/native-macos-meeting-recorder/discovery.md`
- `history/native-macos-meeting-recorder/CONTEXT.md`

---

## 1. Gap Analysis

> What the app already has after Phase 2 vs. what Phase 3 still needs.

| Component | Have | Need | Gap Size |
|-----------|------|------|----------|
| Live recording + saved-session product loop | Buildable app with record/save/history/detail/delete and existing warning surfaces | Honest degraded-state propagation for retry-exhausted transcript lanes and transcript snapshot persistence failures | Medium |
| Persistence boundary | `SessionRepository` already owns manifests, snapshots, summaries, detail loading, and delete | Saved metadata that stays honest when recording-side failure modes appear | Medium |
| Warning presentation | Recording banner, History, and Session Detail already render source or saved-session warnings | The remaining failure paths must actually feed those surfaces | Medium |
| Testability | Manual build verification only | Minimal XCTest target plus focused regression coverage and a working `xcodebuild test` path | Medium |
| Privacy / release defaults | Logger categories exist and sandbox flags are enabled in build settings | Signed entitlements enforcement plus path-safe public logs | High |

The important Phase 3 truth is that the app already feels like a product. What it lacks now is trust: some failure paths still look healthier than they really are, the core loop has no regression harness, and the runtime privacy story is only partially true.

---

## 2. Recommended Approach

Treat Phase 3 as one trust pass over the existing app, not as a new feature layer. First, close the two honesty gaps by reusing the current `SourcePipelineStatus` and saved-session notice pipeline so both live recording and saved bundles become explicit when transcript coverage or transcript snapshot persistence degrades. Then add a minimal XCTest target that locks those invariants in place with `xcodebuild test`. Finally, restore real signing/entitlements behavior and redact sensitive path details from public logs so the app’s local-first privacy story is technically true, not just narratively true.

### Why This Approach

- It respects `D15` and `D23` by keeping the bounded stop path while making partial transcript outcomes visible instead of silent.
- It builds on the UI and persistence seams Phase 2 already introduced rather than replacing them.
- It sequences work so tests capture the final intended hardening behavior instead of freezing the current bugs.
- It keeps project-configuration work late enough that the behavior contract is already settled, but still inside the same phase because privacy/release trust is part of the same user promise.

### Story-Level Strategy

| Story | Strategy | Why This Order |
|-------|----------|----------------|
| Story 1: Honest failure signals survive recording and saving | Extend the existing recording/source-status and saved-session notice model to cover retry exhaustion and snapshot-write failure | These are the most important remaining product-trust failures, and later tests should lock the corrected behavior in place |
| Story 2: Regression coverage protects the core loop | Add the first XCTest target and cover the pure-Swift invariants most likely to regress from Story 1 and future recording changes | Once the truth contract is fixed, tests prevent backsliding |
| Story 3: Privacy and signing defaults match the local-first promise | Re-enable signing with explicit entitlements, then remove full artifact paths from public logs | This closes the trust story at the runtime and observability layer after the product behavior itself is honest |

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Live degraded-state model | Reuse `SourcePipelineStatus` and existing source-state presentation | The app already has a consistent live status language |
| Saved failure surfacing | Reuse persisted source statuses / saved-session notices instead of a second warning UI model | Avoids duplicating saved-session honesty logic |
| Snapshot persistence honesty | Persist an explicit honest signal when transcript snapshot refresh fails | Supports incomplete-session recovery and saved-session trust without guessing later |
| First test surface | Start with pure-Swift recording/persistence seams before UI automation | Fastest path to stable regression coverage in this repo |
| Signing configuration | Add explicit entitlements and restore actual code signing when sandbox is on | Makes the privacy story real and reviewable |
| Log redaction | Keep short identifiers public, mark full paths private or omit them | Preserves debugging value without leaking local storage details |

---

## 3. Alternatives Considered

### Option A: Add tests before fixing the remaining honesty gaps

- Description: create a test target first and capture the current recording/persistence behavior as-is.
- Why considered: it can feel safer to add tests before making changes.
- Why rejected: it would freeze the wrong contract. Story 1 needs to decide what the honest behavior should be before Story 2 locks it in.

### Option B: Introduce a separate saved-session warning model for Phase 3

- Description: create new persisted warning objects or a second UI pipeline dedicated to hardening notices.
- Why considered: it could make the new review issues feel isolated.
- Why rejected: the app already has `SourcePipelineStatus` and `SavedSessionNotice` seams. A second model would duplicate meaning and make later maintenance harder.

### Option C: Defer signing/privacy work to a later release-only phase

- Description: close the recording honesty gaps and tests now, but leave signing and path redaction for a later operational pass.
- Why considered: it shortens the current phase.
- Why rejected: the whole point of Phase 3 is release trust. Leaving sandbox/signing and public path leaks unresolved would keep the app only partially trustworthy.

---

## 4. Risk Map

| Component | Risk Level | Reason | Verification Needed |
|-----------|------------|--------|---------------------|
| Retry-exhaustion honesty fix | **MEDIUM** | Touches the recording state machine and saved-session status propagation in shared files | Focused validation with controlled transcript failure injection |
| Snapshot-write failure honesty fix | **MEDIUM** | Needs to keep bounded recording behavior while making persisted state explicit | Focused validation with repository write-failure injection |
| XCTest target + regression coverage | **MEDIUM** | Requires Xcode project changes plus stable test seams in a repo that currently has none | `xcodebuild test` verification in the local project |
| Signing + entitlements restoration | **HIGH** | Crosses build settings, runtime entitlement behavior, and the app’s privacy model | Explicit build/config verification plus runtime storage-path check |
| Public log redaction | **LOW** | Small code edits, but easy to verify | Log inspection during build/run verification |

### HIGH-Risk Summary (for `khuym:validating`)

- `bd-2w7` should be treated as the only HIGH-risk Phase 3 bead because it changes the build/runtime trust boundary for the app.

---

## 5. Proposed File Structure

```text
MeetlessApp/
  Features/
    Recording/
      RecordingViewModel.swift         # Story 1 honesty fixes and later test seams
    RecordingStatusBanner.swift        # live degraded-state copy if needed
  Services/
    SessionRepository/
      SessionRepository.swift          # persisted honesty markers and testable IO behavior
    Capture/
      ScreenCaptureSession.swift       # path-safe logging

MeetlessTests/
  Recording/
    RecordingCoordinatorTests.swift    # transcript / stop / degraded-state invariants
  Services/
    SessionRepositoryTests.swift       # manifest / snapshot honesty invariants

MeetlessApp/
  Meetless.entitlements                # explicit sandbox/signing contract

Meetless.xcodeproj/
  project.pbxproj                      # test target + signing configuration
```

### File Direction

- Story 1 should touch `RecordingViewModel.swift` and `SessionRepository.swift` first because those edits define the behavior Story 2 will test.
- Story 2 should own the first project-file expansion into `MeetlessTests/` and keep the test surface focused on pure Swift.
- Story 3 should finish the project-level configuration work and then clean up the remaining public-path logs.

---

## 6. Institutional Learnings Applied

- There are still no prior repo learnings for this domain, so the main applied lesson comes from the current feature history: the app already has warning surfaces and a single persistence boundary, so Phase 3 should harden those seams instead of adding new parallel structures.
