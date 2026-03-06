# bd-384f: Session Outcome Taxonomy and Validation Notes

## Outcome taxonomy now enforced

`RuntimeViewModel` now separates live-session failure/finalization outcomes into distinct, inspectable buckets:

- `empty_session_failure`
  - no primary artifacts were created before the session failed or finalization timed out
  - recovery guidance avoids resume/safe-finalize flows and only offers retained diagnostics when they actually exist
- `partial_artifact_failure`
  - the session failed after at least one primary artifact (`session.manifest.json`, `session.jsonl`, or `session.wav`) was written
  - recovery guidance preserves interruption-style actions such as Resume and Safe Finalize
- `finalized_failure`
  - manifest finalization completed, but the manifest status mapped to a failed terminal outcome
  - recovery guidance is narrowed to artifact inspection plus starting a new session, without advertising interruption recovery

## Validation coverage

Focused smoke coverage now proves the taxonomy and adjacent process behavior are truthful:

- `app/ViewModels/runtime_stop_finalization_smoke.swift`
  - passes for empty-session timeout classification
  - passes for partial-artifact interruption classification
  - passes for finalized-failure classification and recovery-action narrowing
- `app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift`
  - passes for manifest-driven live success/failure mapping
  - passes for record-only pending-sidecar creation and cancel control success
  - passes for crash and timeout process-control branches

## Fresh-eyes fixes landed while validating

Two concrete issues surfaced during validation and were fixed:

1. Intentional `.cancel` termination was being reported as `processExitedUnexpectedly` when the child exited from the SIGTERM we requested.
   - `RuntimeProcessManager` now normalizes requested `.cancel` SIGTERM termination to successful control completion.
2. The timeout smoke helper could be interrupted before its shell wrapper had `exec`'d into the signal-ignoring stub.
   - the smoke now uses a signal-ignoring Perl helper and waits briefly before issuing stop so the timeout branch tests the intended process.
