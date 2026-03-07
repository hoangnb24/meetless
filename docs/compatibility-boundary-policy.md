# Compatibility Boundary Policy (bd-bhe0)

Date: 2026-03-02  
Status: normative Phase A compatibility policy for `recordit`

## 1. Purpose

This document turns the factual inventory in `docs/runtime-contract-inventory.md` into the decision policy for productization work.

Goal:
- make compatibility decisions mechanically instead of socially
- define what must not drift without migration
- define what may change during refactor/productization

## 2. Compatibility Tiers

- `Tier A: Frozen compatibility boundary`
  - no rename, removal, semantic reinterpretation, or ordering drift without explicit migration/versioning work
- `Tier B: Transitional compatibility boundary`
  - still consumed downstream today, but expected to be replaced or simplified later; changes require migration messaging and overlap period
- `Tier C: Provisional/operator-tunable surface`
  - exposed today, but allowed to evolve if behavior remains explainable and artifacts stay compatible
- `Tier D: Internal-only implementation`
  - free to refactor so long as Tier A/B/C emitted behavior does not drift

Tier mapping rule:
- every `S0 Stable` item from `docs/runtime-contract-inventory.md` is Tier A
- every `S1 Transitional` item from `docs/runtime-contract-inventory.md` is Tier B
- every `S2 Provisional` item from `docs/runtime-contract-inventory.md` is Tier C
- every `S3 Internal` item from `docs/runtime-contract-inventory.md` is Tier D

Exhaustiveness rule:
- this policy document highlights the highest-risk boundary members
- `docs/runtime-contract-inventory.md` remains the exhaustive inventory of current surfaces

## 3. Tier A: Frozen Compatibility Boundary

### 3.1 CLI names and mode constraints

The following flag names are frozen:
- `--input-wav`
- `--out-wav`
- `--out-jsonl`
- `--out-manifest`
- `--live-stream`
- `--transcribe-channels`
- `--model-doctor`
- `--replay-jsonl`
- `--preflight`

The following parser rules are frozen:
- `--live-stream` and `--live-chunked` must remain mutually exclusive
- chunk tuning flags require a live selector
- live selectors must remain incompatible with `--replay-jsonl`
- live selectors must remain compatible with `--preflight`

### 3.2 Runtime mode labels and compatibility tuple

The emitted runtime-mode tuple is frozen:
- `runtime_mode`
- `runtime_mode_taxonomy`
- `runtime_mode_selector`
- `runtime_mode_status`

Allowed emitted values are frozen:
- offline tuple:
  - `representative-offline`
  - `representative-offline`
  - `<default>`
  - `implemented`
- live-stream tuple:
  - `live-stream`
  - `live-stream`
  - `--live-stream`
  - `implemented`
- representative-chunked compatibility tuple:
  - `live-chunked`
  - `representative-chunked`
  - `--live-chunked`
  - `implemented`

### 3.3 JSONL event families and required keys

Frozen transcript `event_type` values:
- `partial`
- `final`
- `llm_final`
- `reconciled_final`

Frozen control `event_type` values:
- `vad_boundary`
- `mode_degradation`
- `trust_notice`
- `lifecycle_phase`
- `reconciliation_matrix`
- `asr_worker_pool`
- `chunk_queue`
- `cleanup_queue`

Frozen transcript keys:
- `event_type`
- `channel`
- `segment_id`
- `start_ms`
- `end_ms`
- `text`
- `asr_backend`
- `vad_boundary_count`
- `source_final_segment_id` when lineage exists

Frozen control payload keys:
- `vad_boundary`: `boundary_id`, `source`, `vad_backend`, `vad_threshold`
- `mode_degradation`: `requested_mode`, `active_mode`, `code`, `detail`
- `trust_notice`: `code`, `severity`, `cause`, `impact`, `guidance`
- `lifecycle_phase`: `phase`, `transition_index`, `entered_at_utc`, `ready_for_transcripts`, `detail`
- `reconciliation_matrix`: `required`, `applied`, `trigger_count`, `trigger_codes`
- `asr_worker_pool`: queue/processing counters currently emitted
- `chunk_queue`: queue counters plus lag fields
- `cleanup_queue`: cleanup queue counters plus drain/retry fields

Frozen JSONL behavior:
- `live-stream` JSONL must grow during active runtime, not only at shutdown
- transcript ordering must remain deterministic
- replay must continue to consume current transcript event types and preserve lineage when present

### 3.4 Runtime/preflight manifest key boundary

Frozen runtime manifest keys:
- `schema_version`
- `kind`
- `generated_at_utc`
- backend/model/checksum fields
- `input_wav`
- `input_wav_semantics`
- `out_wav`
- `out_wav_semantics`
- `out_wav_materialized`
- `out_wav_bytes`
- `channel_mode_requested`
- `channel_mode`
- `runtime_mode`
- `runtime_mode_taxonomy`
- `runtime_mode_selector`
- `runtime_mode_status`
- `events`
- `event_counts`
- `degradation_events`
- `trust`
- `reconciliation`
- `asr_worker_pool`
- `chunk_queue`
- `cleanup_queue`
- `terminal_summary`
- `session_summary`
- `first_emit_timing_ms`
- `jsonl_path`

Frozen nested manifest structures:
- `first_emit_timing_ms.first_any`
- `first_emit_timing_ms.first_partial`
- `first_emit_timing_ms.first_final`
- `first_emit_timing_ms.first_stable`
- `terminal_summary.live_mode`
- `terminal_summary.render_mode`
- `terminal_summary.stable_line_policy`
- `terminal_summary.stable_line_count`
- `terminal_summary.stable_lines_replayed`
- `terminal_summary.stable_lines`
- `session_summary.session_status`
- `session_summary.duration_sec`
- `session_summary.channel_mode_requested`
- `session_summary.channel_mode_active`
- `session_summary.transcript_events`
- `session_summary.chunk_queue`
- `session_summary.chunk_lag`
- `session_summary.trust_notices`
- `session_summary.degradation_events`
- `session_summary.cleanup_queue`
- `session_summary.artifacts`

Frozen preflight manifest structures:
- `overall_status`
- `config`
- `checks[].id`
- `checks[].status`
- `checks[].detail`
- `checks[].remediation`

### 3.5 Terminal summary order and operator semantics

The deterministic close-summary field order is frozen:
1. `session_status`
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. transcript event counts
6. `chunk_queue`
7. `chunk_lag`
8. `trust_notices`
9. `degradation_events`
10. `cleanup_queue`
11. artifact paths

Frozen operator semantics:
- live mode may emit stable lines during runtime and suppress duplicate replay at closeout
- non-live mode may replay stable lines at closeout
- stable transcript line ordering must remain deterministic

### 3.6 Gate summary outputs consumed by automation

The following key families are frozen because downstream gating consumes them as machine-readable truth.

Frozen `gate_backlog_pressure` summary rows:
- artifact identity: `artifact_track`, `manifest_path`, `jsonl_path`
- runtime-mode tuple: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
- queue pressure metrics: `submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `max_queue`, `high_water`, `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`
- trust/degradation rows: `degradation_codes`, `trust_codes`
- threshold booleans: `threshold_lag_p95_ok`, `threshold_trust_signal_ok`, `threshold_reconciliation_signal_ok`, `threshold_jsonl_chunk_queue_event_ok`, `threshold_runtime_mode_ok`, `threshold_runtime_mode_status_ok`, `threshold_first_stable_emit_ok`, `threshold_transcript_surface_ok`, `threshold_terminal_live_mode_ok`
- final verdict: `gate_pass`

Frozen `gate_v1_acceptance` summary rows:
- artifact paths for cold/warm/backlog manifests and JSONL
- cold/warm runtime-mode tuple rows
- cold/warm first-emit and first-stable rows
- cold/warm `*_first_stable_emit_ok`
- cold/warm `*_terminal_live_mode_ok`
- cold/warm artifact-truth rows (`*_out_wav_materialized`, `*_out_wav_exists`, `*_artifact_truth_ok`)
- backlog interpretation rows: `backlog_gate_pass`, `backlog_pressure_profile`, `backlog_pressure_profile_known_ok`, `backlog_pressure_thresholds_ok`, `backlog_degradation_signal_ok`, `backlog_trust_signal_ok`, `backlog_degradation_event_count`, `backlog_trust_notice_count`, `backlog_surface_ok`
- final verdict: `gate_pass`

Frozen `gate_packaged_live_smoke` summary rows:
- packaged run exit/doctor rows
- packaged artifact-path and existence rows
- runtime-mode tuple rows and `runtime_mode_ok`
- `runtime_out_wav_materialized`, `runtime_out_wav_truth_ok`
- active/first-emit/first-stable rows
- `runtime_first_stable_timing_ms`
- `runtime_first_stable_emit_ok`
- transcript surface rows
- `runtime_terminal_live_mode_ok`
- trust/degradation surface rows
- manifest path match rows
- `runtime_artifact_root_ok`
- `runtime_helper_exec_blocked`
- final verdict: `gate_pass`

## 4. Tier B: Transitional Compatibility Boundary

These surfaces are still compatibility commitments today, but they are explicitly allowed to be migrated with overlap and messaging.

Transitional surfaces:
- `--live-chunked` selector name
- emitted `runtime_mode=live-chunked` while taxonomy says `representative-chunked`
- `llm_final` cleanup refinement path as a named transcript family
- detailed queue/counter field sets in `asr_worker_pool` and `cleanup_queue`
- Makefile wrapper environment knobs for packaged execution and artifact-root/session-stem overrides
- help text phrasing and README wording, as long as underlying frozen names/semantics stay intact

Required migration policy for Tier B:
- keep legacy and replacement surfaces in parallel for at least one documented transition period
- add migration messaging in CLI/docs/gates before removing legacy spelling
- keep machine-readable artifacts backward-compatible until the dependent bead/contract explicitly replaces them

## 5. Tier C: Provisional Surfaces

These may change without formal version bump if the frozen boundary remains intact and docs/tests are updated together.

Provisional surfaces:
- default numeric values for durations, queue caps, worker counts, window/stride, and retry budgets
- default model search paths and staging paths
- exact trust/degradation guidance prose
- exact terminal header text and non-contract diagnostics formatting
- precise benchmark run-count defaults
- internal artifact directory names used only for debug/temp staging

## 6. Tier D: Internal-Only Surfaces

These are not compatibility promises by themselves.

Internal-only surfaces:
- Rust module boundaries and function names
- scheduler implementation details
- capture transport implementation details
- worker-thread orchestration strategy
- temp audio shard naming/layout
- exact checkpoint cadence implementation so long as active-runtime JSONL growth remains true and replay-safe
- test helper implementation details

## 7. Mechanical Change Classification Rules

A proposed change is `breaking` if it does any of the following:
- renames or removes a Tier A flag, field, event type, label, or gate-summary key
- changes the meaning of an existing Tier A key/value without migration
- changes deterministic ordering for terminal summary or replay-relevant transcript ordering
- changes live-mode incompatibility rules or selector semantics

A proposed change is `transitional` if it:
- replaces a Tier B surface with a new preferred surface while keeping both functional during migration
- introduces migration messaging, aliases, or bridge fields without removing the old surface yet

A proposed change is `additive` if it:
- adds optional manifest fields, optional gate rows, or new wrappers without disturbing Tier A rows/names/order
- adds new diagnostics that do not become required by existing automation

A proposed change is `internal-only` if it:
- refactors implementation while leaving CLI, emitted artifacts, gate rows, and test-observed semantics unchanged

## 8. Required Actions by Change Type

For `breaking` changes:
- do not land them inside productization work without an explicit migration bead
- bump schema/versioned contract surfaces where applicable
- update gates/tests/docs in the same change
- document operator/automation impact explicitly

For `transitional` changes:
- add overlap period and migration note
- keep old and new surfaces testable in parallel until dependents are updated
- include a removal follow-up bead

For `additive` changes:
- add regression coverage proving old consumers still pass
- mark new fields/rows as optional until a later contract bead freezes them

For `internal-only` changes:
- keep existing regression and gate surfaces green
- no user-facing migration note required

## 9. Review Checklist for Future Beads

Before landing any productization/refactor bead, answer these in order:
1. Does it touch a Tier A name, label, field, event type, or gate row?
2. Does it alter live/offline mode semantics or parser incompatibility rules?
3. Does it change artifact truth fields or path semantics?
4. Does it change replay ordering or terminal summary ordering?
5. Does any existing gate summary key disappear or change meaning?
6. If yes to any above, is there an explicit migration/versioning bead attached?

If the answer to 1-5 is yes and 6 is no, the change is not allowed under this policy.

## 10. Downstream Impact

This policy is the normative input for:
- `bd-1qfx` golden artifact capture
- `bd-1n5v` regression harness
- `bd-19vx` runtime-mode matrix JSON contract
- `bd-10uo` JSONL stable-key assertions
- `bd-3ruu` manifest stable-key assertions
- `bd-223b` exit-code/failure-class contract publication
