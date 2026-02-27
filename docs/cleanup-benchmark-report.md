# Cleanup Benchmark and Auto-Disable Policy (bd-erj)

Date: 2026-02-27  
Status: completed

## Scope

- Benchmark cleanup-on/off behavior using the same 12-run Gate C stress corpus.
- Capture queue impact and cleanup-path reliability counters.
- Define explicit auto-disable thresholds tied to existing manifest fields.
- Document a quality rubric and sample evaluation for `llm_final` outputs.

## Method

Corpus:

- `artifacts/bench/corpus/gate_c/corpus.tsv` (`12` repeated stereo samples, `3s` each)

Scenarios:

1. `control`: cleanup disabled
2. `cleanup_failure_dead_endpoint`: cleanup enabled with dead endpoint (`127.0.0.1:9`)
3. `cleanup_success_stub`: cleanup enabled against local stub endpoint

All scenarios used:

- `DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live`
- `--asr-backend whispercpp`
- `--asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin`
- `--transcribe-channels separate`
- `--asr-threads 4`
- `--benchmark-runs 1`

## Benchmark Artifact

Root:

- `artifacts/bench/cleanup/20260227T124016Z`

Primary artifact:

- `artifacts/bench/cleanup/20260227T124016Z/cleanup_summary.csv`

| scenario | run_count | success_count | wall_ms_p50 | wall_ms_p95 | overhead_vs_control_ms_p95 | submitted | dropped_queue_full | failed | llm_final_count |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| control | 12 | 12 | 740 | 760 | 0 | 0 | 0 | 0 | 0 |
| cleanup_failure_dead_endpoint | 12 | 12 | 730 | 750 | -10 | 2 | 1 | 1 | 0 |
| cleanup_success_stub | 12 | 12 | 760 | 770 | 10 | 2 | 0 | 0 | 2 |

Queue impact is explicit in all cleanup-enabled manifests:

- `artifacts/bench/cleanup/20260227T124016Z/runtime/failure.manifest.json`
- `artifacts/bench/cleanup/20260227T124016Z/runtime/success.manifest.json`

## Quality Rubric

Rubric for `llm_final` sample evaluation:

1. Semantic fidelity (0-2): preserves key facts/entities from source `final`.
2. Readability gain (0-2): meaningfully improves clarity/grammar without losing content.
3. Determinism/consistency (0-1): stable style across channels/segments.

Recommended pass threshold:

- `>= 3/5` on at least 4 of 5 sampled pairs per model/profile.

Sample evaluation artifact:

- `artifacts/bench/cleanup/20260227T124016Z/quality_samples.csv`

Observed sample (`cleanup_success_stub`) uses synthetic stub text `cleaned local segment`, so it is pipeline-valid but content-quality-poor for semantic fidelity. This confirms quality must be gated independently from queue/latency metrics.

## Auto-Disable Thresholds

Policy artifact:

- `artifacts/bench/cleanup/20260227T124016Z/threshold_policy.json`

Computed evaluation:

- `artifacts/bench/cleanup/20260227T124016Z/threshold_evaluation.csv`

Thresholds (per session manifest window):

1. `drop_rate = dropped_queue_full / submitted`  
Auto-disable if `drop_rate >= 0.25`.
2. `fail_timeout_rate = (failed + timed_out) / submitted`  
Auto-disable if `fail_timeout_rate >= 0.25`.
3. `llm_yield_rate = event_counts.llm_final / submitted`  
Auto-disable if `llm_yield_rate < 0.50`.
4. `overhead_p95_ms = cleanup_wall_ms_p95 - control_wall_ms_p95`  
Auto-disable if `overhead_p95_ms > 100`.
5. Human quality gate (rubric above)  
Auto-disable by default for model/profile if sample quality fails pass threshold.

Policy result on current artifact:

- `cleanup_failure_dead_endpoint` => `auto_disable` (drop/fail thresholds exceeded)
- `cleanup_success_stub` => telemetry thresholds pass, but human-quality gate fails for semantic fidelity (stub content)

## Interpretation

- Cleanup path is operationally isolated: all scenarios were `12/12` successful on ASR path.
- Queue counters cleanly separate failure and success modes.
- Explicit thresholds now convert cleanup from a best-effort feature into a controlled policy with measurable disable triggers.

## Related Files

- `artifacts/bench/cleanup/20260227T124016Z/control/20260227T124017Z/summary.csv`
- `artifacts/bench/cleanup/20260227T124016Z/failure/20260227T124026Z/summary.csv`
- `artifacts/bench/cleanup/20260227T124016Z/success/20260227T124036Z/summary.csv`
- `artifacts/bench/cleanup/20260227T124016Z/runtime/control.manifest.json`
- `artifacts/bench/cleanup/20260227T124016Z/runtime/failure.manifest.json`
- `artifacts/bench/cleanup/20260227T124016Z/runtime/success.manifest.json`
