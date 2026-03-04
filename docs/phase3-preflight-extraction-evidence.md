# Phase 3 Preflight Extraction Evidence

Bead: `bd-phnm`  
Date: 2026-03-04  
Agent: `SilentSnow`

## Objective

Extract preflight/model-doctor responsibilities out of `app.rs` into `preflight.rs` while preserving CLI behavior, diagnostics, and preflight manifest output compatibility.

## Code Surface

- `src/bin/transcribe_live/preflight.rs` (new)
- `src/bin/transcribe_live/app.rs` (wiring-only updates)

## Extraction Result

Moved these responsibilities into `preflight.rs`:

- `run_preflight(...)`
- `run_model_doctor(...)`
- report rendering:
  - `print_preflight_report(...)`
  - `print_model_doctor_report(...)`
- preflight-manifest writer shim:
  - `write_preflight_manifest(...)`
- internal preflight checks:
  - model path + readability
  - output target writability
  - sample-rate check
  - ScreenCaptureKit access/display availability
  - microphone sample-buffer probe
  - backend helper runtime detection

`app.rs` now imports those entrypoints and keeps execution flow unchanged.

## Behavior-Parity Validation

```bash
cargo check -q
cargo test --bin transcribe-live preflight_ -- --nocapture
cargo test --bin transcribe-live model_doctor -- --nocapture
cargo test --bin transcribe-live parse_accepts_live_stream_with_preflight -- --nocapture
cargo test --test modular_stability_contract -- --nocapture
```

Observed result: all commands passed.

## Contract-Safety Notes

- No runtime mode taxonomy/output contract flags were changed.
- Existing preflight/model-doctor CLI parse constraints remain enforced.
- Preflight manifest test coverage remained green after module extraction.
