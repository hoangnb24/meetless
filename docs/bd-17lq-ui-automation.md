# bd-17lq — UI automation: onboarding, runtime, sessions, exports

## Summary
Implemented a deterministic UI-journey smoke harness that exercises the key user-facing flows end to end at view-model/navigation level:

- onboarding route + recovery routing behavior
- runtime start/stop happy path
- runtime interruption failure with explicit recovery actions
- sessions/history load/search/failure-recoverable behavior
- export success/failure behavior with diagnostics option pass-through

## Delivered
- `app/UIAutomation/ui_automation_smoke.swift` (new)

## Coverage

### 1) Onboarding + recovery navigation
- Fresh launch routes to `.onboarding`
- `finishOnboarding` routes to `.mainRuntime`
- Returning user with runtime readiness failure auto-routes to `.recovery`
- Recovery `back` returns to `.mainRuntime`

### 2) Runtime recording flow
- Happy path: `startLive` transitions to `.running`, `stopCurrentRun` transitions to `.completed`
- Failure/recovery path: stop control failure (`processExitedUnexpectedly`) transitions to `.failed` and exposes actionable recovery set including:
  - `resumeSession`
  - `safeFinalize`
  - `retryStop`
  - `openSessionArtifacts`

### 3) Session history flow
- Happy path: refresh loads expected session rows
- Search miss path: unmatched query transitions to `.empty`
- Failure/recovery path: list failure transitions to `.failed` while preserving prior recoverable items

### 4) Export flow
- Diagnostics export happy path emits success completion messaging
- Diagnostics transcript opt-in is propagated into export request
- Permission failure path transitions to `.failed` and surfaces user-facing error text

## Validation
```bash
swiftc \
  app/Accessibility/AccessibilityContracts.swift \
  app/Services/ServiceInterfaces.swift \
  app/Services/MockServices.swift \
  app/Services/PendingSessionSidecarService.swift \
  app/Services/PendingSessionTransitionService.swift \
  app/Services/PendingSessionFinalizerService.swift \
  app/Services/PendingSessionTranscriptionService.swift \
  app/Services/PendingSessionNotificationService.swift \
  app/RuntimeStatus/ManifestFinalStatusMapper.swift \
  app/ViewModels/RuntimeViewModel.swift \
  app/ViewModels/SessionListViewModel.swift \
  app/Exports/SessionExportService.swift \
  app/Exports/SessionExportViewModel.swift \
  app/AppShell/OnboardingCompletionStore.swift \
  app/AppShell/ModelSetupViewModel.swift \
  app/AppShell/PreflightViewModel.swift \
  app/Preflight/PreflightRunner.swift \
  app/Preflight/PreflightGatingPolicy.swift \
  app/RuntimeProcessLayer/RuntimeProcessManager.swift \
  app/RuntimeProcessLayer/RuntimeBinaryReadinessService.swift \
  app/Navigation/NavigationModels.swift \
  app/Navigation/AppNavigationCoordinator.swift \
  app/AppShell/AppShellViewModel.swift \
  app/UIAutomation/ui_automation_smoke.swift \
  -o /tmp/ui_automation_smoke && /tmp/ui_automation_smoke
# ui_automation_smoke: PASS
```

```bash
UBS_MAX_DIR_SIZE_MB=5000 ubs \
  app/UIAutomation/ui_automation_smoke.swift \
  docs/bd-17lq-ui-automation.md
```
