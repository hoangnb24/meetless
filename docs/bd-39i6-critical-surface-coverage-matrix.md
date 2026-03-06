# bd-39i6 — Critical-Surface Coverage Realism Matrix

Date: 2026-03-06
Related bead: `bd-39i6`
Parent feature: `bd-1ml1`
Related backlog: `bd-2elo`, `bd-5cz8`, `bd-11vg`, `bd-2ph4`, `bd-10ou`, `bd-2grd`, `bd-2mbp`, `bd-2ptr`, `bd-13tm`, `bd-1jc9`

## Goal

Identify the **current strongest test or verification lane** for each critical Recordit surface, classify the realism of that lane, and call out where the project still relies on mocks, fixtures, UI-test-mode bypasses, temp filesystems, or manual/document-only proof.

This document is intentionally **critical-path scoped**, not a full exhaustive index of every single test file. The exhaustive catalog now lives in `docs/bd-5cz8-test-surface-inventory.md`, and the seam-policy companion now lives in `docs/bd-39jy-mock-fixture-census.md`. Here the point is to answer the harder question: **what user-visible or runtime-visible surface is actually covered by something credible today, and where is the strongest claim still simulated?**

## Evidence Basis

This matrix was built from repository evidence on 2026-03-06 by scanning:

Repo-wide counts from the supporting inventory pass:

- Rust `#[test]` in `src/`: **249 tests** across **15** files
- Rust `tests/*.rs`: **69 tests** across **26** files
- Swift `*_smoke.swift`: **29** standalone smoke files
- XCTest/XCUITest suites: **2** primary files
- Primary shell/Python verification harnesses in the new exhaustive inventory: **11** files

- Rust tests under `tests/*.rs`
- Rust inline test modules in `src/bin/transcribe_live/preflight.rs` and `src/live_capture.rs`
- Swift smoke executables under `app/**/*_smoke.swift`
- app-level XCTest/XCUITest surfaces in `app/RecorditAppTests/RecorditAppTests.swift` and `app/RecorditAppUITests/RecorditAppUITests.swift`
- packaged/release shell lanes including `scripts/gate_packaged_live_smoke.sh`, `scripts/ci_recordit_xctest_evidence.sh`, `scripts/verify_recordit_release_context.sh`, and `scripts/create_recordit_dmg.sh`
- current validation guidance in `README.md`, `docs/bd-3p8a-release-context-matrix.md`, and `docs/bd-1mep-v1-release-posture.md`

Machine-readable companion inventory: `docs/bd-39i6-critical-surface-coverage-matrix.csv`

Downstream normalized handoff: `docs/bd-39i6-canonical-downstream-matrix.md` and `docs/bd-39i6-canonical-downstream-matrix.csv`

Supporting exhaustive inventory: `docs/bd-5cz8-test-surface-inventory.md` and `docs/bd-5cz8-test-surface-inventory.csv`

Supporting seam census / claim policy: `docs/bd-39jy-mock-fixture-census.md` and `docs/bd-39jy-mock-fixture-census.csv`

## Critical Findings

1. **No current lane proves the end-to-end app-shell → real runtime path without simulation seams.**
   - Swift app-level lanes are still dominated by `AppEnvironment.preview()`, `MockServices`, `Static*` / `Stub*` services, scripted runtime services, or `RECORDIT_UI_TEST_MODE`.
   - This is the central gap that `bd-2ph4` exists to close.

2. **The strongest “real runtime” lanes are still deterministic fake-capture lanes, not true TCC-granted user journeys.**
   - Rust live integration and packaged smoke exercise actual binaries and artifact production, but they depend on `RECORDIT_FAKE_CAPTURE_FIXTURE` rather than live microphone/screen capture.

3. **UI automation is real-app-launched but not realism-complete.**
   - `app/RecorditAppUITests/RecorditAppUITests.swift` launches the app, but `RECORDIT_UI_TEST_MODE=1` swaps in scripted preflight/runtime behavior and hardcoded runtime binary overrides (`/usr/bin/true`).
   - Those lanes are useful for deterministic flow coverage but must not be mistaken for production-backed onboarding/live-run proof.

4. **Session/history/export/search surfaces are mostly covered by temp-filesystem or mocked service lanes.**
   - These provide valuable logic coverage, but they do not yet prove packaged-app behavior against real retained session data under the product’s normal app shell.

5. **DMG install/open is not yet covered by a retained automated verification lane.**
   - The repo can build DMGs and documents the drag-to-Applications flow, but current proof is still script creation + manual/open instructions rather than a complete retained install/open verifier.
   - This leaves the strongest release-install claim at `Partial`.

6. **Some stronger-sounding runtime tests still degrade to skip-on-missing-prerequisite behavior.**
   - For example, `tests/live_stream_true_live_integration.rs` and `tests/bd_1n5v_contract_regression.rs` can skip when fixture/model prerequisites are unavailable.
   - That protects portability, but it also means green runs can overstate host-level readiness unless prerequisite presence is tracked explicitly in evidence.

## Coverage Status Interpretation

For downstream QA/policy work, treat **`covered-with-seams` as the canonical equivalent of simulation-only coverage**: a meaningful lane exists, but it still depends on mocks, fixtures, fake capture, UI-test-mode, preview DI, temp-filesystem assumptions, or packaged-only checks that prevent a real-environment claim.

This terminology is now aligned with:
- `docs/bd-5cz8-test-surface-inventory.csv` for exhaustive file-level evidence
- `docs/bd-39jy-mock-fixture-census.csv` for seam vocabulary and allowed-use policy

## Realism Legend

| Value | Meaning |
|---|---|
| `mock` | Core dependency replaced by mock service, stub, preview DI, or fake in-memory implementation |
| `fixture` | Test drives behavior from static JSON/WAV/text fixtures or scripted payloads |
| `temp-filesystem` | Test uses real file IO/processes in temp dirs but not the packaged app/user install context |
| `packaged-app` | Test or script operates on a built/signed app artifact |
| `manual-user-journey` | Proof currently depends on documented/manual steps rather than retained automated evidence |
| `live-real` | Genuine production-style execution without the above simulation seams |

## Critical-Surface Matrix

| Surface | Strongest current lane(s) | Layer | Realism | What is actually proven | Main simulation / bypass seam | Remaining gap | Follow-on bead(s) |
|---|---|---|---|---|---|---|---|
| Onboarding completion routing | `app/AppShell/onboarding_completion_smoke.swift`; `app/RecorditAppUITests/RecorditAppUITests.swift`; `app/RecorditAppTests/RecorditAppTests.swift` | smoke + xcuitest + xctest | `mock` + `fixture` | step progression, readiness gating decisions, onboarding completion persistence/routing | `StubModelResolutionService`, `StubCommandRunner`, `StubRuntimeReadinessChecker`, `AppEnvironment.preview()`, `RECORDIT_UI_TEST_MODE` | no production-backed first-run path using actual packaged runtime/model resolution | `bd-2ph4`, `bd-2ptr` |
| Permission remediation / recovery UX | `app/AppShell/permission_remediation_smoke.swift`; `app/RecorditAppUITests/RecorditAppUITests.swift` | smoke + xcuitest | `fixture` | copy/state behavior for permission failures and deterministic recovery flow | scripted preflight payloads; UI test mode replaces real TCC state with fixtures | no retained lane proving real macOS permission denial/regrant behavior in app context | `bd-2ph4`, `bd-2ptr` |
| Live readiness contract mapping | `src/bin/transcribe_live/preflight.rs` tests; `app/Preflight/preflight_gating_smoke.swift`; `app/Preflight/preflight_smoke.swift` | rust unit + swift smoke | `fixture` | readiness IDs, domain mapping, blocking vs warning behavior, fallback eligibility | JSON fixture envelopes and stub command runners instead of real preflight command against packaged app context | no end-to-end proof that UI only surfaces Rust-authoritative readiness state in real app runtime | `bd-2ph4`, `bd-11vg` |
| Runtime binary readiness / bundled payload resolution | `app/RuntimeProcessLayer/runtime_binary_readiness_smoke.swift`; `app/RecorditAppTests/RecorditAppTests.swift`; `scripts/verify_recordit_release_context.sh` | smoke + xctest + shell | `temp-filesystem` + `packaged-app` | absolute override validation, bundled runtime lookup expectations, packaged bundle payload presence/signing evidence | smoke lanes synthesize temporary bundle layouts and stub services | no single lane proves packaged app launch, runtime resolution, and first live start together | `bd-2ph4`, `bd-11vg` |
| App-shell → runtime start / stop / finalization | `app/Integration/process_lifecycle_integration_smoke.swift`; `app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift`; `app/ViewModels/runtime_stop_finalization_smoke.swift`; `app/UIAutomation/ui_automation_smoke.swift` | smoke/integration | `mock` + `temp-filesystem` | state transitions, bounded finalization handling, interruption/retry/recovery logic | `LiveRuntimeService`, `ScriptedRuntimeService`, synthetic manifests, temp roots, mocked session library/export services | no production-backed lane that drives actual app shell into actual runtime process and back to retained artifacts | `bd-2ph4`, `bd-10ou` |
| Live runtime streaming behavior / observability | `tests/live_stream_true_live_integration.rs`; `tests/runtime_live_stream_observability.rs`; `src/live_capture.rs` tests | rust integration + rust unit | `fixture` + `temp-filesystem` | live-stream artifact growth, stable transcript emission, scheduler/pressure diagnostics, fake-capture telemetry | `RECORDIT_FAKE_CAPTURE_FIXTURE` drives deterministic stereo capture instead of true device capture/TCC | no live-real lane for true capture devices and app-owned runtime path | `bd-11vg`, `bd-2mbp` |
| Fault handling and runtime degradation | `tests/live_asr_fault_injection_e2e.rs`; `tests/transcribe_live_failed_status_contract.rs`; `tests/recordit_exit_behavior_matrix.rs` | rust integration/contract | `fixture` + `temp-filesystem` | status mapping, retry/delete retention policies, exit-behavior contract, fault classification | synthetic audio fixture creation and direct binary invocation from tests | not yet connected to packaged app UX or app-shell recovery surfaces with shared evidence | `bd-11vg`, `bd-13tm` |
| Session artifact promotion / pending queue / migration repair | `app/Services/pending_queue_integration_smoke.swift`; `app/Services/pending_transcribe_action_smoke.swift`; `app/Services/startup_migration_repair_smoke.swift`; `app/Services/legacy_flat_migration_smoke.swift` | smoke/integration | `mock` + `temp-filesystem` | promotion/failure handling, repair/migration logic, sidecar/update behavior on real temp directories | mocked runtime services and synthetic session roots | no production-backed lane over real retained sessions created by actual app/runtime runs | `bd-10ou`, `bd-11vg` |
| Session list / history / search | `app/ViewModels/session_list_smoke.swift`; `app/Services/session_search_index_smoke.swift`; `app/Services/jsonl_tailer_smoke.swift`; `app/Services/jsonl_event_surface_smoke.swift` | smoke | `mock` + `fixture` + `temp-filesystem` | search indexing, event mapping, list filtering and empty/error states | `MockSessionLibraryService`, fixture JSONL/manifests, synthetic timestamps/paths | no packaged-app lane proves search/history behavior against real session corpus generated by product flows | `bd-10ou`, `bd-11vg` |
| Export / artifact actions | `app/Exports/export_smoke.swift`; `app/Exports/session_export_view_model_smoke.swift`; `app/UIAutomation/ui_automation_smoke.swift` | smoke | `mock` + `temp-filesystem` | export naming, path restrictions, view-model state, export action wiring | fixture manifest/JSONL payloads and `RecordingExportService`-style simulated behavior | no app-level or packaged lane validating export from real completed sessions | `bd-10ou`, `bd-11vg` |
| App-level XCTest responsiveness gates | `app/RecorditAppTests/RecorditAppTests.swift`; `scripts/ci_recordit_xctest_evidence.sh` | xctest + shell | `mock` + `fixture` | app-target responsiveness metrics, summary/xcresult evidence retention, required/optional lane accounting | preview environment and stub services stand in for production runtime/services | timing proof is valuable but not yet proof of real runtime responsiveness in shipped path | `bd-13tm`, `bd-2ph4` |
| XCUITest onboarding/live-run summaries | `app/RecorditAppUITests/RecorditAppUITests.swift`; `scripts/ci_recordit_xctest_evidence.sh` | xcuitest + shell | `fixture` | visible UI flow coverage with retained xcresult/log artifacts | `RECORDIT_UI_TEST_MODE=1`, `/usr/bin/true` runtime overrides, scripted preflight/runtime scenarios | still simulated-only for runtime/process/TCC truth | `bd-2ptr`, `bd-13tm` |
| CLI contract / schema / frozen artifact compatibility | `tests/recordit_cli_dispatch.rs`; `tests/recordit_cli_contract.rs`; `tests/runtime_jsonl_schema_contract.rs`; `tests/runtime_manifest_schema_contract.rs`; `tests/bd_1n5v_contract_regression.rs` | rust contract tests | `fixture` | CLI grammar stability, schema/event compatibility, frozen artifact parsing and contract drift detection | frozen JSON/JSONL fixtures and direct binary help/inspect output | strong compatibility proof, but not user-journey proof | `bd-11vg`, `bd-2mbp` |
| Packaged local signed app path | `scripts/verify_recordit_release_context.sh`; `scripts/gate_packaged_live_smoke.sh`; `README.md` packaged commands | shell | `packaged-app` + `fixture` | signed `dist/Recordit.app` payload/signing checks, packaged smoke artifact generation, default launch-plan semantics | packaged live smoke still uses deterministic fake capture and compatibility runtime assistance | no automated retained lane proving drag-install → first launch → onboarding → first live stop on installed DMG artifact | `bd-3co8`, `bd-13tm` |
| Release candidate signing / notarization posture | `docs/bd-3p8a-release-context-matrix.md`; `docs/bd-1uik-ga-signing-notarization-plan.md`; `docs/bd-b2qv-release-checklist.md` | docs/runbook | `manual-user-journey` | commands/evidence roots for DMG sign/notarize/staple/Gatekeeper workflow are defined | proof is procedural/documented until executed and archived for a concrete release candidate | requires retained GA-grade evidence, not just docs | `bd-13tm`, `bd-3p9b` |
| DMG install / mount / drag-to-Applications / open | `scripts/create_recordit_dmg.sh`; `README.md` local DMG instructions | shell + manual docs | `manual-user-journey` | DMG can be built with `Applications` symlink and documented open/install steps | no retained automated verifier mounts DMG, inspects layout, launches installed app, and captures diagnostics | highest install-surface gap remains open | `bd-3co8`, `bd-13pv` |

## Priority Gaps To Treat As Truthful “Not Covered Yet”

### 1. Production-backed app-shell integration is missing

The repo has many Swift lanes, but the highest-risk user journey still lacks a truthy test lane:

- install/build app
- launch app shell
- resolve real runtime/model payloads
- execute real readiness flow
- start live or record-only mode using production services
- stop/finalize and inspect retained session artifacts

That missing lane is the clearest blocker for claiming comprehensive app coverage.

### 2. UI-test-mode lanes need anti-bypass enforcement

Any lane using these seams should be explicitly labeled simulated until the repo has counter-balancing no-bypass proof:

- `RECORDIT_UI_TEST_MODE`
- `AppEnvironment.preview()`
- `MockServices` / `MockSessionLibraryService`
- `Static*` / `Stub*` / `Scripted*` Swift services
- `/usr/bin/true` runtime binary overrides

This is why `bd-2ptr` and `bd-1jc9` should remain first-class enforcement work, not cleanup chores.

### 3. Packaged smoke is strong but still not full install proof

`scripts/gate_packaged_live_smoke.sh` is currently the strongest packaged runtime lane, but it still does **not** prove:

- DMG mount/install/open behavior
- true first-run onboarding under real permissions
- unsimulated TCC grant/recovery behavior
- app-shell-driven runtime lifecycle without fake capture

### 4. Search/export/history proof is still mostly service-level

These lanes are valuable and should stay, but they should be described as:

- service/view-model correctness proof
- temp-filesystem artifact proof
- not yet full product-journey proof

## Recommended Downstream Sequencing

1. `bd-2ph4` — create the first production-backed app-shell/runtime lane
2. `bd-10ou` — cover real-filesystem session/artifact journeys without mock library services
3. `bd-2ptr` + `bd-1jc9` — detect and control bypass-heavy lanes so claims stay honest
4. `bd-2grd` + `bd-13tm` — unify evidence contracts across shell, XCTest, and XCUITest lanes
5. `bd-3co8` — close the DMG install/open gap
6. `bd-11vg` — publish the broader cross-surface gap report once the above truth baseline is accepted

## Notes For `bd-5cz8`

When the exhaustive inventory is built, it should preserve the classifications above and then expand to every current test surface, including:

- each Rust test file under `tests/`
- each relevant inline `#[test]` module in `src/`
- each Swift `_smoke.swift`
- each XCTest/XCUITest target/lane
- each shell/Python gate and its retained evidence schema

