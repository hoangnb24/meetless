# ADR-003: Cleanup Isolation Boundary and Auto-Disable Policy

- Status: Accepted
- Date: 2026-02-27
- Decision owners: recordit maintainers
- Tracking issue: `bd-27t`
- Implementation issues: `bd-if5`, `bd-2wu`

## Context

Transcript cleanup improves readability, but it is not part of the ASR-critical path. If cleanup can block final transcript emission, the system trades core reliability for optional polish.

The project needs an explicit boundary that keeps cleanup optional, measurable, and automatically suppressible when it harms latency or reliability.

## Decision

1. Cleanup is a post-processing lane for `final` transcript events only.
2. Submission to cleanup is bounded and non-blocking:
   - fixed-capacity queue
   - `try_send` only
   - queue-full requests are dropped and counted
3. Cleanup execution is bounded:
   - `--llm-timeout-ms`
   - `--llm-retries`
4. Cleanup success emits `llm_final` with lineage back to the original `final` segment.
5. Cleanup auto-disable policy is driven by manifest/runtime evidence:
   - disable when drop/failure/latency thresholds are exceeded
   - disable when sampled cleanup quality fails the rubric threshold

## Alternatives Considered

### A. Inline synchronous cleanup before `final` emission

Rejected because it couples optional cleanup latency/failure to ASR correctness and violates the isolation boundary.

### B. Async cleanup with unbounded queue

Rejected because it hides overload behind unbounded memory growth and weakens operational predictability.

### C. Fail the entire session on cleanup errors

Rejected because cleanup is non-essential and should never invalidate a successful core transcript path.

## Tradeoffs

Benefits:
- preserves ASR/final emission even when cleanup is slow or unavailable
- makes degradation explicit and measurable
- supports incremental adoption of local cleanup models without risking the core path

Costs:
- cleanup output can be missing or partial under pressure
- operators must interpret queue metrics and quality gates
- dual-surface semantics (`final` and optional `llm_final`) add downstream schema complexity

## Evidence

- cleanup benchmark report:
  - `docs/cleanup-benchmark-report.md`
- machine-readable policy artifacts:
  - `artifacts/bench/cleanup/20260227T124016Z/cleanup_summary.csv`
  - `artifacts/bench/cleanup/20260227T124016Z/threshold_policy.json`
  - `artifacts/bench/cleanup/20260227T124016Z/threshold_evaluation.csv`
- runtime isolation evidence:
  - `artifacts/bench/gate_c/runtime/dual_cleanup_pressure.manifest.json`
  - `artifacts/validation/bd-if5.runtime.manifest.json`
- contract documentation:
  - `docs/realtime-contracts.md`

## Consequences

- Cleanup remains opt-in enhancement, never a dependency for transcript correctness.
- Operators can disable cleanup using measurable thresholds instead of subjective judgment.
- Downstream consumers must treat `llm_final` as additive/readability-focused output, not canonical source truth.

## Revisit Conditions

Re-open this ADR when:
- cleanup models become reliable enough to reconsider default enablement
- measured threshold policy produces too many false positives/false negatives
- downstream UX requirements require a different relationship between `final` and `llm_final`
