# Runtime Compatibility Boundary Policy (bd-bhe0)

Date: 2026-03-02  
Status: normative Phase A policy for compatibility decisions during v1 productization

## 1. Purpose

This policy defines which runtime/public surfaces are compatibility promises and which surfaces may evolve during refactor/productization.

Use this document to classify any proposed change as:
- additive-compatible
- breaking (migration/versioning required)
- internal-only

Primary source inventory: `docs/runtime-contract-inventory.md`.

## 2. Stability Classes

The repository uses the following classes for compatibility decisions:

- `S0 Stable`: hard compatibility promise; no drift without explicit migration/versioning.
- `S1 Transitional`: currently promised bridge compatibility; changes require migration messaging and bridge planning.
- `S2 Provisional`: exposed but not promised as stable; may evolve with changelog note.
- `S3 Internal`: implementation-only; may refactor freely if emitted behavior stays equivalent.

## 3. S0 Stable Boundary (No Drift Without Migration)

### 3.1 Runtime mode and selector compatibility

The following are `S0`:
- runtime mode label semantics for:
  - `representative-offline`
  - `live-stream`
- parser invariants:
  - `--live-stream` and `--live-chunked` mutual exclusion
  - live selectors incompatible with `--replay-jsonl`
  - live selectors incompatible with `--preflight`
  - chunk tuning flags require a live selector

### 3.2 CLI contract surfaces

The following operator/automation flags are `S0`:
- `--input-wav`
- `--out-wav`
- `--out-jsonl`
- `--out-manifest`
- `--live-stream`
- `--transcribe-channels`
- `--model-doctor`
- `--replay-jsonl`
- `--preflight`

### 3.3 JSONL event contract

The following are `S0` compatibility commitments:
- transcript `event_type` values:
  - `partial`
  - `final`
  - `reconciled_final`
- control `event_type` values:
  - `vad_boundary`
  - `mode_degradation`
  - `trust_notice`
  - `lifecycle_phase`
  - `reconciliation_matrix`
  - `chunk_queue`
- required transcript keys and meaning:
  - `event_type`, `channel`, `segment_id`, `start_ms`, `end_ms`, `text`, `asr_backend`, `vad_boundary_count`
- deterministic transcript ordering key semantics
- append-only incremental runtime growth (especially for live-stream)

### 3.4 Manifest contract

The following manifest semantics are `S0`:
- required identity keys and semantics:
  - `schema_version`, `kind`, `generated_at_utc`
- runtime mode identity fields:
  - `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
- artifact-truth fields and semantics:
  - `input_wav`, `input_wav_semantics`
  - `out_wav`, `out_wav_semantics`, `out_wav_materialized`, `out_wav_bytes`
  - `jsonl_path`
- trust/degradation/reconciliation structures:
  - `trust`
  - `degradation_events`
  - `reconciliation`
- event/timeline fields:
  - `events`
  - `event_counts`
- summary fields:
  - `session_summary`
  - `terminal_summary`

### 3.5 Terminal startup banner and close-summary contract

The deterministic startup banner field order is `S0`:
1. `runtime_mode`
2. `runtime_mode_taxonomy`
3. `runtime_mode_selector`
4. `runtime_mode_status`
5. `channel_mode_requested`
6. `duration_sec`
7. `input_wav`
8. artifact destinations (`out_wav`, `out_jsonl`, `out_manifest`)

The deterministic close-summary field order is also `S0`:
1. `session_status`
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. transcript counts
6. `chunk_queue`
7. `chunk_lag`
8. `trust_notices`
9. `degradation_events`
10. `cleanup_queue`
11. artifact paths (`out_wav`, `out_jsonl`, `out_manifest`)

Session health classification semantics are `S0` for operator interpretation:
- `ok`: successful run with no trust notices
- `degraded`: successful run with one or more trust notices (typically paired with degradation signals)
- `failed`: non-zero command exit where runtime completion summary is unavailable or incomplete
- runtime result emits `run_status` plus `remediation_hints` as the concise operator next-action surface

### 3.6 Gate/automation output contract

The following are `S0` for automation compatibility:
- machine-consumed gate outputs (`status.txt`, `summary.csv`) for:
  - `gate_backlog_pressure`
  - `gate_v1_acceptance`
  - `gate_packaged_live_smoke`
- key gate result semantics (`gate_pass` and contract booleans used in CI/review)
- Makefile entrypoints used by operators/CI:
  - `transcribe-live`
  - `transcribe-live-stream`
  - `transcribe-preflight`
  - `transcribe-model-doctor`
  - `gate-backlog-pressure`
  - `gate-v1-acceptance`
  - `gate-packaged-live-smoke`
  - `run-transcribe-app`
  - `run-transcribe-live-stream-app`
  - `run-transcribe-preflight-app`
  - `run-transcribe-model-doctor-app`

## 4. Transitional/Provisional/Internal Surfaces

### 4.1 S1 Transitional (bridge compatibility required)

`S1` surfaces may change, but only with explicit migration messaging and compatibility bridge handling:
- representative-chunked bridge semantics:
  - taxonomy `representative-chunked` vs runtime label `live-chunked`
  - selector `--live-chunked`
- backend/profile vocabularies likely to evolve:
  - `--asr-backend`
  - `--asr-profile`
  - `--vad-backend`
  - `--vad-threshold`, `--vad-min-speech-ms`, `--vad-min-silence-ms`
- live queue/worker tuning controls:
  - `--chunk-window-ms`, `--chunk-stride-ms`, `--chunk-queue-cap`, `--live-asr-workers`
- cleanup-lane knobs and queue telemetry surface
- `--help` textual contract presentation
- TTY/non-TTY presentation differences

### 4.2 S2 Provisional (soft contract)

`S2` surfaces can evolve during productization with changelog + docs updates:
- tuning-oriented flags and defaults:
  - `--duration-sec`
  - `--asr-language`
  - `--asr-threads`
  - `--llm-endpoint`, `--llm-model`
  - `--benchmark-runs`
  - `--keep-temp-audio`
- packaged wrapper environment variable conventions for artifact roots/session stems

### 4.3 S3 Internal (implementation only)

`S3` includes module boundaries and runtime internals that do not directly change external contracts:
- capture/orchestration module layout
- worker-pool implementation internals
- queue plumbing and helper wiring internals
- refactors that keep CLI/artifact/gate outputs semantically identical

## 5. Additive vs Breaking vs Internal-Only Rules

A change is `additive-compatible` only if all of the following are true:
- no removal/rename/resemanticization of `S0` fields, labels, event types, or gate keys
- no change to `S0` ordering/invariant behavior
- any new fields are optional (or gated by explicit versioning)
- existing scripts/automation continue to pass without migration edits

A change is `breaking` if any of the following occur:
- remove/rename/reinterpret `S0` CLI flags, runtime mode labels, JSONL `event_type` values, required keys, manifest stable fields, or gate output keys
- violate parser invariants or compatibility matrix semantics relied on by automation
- alter deterministic summary order or artifact-truth meaning

A change is `internal-only` if:
- it affects only `S3` internals and `S2` implementation details
- emitted contract artifacts remain semantically unchanged
- compatibility and gate tests remain green without baseline updates

## 6. Required Actions by Change Type

### 6.1 For additive-compatible changes

Required:
- update relevant docs (`README`, contract docs) for discoverability
- add tests for new fields/paths when machine-consumed
- keep existing contract tests/gates passing unchanged

### 6.2 For breaking changes

Required before merge:
- explicit migration note with impact and upgrade steps
- schema/contract version bump where relevant
- dual-path compatibility window when feasible
- update frozen baseline artifacts and regression harness expectations intentionally
- call out breaking scope in bead thread and release notes

### 6.3 For S1 transitional changes

Required:
- preserve bridge behavior during transition window
- emit migration messaging (docs/help/runbook)
- define removal/deprecation condition and follow-up bead

## 7. Mechanical Decision Checklist

Use the canonical status/evidence board in
[`docs/contract-no-drift-checklist.md`](./contract-no-drift-checklist.md)
for current `pass|fail|unknown` state and bead/gate mapping.

Use this mechanical checklist for every contract-touching PR:

1. Does this touch any `S0` surface listed in Section 3?
2. If yes, is there an explicit migration/version plan attached?
3. Do JSONL/manifest/gate contract tests still pass without silent baseline drift?
4. Are docs updated in the same change for any new/renamed surfaces?
5. Is the bead/thread explicitly labeled `additive`, `breaking`, or `internal-only`?

If a reviewer cannot answer these mechanically, the change is not ready.

## 8. Scope Relationship to Other Beads

This policy defines compatibility boundary governance for Phase A and directly supports:
- `bd-1n5v` (contract regression harness)
- `bd-10uo` (JSONL stable invariants)
- `bd-3ruu` (manifest stable invariants)
- `bd-19vx` and `bd-223b` (machine-readable contract publication)

For inventory detail, use `docs/runtime-contract-inventory.md`.
