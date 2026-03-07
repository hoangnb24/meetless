# bd-3rqf — Graceful live stop handshake before interrupt/terminate fallback

Date: 2026-03-07
Related bead: `bd-3rqf`
Primary implementation sources:
- `app/RuntimeProcessLayer/ProcessBackedRuntimeService.swift`
- `src/live_capture.rs`
- `src/bin/transcribe_live/runtime_live_stream.rs`
Primary exercised coverage:
- `app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift`
- `app/ViewModels/runtime_stop_finalization_smoke.swift`
- `tests/live_stream_stop_marker_finalize_integration.rs`

## Purpose

Document the current graceful-stop contract for live sessions: the app asks the runtime to drain and finalize first, then falls back to interrupt-style termination only when the bounded grace window expires or the runtime remains unresponsive.

## Canonical handshake

The current stop path is intentionally two-stage.

### Stage 1: request graceful stop

For `RuntimeControlAction.stop`, `ProcessBackedRuntimeService` now:
- resolves the active session root for the runtime process
- writes `session.stop.request` into that session root
- waits a bounded grace interval for the runtime to stop naturally

The bounded grace interval is controlled by:
- `stopTimeoutSeconds`
- `gracefulStopTimeoutSeconds`
- `boundedGracefulStopTimeout()`

Current rule:
- the graceful window is clamped to a small bounded fraction of the full stop timeout
- the remaining stop budget is reserved for forced fallback if graceful stop does not settle

### Stage 2: forced fallback only if needed

If the graceful request does not produce a settled stop outcome in time, the service falls back to the existing process-control stop path with the remaining timeout budget.

The timeout diagnostics surface both budgets explicitly in stop-timeout failures:
- `graceful_stop_timeout_seconds=...`
- `forced_stop_timeout_seconds=...`

## Runtime-side contract

The live runtime already consumes the stop-request marker instead of requiring an immediate external interrupt.

Current marker path:
- `session.stop.request`

Current behavior on the runtime side:
- live capture and live-stream runtime code watch for the stop marker
- when the marker appears, the runtime transitions into a drain/finalization path rather than treating stop as an abrupt kill-only event
- marker-driven runs are expected to preserve final manifest and transcript artifacts when the runtime can finalize cleanly

## Lifecycle invariants now on disk

The current codebase already asserts these invariants.

### Process-layer smoke invariants

`app/RuntimeProcessLayer/process_lifecycle_integration_smoke.swift` covers:
- stale `session.stop.request` markers are cleared on launch so they do not poison the next run
- explicit stop writes a request that helper runtimes observe as `REQUEST`
- the request marker is removed after control settles
- marker-driven graceful stop can drive `RuntimeViewModel` finalization to `.completed`
- if graceful stop does not complete, stop falls back to interrupt behavior

### View-model bounded finalization invariants

`app/ViewModels/runtime_stop_finalization_smoke.swift` covers:
- successful stop can keep polling until a pending manifest becomes final
- missing manifest paths time out into explicit recovery states
- retry-stop and retry-finalize recovery flows preserve bounded behavior
- interruption contexts distinguish empty-session versus partial-artifact failure modes

### Rust end-to-end invariant

`tests/live_stream_stop_marker_finalize_integration.rs` covers:
- writing `session.stop.request` during a live-stream run drains and finalizes the same run
- the runtime settles within a bounded timeout after the marker is written
- finalized artifacts (`session.wav`, `session.jsonl`, `session.manifest.json`) still exist after marker-driven shutdown
- lifecycle phases preserve `active -> draining -> shutdown` ordering

## Truthful scope boundary

This bead establishes the graceful-stop handshake contract itself.

It does **not** by itself prove every downstream stop/finalization guarantee. In particular, downstream work still exists for:
- broader stop/finalization stress coverage
- richer classification and artifact evidence around stop failures
- additional unit/e2e protection over bounded wait policy and manifest outcomes

That is why `bd-p77p`, `bd-2fic`, and `bd-1qjo` remain separate downstream beads.

## Current contract summary

The truthful current stop contract is now:
- stop prefers a session-root handshake (`session.stop.request`) before forced fallback
- the graceful wait is bounded, not unbounded
- stale stop markers are cleaned up at launch and after settled control
- graceful stop can finalize into a completed session when the runtime cooperates
- interrupt-style fallback still exists for unresponsive runtimes

## Decision

`bd-3rqf` is satisfied by the implementation and exercised coverage already on disk:
- the stop-request marker path exists in the app process layer
- the runtime consumes that marker
- smoke and integration coverage assert both graceful success and forced-fallback behavior

Future stop/finalization beads should build on this handshake instead of reintroducing direct interrupt-first stop semantics.
