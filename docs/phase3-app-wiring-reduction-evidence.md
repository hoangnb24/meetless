# bd-xdwi — app.rs Wiring Reduction Evidence

## Objective

Reduce `src/bin/transcribe_live/app.rs` toward composition/wiring responsibilities
while preserving behavior contracts.

## Applied Reduction

- Consolidated reporting/summary implementation ownership in
  `src/bin/transcribe_live/reporting.rs`.
- Kept `app.rs` compatibility shims as thin delegates where other modules
  (`artifacts.rs`, tests) still consume `app`-level symbols:
  - `stable_terminal_summary_lines(...)`
  - `transcript_event_count(...)`
  - `session_status(...)`
  - `top_codes(...)`
- Removed in-`app.rs` concrete implementations for these helpers and routed to
  `reporting::*`.

This preserves existing integration points while reducing behavioral logic
concentration in `app.rs`.

## Validation

```bash
cargo check -q --bin transcribe-live
cargo test --bin transcribe-live live_close_summary_lines_use_contract_field_order -- --nocapture
cargo test --bin transcribe-live runtime_failure_breadcrumbs_include_artifact_paths_and_hot_path_counters -- --nocapture
cargo test --test modular_stability_contract -- --nocapture
```

All commands passed on the current shared working tree.

## UBS

```bash
UBS_MAX_DIR_SIZE_MB=5000 ubs src/bin/transcribe_live/app.rs src/bin/transcribe_live/reporting.rs docs/phase3-app-wiring-reduction-evidence.md
```

Any warning-heavy inventory on `app.rs` is pre-existing in test-heavy surfaces;
no new bead-specific blocker was introduced by the wiring delegation change.
