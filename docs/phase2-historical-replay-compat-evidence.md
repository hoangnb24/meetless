# Phase 2 Historical Replay Compatibility Evidence

Bead: `bd-1qd4`  
Date: 2026-03-04

## Purpose

Record the historical artifact replay compatibility regression suite status for the typed JSON boundary.

## Code Surface

- `src/bin/transcribe_live/contracts_models.rs`

Regression suite coverage:
- frozen runtime JSONL fixtures from:
  - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.jsonl`
  - `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.jsonl`
  - `artifacts/bench/gate_backlog_pressure/20260302T074649Z/runtime.jsonl`
- typed parse + typed encode + typed reparse roundtrip for every line
- required event-type presence assertions for compatibility-critical event families

## Diagnostic Hardening Added

When typed roundtrip mismatch occurs, test output now includes event-level replay context:

- `event_type`
- `channel`
- `segment_id`
- `start_ms`
- `end_ms`

This gives direct event/segment/channel breadcrumbs for replay divergence without manual artifact archaeology.

## Validation Commands

```bash
cargo test --bin transcribe-live runtime_jsonl_frozen_fixtures_parse_with_typed_boundary_and_context -- --nocapture
cargo test --bin transcribe-live runtime_jsonl_ -- --nocapture
cargo test --test runtime_jsonl_schema_contract -- --nocapture
cargo check -q
```

## Results

- historical fixture parse + typed roundtrip suite: pass
- runtime JSONL typed-boundary unit suite: pass
- runtime JSONL schema contract tests: pass
- compile check: pass

## Follow-On Linkage

This evidence note is a direct input for:
- `bd-o5d0` (Phase 2 contract/schema evidence pass)

and should be cited in that bead's final evidence synthesis.
