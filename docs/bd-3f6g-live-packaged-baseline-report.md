# Live/Packaged Baseline Comparison (`bd-3f6g`)

Date: 2026-03-02  
Status: pass

## Scope

Compare the current live-stream fake-capture and packaged smoke outputs against the frozen baseline expectations for Phase G compatibility work.

## Commands Run

```bash
MODEL="$(pwd)/artifacts/bench/models/whispercpp/ggml-tiny.en.bin" \
OUT_DIR="/tmp/bd-3f6g-gate-v1-acceptance" \
scripts/gate_v1_acceptance.sh

PACKAGED_ROOT="$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta" \
OUT_DIR="$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/bd-3f6g" \
MODEL="$(pwd)/artifacts/bench/models/whispercpp/ggml-tiny.en.bin" \
scripts/gate_packaged_live_smoke.sh
```

## Evidence Inputs

Current run artifacts:

- fake-capture live summary: `/tmp/bd-3f6g-gate-v1-acceptance/summary.csv`
- fake-capture live status: `/tmp/bd-3f6g-gate-v1-acceptance/status.txt`
- packaged smoke summary: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/bd-3f6g/summary.csv`
- packaged smoke status: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/bd-3f6g/status.txt`

Frozen baseline references:

- fake-capture live baseline: `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- packaged smoke baseline: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T130815Z/summary.csv`
- contract references:
  - `docs/runtime-golden-artifact-matrix.md`
  - `docs/gate-packaged-live-smoke.md`

## Comparison Results

### Fake-Capture Live (`gate_v1_acceptance`)

Matched baseline values:

- `cold_event_count=36`
- `warm_event_count=36`
- runtime mode tuple remained `live-stream / live-stream / --live-stream`
- `cold_first_stable_timing_ms=2120`
- `warm_first_stable_timing_ms=2120`
- `cold_terminal_live_mode_ok=true`
- `warm_terminal_live_mode_ok=true`
- `backlog_pressure_profile=buffered-no-drop`
- `backlog_surface_ok=true`
- `gate_pass=true`

Status file verdict:

- `status=pass`
- `detail=v1_acceptance_and_handoff_thresholds_satisfied`

### Packaged Smoke (`gate_packaged_live_smoke`)

Matched baseline values:

- runtime mode tuple remained `live-stream / live-stream / --live-stream`
- `runtime_event_count=50`
- `runtime_first_stable_timing_ms=2120`
- `runtime_terminal_live_mode_ok=true`
- `runtime_terminal_replay_suppressed_ok=true`
- `runtime_trust_notice_count=0`
- `runtime_helper_exec_blocked=false`
- `gate_pass=true`

Status file verdict:

- `status=pass`
- `detail=packaged_live_smoke_thresholds_satisfied`

## Verdict

`bd-3f6g` passes on current shared state. The fake-capture live and packaged smoke lanes both preserve the frozen baseline signals that matter for compatibility: mode tuple, first-stable timing, terminal live behavior, artifact truth, trust/degradation surface cleanliness, and overall gate pass status.
