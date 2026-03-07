# ADR-004: Packaged Beta Entrypoint and Bundle Strategy

- Date: 2026-02-28
- Status: Superseded by ADR-005 (2026-03-05)
- Superseded by: `docs/adr-005-recordit-default-entrypoint.md`
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

## Follow-on Design: Packaged Live-Stream Plumbing (`bd-31s`)

When packaged live-stream support is enabled after CLI v1 stabilization, keep the same packaged operator entrypoint and extend its argument/artifact contract instead of introducing a second app launcher.

Argument plumbing plan:

- entrypoint remains `make run-transcribe-app`
- live selector is forwarded via `TRANSCRIBE_ARGS=--live-stream`
- packaged live mode also needs an explicit container-scoped capture input path:
  - proposed default: `$(TRANSCRIBE_APP_ARTIFACT_ROOT)/$(TRANSCRIBE_APP_SESSION_STEM).input.wav`
- packaged preflight/model-doctor flows stay on the same entrypoint family and continue to enforce debug-CLI selector rules (`--replay-jsonl` remains incompatible with live selectors, while `--preflight` stays compatible)

Artifact destination plan:

- retain the current packaged root:
  - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`
- keep one session stem per run so packaged live writes a coherent quartet:
  - `<stem>.input.wav`
  - `<stem>.wav`
  - `<stem>.jsonl`
  - `<stem>.manifest.json`
- reserve a sibling gate evidence subtree for packaged follow-on validation:
  - `<root>/gates/<gate-name>/<timestamp>/...`

Why this shape:

1. downstream packaged tasks (`bd-3dx`, `bd-3ma`) can reuse the existing packaged app launch path
2. live capture input becomes auditable in the same container root as output artifacts
3. operator docs can describe one packaged path with mode-specific arguments instead of multiple competing app entrypoints
