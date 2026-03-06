# Post-Implementation Verification Checklist and Evidence Index

Purpose: provide a single handoff document for true `--live-stream` verification after implementation changes.

Scope: deterministic gate evidence, packaged smoke evidence, and quick failure classification.

## Prerequisites

1. Ensure model exists:

```bash
make setup-whispercpp-model
```

2. If running packaged smoke, ensure signed app is buildable/signable in your environment.

## Verification Checklist

1. Run backlog pressure gate:

```bash
make gate-backlog-pressure
```

Expected envelope (`status.txt`):
- `status=pass`
- `detail=backlog_pressure_thresholds_satisfied`

Required summary checks (`summary.csv`):
- `threshold_runtime_mode_ok=true`
- `threshold_first_stable_emit_ok=true`
- `threshold_transcript_surface_ok=true`
- `threshold_terminal_live_mode_ok=true`
- `gate_pass=true`

Profile semantics:
- `pressure_profile=drop-path`: degradation/trust/reconciliation signals must be present
- `pressure_profile=buffered-no-drop`: degradation/trust signals must remain absent

2. Run v1 acceptance gate:

```bash
make gate-v1-acceptance
```

Expected envelope (`status.txt`):
- `status=pass`
- `detail=v1_acceptance_thresholds_satisfied`

Required summary checks (`summary.csv`):
- `cold_first_stable_emit_ok=true`
- `warm_first_stable_emit_ok=true`
- `cold_artifact_truth_ok=true`
- `warm_artifact_truth_ok=true`
- `backlog_pressure_profile_known_ok=true`
- `backlog_surface_ok=true`
- `gate_pass=true`

3. Run packaged live smoke gate:

```bash
make gate-packaged-live-smoke
```

Expected envelope (`status.txt`):
- `status=pass`
- `detail=packaged_live_smoke_thresholds_satisfied`

Required summary checks (`summary.csv`):
- `recordit_launch_semantics_ok=true`
- `runtime_first_stable_emit_ok=true`
- `runtime_transcript_surface_ok=true`
- `runtime_terminal_live_mode_ok=true`
- `runtime_out_wav_truth_ok=true`
- `gate_pass=true`

4. Optional targeted integration check for true-live growth:

```bash
cargo test --test live_stream_true_live_integration -- --nocapture
```

Expected:
- test passes
- assertions confirm in-flight growth of `session.input.wav` and `session.jsonl`

## Evidence Index

Backlog pressure gate artifacts:
- `artifacts/bench/gate_backlog_pressure/<timestamp>/status.txt`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/summary.csv`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.manifest.json`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/runtime.jsonl`

V1 acceptance artifacts:
- `artifacts/bench/gate_v1_acceptance/<timestamp>/status.txt`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/summary.csv`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/cold/`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/warm/`
- `artifacts/bench/gate_v1_acceptance/<timestamp>/backlog_pressure/`

Packaged smoke artifacts:
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/recordit_run_plan.log`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/runtime/session.manifest.json`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/runtime/session.jsonl`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/runtime/session.input.wav`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/runtime/session.wav`

## Latest Known-Good Local Evidence (This Session)

Backlog pressure pass:
- `artifacts/bench/gate_backlog_pressure/20260301T130103Z/status.txt`
- `artifacts/bench/gate_backlog_pressure/20260301T130103Z/summary.csv`
- key rows: `pressure_profile=buffered-no-drop`, `gate_pass=true`

V1 acceptance pass:
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/status.txt`
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- key rows: `cold_first_stable_emit_ok=true`, `warm_first_stable_emit_ok=true`, `backlog_surface_ok=true`, `gate_pass=true`

Packaged smoke:
- `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T130815Z/status.txt`
- `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T130815Z/summary.csv`
- key rows: `recordit_launch_semantics_ok=true`, `runtime_first_stable_emit_ok=true`, `runtime_transcript_surface_ok=true`, `runtime_terminal_live_mode_ok=true`, `gate_pass=true`

## Fast Failure Classification

1. `runtime_helper_exec_blocked=true` (packaged smoke): signed-app runtime helper execution path is blocked; treat packaged live as not ready.
2. `backlog_surface_ok=false` with `pressure_profile=buffered-no-drop`: gate/documentation mismatch; verify profile-aware logic is present.
3. `threshold_runtime_mode_ok=false` or `*_runtime_mode_ok=false`: runtime selector/taxonomy contract drifted from `--live-stream`.
4. `*_first_stable_emit_ok=false`: stable transcript timing evidence missing; inspect lifecycle/transcript events and `first_emit_timing_ms`.

## Related References

- `docs/gate-backlog-pressure.md`
- `docs/gate-v1-acceptance.md`
- `docs/gate-packaged-live-smoke.md`
- `docs/transcribe-operator-runbook.md`
- `LIVE_TRANS.md`
