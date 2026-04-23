# Approach: Native macOS Meeting Recorder

**Date**: 2026-04-22
**Feature**: `native-macos-meeting-recorder`
**Based on**:
- `history/native-macos-meeting-recorder/discovery.md`
- `history/native-macos-meeting-recorder/CONTEXT.md`

---

## 1. Gap Analysis

> What the app already has after Phase 1 vs. what Phase 2 still needs.

| Component | Have | Need | Gap Size |
|-----------|------|------|----------|
| App shell | One macOS window with Home, History, and Session Detail destinations | Saved-session selection and refresh state owned at the app level | Medium |
| Recording + save loop | Real local recording, transcript snapshot saving, and session bundle finalization | History/detail screens to consume those saved bundles | Medium |
| Persistence boundary | `SessionRepository` actor for write-side bundle creation and updates | Symmetric read/list/load/delete API and public saved-session models | Medium |
| History UI | Placeholder row contract and browse-only intent | Real rows loaded from `session.json`, navigation into detail, and empty/error states | Medium |
| Session detail UI | Transcript-plus-metadata shell | Real transcript snapshot rendering and saved metadata presentation | Medium |
| Saved-session honesty | Completed/incomplete status exists in the manifest today | Consumption of degraded transcript and persistence-warning markers when review follow-ups land | Medium |
| Hardening | Buildable app and reviewed Phase 1 core loop | Tests, signing, and log/privacy follow-ups | Later phase / sidecar |

The central Phase 2 truth is simple: the app already creates the right kind of saved artifacts, but it still does not let the user live in those saved sessions as a product.

---

## 2. Recommended Approach

Keep the existing single-window SwiftUI shell and extend the current file-backed persistence boundary instead of layering in a new database or a second coordinator tree. `SessionRepository` should become the symmetric owner of saved-session disk access by adding public read-side DTOs and delete operations on top of the existing write-side bundle contract. `AppModel` should grow just enough session-navigation state to manage a selected saved session and coordinate refreshes across Home, History, and Session Detail. History should decode manifest-level summaries for the browse list, while Session Detail should decode the transcript snapshot and metadata from the selected bundle and remain read-only. Delete should stay folder-based and local-only.

### Why This Approach

- It matches `D4`, `D8`, `D9`, `D10`, and `D19` without changing the already-proven storage shape.
- It avoids re-solving persistence with SwiftData or SQLite when the product only needs browse/open/delete over a small local bundle set.
- It keeps saved-session behavior anchored to the exact Phase 1 artifacts that review already verified.
- It leaves a clean place to consume the still-open honesty markers from `bd-2ap` and `bd-15x` rather than duplicating that logic in the view layer.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Read-side ownership | Keep read/list/load/delete inside `SessionRepository` | One file-IO boundary is easier to reason about and test than a second store |
| Public saved-session models | Add explicit summary/detail DTOs rather than exposing private manifest structs directly | Keeps the repository flexible while giving UI code a stable contract |
| Selected-session state | Put it in `AppModel` | The app shell already owns screen selection, so session selection belongs at the same level |
| History refresh model | Explicit refresh on app launch / screen entry / post-recording / post-delete | Simple, predictable, and enough for a browse-only local list |
| Detail rendering | Decode transcript snapshot plus manifest metadata into a read-only view model | Honors `D3`, `D8`, and `D23` without inventing editing or playback |
| Honesty marker handling | Phase 2 consumes saved degraded/incomplete markers when present; it does not invent them in the UI | Keeps write-side review fixes and read-side product surfacing separate |

### Recommended Runtime Shape

```text
MeetlessRootView
  -> AppModel
    -> RecordingViewModel
    -> HistoryViewModel
    -> SessionDetailViewModel
    -> SessionRepository
```

### Proposed Phase 2 Additions

#### Saved-session repository surface

`SessionRepository` should gain public operations such as:

- list saved sessions for history
- load one saved session detail record
- delete one saved session bundle

The repository should decode the existing manifest and transcript snapshot files into public Swift models rather than letting view code parse JSON directly.

#### History flow

History stays intentionally simple:

- load local sessions
- sort newest first
- show the locked row fields
- surface incomplete state clearly
- leave search/filtering absent

The history screen should become the browse hub for saved recordings, not a second recording dashboard.

#### Detail flow

Opening a saved session should show:

- the saved title
- date/time and duration
- incomplete/completed state
- source-status summary
- the persisted transcript snapshot, exactly as saved during recording

No playback, export, or transcript editing should appear here.

#### Delete flow

Delete should remain local and direct:

- remove the bundle folder
- refresh the current list
- return to history if the deleted session was open in detail

Because the app is browse-only in v1, there is no need for trash, remote sync, or soft-delete complexity.

#### Honesty markers

Phase 2 should reserve visible space for saved-session warnings so the app can stay honest when:

- one transcript lane became partial (`bd-2ap`)
- transcript snapshot persistence degraded mid-recording (`bd-15x`)

Those write-side review beads remain the source of truth for producing the markers. Phase 2 should focus on consuming and presenting them.

---

## 3. Alternatives Considered

### Option A: Add SwiftData or SQLite before shipping history/detail

- Description: move saved sessions into a database and treat the bundle files as secondary artifacts.
- Why considered: database queries can make list/detail code feel cleaner.
- Why rejected: the app already has a stable on-disk bundle contract, history is browse-only, and a new persistence layer would create migration work before the product needs it.

### Option B: Let views read `session.json` and `transcript.json` directly

- Description: keep repository write-only and decode saved files inside view models or views.
- Why considered: looks fast in the short term.
- Why rejected: it spreads file-format knowledge through the UI, makes delete/error handling inconsistent, and weakens the single IO boundary that Phase 1 already established.

### Option C: Rebuild the app shell around a more complex coordinator/router now

- Description: replace the current simple `AppModel` screen switcher with a heavier navigation architecture before adding saved-session state.
- Why considered: future growth.
- Why rejected: the current shell already cleanly models the three destinations we need, and Phase 2 only requires one selected-session seam, not a framework-level rewrite.

---

## 4. Risk Map

| Component | Risk Level | Reason | Verification Needed |
|-----------|------------|--------|---------------------|
| Session-bundle read model | **MEDIUM** | The repository currently exposes only write-side behavior and private manifest structs | Focused validation with sample bundles and real Phase 1 artifacts |
| History refresh + navigation state | **MEDIUM** | New saved-session state has to coordinate Home, History, and Detail without drift | Focused validation in-app |
| Session detail rendering | **LOW** | Once the read model exists, transcript-plus-metadata rendering is straightforward SwiftUI | Normal validation |
| Delete flow | **MEDIUM** | Must remove local bundles safely and update selection/list state cleanly | Focused validation with real saved sessions |
| Honesty marker surfacing | **MEDIUM** | Depends on still-open review beads `bd-2ap` and `bd-15x` for full fidelity | Validation should check dependency alignment and visible fallback behavior |

### HIGH-Risk Summary (for `khuym:validating`)

None. Phase 2 is a medium-risk product surfacing phase built on an already-reviewed Phase 1 storage and recording loop.

---

## 5. Proposed File Structure

```text
MeetlessApp/
  App/
    AppModel.swift                # add selected-session state and refresh hooks
    MeetlessRootView.swift        # wire history/detail navigation to real saved-session state

  Features/
    History/
      HistoryView.swift           # render saved rows, status, delete actions
      HistoryViewModel.swift      # real list state instead of placeholder copy
    SessionDetail/
      SessionDetailView.swift     # render transcript snapshot and metadata
      SessionDetailViewModel.swift # selected-session detail loading state

  Services/
    SessionRepository/
      SessionRepository.swift     # read/list/load/delete API plus public DTOs
```

### File Direction

- Favor adding saved-session DTOs to `SessionRepository.swift` first so the UI can stay simple.
- Add a real `SessionDetailViewModel` if loading/detail formatting starts to exceed lightweight view logic.
- Keep `RecordingViewModel` focused on live recording. It should trigger refreshes, not become the owner of history/detail state.

---

## 6. Institutional Learnings Applied

- No prior repo learnings existed for this domain, so the main applied lesson is local to this feature: keep the saved-session UI anchored to the already-proven Phase 1 bundle contract instead of redesigning storage midstream.
