# Contract No-Drift Checklist

Date: 2026-03-04
Status: active checklist for modernization work that must preserve externally consumed behavior

## Purpose

This checklist is the canonical status board for contract-sensitive surfaces during the
live-runtime modernization program.

Use it to answer three mechanical questions:

1. Which public/machine-consumed surfaces must not drift?
2. What evidence currently says each surface is `pass`, `fail`, or `unknown`?
3. Which modernization beads and gates must consult the same evidence before closeout?

This document complements, and should be used together with:
- `docs/runtime-compatibility-boundary-policy.md`
- `docs/agent-contract-index.md`
- `docs/phase1-baseline-anchors.md`

## Current Validation Snapshot

Snapshot command:

```bash
make contracts-ci
```

Latest checked result for this checklist:
- `2026-03-04`: `pass`

Command evidence:
- `scripts/ci_contracts.sh`
- `cargo test --test contract_ci_enforcement -- --nocapture`
- `cargo test --test recordit_cli_contract -- --nocapture`
- `cargo test --test recordit_cli_dispatch -- --nocapture`
- `cargo test --test recordit_exit_contract -- --nocapture`
- `cargo test --test recordit_exit_behavior_matrix -- --nocapture`
- `cargo test --test transcribe_live_legacy_entrypoints_compat -- --nocapture`
- `cargo test --test runtime_mode_matrix_contract -- --nocapture`
- `cargo test --test runtime_jsonl_contract -- --nocapture`
- `cargo test --test runtime_jsonl_schema_contract -- --nocapture`
- `cargo test --test runtime_manifest_contract -- --nocapture`
- `cargo test --test runtime_manifest_schema_contract -- --nocapture`
- `cargo test --test contract_baseline_matrix -- --nocapture`
- `cargo test --test bd_1n5v_contract_regression -- --nocapture`

## Surface Status Ledger

| Surface | Canonical source | Status | Validation evidence | Artifact / gate evidence |
|---|---|---|---|---|
| Recordit CLI grammar and inspect-contract surface | `contracts/recordit-cli-contract.v1.json` | `pass` | `contract_ci_enforcement`, `recordit_cli_contract`, `recordit_cli_dispatch` via `make contracts-ci` | `cargo run --bin recordit -- inspect-contract cli --format json` |
| Runtime mode tuple and compatibility matrix | `contracts/runtime-mode-matrix.v1.json` | `pass` | `runtime_mode_matrix_contract`, `recordit_cli_contract`, `contract_baseline_matrix` via `make contracts-ci` | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`; `docs/phase1-baseline-anchors.md` |
| Runtime JSONL schema and event-family invariants | `contracts/runtime-jsonl.schema.v1.json` | `pass` | `runtime_jsonl_contract`, `runtime_jsonl_schema_contract`, `bd_1n5v_contract_regression` via `make contracts-ci` | frozen JSONL fixtures exercised by those tests; live artifact family documented in `docs/runtime-public-contract-inventory.md` |
| Runtime / preflight manifest schema and artifact-truth semantics | `contracts/session-manifest.schema.v1.json` | `pass` | `runtime_manifest_contract`, `runtime_manifest_schema_contract`, `bd_1n5v_contract_regression` via `make contracts-ci` | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.manifest.json`; `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.manifest.json` |
| Exit-code and failed-status semantics | `contracts/recordit-exit-code-contract.v1.json` | `pass` | `recordit_exit_contract`, `recordit_exit_behavior_matrix` via `make contracts-ci` | `cargo run --bin recordit -- inspect-contract exit-codes --format json` |
| Legacy `transcribe-live` compatibility bridge | README migration guidance + legacy entrypoints exercised in test suite | `pass` | `transcribe_live_legacy_entrypoints_compat` via `make contracts-ci` | `Makefile` wrappers and replay/help paths verified by that test |

Status meaning:
- `pass`: current evidence says the surface still matches its published contract.
- `fail`: a contract test, schema test, or gate says behavior drifted.
- `unknown`: required evidence has not been run yet for the current change set.

## Gate Mapping

| Gate / command | Primary surfaces covered | Why it belongs in no-drift review |
|---|---|---|
| `make contracts-ci` | all five canonical contract surfaces | machine-readable baseline contract enforcement |
| `make gate-v1-acceptance` | runtime mode tuple, artifact truth, live transcript timing expectations | proves the main live operator lane still behaves compatibly |
| `make gate-backlog-pressure` | JSONL / manifest telemetry surfaces under pressure | proves degradation/trust/control-event surfaces remain truthful |
| `cargo run --bin recordit -- inspect-contract <name> --format json` | CLI, runtime modes, schema, exit-code publication surfaces | verifies discovery/published artifacts remain in sync |

## Modernization Bead Mapping

| Bead family | Must keep green | Minimum evidence before closeout |
|---|---|---|
| Phase 1 runtime changes (`bd-r5j4`, `bd-1nsx`, `bd-15iy`, `bd-3d9f`, `bd-1lam`, related follow-ons) | runtime modes, JSONL schema, manifest schema, exit codes | `make contracts-ci`; if runtime behavior changed materially, rerun `make gate-v1-acceptance` and relevant pressure gates |
| Phase 2 typed JSON boundary (`bd-3alz` through `bd-o5d0`) | JSONL schema, manifest schema, replay compatibility | `make contracts-ci`; focus on `runtime_jsonl_*`, `runtime_manifest_*`, and replay-related evidence |
| Phase 3 orchestration modularization (`bd-phnm` through `bd-3jvk`) | CLI grammar, runtime modes, JSONL schema, manifest schema, exit codes | `make contracts-ci`; keep output semantics and inspect-contract payloads unchanged |
| Cross-cutting rollout / closeout (`bd-2cwj`, `bd-1wza`, `bd-3kt2`, `bd-18yj`, `bd-2uz0`) | all surfaces | cite this checklist directly instead of restating contract health from memory |

## Update Protocol

Use this checklist mechanically for every contract-touching bead:

1. Re-run `make contracts-ci`.
2. Update affected surface rows above to `pass`, `fail`, or `unknown`.
3. Add any newly required gate evidence if behavior moved beyond schema-only changes.
4. Reference this checklist in the bead thread and any closeout/go-no-go doc.
5. If any row is `fail`, do not close the bead without an explicit remediation note.

## Closeout Consumers

These downstream beads should link this checklist directly:
- `bd-1wza`
- `bd-3kt2`
- `bd-18yj`
- `bd-2uz0`

If a future session cannot answer contract health by reading this file plus the linked
command/artifact evidence, the checklist is stale and should be updated before closeout.
