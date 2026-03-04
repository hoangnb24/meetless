# Rollback/Alert Drill Evidence (Supplemental - OrangeCanyon)

Bead: `bd-2hqm` (supplemental non-overlap lane)  
Date: 2026-03-04

## Drill Goal

Exercise alert-threshold classification and kill-switch mitigation flow with explicit timeline evidence:
- detect
- decide
- mitigate
- verify

## Inputs

- `docs/ops-alert-thresholds-slo-guardrails.md`
- `docs/phase1-baseline-anchors.md`
- `docs/phase1-rollback-killswitch-playbook.md`
- `artifacts/bench/gate_backlog_pressure/20260304T034834Z/summary.csv`
- `make -n run-transcribe-app TRANSCRIBE_ARGS="--live-stream --disable-adaptive-backpressure"`

## Scenario A: Buffered-No-Drop Control (Expected Healthy)

Detection source:
- `drop_ratio=0.000000`
- `lag_p95_ms=0`
- `trust_codes=<empty>`
- `degradation_codes=<empty>`

Threshold decision:
- classification: `OK`
- rationale: no drop-path or trust/degradation escalation signals.

## Scenario B: Historical Drop-Path Reference (Expected Escalation)

Detection source (frozen anchor):
- `drop_ratio=0.466667`
- `dropped_oldest=14`
- `lag_p95_ms=240`

Threshold decision:
- classification: `PAGE`
- rationale: `drop_ratio > 0.326667` kill-switch escalation threshold.

## Kill-Switch Mitigation Simulation (Dry-Run)

Mitigation command simulation:
```bash
make -n run-transcribe-app TRANSCRIBE_ARGS="--live-stream --disable-adaptive-backpressure"
```

Verification output confirms mitigation flag propagation into packaged execution command:
- contains `--live-stream --disable-adaptive-backpressure`

## Timeline (UTC)

| Time | Stage | Evidence |
|---|---|---|
| 2026-03-04T07:15:07Z | detect.default_pressure | `drop_ratio=0.000000 lag_p95_ms=0 trust_codes=<empty> degradation_codes=<empty>` |
| 2026-03-04T07:15:07Z | classify.default_pressure | `classification=OK` |
| 2026-03-04T07:15:07Z | detect.historical_drop_path_reference | `historical_drop_ratio=0.466667` |
| 2026-03-04T07:15:07Z | classify.historical_drop_path_reference | `classification=PAGE` |
| 2026-03-04T07:15:07Z | mitigate.kill_switch_dry_run | simulated packaged command includes `--disable-adaptive-backpressure` |
| 2026-03-04T07:15:07Z | verify.mitigation_contract | mitigation flag presence confirmed in generated command line |

Measured timings in this tabletop pass:
- detection -> decision: `< 1s`
- decision -> mitigation command generation: `< 1s`
- mitigation -> verification: `< 1s`

## Pass/Fail Interpretation

- `Alert simulation`: pass (threshold logic distinguishes buffered-no-drop `OK` vs historical drop-path `PAGE`).
- `Rollback/kill-switch simulation`: pass for command-path readiness (flag wiring present in packaged run command generation).

## Friction Points

1. This pass validates command-path readiness, not runtime behavioral effect after kill-switch activation.
2. A deterministic, reproducible induced drop-path runtime fixture is still needed for full end-to-end mitigation verification in one command lane.

## Follow-up Recommendations

1. During primary `bd-2hqm` closeout, add one live execution sample with kill-switch enabled and capture post-mitigation `session_summary.chunk_queue.drop_ratio` + trust/degradation deltas.
2. Preserve the resulting manifest/JSONL pair as canonical drill evidence for `bd-2uz0` and `bd-3kt2` closeout references.
