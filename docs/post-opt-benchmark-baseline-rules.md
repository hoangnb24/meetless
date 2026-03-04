# Post-Optimization Benchmark Baseline Rules

Date: 2026-03-04  
Status: active benchmark baseline execution contract  
Owning bead: `bd-1mxy`

## Purpose

Operationalize the frozen anchor set from `bd-1xos` into one execution contract for
post-optimization benchmark lanes so B1.02-B1.07 comparisons remain deterministic and
non-contradictory.

Authoritative anchor source:

- `docs/phase1-baseline-anchors.md`

This document defines how benchmark beads must execute, classify lanes, compute deltas,
and link evidence.

## Baseline Source of Truth

Use these frozen anchors exactly as published in `docs/phase1-baseline-anchors.md`:

- compatibility first-stable baseline: `2120ms` (`gate_v1_acceptance` cold/warm)
- default pressure buffered-no-drop baseline: `dropped_oldest=0`, `drop_ratio=0`, `first_stable_timing_ms=2120`
- historical induced drop-path reference: `dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95_ms=240`

If any anchor changes, update the source baseline doc first, then update this document
in the same change.

## Execution Profiles by Lane

| Lane | Consumer bead(s) | Canonical command/profile | Expected lane class | Required evidence |
|---|---|---|---|---|
| Compatibility | `bd-3fnd` (B1.02) | `make gate-v1-acceptance` | compatibility | `summary.csv`, `status.txt`, cold/warm manifests, cold/warm JSONL |
| Default pressure | `bd-1w6i` (B1.03) | `scripts/gate_backlog_pressure.sh` (default deterministic profile) | buffered-no-drop | `summary.csv`, `status.txt`, `runtime.manifest.json`, `runtime.jsonl` |
| Induced pressure | `bd-1a7y` (B1.04) | `scripts/gate_backlog_pressure.sh --chunk-window-ms 1200 --chunk-stride-ms 120 --chunk-queue-cap 2 --min-drop-ratio 0.15 --max-drop-ratio 0.80 --min-lag-p95-ms 240` | drop-path (required for queue-drop claims) | same as default pressure lane plus explicit lane verdict |
| Aggressive rerun ladder | `bd-2762` (B1.05) | bounded reruns with profile deltas per attempt | drop-path or unresolved | per-attempt command/profile delta + artifact roots + final verdict |
| Delta synthesis | `bd-nxug` (B1.06) | consume B1.02-B1.05 outputs only | n/a (analysis) | metric table with direct baseline/post-opt artifact links |
| Published benchmark note | `bd-1e0t` (B1.07) | consume B1.06 + linked artifacts | n/a (reporting) | concise reviewer-ready report with pass/fail + caveats |

## Required Formulas and Guardrails

These formulas are mandatory for B1.02-B1.07 interpretation.

### First-stable timing

```text
baseline_first_stable_ms = 2120
first_stable_delta_ms = post_first_stable_ms - 2120
first_stable_ratio = post_first_stable_ms / 2120
guardrail: post_first_stable_ms <= 2332
```

### Induced lane dropped-oldest reduction

```text
baseline_dropped_oldest = 14
dropped_oldest_delta = post_dropped_oldest - 14
dropped_oldest_reduction_ratio = 1 - (post_dropped_oldest / 14)
guardrail: post_dropped_oldest <= 9
```

### Induced lane drop-ratio reduction

```text
baseline_drop_ratio = 0.466667
drop_ratio_delta = post_drop_ratio - 0.466667
drop_ratio_reduction_ratio = 1 - (post_drop_ratio / 0.466667)
guardrail: post_drop_ratio <= 0.326667
```

### Lag interpretation (context only)

```text
baseline_lag_p95_ms = 240
```

`lag_p95_ms` is contextual and cannot be used alone as a success claim.

## Lane Classification Rules (Non-Negotiable)

1. Compatibility lane is for mode-truth + first-stable behavior, not queue-drop claims.
2. Default pressure lane is expected to remain buffered-no-drop under default deterministic profile.
3. Queue-drop improvement claims require an induced drop-path lane with explicit drop-path evidence.
4. If induced lane does not reach drop-path, mark the queue-drop comparison as `incomplete`.
5. Never mix buffered-no-drop and drop-path conclusions in one success statement.

## Evidence Bundle Contract

Each benchmark consumer bead must publish:

1. exact command/profile used
2. exact artifact root(s)
3. lane classification verdict
4. formula-derived metric outputs
5. pass/fail/incomplete conclusion with caveat notes

At minimum, each conclusion row in B1.06/B1.07 must link to concrete artifact paths.

## Downstream Consumer Mapping

This section is the required linkage map for B1.02-B1.07:

- B1.02 (`bd-3fnd`) consumes: compatibility lane command/profile + first-stable formula.
- B1.03 (`bd-1w6i`) consumes: default pressure lane profile + buffered-no-drop interpretation rules.
- B1.04 (`bd-1a7y`) consumes: induced pressure command/profile + drop-path requirement + drop formulas.
- B1.05 (`bd-2762`) consumes: induced lane escalation and unresolved-state policy.
- B1.06 (`bd-nxug`) consumes: all formula outputs and lane verdict semantics.
- B1.07 (`bd-1e0t`) consumes: B1.06 table and evidence links without re-deriving formulas.

If a downstream bead needs different rules, update this document and cite the change reason.

## Contradiction Policy

The following are disallowed:

- reporting queue-drop improvement from compatibility or default buffered-no-drop lanes
- replacing frozen baseline values with ad-hoc values inside downstream bead notes
- omitting artifact links for claims labeled pass/fail
- treating an induced-lane non-drop run as successful drop-path evidence

## References

- `docs/phase1-baseline-anchors.md`
- `docs/gate-backlog-pressure.md`
- `docs/gate-v1-acceptance.md`
- `docs/gate-phase-next-report.md`
