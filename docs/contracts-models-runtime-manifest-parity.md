# Typed Manifest Models Parity Evidence

Bead: `bd-2xto`  
Date: 2026-03-04

## Scope

Added typed manifest models in:
- `src/bin/transcribe_live/runtime_manifest_models.rs`

Covered model surfaces:
- `RuntimeManifest` and nested structures for runtime artifact schema
- `PreflightManifest` and nested config/check structures
- decode helpers with explicit `kind`-aware diagnostics:
  - `decode_runtime_manifest(...)`
  - `decode_preflight_manifest(...)`

## Parity Guarantees

- One-to-one top-level key coverage for runtime manifests (including lifecycle, queue telemetry, trust/degradation, and session summary sections).
- Preflight model preserves legacy optional/default semantics via `Option` + `skip_serializing_if` for fields that are absent in older frozen fixtures.
- `serde(deny_unknown_fields)` is used on model structs to surface drift immediately as field-level decode errors.

## Evidence

Validation commands:

```bash
cargo test --bin transcribe-live runtime_manifest_models_ -- --nocapture
cargo test --test runtime_manifest_contract -- --nocapture
cargo check -q
ubs src/bin/transcribe_live/runtime_manifest_models.rs
```

Expected outcomes:
- fixture roundtrip tests pass with no JSON drift
- frozen runtime manifest contract tests remain green
- decode diagnostics include manifest `kind` plus concrete field mismatch context
