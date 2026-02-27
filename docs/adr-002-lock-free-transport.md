# ADR-002: Preallocated Lock-Free Callback Transport

- Status: Accepted
- Date: 2026-02-27
- Decision owners: recordit maintainers
- Tracking issue: `bd-27t`
- Implementation issue: `bd-3ib`

## Context

ScreenCaptureKit callback handlers run on timing-sensitive queues. Blocking waits, lock contention, or heap growth in callbacks creates drop and latency risk for both capture and downstream transcription.

The project needs a transport contract that is deterministic under pressure and produces explicit telemetry when it cannot keep up.

## Decision

1. Use preallocated, fixed-capacity callback transport as the default architecture.
2. Keep callback handlers non-blocking:
   - acquire slot / publish with `try_*` semantics only
   - no disk I/O, no blocking waits, no callback-thread locks
3. Move expensive work (alignment, merge, write, cleanup orchestration) onto worker threads.
4. Expose pressure/degradation counters as first-class telemetry:
   - `slot_miss_drops`
   - `queue_full_drops`
   - `ready_depth_high_water`
   - `recycle_failures`

## Alternatives Considered

### A. `std::sync::mpsc` queue as callback handoff

Rejected as primary path because callback-side allocation/locking behavior is less explicit and less controllable for real-time pressure scenarios.

### B. Mutex-protected shared queue

Rejected due to callback-thread lock contention risk and higher jitter under producer/consumer bursts.

### C. Direct callback-thread processing + disk write

Rejected because it violates callback non-blocking guarantees and couples capture timing to storage latency.

## Tradeoffs

Benefits:
- deterministic behavior under pressure (drops are explicit instead of hidden stalls)
- clear backpressure telemetry for operational tuning
- stronger isolation between callback timing and downstream work

Costs:
- additional complexity in slot lifecycle/recycling
- fixed capacity can drop samples when overloaded
- requires explicit operator tuning for capacity vs burst patterns

## Evidence

- transport stress artifact:
  - `artifacts/validation/bd-27t.transport_stress.txt`
  - key signals: `ordering_errors=0`, explicit drop accounting under pressure
- callback contract documentation:
  - `docs/realtime-contracts.md`
- implementation loci:
  - `src/rt_transport.rs`
  - `src/bin/sequoia_capture.rs`
  - `src/bin/transport_stress.rs`

## Consequences

- Real-time correctness favors deterministic drop-on-pressure over callback blocking.
- Downstream stages must tolerate bounded loss and rely on telemetry for tuning.
- Future changes that introduce callback-thread blocking must be treated as ADR-level regressions.

## Revisit Conditions

Re-open this ADR when:
- measured loss under target workloads exceeds agreed reliability envelope
- alternative transport approaches demonstrate equal determinism with materially lower complexity
- platform/runtime constraints require a different callback handoff primitive
