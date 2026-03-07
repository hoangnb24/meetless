# Runtime/Public Contract Inventory (bd-2rq5)

Date: 2026-03-02  
Status: Phase A contract inventory baseline for `recordit`

Superseded-context note (ADR-005): this inventory contains historical and
compatibility surfaces that include `SequoiaTranscribe.app` wrappers. Canonical
user-facing default entrypoint policy now points to `Recordit.app`
(`docs/adr-005-recordit-default-entrypoint.md`). Legacy packaged wrapper
entries below should be interpreted as fallback/compatibility contracts unless
explicitly re-promoted by a future ADR.

## 1. Purpose and Scope

This inventory captures externally-consumed surfaces that currently behave like contracts for operators, automation, packaged runs, and CI/gates.

Primary authority sources:
- `src/bin/transcribe_live/app.rs` (CLI grammar, runtime mode compatibility, JSONL/manifest emitters)
- `contracts/runtime-mode-matrix.v1.json` (machine-readable runtime mode taxonomy/selector compatibility contract)
- `README.md` (operator entrypoints and artifact semantics)
- `Makefile` + `scripts/gate_*.sh` + `scripts/gate_*_summary.py` (execution and acceptance surfaces)
- `docs/live-jsonl-event-contract.md` and `docs/session-manifest-schema.md` (schema-level contract definitions)
- `docs/near-live-terminal-contract.md` (terminal behavior + deterministic summary contract)

## 2. Stability Classes

- `S0 Stable`: compatibility promise. Breaking change requires explicit migration/versioning plan.
- `S1 Transitional`: compatibility bridge currently promised, but expected to be renamed/replaced later with migration messaging.
- `S2 Provisional`: exposed surface that may change during productization; treat as soft contract.
- `S3 Internal`: implementation-only; safe to refactor if emitted behavior/artifacts do not change.

## 3. Technical Architecture and Product Purpose

Current product purpose:
- Capture mic + system audio on macOS, transcribe with deterministic runtime artifacts, and provide both operator-friendly and machine-readable surfaces.

Current architecture:
- Capture substrate: `recordit::live_capture` + `recordit::capture_api` over ScreenCaptureKit transport.
- Runtime orchestration: `recordit::live_stream_runtime` + `recordit::live_asr_pool`.
- Public CLI/artifact boundary: `src/bin/transcribe_live/app.rs`.
- Operator/package wrappers: `Makefile` packaged targets such as `run-transcribe-app`, `run-transcribe-live-stream-app`, `run-transcribe-preflight-app`, and `run-transcribe-model-doctor-app`.

Architecture modules above are mostly `S3 Internal`; the contracts they emit below are the compatibility boundary.

## 4. CLI Flag Inventory and Classification

Source of truth: `HELP_TEXT` and parse/validation in `src/bin/transcribe_live/app.rs`.

### 4.1 Core runtime/artifact flags

| Flag | Contract surface | Class |
|---|---|---|
| `--duration-sec` | runtime session duration input | S2 |
| `--input-wav` | runtime input path semantics vary by mode | S0 |
| `--out-wav` | canonical session WAV path | S0 |
| `--out-jsonl` | runtime JSONL artifact path | S0 |
| `--out-manifest` | runtime/preflight manifest artifact path | S0 |
| `--sample-rate` | requested capture/sample rate contract | S1 |

### 4.2 ASR/VAD and cleanup flags

| Flag | Contract surface | Class |
|---|---|---|
| `--asr-backend` (`whispercpp|whisperkit|moonshine`) | backend selector vocabulary | S1 |
| `--asr-model` | explicit model resolution override | S0 |
| `--asr-language` | language hint surface | S2 |
| `--asr-threads` | worker thread count surface | S2 |
| `--asr-profile` (`fast|balanced|quality`) | profile label vocabulary | S1 |
| `--vad-backend` (`webrtc|silero`) | VAD backend vocabulary | S1 |
| `--vad-threshold` | threshold scalar contract | S1 |
| `--vad-min-speech-ms` | boundary open constraint | S1 |
| `--vad-min-silence-ms` | boundary close/finalize constraint | S1 |
| `--llm-cleanup` | enables cleanup lane and `llm_final` path | S1 |
| `--llm-endpoint` | cleanup service endpoint wiring | S2 |
| `--llm-model` | cleanup model id | S2 |
| `--llm-timeout-ms` | cleanup timeout contract | S1 |
| `--llm-max-queue` | cleanup queue capacity | S1 |
| `--llm-retries` | cleanup retry policy | S1 |

### 4.3 Runtime-mode and live scheduling flags

| Flag | Contract surface | Class |
|---|---|---|
| `--live-chunked` | representative-chunked selector (runtime label remains `live-chunked`) | S1 |
| `--live-stream` | dedicated live-stream selector | S0 |
| `--chunk-window-ms` | live scheduler window | S1 |
| `--chunk-stride-ms` | live scheduler stride | S1 |
| `--chunk-queue-cap` | bounded ASR queue cap | S1 |
| `--live-asr-workers` | live ASR pool concurrency | S1 |
| `--keep-temp-audio` | temp shard retention behavior | S2 |

### 4.4 Channel/diagnostic/replay flags

| Flag | Contract surface | Class |
|---|---|---|
| `--transcribe-channels` (`separate|mixed|mixed-fallback`) | channel mode taxonomy and fallback behavior | S0 |
| `--speaker-labels` (`mic,system`) | channel-label vocabulary | S1 |
| `--benchmark-runs` | benchmark sample count | S2 |
| `--model-doctor` | structured diagnostics mode | S0 |
| `--replay-jsonl` | replay mode from runtime JSONL | S0 |
| `--preflight` | structured preflight manifest mode | S0 |
| `--help` | human-readable CLI contract print | S1 |

### 4.5 Runtime-mode compatibility rules (explicit parser invariants)

| Rule | Class |
|---|---|
| `--live-stream` and `--live-chunked` are mutually exclusive | S0 |
| chunk tuning flags require a live selector (`--live-chunked` or `--live-stream`) | S0 |
| live selectors are incompatible with `--replay-jsonl` | S0 |
| live selectors are compatible with `--preflight` | S0 |

## 5. Runtime Mode Labels and Compatibility Matrix

Source of truth: `RuntimeModeCompatibility` in `src/bin/transcribe_live/app.rs` plus `contracts/runtime-mode-matrix.v1.json`.

| Taxonomy mode | Runtime label in artifacts | Selector | Status | Replay compat | Preflight compat | Class |
|---|---|---|---|---|---|---|
| `representative-offline` | `representative-offline` | `<default>` | `implemented` | compatible | compatible | S0 |
| `representative-chunked` | `live-chunked` | `--live-chunked` | `implemented` | incompatible | incompatible | S1 |
| `live-stream` | `live-stream` | `--live-stream` | `implemented` | incompatible | incompatible | S0 |

Notes:
- Keeping taxonomy `representative-chunked` while emitting runtime label `live-chunked` is an intentional compatibility bridge (S1).
- Machine-readable mirror: `contracts/runtime-mode-matrix.v1.json`.

## 6. JSONL Contract Inventory

Source of truth: JSONL line emitters in `src/bin/transcribe_live/app.rs` and `docs/live-jsonl-event-contract.md`.

### 6.1 Transcript event family

| `event_type` | Required semantics | Class |
|---|---|---|
| `partial` | non-terminal rolling preview | S0 |
| `final` | stable finalized transcript segment | S0 |
| `llm_final` | cleanup/refinement output, with lineage when derived | S1 |
| `reconciled_final` | post-session canonical correction output | S0 |

Base transcript keys treated as stable: `event_type`, `channel`, `segment_id`, `start_ms`, `end_ms`, `text`, `asr_backend`, `vad_boundary_count`, optional `source_final_segment_id`.

### 6.2 Control-event family

| `event_type` | Stable keys/focus | Class |
|---|---|---|
| `vad_boundary` | boundary id/start/end/source/backend/threshold | S0 |
| `mode_degradation` | requested/active mode + code/detail | S0 |
| `trust_notice` | code/severity/cause/impact/guidance | S0 |
| `lifecycle_phase` | phase/transition index/timestamp/readiness/detail | S0 |
| `reconciliation_matrix` | required/applied/trigger count+codes | S0 |
| `asr_worker_pool` | queue/processing counters | S1 |
| `chunk_queue` | backlog counters + lag stats | S0 |
| `cleanup_queue` | cleanup queue/drain/retry counters | S1 |

### 6.3 JSONL sequencing and durability assumptions

- Incremental append during runtime is contractually significant (`live-stream` must grow in active phase): `S0`.
- Durability checkpoints (`sync_data` cadence + stage boundaries + finalize): `S1`.
- Transcript deterministic ordering key (start/end/event rank/channel/ids/text): `S0`.

## 7. Manifest Contract Inventory

Source of truth: `write_runtime_manifest` in `src/bin/transcribe_live/app.rs` and `docs/session-manifest-schema.md`.

### 7.1 Runtime manifest (`kind=transcribe-live-runtime`) critical surfaces

Top-level and nested surfaces treated as compatibility commitments:

- Identity/config: `schema_version`, `kind`, `generated_at_utc`, backend/model/checksum fields.
- Mode/channel identity: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`, `channel_mode_requested`, `channel_mode`.
- Artifact truth: `input_wav`, `input_wav_semantics`, `out_wav`, `out_wav_semantics`, `out_wav_materialized`, `out_wav_bytes`, `jsonl_path`.
- Event and trust surfaces: `events`, `event_counts`, `degradation_events`, `trust`, `reconciliation`.
- Queue surfaces: `asr_worker_pool`, `chunk_queue`, `cleanup_queue`.
- Terminal mirror surfaces: `session_summary`, `terminal_summary`.
- First-emit timing surface: `first_emit_timing_ms` (`first_any`, `first_partial`, `first_final`, `first_stable`).

Classification:
- Manifest key names and meanings above: S0.
- Additive optional fields allowed without version bump: S1.
- Breaking rename/removal/resemanticization requires schema-version bump: S0.

### 7.2 Preflight manifest (`kind=transcribe-live-preflight`) critical surfaces

Compatibility promises:
- `overall_status` + `checks[]` (`id`, `status`, `detail`, `remediation`) structure: S0.
- `config` runtime mode/backend/model resolution fields and output paths: S0.

## 8. Terminal Summary Contract Inventory

Source of truth: terminal summary emission in `src/bin/transcribe_live/app.rs` and `docs/near-live-terminal-contract.md`.

Deterministic close-summary field order treated as stable (`S0`):
1. `session_status`
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. transcript counts (`partial`, `final`, `llm_final`, `reconciled_final`)
6. `chunk_queue` summary
7. `chunk_lag` summary
8. `trust_notices` summary
9. `degradation_events` summary
10. `cleanup_queue` summary
11. artifact paths (`out_wav`, `out_jsonl`, `out_manifest`)

TTY/non-TTY rendering differences (partials vs stable-only) are presentation-level but expected behavior for operators: `S1`.

## 9. Makefile/Script Entrypoint Inventory

Primary command surfaces consumed by humans/automation:

| Entrypoint | Purpose | Class |
|---|---|---|
| `make transcribe-live` | debug representative runtime path | S0 |
| `make transcribe-live-stream` | debug true live-stream path | S0 |
| `make capture-transcribe` | one-command capture then transcribe | S1 |
| `make transcribe-preflight` | preflight wrapper | S0 |
| `make transcribe-model-doctor` | model-doctor wrapper | S0 |
| `make setup-whispercpp-model` | canonical model bootstrap | S1 |
| `make gate-backlog-pressure` | backlog-pressure gate harness | S0 |
| `make gate-v1-acceptance` | v1 acceptance gate harness | S0 |
| `make gate-packaged-live-smoke` | signed-app live-stream smoke gate | S0 |
| `make run-transcribe-app` | packaged operator entrypoint | S0 |
| `make run-transcribe-live-stream-app` | packaged live-stream wrapper | S0 |
| `make run-transcribe-preflight-app` | packaged preflight diagnostics | S0 |
| `make run-transcribe-model-doctor-app` | packaged model-doctor diagnostics | S0 |

Packaged artifact-root and session-stem override environment surfaces used by wrappers are treated as `S1`.

## 10. Gate and Test Assumption Inventory

### 10.1 Gate script assumptions (contract-sensitive)

- `scripts/gate_backlog_pressure.sh` + `_summary.py`:
  - expects runtime mode triple (`live-stream`, taxonomy `live-stream`, selector `--live-stream`) and queue/trust/degradation surfaces.
- `scripts/gate_v1_acceptance.sh` + `_summary.py`:
  - expects cold/warm first-stable emit evidence plus profile-aware backlog surface checks.
- `scripts/gate_packaged_live_smoke.sh` + `_summary.py`:
  - expects signed-app live-stream model doctor/runtime, packaged artifact path truth, transcript surfaces, and `runtime_first_stable_emit_ok`.

These gate output keys (`summary.csv` + `status.txt`) are consumed as machine-readable acceptance inputs and are `S0`.

### 10.2 Test assumptions that freeze public/runtime behavior

- `tests/live_stream_true_live_integration.rs`:
  - asserts in-flight growth of `input_wav` and JSONL during active runtime,
  - asserts first stable transcript emit before timeout window.
- `src/bin/transcribe_live/app.rs` tests:
  - parser/compatibility invariants for mode combinations,
  - runtime mode matrix/labels,
  - JSONL lifecycle/transcript ordering behavior,
  - manifest session-summary/terminal-summary fields.

These tests collectively define the compatibility baseline and should be treated as `S0` behavior guards.

## 11. Additive vs Breaking vs Internal-Only Decision Rules

A proposed change is:

- `Additive` if it only adds optional fields/events/flags or new wrappers without changing current keys, labels, ordering, or gate result semantics.
- `Breaking` if it removes/renames/reinterprets existing flags, runtime labels, JSONL `event_type` values/required keys, manifest stable fields, summary field order, or gate output keys (`gate_pass` and related status rows).
- `Internal-only` if refactors stay behind the same CLI/runtime artifact outputs and all contract/gate tests remain unchanged.

## 12. Immediate Follow-On Beads Unblocked by This Inventory

This inventory directly unblocks:
- `bd-1qfx` (golden artifact matrix capture)
- `bd-bhe0` (compatibility boundary policy definition)
