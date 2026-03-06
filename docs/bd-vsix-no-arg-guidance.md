# bd-vsix: SequoiaTranscribe No-Arg Launch Guard

## Scope

`bd-vsix` adds an explicit user-guidance guard for unsupported no-arg launches of the legacy compatibility app path (`SequoiaTranscribe.app`), preventing silent failure UX.

Implemented in:

- `src/bin/transcribe_live.rs`

## Behavior Added

When launched with **no arguments** from a SequoiaTranscribe app-path executable:

- block runtime execution and exit with code `2`
- print clear guidance that:
  - `Recordit.app` is the default user-facing app
  - `SequoiaTranscribe.app` is compatibility-only and requires explicit args
  - terminal invocation path remains `make run-transcribe-app`
- on macOS, attempt to show a visible `osascript` alert so double-click launches surface guidance even without terminal attachment

Argument-driven compatibility runs are unchanged.

## Validation Commands

```bash
rustfmt src/bin/transcribe_live.rs
cargo test --bin transcribe-live no_arg -- --nocapture
cargo test --bin transcribe-live sequoia -- --nocapture
```

## Validation Result

- all targeted tests passed
  - `blocks_no_arg_sequoia_transcribe_executable_launch`
  - `does_not_block_non_sequoia_no_arg_launch`
  - `recognizes_bundle_path_marker_for_sequoia_transcribe`

## Outcome

Acceptance intent is satisfied: unsupported no-arg/double-click SequoiaTranscribe launches now produce explicit, actionable guidance that points users to `Recordit.app` instead of failing silently.
