# Phase 1 PR-Slice Rollback and Kill-Switch Playbook (bd-jqms)

Date: 2026-03-04  
Status: normative rollback playbook for Phase 1 slices (`S1`-`S5`)

## Objective

Define exact rollback boundaries, trigger conditions, commands, and verification checks for each Phase 1 PR slice.  
This playbook is the operational companion to:

- `docs/phase1-integration-checkpoint-pr-slicing.md`
- `docs/transcribe-operator-runbook.md`
- `docs/runtime-compatibility-boundary-policy.md`

## Phase 1 Slice Boundaries and Rollback Units

| Slice | Scope | Rollback Unit | Default Rollback Strategy |
|---|---|---|---|
| `S1` Request Transport Foundation | typed request model + executor request API adapter | all `S1` commits as one unit | revert `S1` merge commit set in one revert step |
| `S2` PCM Request Path + Scratch Lifecycle | PCM request flow, scratch lifecycle, temp-audio semantics mapping | runtime builder + asr backend lifecycle + telemetry mapping | revert full `S2` merge commit set |
| `S3` Runtime Control Hardening | adaptive backpressure, cadence control, forced drains, kill-switch wiring | runtime control behavior first via kill-switch, then code rollback if needed | activate kill-switch immediately; revert `S3` if instability persists |
| `S4` Reliability Validation Expansion | parity/fairness/regression/fault-injection/observability suites | newest reliability test layers only | rollback newest failing test/harness additions first; keep core parity suites |
| `S5` Integration Checkpoint | docs/evidence synthesis only | documentation only | rollback by reverting docs commits only (no runtime behavior rollback) |

## Trigger Conditions

Use these triggers to start rollback action:

1. `S1`/`S2` trigger:
   - `cargo test --test transcribe_live_legacy_entrypoints_compat` fails, or
   - path/PCM request parity fails (`live_asr_request_path_parity`, `live_asr_pool`, `adapter_request_`, `pcm_scratch_`).
2. `S3` trigger:
   - trust/degradation includes `chunk_queue_backpressure_severe` in two consecutive runs, or
   - `session_summary.chunk_queue.drop_ratio > 0.326667` in two consecutive runs, or
   - first stable timing exceeds `2332ms` in two consecutive runs.
3. `S4` trigger:
   - reliability suites become nondeterministic/flaky and block release confidence.
4. `S5` trigger:
   - evidence/decision text is inconsistent with executed artifacts or closed-bead state.

## Exact Rollback Commands by Slice

Run from a clean branch pointing at the deployment/release target.

### `S1` Request Transport Foundation

```bash
git checkout <release-branch>
git pull --ff-only
git revert --no-edit <S1_merge_sha_or_range>
cargo check -q
cargo test --lib live_asr_pool -- --nocapture
cargo test --bin transcribe-live adapter_request_ -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
```

### `S2` PCM Request Path + Scratch Lifecycle

```bash
git checkout <release-branch>
git pull --ff-only
git revert --no-edit <S2_merge_sha_or_range>
cargo check -q
cargo test --bin transcribe-live build_live_asr_request_for_spec -- --nocapture
cargo test --bin transcribe-live pcm_scratch_ -- --nocapture
cargo test --test live_asr_request_path_parity -- --nocapture
cargo test --lib live_asr_pool -- --nocapture
```

### `S3` Runtime Control Hardening

Step 1: immediate operational fallback (kill-switch), no code revert yet:

```bash
make run-transcribe-app \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_ARGS="--live-stream --disable-adaptive-backpressure"
```

Debug equivalent:

```bash
make transcribe-live-stream \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_LIVE_STREAM_ARGS="--disable-adaptive-backpressure"
```

Step 2: if instability persists after kill-switch activation, revert `S3`:

```bash
git checkout <release-branch>
git pull --ff-only
git revert --no-edit <S3_merge_sha_or_range>
cargo check -q
cargo test --bin transcribe-live pump_cadence_gate_ -- --nocapture
cargo test --lib live_stream_runtime -- --nocapture
cargo test --bin transcribe-live kill_switch_ -- --nocapture
```

### `S4` Reliability Validation Expansion

```bash
git checkout <release-branch>
git pull --ff-only
git revert --no-edit <S4_newest_test_layer_sha_or_range>
cargo check -q
cargo test --test pressure_channel_fairness -- --nocapture
cargo test --test representative_offline_request_regression -- --nocapture
cargo test --test live_asr_request_path_parity -- --nocapture
cargo test --test live_asr_fault_injection_e2e -- --nocapture
```

### `S5` Integration Checkpoint (docs-only)

```bash
git checkout <release-branch>
git pull --ff-only
git revert --no-edit <S5_docs_sha_or_range>
cargo check -q
cargo test --test modular_stability_contract -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
```

## Kill-Switch Operating Procedure (S3)

### Enter kill-switch mode

Enter when any trigger condition holds across two consecutive runs:

- `chunk_queue_backpressure_severe` appears in trust/degradation
- `session_summary.chunk_queue.drop_ratio > 0.326667`
- first stable timing exceeds `2332ms`

Command:

```bash
make run-transcribe-app \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_ARGS="--live-stream --disable-adaptive-backpressure"
```

Fallback behavior expectation:

- scheduler stays in normal behavior envelope
- adaptive transitioning is disabled
- operator classifies run as rollback/fallback mode until exit criteria pass

### Exit kill-switch mode

Require all of the following for three consecutive runs:

1. no `chunk_queue_backpressure_severe`
2. bounded queue pressure with stable lag (`lag_p95_ms` not worsening versus lane baseline)
3. first stable timing `<= 2332ms`

Validation lane:

```bash
make gate-v1-acceptance
make gate-backlog-pressure
```

## Post-Rollback Verification Checklist

A rollback is complete only when all checks below pass:

1. Contract checks:
   - `make contracts-ci`
   - verify no `S0` drift using `docs/contract-no-drift-checklist.md`
2. Behavior checks (slice-specific):
   - run the matching command set in the slice section above
3. Diagnostics checks:
   - manifest includes trustworthy `trust`, `degradation_events`, `session_summary`, `terminal_summary`
   - runtime outputs contain expected `diagnostics_*` lines and `diagnostics_breadcrumbs` for incident triage
4. Evidence publication:
   - attach command transcript + pass/fail verdict
   - include artifact paths and summary keys (`summary.csv`, `status.txt`, JSONL/manifest pointers)

## Evidence Templates and Canonical References

Use these docs as templates/reference packs:

- `docs/phase1-integration-checkpoint-pr-slicing.md`
- `docs/phase1-integration-checkpoint-evidence.md`
- `docs/phase1-request-executor-migration-evidence.md`
- `docs/phase1-baseline-anchors.md`
- `docs/gate-v1-acceptance-post-opt-evidence.md`
- `docs/transcribe-operator-runbook.md`

## Incident Escalation and Communication Protocol

For every rollback/kill-switch incident window:

1. Open/update bead thread with subject prefix `[bd-jqms]` or the active incident bead ID.
2. Post:
   - trigger condition(s)
   - exact command(s) executed
   - current state (`fallback_active`, `rollback_complete`, or `blocked`)
   - next verification checkpoint time
3. Escalate immediately if:
   - kill-switch mode still fails trigger criteria after two additional runs, or
   - contract checks fail (`contracts-ci` or legacy entrypoint compatibility).
4. Do not declare incident resolved until post-rollback checklist is fully green with linked evidence.
