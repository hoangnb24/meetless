# Ops Simulation Drill Evidence (bd-2hqm)

Date: 2026-03-04  
Bead: `bd-2hqm`  
Agent: `SilentSnow`

## Objective

Run a pre-closeout operator drill that exercises:
1. alert-threshold detection/classification using current modernization diagnostics
2. rollback/kill-switch mitigation path using the Phase 1 playbook command surface
3. explicit `detect -> decide -> mitigate -> verify` evidence timeline

## Canonical Inputs

- `docs/ops-alert-thresholds-slo-guardrails.md`
- `docs/phase1-rollback-killswitch-playbook.md`
- `docs/transcribe-operator-runbook.md`
- `artifacts/bench/gate_backlog_pressure/20260304T034834Z/summary.csv`
- `artifacts/validation/bd-1qfx/representative-chunked.runtime.manifest.json`

## Commands Executed

```bash
# Alert/control scenario extraction (buffered-no-drop)
jq -n ... > artifacts/ops/bd-2hqm/alert-scenario-buffered-no-drop.json

# Alert-trigger scenario extraction (severe-pressure representative manifest)
jq ... artifacts/validation/bd-1qfx/representative-chunked.runtime.manifest.json \
  > artifacts/ops/bd-2hqm/alert-scenario-representative.json

# Kill-switch mitigation command-path simulation
make -n run-transcribe-app \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_ARGS="--live-stream --disable-adaptive-backpressure" \
  > artifacts/ops/bd-2hqm/kill-switch-dry-run.log

# Kill-switch flag propagation verification
rg --fixed-strings --line-number -- '--disable-adaptive-backpressure' \
  artifacts/ops/bd-2hqm/kill-switch-dry-run.log \
  > artifacts/ops/bd-2hqm/kill-switch-flag-verify.log

# Kill-switch behavior regression verification
cargo test --bin transcribe-live kill_switch_ -- --nocapture \
  > artifacts/ops/bd-2hqm/kill-switch-verification-test.log 2>&1
```

## Scenario A: Alert Threshold Simulation

### A1. Control lane (buffered-no-drop, expected healthy)

Artifact: `artifacts/ops/bd-2hqm/alert-scenario-buffered-no-drop.json`

Observed values:
- `pressure_profile=buffered-no-drop`
- `drop_ratio=0.000000`
- `lag_p95_ms=0`
- `first_stable_ms=2120` (within `<=2332ms` guardrail)
- `trust_codes` and `degradation_codes` empty

Classification:
- `OK`

### A2. Trigger lane (representative severe-pressure, expected escalation)

Artifact: `artifacts/ops/bd-2hqm/alert-scenario-representative.json`

Observed values:
- `dropped_oldest=16 / submitted=38`
- `drop_ratio=0.42105263157894735` (breaches `0.326667` PAGE threshold)
- `lag_p95_ms=1500` (above severe reference)
- `first_stable_ms=11000` (breaches `2332ms` guardrail)
- `degradation_codes` includes `live_chunk_queue_backpressure_severe`

Classification:
- `PAGE`

Interpretation:
- The guardrail mapping correctly separates healthy buffered-no-drop behavior from severe pressure/drop-path behavior.

## Scenario B: Rollback/Kill-Switch Simulation

### B1. Mitigation command-path validation

Artifacts:
- `artifacts/ops/bd-2hqm/kill-switch-dry-run.log`
- `artifacts/ops/bd-2hqm/kill-switch-flag-verify.log`

Verification:
- Dry-run packaged command includes `--disable-adaptive-backpressure` in both attached and LaunchServices launch forms.

### B2. Kill-switch behavior verification tests

Artifact:
- `artifacts/ops/bd-2hqm/kill-switch-verification-test.log`

Executed test selector:
- `cargo test --bin transcribe-live kill_switch_ -- --nocapture`

Result:
- 5/5 passed:
  - `live_stream_backpressure_kill_switch_sets_unreachable_thresholds`
  - `parse_accepts_live_kill_switch_flag`
  - `parse_rejects_kill_switch_without_live_mode`
  - `kill_switch_keeps_scheduler_in_normal_mode_under_extreme_pressure`
  - `kill_switch_preserves_normal_job_emission_under_pressure`

## Timeline (UTC)

Source:
- `artifacts/ops/bd-2hqm/drill-timeline.log`
- `artifacts/ops/bd-2hqm/timeline.env`

| Time | Stage | Evidence |
|---|---|---|
| 2026-03-04T07:20:06Z | detect.control | parsed buffered-no-drop control summary |
| 2026-03-04T07:20:07Z | detect.trigger | parsed severe-pressure representative manifest |
| 2026-03-04T07:20:08Z | decide+mitigate | generated kill-switch packaged command with `--disable-adaptive-backpressure` |
| 2026-03-04T07:20:09Z | verify | executed `kill_switch_` regression tests (pass) |

Measured stage deltas:
- detect(control) -> detect(trigger): 1s
- detect(trigger) -> mitigate: 1s
- mitigate -> verify start: 1s
- end-to-end drill flow (tabletop execution): 3s

## Pass/Fail vs Guardrails

1. Alert threshold simulation: **PASS**
   - control lane remained `OK`
   - trigger lane correctly escalated to `PAGE` with explicit threshold breaches
2. Rollback/kill-switch simulation: **PASS**
   - mitigation command path is wired
   - kill-switch regression tests passed
3. Response-timing interpretation: **PASS-WITH-FOLLOWUP**
   - timing was measured and recorded
   - current docs do not define numeric response-time SLOs for stage transitions

## Drill Friction and Follow-up Beads

1. Manifest schema ambiguity (`trust` object may be null in historical fixtures):
   - follow-up bead: `bd-qgwp`
2. Missing explicit numeric response-time SLOs for triage stage transitions:
   - follow-up bead: `bd-mba9`

Both follow-up beads were created during this drill so integrated closeout can proceed with explicit residual work tracking.

## Verdict

`bd-2hqm` acceptance is satisfied with documented evidence:
- timestamped two-scenario drill timeline
- explicit guardrail pass/fail mapping
- linked follow-up beads for discovered ambiguities
