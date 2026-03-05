# bd-1xwe — Integration tests: process lifecycle and artifact finalization

## Summary
Added a deterministic integration smoke that validates process lifecycle and artifact finalization across both runtime modes required by this bead:

- live runtime lifecycle via `RuntimeViewModel`
- record-only deferred transcription lifecycle via `PendingSessionTranscriptionService`

The smoke covers success and primary failure branches (interruption/crash, timeout, failed manifest status), and asserts final state + artifact expectations.

## Delivered
- `app/Integration/process_lifecycle_integration_smoke.swift` (new)

## Coverage Matrix

### Live mode (`RuntimeViewModel`)
1. **Happy path**
- start transitions to running
- stop transitions through bounded finalization to completed

2. **Interruption / crash on stop**
- stop control throws `processExitedUnexpectedly`
- state becomes failed
- recovery set includes interruption actions (`resumeSession`, `safeFinalize`) and stop remediation (`retryStop`)

3. **Finalization timeout**
- manifest remains unavailable until timeout
- state becomes failed with `timeout`
- recovery set includes `retryFinalize`

4. **Failed manifest status**
- manifest status `failed` maps to failed state
- failure code maps to `processExitedUnexpectedly`

### Record-only mode (`PendingSessionTranscriptionService`)
1. **Happy path**
- runtime emits manifest status `ok`
- final state returns `completed`
- pending sidecar (`session.pending.json`) is removed

2. **Launch failure**
- runtime launch throws `processLaunchFailed`
- sidecar transitions to `failed`
- retry context (`session.pending.retry.json`) is persisted

3. **Timeout waiting for manifest**
- runtime launches but emits no manifest
- action throws `timeout`
- sidecar transitions to `failed`
- retry context is persisted

4. **Failed manifest status**
- runtime emits manifest status `failed`
- action throws `processExitedUnexpectedly`
- sidecar transitions to `failed`

## Validation
```bash
swiftc \
  app/Accessibility/AccessibilityContracts.swift \
  app/Services/ServiceInterfaces.swift \
  app/Services/PendingSessionSidecarService.swift \
  app/Services/PendingSessionTransitionService.swift \
  app/Services/PendingSessionFinalizerService.swift \
  app/Services/PendingSessionTranscriptionService.swift \
  app/RuntimeStatus/ManifestFinalStatusMapper.swift \
  app/ViewModels/RuntimeViewModel.swift \
  app/Integration/process_lifecycle_integration_smoke.swift \
  -o /tmp/process_lifecycle_integration_smoke && /tmp/process_lifecycle_integration_smoke
# process_lifecycle_integration_smoke: PASS
```

```bash
UBS_MAX_DIR_SIZE_MB=5000 ubs \
  app/Integration/process_lifecycle_integration_smoke.swift \
  docs/bd-1xwe-integration-lifecycle.md
```
