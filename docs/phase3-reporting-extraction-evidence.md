# Phase 3 Reporting Extraction Evidence

Bead: `bd-1uuf`  
Date: 2026-03-04  
Agent: `OrangeCanyon`

## Objective

Extract close-summary and terminal reporting formatting logic from `app.rs` into `reporting.rs` while preserving existing output semantics and diagnostics contracts.

## Code Surface

- `src/bin/transcribe_live/reporting.rs` (new)
- `src/bin/transcribe_live/app.rs` (module wiring + reduced orchestration surface)

## Extraction Result

Moved reporting-focused responsibilities into `reporting.rs`:

- `print_live_report(...)`
- `build_live_close_summary_lines(...)`
- `runtime_failure_breadcrumbs(...)`
- remediation hint generation/rendering helpers
- close-summary helper functions (`session_status`, `top_codes`, `top_codes_csv`)

`app.rs` now wires the reporting module and keeps non-reporting orchestration concerns.
Compatibility helpers required by `artifacts.rs` (`session_status`, `top_codes`) remain in `app.rs` to preserve existing cross-module call surfaces.

## Validation Commands

```bash
cargo check -q
cargo test --bin transcribe-live live_close_summary_lines_use_contract_field_order -- --nocapture
cargo test --bin transcribe-live runtime_failure_breadcrumbs_include_artifact_paths_and_hot_path_counters -- --nocapture
cargo test --bin transcribe-live remediation_hints_are_deterministic_and_deduplicated -- --nocapture
cargo test --bin transcribe-live runtime_manifest_includes_ordered_event_timeline -- --nocapture
cargo test --test modular_stability_contract -- --nocapture
```

Observed result: all commands passed.

## Parity Notes

- Close-summary field order contract remains unchanged.
- Runtime diagnostics breadcrumb formatting remains unchanged.
- Remediation hints stay deterministic and deduplicated.
- Runtime manifest terminal/session summary payloads remain compatible.
