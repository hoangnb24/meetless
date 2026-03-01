# Gate: Packaged Live-Stream Smoke

This gate validates the signed transcribe app executable in live-stream mode
using deterministic fake capture input. It is the packaged companion to the
debug-side live gates and produces machine-readable evidence for packaged live
readiness.

## Run

```bash
make gate-packaged-live-smoke
```

Direct script invocation is also supported:

```bash
scripts/gate_packaged_live_smoke.sh
```

If you override `--out-dir`, keep it under `--packaged-root`; signed-app sandboxed runs can fail when artifact targets point outside the packaged container root.

Default artifact root:

- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/`

Expected outputs:

- `model_doctor/model_doctor.stdout.log`
- `model_doctor/model_doctor.time.txt`
- `runtime/runtime.stdout.log`
- `runtime/runtime.time.txt`
- `runtime/session.input.wav`
- `runtime/session.wav`
- `runtime/session.jsonl`
- `runtime/session.manifest.json`
- `summary.csv`
- `status.txt`

## Acceptance Bar

`summary.csv` publishes per-check booleans and `gate_pass`.

Core checks:

1. `doctor_exit_ok=true`
2. `doctor_banner_ok=true`
3. `runtime_exit_ok=true`
4. `runtime_kind_ok=true` (`kind=transcribe-live-runtime`)
5. `runtime_mode_ok=true` (`runtime_mode=live-stream`, taxonomy `live-stream`, selector `--live-stream`)
6. `runtime_mode_status_ok=true`
7. `runtime_input_capture_ok=true` (`session.input.wav` materialized and non-zero bytes)
8. `runtime_out_wav_truth_ok=true` (`out_wav_materialized=true`, manifest bytes > 0, file exists)
9. `runtime_first_stable_emit_ok=true` (active phase observed and stable first-emit evidence present)
10. `runtime_terminal_live_mode_ok=true`
11. `runtime_terminal_replay_suppressed_ok=true`
12. `runtime_trust_surface_ok=true`
13. `runtime_degradation_surface_ok=true`
14. `runtime_artifact_root_ok=true`
15. `runtime_manifest_jsonl_match_ok=true`
16. `runtime_manifest_out_manifest_match_ok=true`
17. `runtime_transcript_surface_ok=true`

Interpretation:

- the gate runs the signed app executable (`dist/SequoiaTranscribe.app/Contents/MacOS/SequoiaTranscribe`) after `make sign-transcribe`
- runtime scenario uses `RECORDIT_FAKE_CAPTURE_FIXTURE` for deterministic input while still validating signed-app artifact semantics
- trust/degradation checks enforce manifest-shape consistency so downstream review work can rely on packaged artifacts without re-deriving contract assumptions
- `status.txt` is a quick PASS/FAIL envelope; `summary.csv` is the canonical machine-readable evidence artifact
- `summary.csv` also records `runtime_error_line` and `runtime_helper_exec_blocked` for no-go classification when packaged live prewarm fails
- `runtime_first_emit_during_active_ok` and `runtime_first_stable_during_active_ok` remain diagnostic fields; final pass/fail uses `runtime_first_stable_emit_ok` to avoid false negatives from non-chronological JSONL row ordering
