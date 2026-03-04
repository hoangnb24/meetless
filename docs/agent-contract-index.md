# Agent Contract Index (bd-jhxw)

Date: 2026-03-02
Audience: AI agents and automation that need machine-readable runtime/CLI contracts quickly.

## 1. Fast Bootstrap (No Repo Deep-Dive)

Run these from repo root:

```bash
cargo run --bin recordit -- inspect-contract cli --format json
cargo run --bin recordit -- inspect-contract runtime-modes --format json
cargo run --bin recordit -- inspect-contract jsonl-schema --format json
cargo run --bin recordit -- inspect-contract manifest-schema --format json
cargo run --bin recordit -- inspect-contract exit-codes --format json
```

Then use `make contracts-ci` to verify contract/schema surfaces are still coherent.

## 2. Canonical Contract Artifacts

All canonical contract files live under `contracts/`:

| Contract surface | Canonical file | Discovery command | Notes |
|---|---|---|---|
| Recordit CLI grammar contract | `contracts/recordit-cli-contract.v1.json` | `recordit inspect-contract cli --format json` | Canonical operator grammar and command/option map. |
| Runtime mode matrix | `contracts/runtime-mode-matrix.v1.json` | `recordit inspect-contract runtime-modes --format json` | Full matrix file includes compatibility rules and all taxonomy rows. |
| Runtime JSONL schema | `contracts/runtime-jsonl.schema.v1.json` | `recordit inspect-contract jsonl-schema --format json` | JSON Schema for each `session.jsonl` line object. |
| Session/preflight manifest schema | `contracts/session-manifest.schema.v1.json` | `recordit inspect-contract manifest-schema --format json` | JSON Schema covering both runtime and preflight manifest kinds. |
| Exit-code/failure-class contract | `contracts/recordit-exit-code-contract.v1.json` | `recordit inspect-contract exit-codes --format json` | Exit code classes and degraded-success interpretation rules. |

## 3. Schema-to-Artifact Mapping

| Artifact emitted by runtime | Governing contract/schema |
|---|---|
| `session.jsonl` | `contracts/runtime-jsonl.schema.v1.json` |
| `session.manifest.json` (runtime) | `contracts/session-manifest.schema.v1.json` (`$defs.runtime_manifest`) |
| preflight manifest (`kind=transcribe-live-preflight`) | `contracts/session-manifest.schema.v1.json` (`$defs.preflight_manifest`) |
| runtime mode tuple fields (`runtime_mode*`) | `contracts/runtime-mode-matrix.v1.json` |
| CLI exit interpretation (`0` vs `2`, degraded success signals) | `contracts/recordit-exit-code-contract.v1.json` |

## 4. Discovery and Validation Flow for Agents

1. Discover CLI and contract names using `inspect-contract cli`.
2. Resolve each symbolic contract name to its canonical file under `contracts/`.
3. Validate generated artifacts against schemas/contracts as needed.
4. Run `make contracts-ci` before closing contract-touching work.

Minimum validation anchors in test suite:
- `tests/contract_ci_enforcement.rs`
- `tests/runtime_jsonl_schema_contract.rs`
- `tests/runtime_manifest_schema_contract.rs`
- `tests/runtime_mode_matrix_contract.rs`
- `tests/recordit_exit_contract.rs`

## 4a. Current No-Drift Checklist

Use [`docs/contract-no-drift-checklist.md`](./contract-no-drift-checklist.md) when you need:
- the current `pass|fail|unknown` status for each public contract surface
- the exact `make contracts-ci` evidence set behind that status
- the mapping from modernization beads/gates to the contract checks they must keep green

## 5. Versioning and Breaking-Change Rules

Contract evolution policy is defined in `docs/schema-versioning-policy.md`.

Key operational rules:
- versioned filenames must use `.vN` major suffixes
- additive changes keep major version; breaking changes require new `vN+1` artifacts
- breaking changes require explicit migration notes and updated validation coverage

For compatibility boundary context, see `docs/runtime-compatibility-boundary-policy.md` and `docs/runtime-contract-inventory.md`.
