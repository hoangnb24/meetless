# Reliability-First Modernization Plan for `recordit`

## Summary
This plan improves the 3 weakest areas we discussed, in a phased and low-risk way, while keeping external behavior stable.

1. Reduce live-stream overload and queue drops by removing per-job file churn and adding adaptive scheduling under pressure.
2. Replace manual JSON string building/parsing with typed serde models for safer artifacts and replay.
3. Split the giant `app.rs` orchestration into clear modules so changes are safer and faster.

This plan preserves existing CLI/runtime contracts and keeps all current gate/test surfaces valid.

## Locked Decisions
1. Rollout style: **Phased hardening**.
2. Compatibility policy: **No contract changes**.
3. Optimization priority: **Reliability first**.

## Scope and Non-Goals
1. In scope: internal architecture and runtime reliability changes in `src/bin/transcribe_live/app.rs`, `src/bin/transcribe_live/runtime_live_stream.rs`, `src/live_asr_pool.rs`, `src/bin/transcribe_live/artifacts.rs`, and related modules.
2. Out of scope: changing public command grammar, changing manifest/jsonl field names, changing contract version files, replacing whisper backends with entirely new ASR engines.

## Phase Plan

## Phase 1: Live-Stream Reliability and Throughput (Hot Path)
This phase fixes the live path where we are currently spending too much time creating/deleting tiny WAV files and emitting too many partial jobs under pressure.

### Phase 1 Goal (Plain Terms)
1. Keep the system responsive when CPU/disk is busy.
2. Protect final transcript quality first.
3. Reduce avoidable queue drops without changing user-facing contracts.

### Phase 1A: Typed ASR Request Surface (No Behavior Change First)
1. Add `LiveAsrAudioInput` in `src/live_asr_pool.rs` with:
- `Path(PathBuf)` for current behavior.
- `PcmWindow { sample_rate_hz, mono_samples }` for live in-memory path.
2. Add `LiveAsrRequest` in `src/live_asr_pool.rs` to carry:
- Existing job metadata (`job_id`, class, role, label, segment identity).
- New `audio_input: LiveAsrAudioInput`.
- Temp-audio bookkeeping fields needed for current telemetry behavior.
3. Update `LiveAsrExecutor` to accept a request-style transcribe input while keeping a compatibility path adapter so existing backend code still compiles during migration.
4. Keep representative/offline path unchanged in this sub-step by creating requests with `LiveAsrAudioInput::Path`.
5. Add unit tests proving path-only behavior is unchanged before switching live mode.

### Phase 1B: Remove Live Per-Job Temp File Churn
1. In `src/bin/transcribe_live/runtime_live_stream.rs`, replace `materialize_job_audio` in live mode with:
- Window extraction from `audio_by_channel`.
- Direct `LiveAsrRequest` submission with `PcmWindow`.
2. Keep current fallback guards:
- If extracted samples are empty, use a single zero sample.
- Preserve channel/segment/window metadata exactly as today.
3. Keep representative mode and any non-live flows on the existing file-path behavior.
4. Delete only the now-unused live temp-file-per-job path once tests pass.

### Phase 1C: Worker-Local Scratch Reuse
1. In `src/live_asr_pool.rs`, give each worker one reusable scratch WAV path.
2. For `PcmWindow` requests:
- Overwrite worker scratch WAV.
- Run backend transcribe using that scratch path.
3. For `Path` requests:
- Use path directly with no new scratch write.
4. Keep telemetry compatible:
- Continue reporting queue/submit/process counters.
- Preserve existing temp-audio policy behavior for path-based jobs.
5. Add tests for repeated submissions proving scratch reuse and correct transcripts across many jobs.

### Phase 1D: Adaptive Backpressure Modes in Scheduler
1. Add a small internal mode enum in `src/live_stream_runtime.rs`:
- `normal`
- `pressure`
- `severe`
2. Mode behavior:
- `normal`: emit partial + final + reconcile.
- `pressure`: emit partial less often (double stride / half cadence).
- `severe`: suppress partial jobs, keep final + reconcile only.
3. Transition rules (time-window based, deterministic):
- Enter `pressure` when queue drops appear or pending load stays above 70% for 1 second.
- Enter `severe` when drops continue for 2 consecutive seconds.
- Recover one step at a time after 5 low-pressure intervals.
4. Keep priority guarantees unchanged (`final > reconcile > partial`) and do not change existing event names/codes.
5. Add deterministic unit tests for each transition and recovery path.

### Phase 1E: Pump Cadence Control in Live Runtime Loop
1. In `src/bin/transcribe_live/runtime_live_stream.rs`, stop running full `pump_once` on every callback.
2. Add a lightweight cadence gate:
- Run full pump every 20ms during active streaming.
- Always force immediate pump on phase transitions (`Warmup -> Active`, `Active -> Draining`, `Draining -> Shutdown`).
- Force pump on capture-end style events.
3. Keep `drain_until_idle` behavior for shutdown correctness.
4. Add integration assertions that first stable emit timing does not regress materially.

### Phase 1F: Rollout Sequence and Kill-Switch Strategy
1. Deliver in small PR slices:
- PR 1: Phase 1A (typed request surface + compatibility adapter).
- PR 2: Phase 1B + 1C (live PCM path + scratch reuse).
- PR 3: Phase 1D + 1E (backpressure modes + cadence control).
2. Keep rollback-simple boundaries between PRs so each change can be reverted independently if needed.
3. Use an internal runtime flag for adaptive backpressure during burn-in so we can disable only the new behavior if regressions appear.

### Phase 1 Exit Criteria
1. At least 30% fewer queue-drop events (`dropped_queue_full`) in constrained live-pressure test runs versus current baseline.
2. No public contract drift:
- Same CLI/runtime contract behavior.
- Same degradation/trust notice codes.
3. First stable transcript emit time regresses by no more than 10% in current live integration scenarios.
4. Existing contract and schema tests pass without edits to contract files.

## Phase 2: Typed JSON Boundary (Safety and Maintainability)
1. Introduce serde runtime event and manifest models in a new module `src/bin/transcribe_live/contracts_models.rs`.
2. Define `RuntimeJsonlEvent` enum with tagged `event_type` variants that match current schema names exactly.
3. Define `RuntimeManifest` and `PreflightManifest` structs that map one-to-one to current output fields.
4. Replace manual string assembly in `src/bin/transcribe_live/artifacts.rs` with serde serialization.
5. Keep JSONL as one-object-per-line; write each `RuntimeJsonlEvent` with serde to preserve schema while removing formatting fragility.
6. Replace manual replay parsing in `src/bin/transcribe_live/app.rs` with serde deserialization; keep permissive handling for unknown fields.
7. Remove custom `extract_json_string_field` and `extract_json_u64_field` parsing for runtime JSONL replay path.
8. Preserve existing schema and contract files in `contracts/runtime-jsonl.schema.v1.json` and `contracts/session-manifest.schema.v1.json` without version bump.

## Phase 3: Modularization of Runtime Orchestration
1. Reduce `src/bin/transcribe_live/app.rs` to wiring/composition only.
2. Move preflight/model-doctor logic into `src/bin/transcribe_live/preflight.rs`.
3. Move cleanup queue client/worker logic into `src/bin/transcribe_live/cleanup.rs`.
4. Move close-summary and terminal report formatting into `src/bin/transcribe_live/reporting.rs`.
5. Move reconciliation matrix/build logic into `src/bin/transcribe_live/reconciliation.rs`.
6. Keep existing extracted modules and entrypoints in:
- `src/bin/transcribe_live/runtime_representative.rs`
- `src/bin/transcribe_live/runtime_live_stream.rs`
- `src/bin/transcribe_live/asr_backend.rs`
- `src/bin/transcribe_live/cli_parse.rs`
- `src/bin/transcribe_live/runtime_events.rs`
- `src/bin/transcribe_live/transcript_flow.rs`
7. Target outcome: `app.rs` reduced to bootstrap, parse/dispatch, and high-level orchestration glue.

## Important API / Interface / Type Changes
1. Internal interface change in `src/live_asr_pool.rs`: add `LiveAsrAudioInput` enum and `LiveAsrRequest` struct.
2. Internal trait change in `src/live_asr_pool.rs`: `LiveAsrExecutor` transcribe method accepts request object; provide adapter helpers so existing backend code compiles incrementally.
3. Internal scheduler extension in `src/live_stream_runtime.rs`: add backpressure mode state and mode update hooks.
4. Internal serialization model addition: new typed event/manifest structs in `contracts_models.rs`.
5. Public interfaces remain stable: `recordit` CLI grammar, `transcribe-live` flags, JSONL event names, manifest top-level fields, contract JSON files.

## Testing Plan

## Unit Tests
1. `live_asr_pool`: PCM request path serializes to worker scratch and transcribes correctly; scratch reuse works across multiple jobs.
2. `live_asr_pool`: queue pressure still honors class priority (`final > reconcile > partial`) with new request type.
3. `live_stream_runtime`: backpressure mode transitions and partial suppression logic are deterministic.
4. `artifacts/contracts_models`: serde round-trip for every JSONL event variant.
5. `replay parser`: malformed rows fail safely; valid rows parse via typed models.

## Integration Tests
1. Extend `tests/live_stream_true_live_integration.rs` to assert no regression in first stable emit timing and in-flight artifact growth.
2. Add live-stream pressure scenario with constrained queue capacity to confirm reduced `dropped_queue_full` after adaptive scheduler.
3. Add replay regression scenario to confirm typed parser reproduces current transcript reconstruction behavior.

## Contract and Baseline Tests
1. Run existing contract suites unchanged in `tests/`.
2. Verify `tests/runtime_jsonl_schema_contract.rs` and `tests/runtime_manifest_schema_contract.rs` pass without schema edits.
3. Verify frozen baseline tests pass without regenerating contract files; if any baseline artifact drift occurs, it must be investigated and corrected, not accepted by default.

## Post-Optimization Benchmark Re-Run Protocol
This section defines exactly how to rerun benchmarks after Phase 1 optimization and compare against the current baseline evidence.

### Baseline Anchors (Current System)
1. Compatibility baseline:
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- Key anchor: `cold_first_stable_timing_ms=2120`, `warm_first_stable_timing_ms=2120`, `gate_pass=true`.
2. Pressure baseline (drop-path reference):
- `artifacts/bench/gate_backlog_pressure/20260228T153738Z/summary.csv` (referenced by `docs/gate-phase-next-report.md`).
- Key anchor: `dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95_ms=240`, `gate_pass=true`.
3. Buffered/no-drop baseline (surface sanity):
- `artifacts/bench/gate_backlog_pressure/20260302T074649Z/summary.csv`.
- Key anchor: `pressure_profile=buffered-no-drop`, `dropped_oldest=0`, `first_stable_timing_ms=2120`, `gate_pass=true`.

### Re-Run Commands (After Phase 1)
1. Set model path:
```bash
MODEL="$(pwd)/artifacts/bench/models/whispercpp/ggml-tiny.en.bin"
```
2. Run compatibility gate (must pass):
```bash
OUT_DIR="$(pwd)/artifacts/bench/post_opt/gate_v1_acceptance/$(date -u +%Y%m%dT%H%M%SZ)" \
MODEL="$MODEL" \
scripts/gate_v1_acceptance.sh
```
3. Run default pressure gate (surface sanity lane):
```bash
OUT_DIR="$(pwd)/artifacts/bench/post_opt/gate_backlog_pressure/default/$(date -u +%Y%m%dT%H%M%SZ)" \
MODEL="$MODEL" \
scripts/gate_backlog_pressure.sh
```
4. Run induced pressure gate (drop-path comparison lane):
```bash
OUT_DIR="$(pwd)/artifacts/bench/post_opt/gate_backlog_pressure/drop_path/$(date -u +%Y%m%dT%H%M%SZ)" \
MODEL="$MODEL" \
scripts/gate_backlog_pressure.sh \
  --chunk-window-ms 1200 \
  --chunk-stride-ms 80 \
  --chunk-queue-cap 1 \
  --min-drop-ratio 0.05 \
  --max-drop-ratio 0.90 \
  --min-lag-p95-ms 120
```
5. If the induced lane reports `pressure_profile=buffered-no-drop`, rerun with more aggressive settings until `pressure_profile=drop-path` is observed:
```bash
scripts/gate_backlog_pressure.sh --chunk-window-ms 1400 --chunk-stride-ms 60 --chunk-queue-cap 1 --min-drop-ratio 0.05 --max-drop-ratio 0.95 --min-lag-p95-ms 80
```

### Comparison Rules (Before vs After)
1. First stable timing guardrail:
- Target: post-opt `cold_first_stable_timing_ms` and `warm_first_stable_timing_ms` must be `<= 2332` (no more than 10% slower than 2120).
2. Drop reduction target in induced drop-path lane:
- Target formula: `post_dropped_oldest <= floor(baseline_dropped_oldest * 0.70)`.
- With baseline 14, target is `<= 9`.
3. Drop ratio target in induced drop-path lane:
- Target formula: `post_drop_ratio <= baseline_drop_ratio * 0.70`.
- With baseline 0.466667, target is `<= 0.326667`.
4. Contract/truth gates must still pass:
- `gate_v1_acceptance`: `gate_pass=true`.
- `gate_backlog_pressure`: `gate_pass=true`.
- No schema/contract file changes.

### Benchmark Output Checklist
1. Record the three new summary files:
- `post_opt/gate_v1_acceptance/.../summary.csv`
- `post_opt/gate_backlog_pressure/default/.../summary.csv`
- `post_opt/gate_backlog_pressure/drop_path/.../summary.csv`
2. Produce a one-page benchmark note with:
- Baseline path and post-opt path for each lane.
- Metric deltas for `first_stable_timing_ms`, `dropped_oldest`, `drop_ratio`, `lag_p95_ms`.
- Final pass/fail verdict for Phase 1 performance goals.

## Acceptance Criteria
1. No public contract changes in CLI grammar, runtime mode matrix, JSONL schema, manifest schema, or exit-code contract.
2. Live pressure scenarios show a measurable drop reduction target: at least 30% fewer dropped near-live tasks in backlog-pressure runs versus current baseline.
3. First stable emit timing does not regress by more than 10% in existing live-stream integration scenarios.
4. All existing contract/regression tests pass.
5. `app.rs` complexity materially reduced through module extraction, with behavior preserved.

## Rollout and Delivery Sequence
1. PR 1: Phase 1A/1B core reliability changes with backpressure mode and ASR input type; no JSON boundary changes yet.
2. PR 2: Phase 1C pump cadence tuning and live integration test updates.
3. PR 3: Phase 2 typed JSON event/manifest serialization and replay parser migration.
4. PR 4: Phase 3 module decomposition and cleanup.
5. PR 5: post-optimization benchmark rerun using the protocol above and publish benchmark delta note.
6. After each PR: run contract tests, runtime smoke paths, and backlog-pressure gate to prevent cumulative drift.

## Assumptions and Defaults
1. Keep whispercpp/whisperkit helper-process model for now; do not introduce new external backend dependency in this cycle.
2. Keep current trust/degradation semantics and code values.
3. Keep current artifact path semantics (`input_wav`, `out_wav`, `jsonl`, `manifest`) exactly as documented.
4. Keep fake capture behavior compatible with current tests; internal cleanup is allowed if observable behavior remains equivalent.
