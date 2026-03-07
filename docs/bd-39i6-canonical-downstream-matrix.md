# bd-39i6 — Canonical Downstream Matrix Seed

Date: 2026-03-06
Source bead: `bd-39i6`
Primary downstream consumers: `bd-11vg`, `bd-2mbp`, `bd-1jc9`, `bd-3p9b`, `bd-13tm`

## Purpose

This is the normalized handoff artifact for the first `bd-39i6` inventory pass. It converts the narrative findings into a stable table shape that downstream policy, scanner, CI, and reporting beads can consume without reinterpreting prose.

Default interpretation rule:

- Any surface without an explicit `lane_id` is `uncovered`.
- Any lane that depends on `RECORDIT_UI_TEST_MODE`, `AppEnvironment.preview()`, `Mock*`/`Stub*` services, `/usr/bin/true` runtime overrides, or `RECORDIT_FAKE_CAPTURE_FIXTURE` is **not** `live-real`.
- Any row with only docs/manual commands as evidence is `partial` until retained execution evidence exists.

## Enumerations

### `realism_class`

- `mock`
- `fixture`
- `temp-filesystem`
- `scripted`
- `packaged-app`
- `manual-user-journey`
- `uncovered`

### `evidence_quality`

- `retained-rich` — structured retained evidence exists (`xcresult`, phase logs, stdout/stderr, artifact roots)
- `retained-partial` — some retained logs/artifacts exist, but not enough for uniform triage
- `local-test-only` — coverage exists mainly as test assertions without a standardized retained evidence root
- `docs-only` — procedure/runbook only
- `none` — no canonical lane found

### `confidence_level`

- `high-bounded` — strong for the narrow claim, but realism seams limit generalization
- `medium` — useful proof, but the lane is materially simulated or partial
- `low` — weak or procedural proof only
- `none` — no current proof

### `gap_status`

- `covered-with-seams`
- `partial`
- `uncovered`

## Canonical Matrix

| surface_key | journey | owning_modules | lane_id | realism_class | evidence_quality | confidence_level | gap_status | main_bypass_or_limit | remaining_gap | follow_on_beads |
|---|---|---|---|---|---|---|---|---|---|---|
| onboarding-completion-routing | first-run onboarding reaches main shell | `app/RecorditApp`, `app/AppShell`, `app/RecorditAppUITests` | `app/RecorditAppUITests/RecorditAppUITests.swift::testFirstRunOnboardingHappyPathTransitionsToMainRuntime`; `app/AppShell/onboarding_completion_smoke.swift::main` | `scripted` | `retained-partial` | `medium` | `covered-with-seams` | `RECORDIT_UI_TEST_MODE`, `AppEnvironment.preview()`, stub services | no production-backed first-run lane using actual packaged runtime/model resolution | `bd-2ph4`, `bd-2ptr`, `bd-11vg` |
| permission-remediation | denied permissions and recovery guidance | `app/AppShell`, `app/RecorditAppUITests` | `app/RecorditAppUITests/RecorditAppUITests.swift::testPermissionDenialRemediationRecoversToOnboardingProgression`; `app/AppShell/permission_remediation_smoke.swift::main` | `scripted` | `retained-partial` | `medium` | `covered-with-seams` | scripted preflight payloads; ui-test-mode bypass | no real TCC prompt/system-settings round trip coverage | `bd-2ptr`, `bd-2ph4`, `bd-11vg` |
| startup-runtime-readiness | startup resolves runtime/model and rejects bad overrides | `app/RuntimeProcessLayer`, `app/RecorditAppTests`, `scripts` | `app/RuntimeProcessLayer/runtime_binary_readiness_smoke.swift::main`; `app/RecorditAppTests/RecorditAppTests.swift::testRuntimeBinaryReadinessRejectsRelativeOverride`; `scripts/verify_recordit_release_context.sh` | `temp-filesystem` | `retained-partial` | `high-bounded` | `covered-with-seams` | temp executable shims and test doubles; packaged audit is non-launching | no lane proves packaged app launch, runtime resolution, and first live start together | `bd-2ph4`, `bd-11vg` |
| preflight-contract-gating | readiness IDs and fallback policy | `app/Preflight`, `app/RecorditAppTests` | `app/Preflight/preflight_gating_smoke.swift::main`; `app/RecorditAppTests/RecorditAppTests.swift::testPreviewEnvironmentRuntimeAndPreflightContracts` | `fixture` | `local-test-only` | `high-bounded` | `covered-with-seams` | fixture envelopes and preview environment | no full app lane proves production preflight in shipped app context | `bd-2ph4`, `bd-11vg` |
| app-shell-runtime-lifecycle | app starts live run, stops, finalizes, and reflects summary | `app/Integration`, `app/ViewModels`, `app/RecorditAppUITests`, `app/RuntimeProcessLayer` | `app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift::main`; `app/ViewModels/runtime_stop_finalization_smoke.swift::main`; `app/RecorditAppUITests/RecorditAppUITests.swift::testLiveRunStartStopShowsRuntimeStatusTranscriptAndSummary` | `scripted` | `retained-partial` | `medium` | `covered-with-seams` | scripted runtime services, `/usr/bin/true` overrides, synthetic manifests | no production-backed app-shell to actual runtime process lane | `bd-2ph4`, `bd-10ou`, `bd-11vg` |
| live-runtime-streaming | runtime emits streaming artifacts during live transcription | `tests`, `src/live_capture.rs` | `tests/live_stream_true_live_integration.rs::live_stream_emits_stable_before_timeout_and_artifacts_grow_in_flight`; `tests/runtime_live_stream_observability.rs`; `src/live_capture.rs` | `fixture` | `local-test-only` | `high-bounded` | `covered-with-seams` | `RECORDIT_FAKE_CAPTURE_FIXTURE` deterministic capture; prerequisite-based skips | no live-real device/TCC capture lane through product app path | `bd-11vg`, `bd-2mbp` |
| fault-handling | runtime failure paths classify and retain evidence | `tests`, `src/bin/transcribe_live` | `tests/live_asr_fault_injection_e2e.rs`; `tests/transcribe_live_failed_status_contract.rs`; `tests/recordit_exit_behavior_matrix.rs` | `fixture` | `local-test-only` | `high-bounded` | `covered-with-seams` | synthetic fixtures and direct binary invocation | not connected to packaged-app UX recovery with shared evidence contract | `bd-11vg`, `bd-13tm` |
| session-artifact-promotion | pending queue, migration, and retained session promotion | `app/Services` | `app/Services/pending_queue_integration_smoke.swift::main`; `app/Services/pending_transcribe_action_smoke.swift::main`; `app/Services/startup_migration_repair_smoke.swift::main` | `temp-filesystem` | `local-test-only` | `medium` | `covered-with-seams` | synthetic roots and mock runtime/library services | no production-backed retained-session lane from actual runs | `bd-10ou`, `bd-11vg` |
| session-history-search | session list, search, and retained-corpus navigation | `app/ViewModels`, `app/Services`, `app/Navigation` | `app/ViewModels/session_list_smoke.swift::main`; `app/Services/session_search_index_smoke.swift::main`; `app/Navigation/navigation_smoke.swift::main` | `temp-filesystem` | `local-test-only` | `medium` | `covered-with-seams` | temp session corpus and mock navigation/service seams | no packaged-app proof against real session corpus generated by product flows | `bd-10ou`, `bd-11vg` |
| export-actions | export transcript/audio/bundles from completed sessions | `app/Exports`, `app/UIAutomation` | `app/Exports/export_smoke.swift::main`; `app/Exports/session_export_view_model_smoke.swift::main`; `app/UIAutomation/ui_automation_smoke.swift::main` | `fixture` | `local-test-only` | `medium` | `covered-with-seams` | fixture manifests and simulated export services | no app-level or packaged lane validating export from real completed sessions | `bd-10ou`, `bd-11vg` |
| ui-automation-live-run | visible onboarding/live-run summary flow with retained xcresult evidence | `app/RecorditAppUITests`, `scripts` | `app/RecorditAppUITests/RecorditAppUITests.swift`; `scripts/ci_recordit_xctest_evidence.sh` | `scripted` | `retained-rich` | `medium` | `covered-with-seams` | `RECORDIT_UI_TEST_MODE=1`, scripted preflight/runtime, `/usr/bin/true` runtime overrides | still simulated-only for runtime/process/TCC truth | `bd-2ptr`, `bd-13tm`, `bd-11vg` |
| packaged-local-app-path | signed packaged app payload checks, packaged live smoke, and DMG install/open verifier | `scripts`, `dist/Recordit.app` | `scripts/verify_recordit_release_context.sh`; `scripts/gate_packaged_live_smoke.sh`; `scripts/gate_dmg_install_open.sh` | `packaged-app` | `retained-rich` | `high-bounded` | `partial` | deterministic fake capture plus retained installed-DMG launch diagnostics | onboarding + first live start/stop are not yet covered in this installed-DMG lane | `bd-78qy`, `bd-13tm`, `bd-11vg` |
| release-signing-notarization | release-candidate sign/notarize/staple/Gatekeeper workflow | `docs`, `scripts` | `docs/bd-3p8a-release-context-matrix.md`; `docs/bd-1uik-ga-signing-notarization-plan.md`; `docs/bd-b2qv-release-checklist.md` | `manual-user-journey` | `docs-only` | `low` | `partial` | runbook/procedure only | needs retained GA-grade execution evidence, not just docs | `bd-13tm`, `bd-3p9b` |
| dmg-install-open | mount DMG, inspect layout, copy/install, open app, retain diagnostics | `scripts`, `README.md` | `scripts/gate_dmg_install_open.sh`; `scripts/create_recordit_dmg.sh`; `README.md` | `packaged-app` | `retained-rich` | `medium` | `partial` | retained automated verifier now captures mount/layout/copy/open diagnostics | lane currently stops at install/open and does not include onboarding/live-stop proof | `bd-78qy`, `bd-13pv`, `bd-11vg` |
| playback-functional | functional playback controls against real session media in app context | `app`, `docs` | `none` | `uncovered` | `none` | `none` | `uncovered` | no canonical playback lane found | no play/pause/seek/audio-device verification in app context | `bd-10ou`, `bd-11vg` |
| production-app-journey | production AppEnvironment onboarding to live run to session review | `app/RecorditApp`, `app/AppShell`, `scripts` | `none` | `uncovered` | `none` | `none` | `uncovered` | no current lane without preview/ui-test-mode seams | no end-to-end production-environment product journey found | `bd-2ph4`, `bd-10ou`, `bd-11vg` |

## Immediate Use Rules For Downstream Beads

- `bd-11vg` should treat this file as the seed for the broader canonical gap report and extend it with module-level expansion.
- `bd-2mbp` should define the exception register against the `main_bypass_or_limit` column rather than informal discussion.
- `bd-1jc9` should fail or warn on unregistered occurrences of the bypass patterns called out here.
- `bd-3p9b` should require that every `partial` or `uncovered` row is either linked to an open bead or explicitly downgraded in coverage claims.
- `bd-13tm` should treat `retained-rich` versus `retained-partial` as the baseline for evidence validation policy.
