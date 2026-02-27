# Gate A/B Experiment Report (bd-2il)

Date: 2026-02-27
Status: in progress (runtime/model provisioning blocker)

## Scope

- Gate A: backend comparison under identical corpus/hardware conditions
- Gate B: Rust integration overhead and repeated-run stability

## Environment Inventory (Verified)

Command checks:

```bash
which whisper-cli || true
which whisper || true
which moonshine || true
which ort || true
which ffmpeg || true
ls -la models || true
```

Observed:

- `whisper-cli`: not installed
- `whisper`: not installed
- `moonshine`: not installed
- `ort`: not installed
- `ffmpeg`: installed (`/opt/homebrew/bin/ffmpeg`)
- `models/`: directory absent

## Available Benchmark Infrastructure

- Harness: `src/bin/benchmark_harness.rs`
- Corpus definition: `bench/corpus/v1/corpus.tsv`
- Runner: `make bench-harness`
- Current machine-readable output examples:
  - `artifacts/bench/20260227T104713Z/summary.csv`
  - `artifacts/bench/20260227T104713Z/runs.csv`

## Blocker

Gate A/B cannot produce backend-comparison metrics yet because candidate ASR runtimes and local model assets are missing.

## Ready-to-Run Command Shapes (when assets are available)

Whisper candidate:

```bash
MODEL_PATH=/abs/path/to/model.bin \
make bench-harness \
  BENCH_BACKEND=whisper-cli \
  BENCH_CMD="whisper-cli -m $MODEL_PATH -f {input} -l en -otxt -of /tmp/recordit-whisper"
```

Moonshine candidate (placeholder command shape):

```bash
MODEL_PATH=/abs/path/to/model.onnx \
make bench-harness \
  BENCH_BACKEND=moonshine \
  BENCH_CMD="moonshine --model $MODEL_PATH --input {input} --language en"
```

## Next Step

Provision local backend executables and model paths, then rerun Gate A/B with the same corpus and compare:

- wall-time p50/p95
- derived CPU percent p50/p95
- max RSS p50/p95
- integration overhead ratio (Gate B)
- failure analysis and recommendation
