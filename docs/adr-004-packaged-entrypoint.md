# ADR-004: Packaged Beta Entrypoint and Bundle Strategy

- Date: 2026-02-28
- Status: Accepted
- Related bead: `bd-4d9`

## Context

The repository currently exposes multiple runnable surfaces:

- debug binaries (`cargo run`, `make transcribe-live`, `make capture-transcribe`)
- signed capture bundle (`make run-app` -> `SequoiaCapture.app`)
- signed transcribe bundle (`make run-transcribe-app` -> `SequoiaTranscribe.app`)

That flexibility is useful for engineering, but it creates ambiguity for packaged beta operators and blocks downstream packaging tasks that need one canonical launch path.

## Decision

For packaged beta usage, the single recommended entrypoint is:

- `make run-transcribe-app` (launches signed `dist/SequoiaTranscribe.app`)

Companion packaged diagnostics for that same path are:

- `make run-transcribe-preflight-app`
- `make run-transcribe-model-doctor-app`

Engineering-only surfaces remain supported but are not the packaged default:

- `make transcribe-live`
- `make capture-transcribe`
- direct `cargo run --bin ...`
- `make run-app` (`SequoiaCapture.app`)

## Rationale

1. The transcribe bundle is the product-facing runtime contract (`transcribe-live`) and owns the near-live artifacts, trust/degradation reporting, and manifest semantics operators care about.
2. The signed app path gives stable sandboxed behavior and predictable container-scoped artifact locations.
3. Preflight/model diagnostics already map naturally onto this path via `run-transcribe-preflight-app`.
4. Choosing now unblocks packaging follow-ons (`bd-iv6`, `bd-np8`) without forcing premature UX consolidation in this bead.

## Consequences

- Docs/help text should reference `run-transcribe-app` as the packaged beta default.
- Follow-on work can standardize artifact destination and session summary around this path.
- Capture-only and debug paths stay available for development/testing, but should be documented as non-default for packaged operators.
