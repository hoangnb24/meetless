# Gate D 60-Minute Soak Report (bd-7cb)

Date: 2026-02-27  
Status: completed (first full artifact fails gate due invalid direct-binary launch; reusable fixed harness published and smoke-validated)

## Scope

- Execute a true 60-minute reliability soak.
- Track long-run drift and stability using per-run runtime artifacts.
- Publish reusable regression-gate commands for repeat execution.

## Gate D Procedure

1. Build the runtime binary once:

```bash
cargo build --bin transcribe-live
```

2. Run a 3600-second soak loop that repeatedly executes `cargo run --quiet --bin transcribe-live -- ...` with `DYLD_LIBRARY_PATH=/usr/lib/swift`:
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
make gate-d-soak
```

Evaluate a completed Gate D artifact:

```bash
SOAK_DIR=artifacts/bench/gate_d/<stamp>
column -s, -t "$SOAK_DIR/summary.csv"
```

## Results

- Full soak artifact: `artifacts/bench/gate_d/20260227T125909Z/`
  - root cause of failure: direct execution of `target/debug/transcribe-live` aborted before runtime start with `dyld: Library not loaded: @rpath/libswift_Concurrency.dylib`
  - final summary: `failure_count=22000`, `soak_seconds_actual=3600`, `threshold_soak_duration_ok=true`, `gate_pass=false`
  - interpretation: Gate D correctly rejected the invalid launch path and preserved a full-duration failure artifact for audit
- Fixed regression command: `make gate-d-soak`
  - implementation: `scripts/gate_d_soak.sh` + `scripts/gate_d_summary.py`
  - smoke validation: `artifacts/validation/bd-7cb.make-smoke/summary.csv` shows `gate_pass=true` for a short-duration harness check with the corrected `cargo run` launch path
