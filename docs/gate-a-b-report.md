# Gate A/B Experiment Report (bd-2il)

Date: 2026-02-27
Status: completed

## Scope

- Gate A: backend comparison under identical corpus/hardware conditions
- Gate B: Rust integration overhead and repeated-run stability

## Environment and Candidate Availability

Observed on this host:

- `whisper-cli`: available (`/opt/homebrew/bin/whisper-cli`)
- `whisperkit-cli`: available (`/opt/homebrew/bin/whisperkit-cli`)
- `moonshine`: not available as a local CLI binary on this host

Moonshine gap:

- `moonshine` is not installed and was not discoverable via the local package workflow used in this session.
- Because Gate A requires runnable local binaries with reproducible command lines, moonshine was excluded from measured comparisons.
- This is tracked as an availability gap, not a quality verdict.

## Corpus and Commands

Gate corpus:

- `artifacts/bench/corpus/gate_a/corpus.tsv`
- Samples: `jfk` (11s), `recordit_tts` (3s)

Measured commands:

```bash
whispercpp:
  whisper-cli -m artifacts/bench/models/whispercpp/ggml-tiny.en.bin -f {input} -l en -otxt -of /tmp/recordit-whispercpp

whisperkit:
  whisperkit-cli transcribe --audio-path {input} \
    --model-path artifacts/bench/models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-tiny \
    --language en --task transcribe --without-timestamps
```

## Gate A: Backend Comparison

Source summaries:

- `artifacts/bench/harness_gateab/whispercpp/20260227T111516Z/summary.csv`
- `artifacts/bench/harness_gateab/whisperkit/20260227T111517Z/summary.csv`

Results (2/2 success for both backends):

| backend | wall_ms_p50 | wall_ms_p95 | cpu_pct_p50 | max_rss_bytes_p50 |
|---|---:|---:|---:|---:|
| whispercpp | 620 | 620 | 49.18 | 200,392,704 |
| whisperkit | 870 | 870 | 86.11 | 82,296,832 |

Interpretation:

- Latency: whispercpp is faster on this corpus/hardware.
- CPU load: whispercpp shows materially lower derived CPU%.
- Memory: whisperkit uses significantly less RSS.
- Both produced correct first-line transcripts for both samples in direct runs.

Recommendation (Gate A):

- Select `whispercpp` as the primary backend on this host for better latency/CPU efficiency.
- Keep `whisperkit` as a viable fallback where lower memory footprint is prioritized.

## Gate B: Rust Integration Overhead and Stability

Method:

- Compared matched direct CLI invocations vs harness-driven invocations over the same corpus and command templates.
- Direct timing artifacts:
  - `artifacts/bench/outputs/direct_gateab/whispercpp/*.time`
  - `artifacts/bench/outputs/direct_gateab/whisperkit/*.time`
- Harness timing artifacts:
  - `artifacts/bench/harness_gateab/whispercpp/20260227T111516Z/runs.csv`
  - `artifacts/bench/harness_gateab/whisperkit/20260227T111517Z/runs.csv`

Overhead ratios (harness/direct, p50):

| backend | direct wall_ms_p50 | harness wall_ms_p50 | ratio | rss ratio |
|---|---:|---:|---:|---:|
| whispercpp | 620 | 620 | 1.000 | 1.002 |
| whisperkit | 860 | 870 | 1.012 | 1.019 |

Failure analysis:

- No execution failures observed in Gate B runs (all runs exit code 0).
- Harness integration overhead is negligible (0% to ~1.2%), within expected measurement noise for short single-file CLI runs.
- During execution, one harness parser gap was identified and fixed: corpus metadata values prefixed with `reference:` are now accepted as non-generated inputs.

Gate B conclusion:

- Rust harness invocation overhead does not materially distort backend measurements.
- The current harness and corpus are suitable for continued backend evaluation and regression tracking.
