# Gate D 60-Minute Soak Report (bd-7cb)

Date: 2026-02-27  
Status: running (results section will be finalized when soak completes)

## Scope

- Execute a true 60-minute reliability soak.
- Track long-run drift and stability using per-run runtime artifacts.
- Publish reusable regression-gate commands for repeat execution.

## Gate D Procedure

1. Build the runtime binary once:

```bash
cargo build --bin transcribe-live
```

2. Run a 3600-second soak loop that repeatedly executes `target/debug/transcribe-live` with:
   - `--asr-backend whispercpp`
   - `--transcribe-channels mixed-fallback`
   - bounded cleanup lane enabled (`--llm-cleanup`, `--llm-max-queue 1`, short timeout/retries)
   - per-run JSONL/manifest/time/stdout artifacts saved under `artifacts/bench/gate_d/<stamp>/runs/`

3. Aggregate per-run metrics into:
   - `runs.csv`
   - `summary.csv`

## Gate D Thresholds

| Check | Threshold | Why |
|---|---|---|
| Soak duration | `soak_seconds_actual >= 3600` | Ensures full long-duration exposure |
| Harness reliability | `failure_count = 0` | Gate should fail on runtime instability |
| Runtime latency drift | `manifest_wall_ms_p95_p95 <= 1.25 * manifest_wall_ms_p95_p50` | Bounds long-tail growth across the soak |
| Memory pressure growth | `max_rss_kb_p95 <= 1.30 * max_rss_kb_p50` | Detects likely leak/accumulation patterns |
| Cleanup backpressure visibility | `total_cleanup_dropped`, `total_cleanup_failed`, `total_cleanup_timed_out` present | Confirms queue/degradation visibility under stress |
| Degradation signaling visibility | `total_degradation_events` present | Confirms trust/degradation metadata remains surfaced |

## Reusable Regression Gate Commands

Run Gate D soak:

```bash
bash -lc '
set -euo pipefail
ROOT=/Users/themrb/Documents/1_projects/recordit
MODEL=$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin
INPUT=$ROOT/artifacts/bench/corpus/gate_a/tts_phrase.wav
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=$ROOT/artifacts/bench/gate_d/$STAMP
mkdir -p "$OUT/runs"
echo "run_index,start_utc,end_utc,exit_code,real_ms,max_rss_kb,wall_ms_p95,wall_ms_p50,cleanup_dropped_queue_full,cleanup_failed,cleanup_timed_out,mode_requested,mode_active,degradation_events" > "$OUT/runs.csv"
cargo build --bin transcribe-live >/dev/null
start_epoch=$(date +%s)
end_epoch=$((start_epoch + 3600))
run=0
while [ "$(date +%s)" -lt "$end_epoch" ]; do
  run=$((run + 1))
  p="$OUT/runs/run_${run}"
  manifest="$p.manifest.json"
  jsonl="$p.jsonl"
  start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set +e
  /usr/bin/time -l "$ROOT/target/debug/transcribe-live" \
    --asr-backend whispercpp \
    --asr-model "$MODEL" \
    --input-wav "$INPUT" \
    --benchmark-runs 1 \
    --transcribe-channels mixed-fallback \
    --llm-cleanup \
    --llm-endpoint http://127.0.0.1:9/v1/chat/completions \
    --llm-model dummy \
    --llm-timeout-ms 80 \
    --llm-max-queue 1 \
    --llm-retries 0 \
    --out-jsonl "$jsonl" \
    --out-manifest "$manifest" \
    > "$p.stdout.txt" 2> "$p.time.txt"
  ec=$?
  set -e
  end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  real_ms=$(awk "/real/{printf \"%.3f\", \$1*1000; exit}" "$p.time.txt")
  rss=$(awk "/maximum resident set size/{print \$1; exit}" "$p.time.txt")
  if [ -f "$manifest" ]; then
    wp95=$(jq -r ".benchmark.wall_ms_p95 // 0" "$manifest")
    wp50=$(jq -r ".benchmark.wall_ms_p50 // 0" "$manifest")
    qdrop=$(jq -r ".cleanup_queue.dropped_queue_full // 0" "$manifest")
    qfail=$(jq -r ".cleanup_queue.failed // 0" "$manifest")
    qto=$(jq -r ".cleanup_queue.timed_out // 0" "$manifest")
    mode_req=$(jq -r ".channel_mode_requested // \"unknown\"" "$manifest")
    mode_act=$(jq -r ".channel_mode // \"unknown\"" "$manifest")
    deg=$(jq -r "(.degradation_events // []) | length" "$manifest")
  else
    wp95=0; wp50=0; qdrop=0; qfail=0; qto=0; mode_req=unknown; mode_act=unknown; deg=0
  fi
  echo "$run,$start_utc,$end_utc,$ec,$real_ms,$rss,$wp95,$wp50,$qdrop,$qfail,$qto,$mode_req,$mode_act,$deg" >> "$OUT/runs.csv"
done
'
```

Evaluate a completed Gate D artifact:

```bash
SOAK_DIR=artifacts/bench/gate_d/<stamp>
column -s, -t "$SOAK_DIR/summary.csv"
```

## Results

Pending completion of the currently running soak execution.
