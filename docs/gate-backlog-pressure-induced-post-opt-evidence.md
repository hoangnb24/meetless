# Post-Optimization Backlog Pressure Induced-Lane Evidence

Bead: `bd-1a7y`  
Date: 2026-03-04

## Run Context

Command:

```bash
scripts/gate_backlog_pressure.sh \
  --chunk-window-ms 1200 \
  --chunk-stride-ms 120 \
  --chunk-queue-cap 2 \
  --min-drop-ratio 0.15 \
  --max-drop-ratio 0.80 \
  --min-lag-p95-ms 240
```

Artifact root:

- `/Users/themrb/Documents/1_projects/recordit/artifacts/bench/gate_backlog_pressure/20260304T035146Z`

Primary status files:

- `artifacts/bench/gate_backlog_pressure/20260304T035146Z/status.txt`
- `artifacts/bench/gate_backlog_pressure/20260304T035146Z/summary.csv`
- `artifacts/bench/gate_backlog_pressure/20260304T035146Z/runtime.manifest.json`
- `artifacts/bench/gate_backlog_pressure/20260304T035146Z/runtime.jsonl`

## Deterministic Verdict

- gate status: `pass` (`detail=backlog_pressure_thresholds_satisfied`)
- `gate_pass=true`
- lane classification: `pressure_profile=buffered-no-drop`
- induced drop-path verdict: **not observed in this run**

This run is valid deterministic evidence for lane classification, but it is not valid evidence of drop-path behavior.

## Key Metrics (Observed)

From `summary.csv` and manifest/session summary:

- runtime tuple: `live-stream / live-stream / --live-stream` (`implemented`)
- queue pressure: `submitted=34`, `enqueued=34`, `high_water=2`, `max_queue=2`
- drop metrics: `dropped_oldest=0`, `drop_ratio=0.000000`
- lag metrics: `lag_p95_ms=0` (`lag_sample_count=0`)
- first stable timing: `first_stable_timing_ms=2120`
- trust/degradation: none (`trust_codes` empty, `degradation_codes` empty)
- JSONL control visibility: `jsonl_chunk_queue_event_count=1`

## Baseline Comparison

Reference: `docs/phase1-baseline-anchors.md`

Compatibility-timing anchor:

- baseline first stable: `2120 ms`
- observed first stable: `2120 ms`
- delta: `0 ms`

Historical induced drop-path reference:

- baseline `dropped_oldest=14`, observed `0` (delta `-14`)
- baseline `drop_ratio=0.466667`, observed `0.000000` (delta `-0.466667`)
- baseline `lag_p95_ms=240`, observed `0` (delta `-240`)

Interpretation:

- despite constrained settings, this run did not enter drop-path semantics
- do not treat this as queue-drop improvement proof
- treat as an induced-lane non-drop outcome requiring follow-on aggressive rerun evidence

## Diagnostics Interpretation for Unexpected No-Drop

- queue saturation was still reached (`high_water == max_queue`), so pressure existed
- no oldest-drop and no lag sampling imply processing kept pace under this execution profile
- trust/degradation remained clean, consistent with buffered-no-drop classification

## Follow-On Implication

- `bd-1a7y` acceptance is satisfied with explicit lane verdict + diagnostics evidence.
- queue-drop reduction claims remain incomplete until aggressive induced rerun (`bd-2762`) produces a true drop-path profile with corresponding trust/degradation/reconciliation signals.
