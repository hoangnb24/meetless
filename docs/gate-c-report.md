# Gate C Stress Benchmark Report (bd-3vk)

Date: 2026-02-27  
Status: completed

## Scope

- Validate dual-channel viability under sustained repeated runs (12x, 3s stereo sample).
- Compare tuning profiles (`separate` with `--asr-threads 2` vs `4`) and a `mixed` baseline.
- Confirm queue/drop behavior remains observable and non-blocking under cleanup pressure.

## Validity Notes and Protocol

Earlier Gate C harness directories (`dual_t2`, `dual_t4`, `mixed_t4`, and `*_bin` variants) were not valid for decision-making because runs failed (`exit_code` `101` or `-1`) due invocation/runtime-loader context.

Validated Gate C runs were re-executed using command templates that explicitly set:

```bash
DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live ...
```

Commands used:

```bash
cargo run --quiet --bin benchmark_harness -- \
  --corpus artifacts/bench/corpus/gate_c/corpus.tsv \
  --out-dir artifacts/bench/gate_c/dual_t2_dyld \
  --backend-id gatec_dual_t2_dyld \
  --cmd "DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live --asr-backend whispercpp --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --input-wav {input} --transcribe-channels separate --asr-threads 2 --benchmark-runs 1 --out-jsonl artifacts/bench/gate_c/runtime/dual_t2_dyld.jsonl --out-manifest artifacts/bench/gate_c/runtime/dual_t2_dyld.manifest.json"

cargo run --quiet --bin benchmark_harness -- \
  --corpus artifacts/bench/corpus/gate_c/corpus.tsv \
  --out-dir artifacts/bench/gate_c/dual_t4_dyld \
  --backend-id gatec_dual_t4_dyld \
  --cmd "DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live --asr-backend whispercpp --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --input-wav {input} --transcribe-channels separate --asr-threads 4 --benchmark-runs 1 --out-jsonl artifacts/bench/gate_c/runtime/dual_t4_dyld.jsonl --out-manifest artifacts/bench/gate_c/runtime/dual_t4_dyld.manifest.json"

cargo run --quiet --bin benchmark_harness -- \
  --corpus artifacts/bench/corpus/gate_c/corpus.tsv \
  --out-dir artifacts/bench/gate_c/mixed_t4_dyld \
  --backend-id gatec_mixed_t4_dyld \
  --cmd "DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live --asr-backend whispercpp --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --input-wav {input} --transcribe-channels mixed --asr-threads 4 --benchmark-runs 1 --out-jsonl artifacts/bench/gate_c/runtime/mixed_t4_dyld.jsonl --out-manifest artifacts/bench/gate_c/runtime/mixed_t4_dyld.manifest.json"
```

## Gate C Thresholds

| Check | Threshold | Result |
|---|---|---|
| Harness reliability | `success_count == run_count` for all measured profiles | PASS |
| Dual-channel stress latency | `wall_ms_p95 <= 1200` for `separate` profiles | PASS |
| Runtime SLO conformance | `partial_slo_met=true` and `final_slo_met=true` in runtime manifests | PASS |
| Resource envelope | `cpu_pct_p95 <= 85` and `max_rss_bytes_p95 <= 210000000` | PASS |
| Degradation signaling | `degradation_events=[]` in normal `separate`/`mixed` runs | PASS |
| Cleanup isolation under pressure | cleanup may drop/fail requests, but transcription SLO remains met and queue drains | PASS |

## Results

### Validated stress runs

| Profile | Success | wall_ms_p50 | wall_ms_p95 | cpu_pct_p95 | max_rss_bytes_p95 | Gate |
|---|---:|---:|---:|---:|---:|---|
| `gatec_dual_t2_dyld` (`separate`, threads=2) | 12/12 | 720 | 1010 | 77.78 | 198017024 | PASS |
| `gatec_dual_t4_dyld` (`separate`, threads=4) | 12/12 | 710 | 720 | 79.17 | 199704576 | PASS |
| `gatec_mixed_t4_dyld` (`mixed`, threads=4) | 12/12 | 640 | 650 | 37.50 | 199278592 | PASS |

### Drift and stability notes

- `dual_t2_dyld`: first run `1.120s`, last run `0.710s` (`-36.6%`) indicating cold-start/warm-up skew.
- `dual_t4_dyld`: first run `0.710s`, last run `0.710s` (`0.0%`), with tight range (`0.700s` to `0.730s`).
- `mixed_t4_dyld`: first run `0.640s`, last run `0.650s` (`+1.6%`), stable.

## Quantitative Tuning Comparison

- `dual_t4` vs `dual_t2`:
  - `wall_ms_p50`: `-1.4%`
  - `wall_ms_p95`: `-28.7%`
  - `cpu_pct_p50`: `+2.3%` (higher CPU usage)
  - `max_rss_bytes_p50`: `+0.9%`
- `mixed_t4` vs `dual_t4`:
  - `wall_ms_p50`: `-9.9%`
  - `wall_ms_p95`: `-9.7%`
  - `cpu_pct_p50`: `-51.8%`
  - `max_rss_bytes_p50`: `-0.3%`
  - tradeoff: loses per-channel transcript attribution (single merged lane)

## Cleanup Pressure Evidence

From `dual_cleanup_pressure` runtime artifact:

- `cleanup_queue`: `submitted=2`, `enqueued=1`, `dropped_queue_full=1`, `failed=1`, `drain_completed=true`
- benchmark latency remained within SLO (`wall_ms_p95=661.058875`, `partial_slo_met=true`, `final_slo_met=true`)
- `degradation_events=[]`

Comparison against no-cleanup control (`manual_dual_t4`):

- control `wall_ms_p95=656.738542`
- cleanup-pressure `wall_ms_p95=661.058875`
- delta `+4.320ms` (`+0.66%`)

Interpretation: queue pressure is observable and non-zero under induced cleanup failure, but core ASR latency/SLO behavior remains effectively unchanged.

## Bottlenecks and Follow-Up Actions

1. Invocation/runtime-loader fragility can silently invalidate benchmark runs.  
Follow-up: codify an execution contract (or wrapper) that always injects Swift runtime env for direct binary invocation; capture this guidance in schema/docs work (`bd-oe2`).

2. Lower-thread dual-channel profile shows warm-up skew and worse p95 tail.  
Follow-up: keep `--asr-threads 4` as recommended dual-channel stress profile and verify under longer duration in soak gate (`bd-7cb`).

3. Cleanup queue backpressure is expected under endpoint failure and currently tolerated.  
Follow-up: formalize auto-disable thresholds and operator policy from measured queue impact (`bd-erj`), and keep telemetry linkage in reliability lane (`bd-a88`).

## Artifacts

- Valid stress summaries/runs:
  - `artifacts/bench/gate_c/dual_t2_dyld/20260227T122716Z/summary.csv`
  - `artifacts/bench/gate_c/dual_t2_dyld/20260227T122716Z/runs.csv`
  - `artifacts/bench/gate_c/dual_t4_dyld/20260227T122726Z/summary.csv`
  - `artifacts/bench/gate_c/dual_t4_dyld/20260227T122726Z/runs.csv`
  - `artifacts/bench/gate_c/mixed_t4_dyld/20260227T122735Z/summary.csv`
  - `artifacts/bench/gate_c/mixed_t4_dyld/20260227T122735Z/runs.csv`
- Runtime manifests/JSONL:
  - `artifacts/bench/gate_c/runtime/dual_t2_dyld.manifest.json`
  - `artifacts/bench/gate_c/runtime/dual_t4_dyld.manifest.json`
  - `artifacts/bench/gate_c/runtime/mixed_t4_dyld.manifest.json`
  - `artifacts/bench/gate_c/runtime/manual_dual_t4.manifest.json`
  - `artifacts/bench/gate_c/runtime/dual_cleanup_pressure.manifest.json`
  - `artifacts/bench/gate_c/runtime/dual_cleanup_pressure.jsonl`
