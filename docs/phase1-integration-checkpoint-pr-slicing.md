# Phase 1 Integration Checkpoint And PR Slicing Plan

Bead: `bd-2xxv`  
Date: 2026-03-04

## Objective

Define an explicit, rollback-safe PR slicing plan for Phase 1 and the validation matrix required to mark Phase 1 implementation-ready.

## Checkpoint Status (Current)

- `bd-2xxv`: `in_progress` (checkpoint closeout lane)
- Former readiness blocker `bd-1gnz`: `closed`
- Required upstream reliability contributors are now closed:
  - `bd-1wb2`: structured hot-path observability + breadcrumbs
  - `bd-7tq2`: deterministic fault-injection e2e scenarios

Implementation-ready verdict for this checkpoint is **GO** based on completed upstream closures and green gate evidence.

## PR Slice Sequence

| Slice | Beads | Scope | Rollback Boundary | Merge Risk |
|---|---|---|---|---|
| S1 Request Transport Foundation | `bd-r5j4`, `bd-1nsx` | typed request model + executor request API adapter | revert request-model + executor signature changes as one unit | medium (core interface touch) |
| S2 PCM Request Path + Scratch Lifecycle | `bd-3qbg`, `bd-1l1u`, `bd-27aa`, `bd-2u94`, `bd-32jo` | in-memory PCM request flow, scratch lifecycle, security/privacy, telemetry/temp-audio semantics mapping | revert runtime request builder + asr backend scratch lifecycle + temp-audio mapping as one unit | high (runtime hot path + lifecycle) |
| S3 Runtime Control Hardening | `bd-15iy`, `bd-3d9f`, `bd-1lam`, `bd-2mfb` | adaptive backpressure state machine, cadence control, forced drains, kill-switch wiring | rollback kill-switch first, then cadence/backpressure controls if needed | high (hot-loop behavior) |
| S4 Reliability Validation Expansion | `bd-2ia7`, `bd-2jx6`, `bd-fz40`, `bd-1wb2`, `bd-7tq2`, `bd-1gnz` | parity/fairness/regression/fault-injection/observability suites with artifact breadcrumbs | rollback newest test/harness layers first; keep foundational parity suites | medium (test surface broad, low runtime risk) |
| S5 Phase 1 Integration Checkpoint | `bd-2xxv` | final checkpoint synthesis, reviewer risk notes, evidence index, implementation-ready verdict | no code rollback; documentation/evidence checkpoint only | low |

## Required Validation Matrix By Slice

### S1 Request Transport Foundation

Required gates:

```bash
cargo test --lib live_asr_pool -- --nocapture
cargo test --bin transcribe-live adapter_request_ -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
```

Expected evidence:
- typed request model compatibility (`Path` + explicit `PcmWindow` behavior)
- legacy entrypoint compatibility preserved

### S2 PCM Request Path + Scratch Lifecycle

Required gates:

```bash
cargo test --bin transcribe-live build_live_asr_request_for_spec -- --nocapture
cargo test --bin transcribe-live pcm_scratch_ -- --nocapture
cargo test --test live_asr_request_path_parity -- --nocapture
cargo test --lib live_asr_pool -- --nocapture
```

Expected evidence:
- request-path runtime builder correctness for PCM windows
- worker-local scratch lifecycle policy behavior
- security semantics (symlink/non-file safe handling)
- pool telemetry semantics mapping across `Path` and `PcmWindow`

### S3 Runtime Control Hardening

Required gates:

```bash
cargo test --bin transcribe-live pump_cadence_gate_ -- --nocapture
cargo test --lib live_stream_runtime -- --nocapture
cargo test --bin transcribe-live kill_switch_ -- --nocapture
```

Expected evidence:
- deterministic cadence decisions and forced drains
- adaptive backpressure transition correctness
- kill-switch keeps scheduler in normal behavior envelope

### S4 Reliability Validation Expansion

Required gates:

```bash
cargo test --test pressure_channel_fairness -- --nocapture
cargo test --test representative_offline_request_regression -- --nocapture
cargo test --test live_asr_request_path_parity -- --nocapture
cargo test --test live_asr_fault_injection_e2e -- --nocapture
```

Expected evidence:
- fairness and priority invariants (`final > reconcile > partial`)
- deterministic failure-path coverage with artifact breadcrumbs
- representative/offline compatibility preserved post-request migration

### S5 Integration Checkpoint (This Bead)

Required gates:

```bash
cargo check -q
cargo test --test modular_stability_contract -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
```

Expected evidence:
- all Phase 1 child beads complete
- checkpoint report includes explicit go/no-go for implementation-ready state
- no hidden assumptions about unresolved reliability risks

## Reviewer-Facing Risk Notes

- Hot-path volatility remains concentrated in `runtime_live_stream` and ASR request/scratch boundaries; always pair behavior changes with deterministic e2e evidence.
- `temp_audio_deleted`/`temp_audio_retained` counters remain pool-level path-cleanup truth and do not include executor-local PCM worker scratch cleanup.
- Queue-pressure claims are invalid without pressure-lane artifacts proving actual drop-path or buffered-no-drop classification.
- Kill-switch fallback must remain rollback-safe and documented in operator runbook.

## Rollback Hooks Per Slice

- S1/S2 rollback hook: revert request-surface migration + backend adapter changes to path-only flow.
- S3 rollback hook: apply `--disable-adaptive-backpressure` kill-switch and restore prior cadence behavior if regressions appear.
- S4 rollback hook: keep core parity suites; temporarily remove flaky/non-deterministic additions until deterministic behavior is restored.
- S5 rollback hook: documentation-only; do not advance readiness verdict if any upstream gate remains unresolved.

## Implementation-Ready Exit Criteria

Phase 1 is implementation-ready only when all of the following are true:

1. `bd-1gnz` is closed with complete validation evidence.
2. `bd-1wb2` and `bd-7tq2` deliver deterministic diagnostics/fault-injection coverage with passing suites.
3. Core contract checks remain green (`modular_stability_contract`, legacy entrypoints compatibility).
4. Reviewer risk notes above have no unresolved critical/high gaps without explicit follow-up ownership.

## Evidence Links

- `docs/phase1-request-executor-migration-evidence.md`
- `docs/temp-audio-security-policy.md`
- `docs/phase1-baseline-anchors.md`
- `docs/reliability-risk-register.md`
- `docs/transcribe-operator-runbook.md`

## Checkpoint Gate Evidence (2026-03-04)

`bd-2xxv` closeout validation:

```bash
cargo check -q
cargo test --test modular_stability_contract -- --nocapture
cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture
cargo test --test live_asr_fault_injection_e2e -- --nocapture
cargo test --test live_asr_request_path_parity -- --nocapture
cargo test --test representative_offline_request_regression -- --nocapture
cargo test --test pressure_channel_fairness -- --nocapture
cargo test --lib live_stream_runtime -- --nocapture
cargo test --bin transcribe-live pump_cadence_gate_ -- --nocapture
cargo test --bin transcribe-live hot_path_diagnostics_builder_covers_all_control_surfaces -- --nocapture
cargo test --bin transcribe-live runtime_failure_breadcrumbs_include_artifact_paths_and_hot_path_counters -- --nocapture
```

Result:
- all commands passed
- contract stability and legacy entrypoint compatibility remained intact
- reliability/fairness/fault-injection/diagnostics coverage remained green in the final checkpoint pass
- no open Phase 1 blocker remains on the `bd-1gnz -> bd-2xxv` chain
