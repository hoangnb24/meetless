# Post-Optimization Gate V1 Acceptance Evidence

Bead: `bd-3fnd`  
Date: 2026-03-04

## Run Context

Command:

```bash
make gate-v1-acceptance
```

Artifact root:

- `/Users/themrb/Documents/1_projects/recordit/artifacts/bench/gate_v1_acceptance/20260304T034250Z`

Primary status files:

- root status: `artifacts/bench/gate_v1_acceptance/20260304T034250Z/status.txt`
- root summary: `artifacts/bench/gate_v1_acceptance/20260304T034250Z/summary.csv`
- backlog status: `artifacts/bench/gate_v1_acceptance/20260304T034250Z/backlog_pressure/status.txt`
- backlog summary: `artifacts/bench/gate_v1_acceptance/20260304T034250Z/backlog_pressure/summary.csv`

## Deterministic Verdict

- root gate status: `pass` (`detail=v1_acceptance_thresholds_satisfied`)
- root `gate_pass`: `true`
- backlog gate status: `pass` (`detail=backlog_pressure_thresholds_satisfied`)
- backlog `gate_pass`: `true`

## Key Metrics (Observed)

From `summary.csv`:

- cold first stable timing: `2120 ms`
- warm first stable timing: `2120 ms`
- cold runtime mode tuple: `live-stream / live-stream / --live-stream`
- warm runtime mode tuple: `live-stream / live-stream / --live-stream`
- runtime mode status: `implemented` for cold/warm
- first stable emit during active phase: `true` for cold/warm
- artifact truth checks: `cold_artifact_truth_ok=true`, `warm_artifact_truth_ok=true`
- backlog pressure profile: `buffered-no-drop`
- backlog trust/degradation signals: empty (`backlog_trust_notice_count=0`, `backlog_degradation_event_count=0`)

## Baseline Comparison

Baseline anchors (from `docs/phase1-baseline-anchors.md`):

- compatibility anchor first stable timing: `2120 ms` (cold/warm)
- accepted default pressure profile: `buffered-no-drop`

Comparison result:

- first stable delta: `0 ms` (cold and warm)
- first stable ratio: `1.000` (cold and warm)
- truth tuple parity: matched baseline (`live-stream/live-stream/--live-stream`)
- pressure profile parity: matched baseline (`buffered-no-drop`)

## Regression Notes

- No compatibility regression detected in this lane.
- No trust/degradation escalation detected for the buffered-no-drop acceptance profile.
- Artifacts contain complete deterministic evidence for follow-on delta lanes (`bd-1w6i`, `bd-2ptm`, `bd-nxug`).
