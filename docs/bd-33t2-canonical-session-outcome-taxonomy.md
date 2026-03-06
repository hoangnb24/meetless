# bd-33t2: Canonical Session Outcome Taxonomy and Codes

## Canonical split

The shared service layer now carries two related but distinct machine-readable session outcome surfaces:

- `SessionOutcomeClassification`
  - stable 4-bucket classification used for broad UX/reporting decisions
  - values:
    - `empty_root`
    - `partial_artifact`
    - `finalized_failure`
    - `finalized_success`
- `SessionOutcomeCode`
  - finer-grained canonical code recorded in `outcomeDiagnostics["outcome_code"]`
  - values:
    - `empty_session_root`
    - `partial_artifact_session`
    - `finalized_failure`
    - `finalized_success`
    - `finalized_degraded_success`

## Why both exist

`SessionOutcomeClassification` stays intentionally compact so downstream surfaces can reason about the major bucket without exploding switch logic.

`SessionOutcomeCode` carries the more precise contract language needed by diagnostics/export/e2e surfaces, especially for the distinction between ordinary finalized success and degraded finalized success. Degraded finalized success now includes both explicit `session_status=degraded` manifests and `session_status=ok` manifests whose trust surface reports one or more notices.

## Current wiring

The canonical outcome contract is now exposed in two compatible forms:

- explicit DTO field: `outcomeCode`
- diagnostics compatibility key: `outcomeDiagnostics["outcome_code"]`

Both are now emitted by:

- `FileSystemSessionLibraryService`
- `FileSystemArtifactIntegrityService`

This keeps session-list discovery and artifact-integrity reporting aligned on the same machine-readable outcome contract.
