# Near-Live Soak Baseline vs Post-Opt Drift Deltas

Bead: `bd-1ady`  
Date: 2026-03-04

## Inputs And Provenance

Baseline reference:
- `docs/gate-d-report.md` (`Observed (20260228T154530Z)`)
- baseline artifact pointer from that report: `artifacts/bench/gate_d/20260228T154530Z/summary.csv`

Post-opt source of truth:
- `artifacts/bench/gate_d/20260304T034759Z/summary.csv`
- `artifacts/bench/gate_d/20260304T034759Z/status.txt`
- `docs/gate-near-live-soak-post-opt-evidence.md`

Provenance caveat:
- the baseline `summary.csv` artifact path referenced in `docs/gate-d-report.md` is not currently present in this workspace, so only baseline values explicitly frozen in docs can be compared directly.

## Delta Table

| Metric | Baseline | Post-Opt | Delta | Status | Severity | Evidence |
|---|---:|---:|---:|---|---|---|
| `run_count` | `2` | `483` | `+481` | non-comparable horizon change (validation soak vs full soak target) | info | `docs/gate-d-report.md`, post-opt `summary.csv` |
| `failure_count` | `0` | `0` | `0` | no reliability regression | low | same |
| `gate_pass` | `true` | `true` | parity | pass | low | same |
| threshold booleans (`soak_duration`, `harness_reliability`, `latency_drift`, `memory_growth`, `near_live_mode`, `chunk_queue_visibility`, `chunk_drain`, `out_wav_truth`, `continuity_signal`, `lag_drift`) | all true (documented) | all true | parity | pass | low | `docs/gate-d-report.md`, post-opt `summary.csv` |
| latency drift ratio (`manifest_wall_ms_p95_p95 / manifest_wall_ms_p95_p50`) | baseline numeric unavailable | `1.095201` | n/a | within gate threshold (`<= 1.25`) | low | post-opt `summary.csv` + `scripts/gate_d_summary.py` |
| memory growth ratio (`max_rss_kb_p95 / max_rss_kb_p50`) | baseline numeric unavailable | `1.002526` | n/a | within gate threshold (`<= 1.30`) | low | post-opt `summary.csv` + `scripts/gate_d_summary.py` |
| lag drift ratio (`chunk_lag_p95_ms_p95 / chunk_lag_p95_ms_p50`) | baseline numeric unavailable | `1.000000` | n/a | within gate threshold (`<= 1.50`) | low | post-opt `summary.csv` + `scripts/gate_d_summary.py` |
| pressure/recovery telemetry (`chunk_drop_ratio`, trust/degradation totals) | baseline numeric unavailable | `chunk_drop_ratio=0.3125`, `total_trust_notices=2414`, `total_degradation_events=1449` | n/a | expectedly exercised under long soak; no gate failure | medium (data continuity gap) | post-opt `summary.csv` |

## Regression Flags And Follow-Up

1. No blocker-grade regression is indicated by the baseline-comparable surfaces (reliability and threshold parity are preserved).
2. Numeric baseline-vs-post-opt deltas for drift internals are partially unavailable due baseline artifact retention gaps.
3. Follow-up recommendation: archive canonical baseline `gate_d` summaries (`summary.csv` + `status.txt`) under a durable, versioned evidence index so future beads can compute full numeric deltas instead of threshold-only parity.

## Integration Summary

- Benchmark delta report integration: `docs/post-opt-benchmark-delta-table.md`
- Optimization decision context integration: `docs/gate-phase-next-report.md`
