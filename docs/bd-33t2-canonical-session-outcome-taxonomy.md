# bd-33t2 — Canonical session outcome taxonomy and diagnostic codes

Date: 2026-03-07
Related bead: `bd-33t2`
Parent feature: `bd-384f`
Primary implementation sources:
- `app/Services/ServiceInterfaces.swift`
- `app/Services/FileSystemSessionLibraryService.swift`
- `app/Services/ArtifactIntegrityService.swift`
Primary exercised coverage:
- `app/Services/pending_transition_smoke.swift`
- `app/Services/real_filesystem_session_integration_smoke.swift`

## Purpose

Define the canonical machine-readable outcome taxonomy for Recordit session roots so downstream UX, export, support-bundle, stop/finalization, and diagnostics surfaces all speak one contract.

This taxonomy answers a different question than retained e2e phase results.

- e2e phase status answers: **how did a verification lane run?**
- session outcome taxonomy answers: **what state is this session root in for product and support purposes?**

That distinction matters because a green or failed test run is not itself the same thing as a session artifact outcome.

## Canonical split

The shared service layer now carries two related but distinct machine-readable outcome surfaces.

### `SessionOutcomeClassification`

A stable four-bucket classification used for broad UX/reporting decisions.

Values:
- `empty_root`
- `partial_artifact`
- `finalized_failure`
- `finalized_success`

### `SessionOutcomeCode`

A finer-grained canonical code recorded both as a typed DTO field and in diagnostics payloads.

Values:
- `empty_session_root`
- `partial_artifact_session`
- `finalized_failure`
- `finalized_success`
- `finalized_degraded_success`

## Why both exist

`SessionOutcomeClassification` stays intentionally compact so downstream surfaces can reason about the major bucket without exploding switch logic.

`SessionOutcomeCode` carries the more precise contract language needed by diagnostics/export/e2e/support surfaces, especially for the distinction between ordinary finalized success and degraded finalized success.

## Canonical mapping rules

The authoritative mapping is defined in `SessionOutcomeClassification.canonicalCode(manifestStatus:)` in `app/Services/ServiceInterfaces.swift`.

| Classification | Manifest status context | Canonical code | Meaning |
| --- | --- | --- | --- |
| `empty_root` | no usable manifest status | `empty_session_root` | the session root is missing or contains no retained runtime artifacts |
| `partial_artifact` | any partial or not-fully-finalized state | `partial_artifact_session` | some retained artifacts exist, but the session is not a finalized complete session |
| `finalized_failure` | finalized manifest with `failed` status | `finalized_failure` | the session finalized into a failed terminal state |
| `finalized_success` | finalized manifest with `ok` status | `finalized_success` | the session finalized successfully without degraded trust/runtime status |
| `finalized_success` | finalized manifest with `degraded` status | `finalized_degraded_success` | the session finalized successfully, but the result is degraded and must retain that distinction |

Interpretation rule:
- `finalized_degraded_success` is a **code**, not a fifth classification bucket
- the broader classification remains `finalized_success`

## How classification is derived today

The current canonical classification logic is shared across session discovery and artifact-integrity evaluation.

### Finalized manifest present

When a manifest is present:
- `manifest.status == failed` -> `finalized_failure`
- `manifest.status == ok` or `manifest.status == degraded` **and** `session.wav` exists -> `finalized_success`
- `manifest.status == ok` or `manifest.status == degraded` but `session.wav` is missing -> `partial_artifact`
- `manifest.status == pending` -> `partial_artifact`

### No manifest-derived finalized state

When a finalized manifest does not establish the state:
- any retained artifact presence (`manifest`, `pending`, `retry_context`, `wav`, or `jsonl`) -> `partial_artifact`
- no retained artifacts -> `empty_root`

This keeps the taxonomy rooted in artifact truth, not in optimistic assumptions.

## Canonical diagnostics contract

The current canonical outcome contract is exposed in two compatible forms:

- explicit DTO field: `outcomeCode`
- diagnostics compatibility key: `outcomeDiagnostics["outcome_code"]`

Related companion field:
- `outcomeDiagnostics["outcome_classification"]`

### Required diagnostics keys

The current emitters preserve these baseline keys in `outcomeDiagnostics`:
- `root_path`
- `manifest_path`
- `pending_path`
- `retry_context_path`
- `wav_path`
- `jsonl_path`
- `has_manifest`
- `has_pending`
- `has_retry_context`
- `has_wav`
- `has_jsonl`
- `outcome_classification`
- `outcome_code`

Conditional keys that appear when available:
- `manifest_status`
- `pending_transcription_state`

Interpretation rule:
- `outcome_code` is the stable machine-readable session outcome
- finding codes such as `session_root_missing`, `manifest_invalid_json`, or `pending_sidecar_without_audio` are **artifact-integrity finding codes**, not replacements for `outcome_code`

## Boundary against e2e `exit_classification`

This taxonomy must not be confused with e2e phase `exit_classification` from the retained-evidence contract.

### Session outcome taxonomy

Answers:
- what state is this session root in?
- is it empty, partial, failed, successful, or degraded-success?

Examples:
- `empty_session_root`
- `partial_artifact_session`
- `finalized_degraded_success`

### E2E phase `exit_classification`

Answers:
- how did a verification phase execute?

Examples:
- `success`
- `product_failure`
- `infra_failure`
- `contract_failure`
- `flake_retried`
- `skip_requested`

Interpretation rule:
- session outcome codes are product-artifact state semantics
- e2e exit classifications are verification-lane execution semantics
- downstream consumers must never switch on one when they mean the other

## Current producers

The canonical outcome taxonomy is currently emitted by:
- `FileSystemSessionLibraryService`
- `FileSystemArtifactIntegrityService`

This keeps session-list discovery and artifact-integrity reporting aligned on the same machine-readable outcome contract.

## Current exercised coverage

The current taxonomy is not only declared; it is exercised in smoke coverage.

### `app/Services/real_filesystem_session_integration_smoke.swift`

Covers at least:
- finalized live session -> `finalized_success`
- pending record-only session -> `partial_artifact_session`
- integrity report and session-library summary agreement on both classification and code

### `app/Services/pending_transition_smoke.swift`

Covers at least:
- finalized success -> `finalized_success`
- degraded success -> `finalized_degraded_success`
- trust-degraded success -> `finalized_degraded_success`
- finalized failure -> `finalized_failure`
- pending-manifest / orphan-wav / stale-completed roots -> `partial_artifact_session`
- empty root -> `empty_session_root`
- integrity report preservation of classification and `outcome_code`

## Canonical consumer guidance

Use `SessionOutcomeClassification` when you need:
- broad bucketed UX decisions
- coarse filtering/reporting
- compact state grouping in session history or dashboards

Use `SessionOutcomeCode` when you need:
- support-bundle/export payloads
- more precise user-facing failure/success messaging
- distinction between ordinary success and degraded success
- stable machine-readable diagnostics intended for downstream tooling

## Truthful current limitations

The current taxonomy is intentionally compact and truthful.

It does **not** yet attempt to encode every causal failure reason into `SessionOutcomeCode`.

For example, it does not split:
- invalid manifest JSON versus missing manifest
- missing wav versus corrupt jsonl
- failed finalization because of timeout versus process crash

Those details currently belong in:
- `outcomeDiagnostics`
- artifact-integrity findings
- future downstream diagnostic-code work built on top of this taxonomy

## Recommended downstream use

This taxonomy should unblock and stabilize:
- `bd-1f4q` — support bundle export should preserve `outcomeCode` and `outcomeDiagnostics`
- `bd-1v5c` — SwiftUI session history/failure UX should use `SessionOutcomeClassification` for broad grouping and `SessionOutcomeCode` for precise messaging
- `bd-2fic` — stop/finalization stress scripts should report resulting session outcomes using these codes, not invent parallel names
- `bd-1qjo` — unit coverage for stop/finalization classification should assert these exact codes and mappings

## Decision

The canonical session outcome contract is now:
- four broad `SessionOutcomeClassification` buckets
- five precise `SessionOutcomeCode` values
- one required diagnostics compatibility key: `outcomeDiagnostics["outcome_code"]`
- explicit separation from e2e phase `exit_classification`

Any future session-level diagnostics or UX work should build on this taxonomy instead of creating new outcome names for the same artifact states.
