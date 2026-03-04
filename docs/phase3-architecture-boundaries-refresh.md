# Phase 3 Architecture Boundaries Refresh (`bd-15ug`)

Date: 2026-03-04  
Agent: `SilentSnow`

## Objective

Refresh architecture documentation so module ownership after Phase 3 extraction is explicit, reviewable, and safe to extend.

## `app.rs` Responsibility Statement

`src/bin/transcribe_live/app.rs` is the transcribe runtime composition boundary, not the preferred home for concern-heavy implementation code.

`app.rs` responsibilities:
1. declare module seams (`mod ...`) for transcribe runtime components
2. coordinate runtime mode dispatch and compatibility-sensitive composition
3. preserve thin delegating wrappers for extracted entrypoints where tests/contracts lock call surfaces

`app.rs` non-goal:
- reintroducing deeply specialized concern logic once a dedicated module owns it

## Module Ownership and Rationale

| Module | Owned responsibility | Why this boundary exists |
|---|---|---|
| `cli_parse.rs` | CLI parse + config validation | Keeps grammar/validation changes isolated from runtime execution internals. |
| `asr_backend.rs` | backend binary/model resolution | Centralizes backend/model policy and diagnostics behavior. |
| `runtime_representative.rs` | representative runtime pipeline | Keeps representative path logic independent from live-stream specifics. |
| `runtime_live_stream.rs` | live-stream runtime pipeline | Isolates hot-path scheduling/pressure logic from CLI and artifact layers. |
| `preflight.rs` | preflight/model-doctor checks + reporting | Reduces incidental coupling between startup diagnostics and runtime orchestration. |
| `cleanup.rs` | cleanup queue, worker lifecycle, endpoint parsing | Keeps async cleanup mechanics and telemetry cohesive and testable. |
| `reporting.rs` | close-summary and failure breadcrumb formatting | Stabilizes high-change operator output surfaces in one module. |
| `reconciliation.rs` | reconciliation matrix + targeted reconcile events | Keeps correctness-critical reconciliation logic separately reviewable. |
| `runtime_events.rs` | runtime-output event translation | Preserves contract-event conversion seam independent of orchestration code. |
| `artifacts.rs` | JSONL/manifest/preflight-manifest writes | Isolates artifact serialization policies and contract formatting surfaces. |
| `transcript_flow.rs` | deterministic merge/reconstruct/render helpers | Prevents terminal/readability logic from spreading across runtime entrypoints. |
| `contracts_models.rs`, `runtime_manifest_models.rs` | typed contract models | Makes schema boundaries explicit and replay/manifest-safe. |

## Legacy Concentration to New Ownership

| Legacy concentration in `app.rs` | New owner module | Evidence |
|---|---|---|
| preflight + model-doctor diagnostics | `preflight.rs` | `docs/phase3-preflight-extraction-evidence.md` |
| cleanup queue + cleanup worker flow | `cleanup.rs` | `docs/phase3-cleanup-extraction-evidence.md` |
| close-summary/reporting formatting | `reporting.rs` | `docs/phase3-reporting-extraction-evidence.md` |
| reconciliation matrix + targeted event generation | `reconciliation.rs` | `docs/phase3-reconciliation-extraction-evidence.md` |

## Safe Extension Guidance

When adding new behavior:
1. add concern-specific implementation to the most specific module, not `app.rs`
2. keep `app.rs` updates at wiring/delegation level whenever feasible
3. preserve contract-sensitive surfaces (CLI/runtime mode labels, JSONL event families, manifest semantics, trust/degradation codes) unless a deliberate contract change is documented
4. extend modular stability and contract tests in the same change

## Contract-Sensitive Boundaries

These boundaries remain compatibility-critical across modularization:
- CLI grammar and runtime mode taxonomy
- JSONL event naming + meaning
- manifest schema/field semantics used by gates
- trust/degradation code semantics and operator close-summary interpretation

## Status Note

Final wiring verification completed against:
- `docs/phase3-app-wiring-reduction-evidence.md` (`bd-xdwi`, closed)

This architecture refresh reflects the post-extraction + post-wiring-reduction ownership state.
