# Ops Alert Thresholds and SLO Guardrails (Modernization Diagnostics)

Bead: `bd-38ai`  
Date: 2026-03-04  
Agent: `OrangeCanyon`

## Objective

Define operator-facing thresholds for modernization diagnostics so trust/degradation and hot-path counters map to consistent response actions (`INVESTIGATE`, `WARN`, `PAGE`).

## Evidence Anchors

Primary references used for threshold grounding:

1. `docs/phase1-baseline-anchors.md`
   - buffered-no-drop baseline (`drop_ratio=0`, `dropped_oldest=0`, `lag_p95_ms=0`)
   - induced drop-path historical reference (`drop_ratio=0.466667`, `dropped_oldest=14`, `lag_p95_ms=240`)
   - first-stable guardrail (`<=2332ms`)
2. `docs/phase1-rollback-killswitch-playbook.md`
   - kill-switch trigger threshold (`drop_ratio > 0.326667` for consecutive runs)
   - severe-pressure interpretation and rollback flow
3. `docs/gate-backlog-pressure-post-opt-evidence.md`
   - post-opt buffered-no-drop confirmation (`drop_ratio=0`, `lag_p95_ms=0`, no trust/degradation codes)
4. `docs/gate-near-live-soak-post-opt-evidence.md`
   - sustained-run pressure/recovery totals (`total_chunk_dropped_oldest=2415`, trust/degradation totals non-zero under long soak)
5. `docs/hot-path-diagnostics-before-after.md`
   - scratch write/reuse and pump counter provenance (`scratch_writes_est`, `scratch_reuse_overwrites_est`, `pump_*`)
6. `docs/transcribe-operator-runbook.md`
   - existing triage and kill-switch action flow to align response procedures.

## Severity Levels

- `INVESTIGATE`: monitor and collect artifacts; no immediate runtime policy change.
- `WARN`: degraded signal requiring runbook triage before clean-session claims.
- `PAGE`: immediate incident posture; execute kill-switch/rollback decision path.

## Threshold Table

| Signal / Counter | INVESTIGATE | WARN | PAGE | First Response Action | Evidence Anchor |
|---|---|---|---|---|---|
| `trust.codes` includes `chunk_queue_backpressure` | first occurrence in run | present with `dropped_oldest > 0` | escalates to `chunk_queue_backpressure_severe` | classify run as backlog-pressured; review `reconciled_final`, `chunk_queue`, `session_summary` | runbook + backlog pressure baseline |
| `trust.codes` includes `chunk_queue_backpressure_severe` | n/a | first occurrence | present in 2 consecutive runs | enable kill-switch candidate flow; collect manifest+JSONL; compare to baseline anchors | rollback playbook |
| `session_summary.chunk_queue.drop_ratio` | `>0.0` | `>0.15` | `>0.326667` in 2 consecutive runs | treat as drop-path regression; trigger kill-switch decision and rollback readiness check | baseline anchors + rollback playbook |
| `chunk_queue.dropped_oldest` | `>0` | `>=9` | `>=14` or sustained growth run-over-run | classify as active drop-path degradation; prioritize post-session reconciliation review | baseline anchors (historical drop-path reference) |
| `chunk_queue.lag_p95_ms` | `>0` | `>=120` | `>=240` or worsening trend with drops | evaluate queue/load tuning; correlate with trust/degradation codes before rerun | baseline anchors (`lag_p95_ms=240` reference) |
| `first_stable_timing_ms` | `>2120` | `>2250` | `>2332` | treat responsiveness as regressing; review host load and backpressure mode | baseline anchors first-stable guardrail |
| continuity trust (`continuity_recovered_with_gaps`, `continuity_unverified`) | first occurrence | any continuity code with degraded run | repeated continuity code in consecutive runs | block continuity-sensitive claims; inspect lifecycle + reconciliation trigger codes | runbook + reliability risk register |
| callback-contract trust (`capture_callback_contract_degraded`) | first occurrence | present with continuity code | repeated with continuity/code-path failures | escalate capture contract investigation; consider strict-mode hardening path | reliability risk register |
| scratch anomaly (`retained_for_review_hint=true` + failure counters) | one-off retained artifact | repeated retained artifacts | retained artifacts with severe-pressure/continuity codes | preserve artifacts, run preflight/model-doctor, open incident triage ticket | hot-path diagnostics + runbook |

## Operator Response-Time SLO Guardrails (`bd-2rz8`)

These limits score the workflow stages `detect -> decide -> mitigate -> verify`
independently from runtime quality signals. Use the highest severity reached in
the incident (`INVESTIGATE`, `WARN`, `PAGE`) as the scoring profile.

| Stage | INVESTIGATE max | WARN max | PAGE max |
|---|---:|---:|---:|
| detect | 300000 ms (5m) | 120000 ms (2m) | 60000 ms (1m) |
| decide | 900000 ms (15m) | 300000 ms (5m) | 120000 ms (2m) |
| mitigate | 1800000 ms (30m) | 600000 ms (10m) | 300000 ms (5m) |
| verify | 1200000 ms (20m) | 600000 ms (10m) | 300000 ms (5m) |

### Scoring Rules

1. Determine incident severity from the threshold table above.
2. Measure each stage duration in milliseconds from the drill timeline.
3. Stage verdict is `pass` when `duration_ms <= severity_max_ms`; otherwise `fail`.
4. Drill verdict is `pass` only when all four stage verdicts pass.
5. Any failed stage requires follow-up bead linkage before integrated closeout.

## Guardrail Interpretation Rules

1. Buffered-no-drop lanes are expected to keep trust/degradation surfaces empty; any non-empty trust/degradation in this profile is at least `WARN`.
2. Drop-path evidence is valid only when queue-drop signals are explicitly present; do not infer pressure severity from lag alone.
3. `PAGE` actions require both signal threshold breach and evidence capture (manifest + JSONL + close-summary diagnostics) before declaring rollback.
4. Kill-switch activation follows existing playbook semantics; this table standardizes when to enter that playbook.
5. Drill pass/fail scoring must use the response-time table above; prose-only
   "fast enough" interpretation is not acceptable.

## Standard Incident Artifact Bundle

For any `WARN`/`PAGE` classification, collect:

- runtime manifest fields: `trust`, `degradation_events`, `chunk_queue`, `session_summary`, `terminal_summary`, `reconciliation`
- runtime JSONL control events: `chunk_queue`, `mode_degradation`, `trust_notice`, `reconciliation_matrix`, lifecycle markers
- close-summary diagnostics lines: `diagnostics_backpressure`, `diagnostics_transport`, `diagnostics_pump`, `diagnostics_scratch`

## Schema-Tolerant Signal Extraction (`bd-qgwp`)

When manifest schema variants are mixed (`trust` object present, absent, or
null), extract codes with the canonical helper instead of hard-coded jq paths:

```bash
python3 scripts/manifest_signal_extract.py --manifest <runtime.manifest.json>
```

Expected output fields are stable:
- `trust_codes`
- `degradation_codes`
- `trust_source`
- `degradation_source`

Use this helper output for drill triage notes before applying the threshold
table above.

## Integration Links

- Runbook action mapping: `docs/transcribe-operator-runbook.md`
- Kill-switch/rollback flow: `docs/phase1-rollback-killswitch-playbook.md`
- Risk register linkage: `docs/reliability-risk-register.md`
- Drill response-time scoring example: `docs/ops-simulation-drill-evidence-orangecanyon.md`
- Final validation/closeout consumers: `bd-2uz0`, `bd-3kt2`, `bd-2hqm`

## Status

Operationally complete for both signal thresholds (`bd-38ai`) and response-time
SLO scoring (`bd-2rz8`).
