# Live-Stream Verification Checklist and Evidence Index

Status: post-implementation handoff for `bd-25s1`

This document is the single-session verification checklist for shipped `transcribe-live --live-stream` behavior.
Use it when deciding whether the current workspace is still release-ready, when handing off to another session,
or when you need to reproduce the core evidence without re-deriving the workflow from code.

## Release Checklist

Run these in order.

1. Model/bootstrap readiness
   - Command:
     ```bash
     make setup-whispercpp-model
     ```
   - Expected result:
     - local whispercpp model materializes at `artifacts/bench/models/whispercpp/ggml-tiny.en.bin`
     - output prints absolute path, SHA-256, and byte size

2. Packaged live smoke
   - Command:
     ```bash
     make gate-packaged-live-smoke
     ```
   - Required result:
     - `status=pass`
     - `detail=packaged_live_smoke_thresholds_satisfied`
     - `gate_pass=true`
     - `runtime_first_stable_emit_ok=true`
     - `runtime_transcript_surface_ok=true`
     - `runtime_terminal_live_mode_ok=true`
   - Canonical artifacts:
     - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`
     - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`

3. True live acceptance gate
   - Command:
     ```bash
     make gate-v1-acceptance
     ```
   - Required result:
     - `status=pass`
     - `detail=v1_acceptance_and_handoff_thresholds_satisfied`
     - `gate_pass=true`
     - cold/warm `runtime_mode_ok=true`
     - cold/warm `first_stable_emit_ok=true`
     - cold/warm `terminal_live_mode_ok=true`
     - `backlog_gate_pass=true`
     - `backlog_surface_ok=true`
   - Canonical artifacts:
     - `artifacts/bench/gate_v1_acceptance/<timestamp>/status.txt`
     - `artifacts/bench/gate_v1_acceptance/<timestamp>/summary.csv`
     - `artifacts/bench/gate_v1_acceptance/<timestamp>/cold/runtime.manifest.json`
     - `artifacts/bench/gate_v1_acceptance/<timestamp>/warm/runtime.manifest.json`
     - `artifacts/bench/gate_v1_acceptance/<timestamp>/backlog_pressure/summary.csv`

4. Backlog-pressure gate
   - Command:
     ```bash
     make gate-backlog-pressure
     ```
   - Required result:
     - `status=pass`
     - `detail=backlog_pressure_thresholds_satisfied`
     - `gate_pass=true`
     - `threshold_runtime_mode_ok=true`
     - `threshold_first_stable_emit_ok=true`
     - `threshold_transcript_surface_ok=true`
     - `threshold_terminal_live_mode_ok=true`
   - Profile-aware interpretation:
     - `pressure_profile=drop-path`: degradation/trust signals are expected
     - `pressure_profile=buffered-no-drop`: zero degradation/trust signals are acceptable and expected
   - Canonical artifacts:
     - `artifacts/bench/gate_backlog_pressure/<timestamp>/status.txt`
     - `artifacts/bench/gate_backlog_pressure/<timestamp>/summary.csv`
     - `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.manifest.json`
     - `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.jsonl`

5. Deterministic integration guard
   - Command:
     ```bash
     cargo test --test live_stream_true_live_integration -- --nocapture
     ```
   - Required result:
     - the test passes
     - it proves in-flight `session.input.wav` growth, in-flight `session.jsonl` growth, and first stable emit before timeout

6. Optional debug CLI run
   - Command:
     ```bash
     make transcribe-live-stream \
       ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
     ```
   - Expected result:
     - terminal transitions through `warmup`, `active`, `draining`, `shutdown`
     - stable transcript output appears during `active`
     - `--input-wav` grows during runtime
     - `--out-wav` is materialized as the canonical session artifact on success

## Current Evidence Index

Confirmed passing artifacts from this session:

1. Backlog-pressure gate
   - `artifacts/bench/gate_backlog_pressure/20260301T130103Z/status.txt`
   - `artifacts/bench/gate_backlog_pressure/20260301T130103Z/summary.csv`
   - `artifacts/bench/gate_backlog_pressure/20260301T130103Z/runtime.manifest.json`
   - `artifacts/bench/gate_backlog_pressure/20260301T130103Z/runtime.jsonl`

2. V1 acceptance gate
   - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/status.txt`
   - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
   - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.manifest.json`
   - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.manifest.json`
   - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/backlog_pressure/summary.csv`

3. Packaged live smoke gate
   - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T123823Z/status.txt`
   - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T123823Z/summary.csv`

4. Deterministic integration test
   - command: `cargo test --test live_stream_true_live_integration -- --nocapture`
   - result: `1 passed; 0 failed`

## Known Caveats

1. `gate-backlog-pressure` is intentionally profile-aware now. A passing run does not have to emit drop/degradation/trust signals if the queue stayed in the buffered-no-drop profile.
2. `summary.csv` is the canonical machine-readable artifact for all gates; `status.txt` is only the quick operator envelope.
3. If packaged smoke reports `runtime_helper_exec_blocked=true`, treat signed-app live-stream as not ready regardless of other local debug successes.
4. `moonshine` remains out of scope for shipped live-stream runtime validation in this phase.

## Related References

- `README.md`
- `LIVE_TRANS.md`
- `docs/transcribe-operator-runbook.md`
- `docs/gate-packaged-live-smoke.md`
- `docs/gate-backlog-pressure.md`
- `docs/gate-v1-acceptance.md`
