# bd-2n6m: UX Spec Traceability Matrix

Date: 2026-03-05

## Scope

This matrix maps v1 UX/UI journey requirements to:

1. Beads issue IDs (`bd-*`)
2. implementation modules/files
3. deterministic validation evidence with explicit proof class boundaries (smoke/integration vs app-level vs release-level)

Primary spec source:
- `plan/recordit-user-interfaces-journey.md`

Supporting canonical contracts:
- `docs/ux-copy-lexicon.md`
- `docs/architecture-swiftui-module-map.md`

Superseded-entrypoint context:
- `docs/adr-005-recordit-default-entrypoint.md` is now the canonical user-facing default policy.
- any historical `SequoiaTranscribe.app` default wording referenced by linked artifacts should be interpreted as compatibility/fallback context only.

## Traceability Matrix

| Clause ID | Spec Clause (source) | Beads / Issues | Implementation Modules | Test / Evidence | Coverage |
|---|---|---|---|---|---|
| UX-US-01 | DMG-first install/release path (`Product Goal`, `Primary User Stories` #1) | `bd-b2qv`, `bd-1uik`, `bd-2n4m`, `bd-3egg` | `docs/bd-b2qv-release-checklist.md`, `docs/bd-1uik-ga-signing-notarization-plan.md`, `docs/adr-005-recordit-default-entrypoint.md` | release checklists + gate commands in docs; default-entrypoint supersession policy in ADR-005; soak gate tracked by `bd-2n4m` | Partial (soak/cutover in progress) |
| UX-US-02 | First launch guides setup (permissions + model) (`Primary User Stories` #2, `First-Run Onboarding Journey`) | `bd-19iv`, `bd-33d5`, `bd-7uap`, `bd-p4p4`, `bd-2jsx`, `bd-1aqk`, `bd-3c0x` | `app/AppShell/PermissionRemediationViewModel.swift`, `app/AppShell/ModelSetupViewModel.swift`, `app/Preflight/PreflightGatingPolicy.swift`, `app/AppShell/AppShellViewModel.swift`, `app/RuntimeProcessLayer/RuntimeBinaryReadinessService.swift`, `app/RecorditApp/OnboardingFlowView.swift`, `app/RecorditAppUITests/RecorditAppUITests.swift` | Smoke/integration: `app/AppShell/permission_remediation_smoke.swift`, `app/Services/model_resolution_smoke.swift`, `app/Preflight/preflight_gating_smoke.swift`, `app/AppShell/onboarding_completion_smoke.swift`, `app/RuntimeProcessLayer/runtime_binary_readiness_smoke.swift`; App-level evidence: `docs/bd-1aqk-first-run-onboarding-xcuitest.md`, `docs/bd-3c0x-permission-remediation-xcuitest.md`; Release evidence: `docs/bd-55np-release-rehearsal-report.md` | Partial (app-level covered; release-level first-run proof remains limited to rehearsal launch surface) |
| UX-US-03 | User can start/stop/review output fully in app (`Primary User Stories` #3, `Main Runtime Journey`) | `bd-2pdv`, `bd-2jhd`, `bd-30zd`, `bd-1xwe`, `bd-17lq`, `bd-b4h6`, `bd-2ghc` | `app/Navigation/AppNavigationCoordinator.swift`, `app/ViewModels/RuntimeViewModel.swift`, `app/RecorditApp/MainSessionView.swift`, `app/RecorditApp/MainWindowView.swift`, `app/RecorditAppUITests/RecorditAppUITests.swift` | Smoke/integration: `app/Navigation/navigation_smoke.swift`, `app/ViewModels/runtime_state_machine_smoke.swift`, `app/ViewModels/runtime_stop_finalization_smoke.swift`, `app/Integration/process_lifecycle_integration_smoke.swift`, `app/UIAutomation/ui_automation_smoke.swift`; App-level evidence: `docs/bd-b4h6-live-run-xcuitest.md`, `docs/bd-2ghc-session-summary-artifact-actions-xcuitest.md`; Release evidence: `docs/bd-55np-release-rehearsal-report.md` | Partial (app-level journey proof landed; release rehearsal confirms launch/install, not full in-window journey replay) |
| UX-US-04 | User chooses `Live Transcribe` or `Record Only` (`Primary User Stories` #4, `Main Runtime Journey`) | `bd-2jhd`, `bd-1m3z`, `bd-1xwe`, `bd-17lq`, `bd-8du2`, `bd-b4h6` | `app/ViewModels/RuntimeViewModel.swift`, `app/Services/PendingSessionTranscriptionService.swift`, `app/RuntimeProcessLayer/RuntimeProcessManager.swift`, `app/RecorditApp/MainSessionView.swift`, `app/RecorditAppTests/RecorditAppTests.swift` | Smoke/integration: `app/Integration/process_lifecycle_integration_smoke.swift`, `app/Services/pending_transcribe_action_smoke.swift`, `app/UIAutomation/ui_automation_smoke.swift`; App-level evidence: `docs/bd-8du2-xctest-targets.md`, `docs/bd-b4h6-live-run-xcuitest.md`; Release evidence: `docs/bd-55np-release-rehearsal-report.md` | Partial (live path app-level proof covered; record-only mode still depends on release/support matrix hardening) |
| UX-US-05 | Offline journey: record now, transcribe later (`Primary User Stories` #5, `Offline Journey`) | `bd-xknj`, `bd-1m3z`, `bd-125h`, `bd-2i3h` | `app/Services/PendingSessionTransitionService.swift`, `app/Services/PendingSessionTranscriptionService.swift`, `app/Services/PendingSessionNotificationService.swift`, `app/ViewModels/SessionListViewModel.swift` | `app/Services/pending_transition_smoke.swift`, `app/Services/pending_transcribe_action_smoke.swift`, `app/ViewModels/session_list_smoke.swift`, `app/Integration/process_lifecycle_integration_smoke.swift` | Covered |
| UX-ARCH-01 | UI consumes structured artifacts; no terminal parsing (`Runtime Topology`, `Reliability Requirements` #3) | `bd-1a25`, `bd-n7cp`, `bd-2zxu` | `app/Services/FileSystemJsonlTailService.swift`, `app/Services/JsonlEventSurfaceMapper.swift`, `docs/architecture-swiftui-module-map.md` | `app/Services/jsonl_tailer_smoke.swift`, `app/Services/jsonl_event_surface_smoke.swift`, boundary checklist in `docs/architecture-swiftui-module-map.md` | Covered |
| UX-STATUS-01 | Final badge/status is manifest-driven (`Session Artifact Contract`, `Exit and Status Semantics`) | `bd-1g73`, `bd-30zd`, `bd-1xwe` | `app/RuntimeStatus/ManifestFinalStatusMapper.swift`, `app/ViewModels/RuntimeViewModel.swift` | `app/ViewModels/runtime_status_mapping_smoke.swift`, `app/ViewModels/runtime_stop_finalization_smoke.swift`, `app/Integration/process_lifecycle_integration_smoke.swift` | Covered |
| UX-PREFLIGHT-01 | Blocking/warn preflight semantics with explicit acknowledgement (`Permission Integration`) | `bd-7uap`, `bd-p4p4` | `app/Preflight/PreflightGatingPolicy.swift`, `app/AppShell/PreflightViewModel.swift`, `app/AppShell/AppShellViewModel.swift` | `app/Preflight/preflight_gating_smoke.swift`, `app/AppShell/onboarding_completion_smoke.swift` | Covered |
| UX-MODEL-01 | Model resolution precedence + backend-kind constraints (`Model Asset Technical Spec`) | `bd-33d5` | `app/Services/FileSystemModelResolutionService.swift`, `app/AppShell/ModelSetupViewModel.swift` | `app/Services/model_resolution_smoke.swift` | Covered |
| UX-RUNTIME-01 | Session state-machine transition constraints (`Session State Machine`) | `bd-2jhd`, `bd-30zd`, `bd-fggr` | `app/ViewModels/RuntimeViewModel.swift` | `app/ViewModels/runtime_state_machine_smoke.swift`, `app/ViewModels/runtime_stop_finalization_smoke.swift` | Covered |
| UX-RUNTIME-02 | Bounded stop/finalization and recoverable failure actions (`Reliability Requirements` #2) | `bd-30zd`, `bd-fggr`, `bd-1xwe` | `app/ViewModels/RuntimeViewModel.swift`, `app/Integration/process_lifecycle_integration_smoke.swift` | `app/ViewModels/runtime_stop_finalization_smoke.swift`, `app/Integration/process_lifecycle_integration_smoke.swift`, `app/UIAutomation/ui_automation_smoke.swift` | Covered |
| UX-JSONL-01 | Tailer handles newline termination, malformed rows, resumable cursor (`Reliability Requirements` #4/#5/#6) | `bd-1a25`, `bd-n7cp` | `app/Services/FileSystemJsonlTailService.swift`, `app/Services/JsonlEventSurfaceMapper.swift` | `app/Services/jsonl_tailer_smoke.swift`, `app/Services/jsonl_event_surface_smoke.swift` | Covered |
| UX-EXPORT-01 | Deterministic export naming and diagnostics privacy controls (`Main Runtime Journey`, `Security and Privacy Requirements` #4) | `bd-2j6l`, `bd-2hxr`, `bd-1tuy`, `bd-2snv` | `app/Exports/SessionExportService.swift`, `app/Exports/SessionExportViewModel.swift` | `app/Exports/export_smoke.swift`, `app/Exports/session_export_view_model_smoke.swift`, docs `bd-1tuy`/`bd-2snv` acceptance mapping | Covered |
| UX-SESSIONS-01 | Sessions/history filtering, empty/error states, and recoverable list behavior (`Out of Scope` carveout handled as v1-lite) | `bd-2i3h`, `bd-125h`, `bd-1m3z` | `app/ViewModels/SessionListViewModel.swift`, `app/Services/PendingSessionNotificationService.swift` | `app/ViewModels/session_list_smoke.swift` | Covered (v1-lite) |
| UX-COPY-01 | Canonical onboarding/runtime/export lexicon and stable string key scheme (`docs/ux-copy-lexicon.md`) | `bd-2m6f`, `bd-3lkr` | `docs/ux-copy-lexicon.md`, `app/Accessibility/AccessibilityContracts.swift` | `app/Accessibility/accessibility_smoke.swift` + lexicon contract doc | Covered |

## Bead-to-Doc Index (This Session)

This matrix consolidates evidence from prior bead docs and smokes so maintainers can answer, for any UX requirement:

1. which issue(s) implemented it
2. which module owns behavior
3. which deterministic test/doc artifact proves it

Coverage rule for this matrix:
- mark rows `Covered` only when app-level and release-level evidence are both present for the clause (smoke-only proof is necessary but insufficient).

## Update Protocol (Keep Current)

When scope evolves, update this file in the same PR/session as the behavior change:

1. Add or update row(s) for every changed spec clause.
2. Include at least one `bd-*` issue id per clause.
3. Link at least one implementation module path and one deterministic validation artifact.
4. Mark coverage status (`Covered`, `Partial`, or scoped qualifier like `Covered (v1-lite)`).
5. If a clause is not yet complete, create/track a bead and mark row `Partial` until closed.
