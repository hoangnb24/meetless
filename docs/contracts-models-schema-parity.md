# Contracts Models Schema Parity Evidence

Bead: `bd-3alz`  
Date: 2026-03-04

## Scope

Introduced `src/bin/transcribe_live/contracts_models.rs` as the typed contract boundary scaffold for:
- runtime JSONL event vocabulary (`runtime_jsonl`)
- runtime/preflight manifest vocabulary (`runtime_manifest`)

This bead keeps runtime behavior unchanged while centralizing schema vocabulary for later typed serde migration beads.

## Preserved Vocabulary

The following contract strings are now centralized and referenced by emitters:
- JSONL event types:
  - `vad_boundary`
  - `mode_degradation`
  - `trust_notice`
  - `lifecycle_phase`
  - `reconciliation_matrix`
  - `asr_worker_pool`
  - `chunk_queue`
  - `cleanup_queue`
- Manifest kinds:
  - `transcribe-live-runtime`
  - `transcribe-live-preflight`

## Evidence

Validation commands run:

```bash
cargo test --bin transcribe-live contracts_models_ -- --nocapture
cargo test --bin transcribe-live runtime_jsonl_chunk_queue_event_includes_lag_metrics -- --nocapture
cargo test --bin transcribe-live runtime_manifest_includes_ordered_event_timeline -- --nocapture
cargo check -q
ubs src/bin/transcribe_live/contracts_models.rs src/bin/transcribe_live/artifacts.rs
```

Results:
- all commands passed
- parity tests confirm emitted JSONL keys align with centralized contract vocabulary constants
- manifest kind constants preserve prior runtime/preflight contract values
