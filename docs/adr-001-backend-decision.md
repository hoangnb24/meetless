# ADR-001: ASR Backend Decision and Explicit Fallback Strategy

- Status: Accepted
- Date: 2026-02-27
- Decision owners: recordit maintainers
- Tracking issue: `bd-1ll`
- Discovery parent: `bd-2kk`
- Evidence task: `bd-2il`

## Context

The project needs a local ASR backend choice for Phase 1 (`transcribe-live`) that is backed by repo-local benchmark evidence, not external claims.

Decision criteria from project planning:

- maintain low-latency transcript delivery on Apple Silicon/macOS 15+
- keep callback-thread safety and runtime stability constraints intact
- keep packaging/model-path operations workable in debug and signed-app modes
- preserve a practical fallback path when assumptions fail

## Decision

1. Primary backend: `whispercpp` (Whisper.cpp, integrated through Rust adapter work in downstream issues).
2. Secondary fallback backend: `whisperkit`.
3. Not selected for current implementation scope: `moonshine` (availability/integration not yet evidenced in this repo on this host).

## Evidence Used

Primary report:

- `docs/gate-a-b-report.md`

Gate A/Gate B machine-readable artifacts:

- `artifacts/bench/harness_gateab/whispercpp/20260227T111516Z/summary.csv`
- `artifacts/bench/harness_gateab/whispercpp/20260227T111516Z/runs.csv`
- `artifacts/bench/harness_gateab/whisperkit/20260227T111517Z/summary.csv`
- `artifacts/bench/harness_gateab/whisperkit/20260227T111517Z/runs.csv`
- `artifacts/bench/outputs/direct_gateab/whispercpp/*.time`
- `artifacts/bench/outputs/direct_gateab/whisperkit/*.time`

Observed host-level outcome (Gate A):

- `whispercpp`: lower wall latency and lower derived CPU%
- `whisperkit`: lower RSS, but slower wall latency on the tested corpus

Observed integration outcome (Gate B):

- harness/direct overhead ratios are negligible (~0% to ~1.2%)
- all measured runs exited successfully

## Alternatives Considered

### A. `whisperkit` as primary

Rejected as primary at this time because measured wall latency and CPU% on this host are weaker than `whispercpp`, despite lower RSS.

### B. `moonshine` as primary

Rejected for current scope because a reproducible local moonshine CLI/runtime path was not available during `bd-2il` execution. This is an availability/integration evidence gap, not a model-quality judgment.

## Explicit Fallback Triggers

Fallback is mandatory (not discretionary) when one or more conditions below are true.

1. Integration overhead failure (Gate B contract):
   - trigger: selected backend exceeds `2x` standalone runtime in Rust integration validation
   - action: switch implementation target to `whisperkit` adapter path and continue Phase 1 deliverables

2. Latency SLO failure after tuning:
   - trigger: selected backend cannot meet agreed single-channel latency envelope for target hardware tier after profile tuning
   - action: switch backend/profile and, if needed, document SLO adjustment in a follow-up ADR update

3. Runtime stability failure under repeated runs/soak:
   - trigger: crash/leak/stall behavior under repeated inference or stress criteria
   - action: fall back to alternate backend and continue with reduced mode until stability is restored

4. Packaging/model-resolution failure in signed app workflow:
   - trigger: backend model assets cannot be resolved deterministically in sandboxed execution
   - action: move to backend/path layout that supports deterministic signed-app operation

## Risk Register Entries (linked to owning issues)

| risk_id | Risk | Owning issue(s) | Fallback/mitigation |
|---|---|---|---|
| R-001 | Rust adapter integration overhead or instability for selected backend | `bd-1kp` | Switch backend adapter target to `whisperkit`; keep event contract stable |
| R-002 | Model asset layout and sandbox path resolution drift | `bd-2p6` | Enforce deterministic model layout/resolution rules and signed-app path checks |
| R-003 | Event contract/replay regressions (partial/final semantics) | `bd-w4c` | Preserve JSONL schema and replay validation as a release gate |
| R-004 | Real-time degradation under load (drops/latency/backpressure) | `bd-a88`, `bd-3vk` | Enforce telemetry gates; fall back to mixed mode or alternate backend by tier |

## Consequences

- Phase 1 proceeds with `whispercpp` as the implementation default.
- `whisperkit` remains a first-class fallback path, not a discarded option.
- `moonshine` can be reconsidered only after reproducible local availability and benchmark evidence are added to this repo.

## Revisit Conditions

Re-open this ADR when any of the following occurs:

- moonshine becomes locally runnable with reproducible benchmark artifacts in `artifacts/bench/**`
- Gate C or long-session stability evidence invalidates this decision on target hardware tiers
- packaging constraints force a backend switch for signed-app reliability
