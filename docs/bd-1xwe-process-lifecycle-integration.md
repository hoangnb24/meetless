# bd-1xwe: Process Lifecycle and Artifact Finalization Integration Coverage

## Goal

Validate runtime lifecycle integration across live and record-only flows, including crash/timeout control branches and manifest-driven finalization outcomes.

## Delivered

1. `app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift`
2. `docs/bd-1xwe-process-lifecycle-integration.md`

## Integration Coverage Added

`process_lifecycle_integration_smoke` now validates:

1. Live start/stop/finalize success:
   - launches live runtime through `ProcessBackedRuntimeService`
   - stops via runtime control
   - finalizes to `completed` when manifest artifact is present and status is `ok`

2. Live finalization failure path:
   - manifest presence with status `failed` maps to runtime failed terminal state
   - failure classification is `processExitedUnexpectedly`

3. Record-only lifecycle:
   - starts record-only runtime through `ProcessBackedRuntimeService`
   - verifies `session.pending.json` is created
   - verifies pending sidecar contract:
     - `mode=record_only`
     - `transcription_state=pending_model` when model path is not explicit
   - verifies cancel control succeeds

4. Crash control branch:
   - non-zero runtime termination maps to `AppServiceError(.processExitedUnexpectedly)`

5. Timeout control branch:
   - stop control timeout maps to `AppServiceError(.timeout)`

## Acceptance Mapping

1. Start/stop/finalize lifecycle validated for live and record-only:
   - covered by live + record-only integration scenarios.
2. Crash/timeout branches validated:
   - covered by dedicated crash and timeout scenarios.
3. Manifest artifact presence/finalization expectations validated:
   - covered by explicit manifest-presence success/failure scenarios.
