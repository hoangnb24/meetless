# Phase 1 Baseline Anchors

Date: 2026-03-04  
Status: frozen pre-change anchor set for Phase 1 and post-opt benchmark comparisons

## Purpose

This document freezes the baseline evidence, formulas, and interpretation rules used for:
- Phase 1 hot-path/runtime modernization comparisons
- post-optimization benchmark reruns (`B1.01+`)
- lane classification between compatibility, default pressure, and induced drop-path scenarios

The goal is to prevent moving-target comparisons. Downstream beads should cite this document rather than redefining baseline values ad hoc.

Freeze context:
- workspace HEAD at freeze time: `a402b68`
- baseline freeze bead: `bd-1xos`

## Frozen Anchor Registry

| Anchor ID | Lane intent | Canonical evidence | Generated-at context | Frozen values | Hash context |
|---|---|---|---|---|---|
| `compat-live-first-stable` | compatibility lane for `gate_v1_acceptance` cold/warm live-stream behavior | `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv` plus cold/warm manifests | summary `2026-03-01T13:05:21Z`; cold manifest `2026-03-01T13:03:56Z` | `cold_first_stable_timing_ms=2120`, `warm_first_stable_timing_ms=2120`, live mode tuple `live-stream/live-stream/--live-stream`, trust/degradation empty | `summary.csv sha256=a71db0fad9cee98b99f850fb2ab24bb9f5e087dd310416960ab4468d58d0f912`; `cold manifest sha256=5c640a6a2fddda1ebf5aac1dbdbfdae90f8bf1279dd8b99ed47355d51b0351cb`; `warm manifest sha256=dc5596c46d9bada49994b9830ddc3d0b0f1bf0643c448dc055a2b914087910ab` |
| `default-pressure-buffered-no-drop` | default backlog-pressure lane used to validate buffered-no-drop behavior without false-positive degradation/trust alarms | `artifacts/bench/gate_backlog_pressure/20260302T074649Z/summary.csv` plus runtime manifest | summary `2026-03-02T07:47:22Z`; manifest `2026-03-02T07:46:50Z` | `pressure_profile=buffered-no-drop`, `submitted=78`, `enqueued=78`, `dropped_oldest=0`, `drop_ratio=0.000000`, `high_water=2`, `max_queue=2`, `lag_p95_ms=0`, `first_stable_timing_ms=2120`, trust/degradation empty | `summary.csv sha256=7d8a528dd14dfd7ddf0a5d77c89a51269cb6e656c629dbc6e6638a3705420c98`; `runtime.manifest.json sha256=48c019b083a796416a863b1aa3ca07fdfca23c1f0d50edf92430eba7400b6d41` |
| `historical-drop-path-reference` | induced-pressure reference lane for queue-drop improvement claims | `docs/gate-phase-next-report.md` historical observation row | report frozen from commit `9d9e59e9ce52dc2f5ab6d4e205d422f069c29db1` (`2026-02-28T23:03:57+07:00`) | `dropped_oldest=14`, `drop_ratio=0.466667`, `lag_p95_ms=240` | `docs/gate-phase-next-report.md sha256=8a60a3bdb39913248fe11ddfe14a2395578cff26d12b025dba899469173fb001` |

## Command/Profile Assumptions

### Compatibility lane

Use the canonical live compatibility gate:

```bash
make gate-v1-acceptance
```

Baseline evidence is frozen from:
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/summary.csv`
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/cold/runtime.manifest.json`
- `artifacts/bench/gate_v1_acceptance/20260301T130355Z/warm/runtime.manifest.json`

### Default pressure lane

Use the deterministic default backlog-pressure profile:

```bash
scripts/gate_backlog_pressure.sh
```

Current accepted baseline behavior is `pressure_profile=buffered-no-drop`, not induced drop-path.

### Induced drop-path lane

Use a constrained backlog-pressure profile intended to force drops:

```bash
scripts/gate_backlog_pressure.sh \
  --chunk-window-ms 1200 \
  --chunk-stride-ms 120 \
  --chunk-queue-cap 2 \
  --min-drop-ratio 0.15 \
  --max-drop-ratio 0.80 \
  --min-lag-p95-ms 240
```

Important:
- the historical induced-pressure anchor is currently frozen from the consolidated report row, not from a checked-in raw `summary.csv`
- future induced-pressure benchmark beads should preserve raw artifacts and cite them directly
- if a rerun does not actually classify as `drop-path`, mark the result `incomplete` rather than claiming success

## Exact Comparison Formulas

### First-stable timing regression

Baseline:
- `baseline_first_stable_ms = max(cold_first_stable_timing_ms, warm_first_stable_timing_ms) = 2120`

Formula:

```text
first_stable_delta_ms = post_first_stable_ms - 2120
first_stable_ratio = post_first_stable_ms / 2120
```

Guardrail:

```text
post_first_stable_ms <= 2332
```

This is the 10% regression ceiling recorded for downstream delta work.

### Dropped-oldest reduction under induced drop-path

Historical baseline:

```text
baseline_dropped_oldest = 14
```

Formula:

```text
dropped_oldest_delta = post_dropped_oldest - 14
dropped_oldest_reduction_ratio = 1 - (post_dropped_oldest / 14)
```

Guardrail:

```text
post_dropped_oldest <= floor(14 * 0.70) = 9
```

### Drop-ratio reduction under induced drop-path

Historical baseline:

```text
baseline_drop_ratio = 0.466667
```

Formula:

```text
drop_ratio_delta = post_drop_ratio - 0.466667
drop_ratio_reduction_ratio = 1 - (post_drop_ratio / 0.466667)
```

Guardrail:

```text
post_drop_ratio <= 0.466667 * 0.70 = 0.326667
```

### Lag context

Historical induced-pressure reference:

```text
baseline_lag_p95_ms = 240
```

Interpretation rule:
- `lag_p95_ms` is contextual, not a standalone success claim
- use it to explain why a run classified as drop-path or buffered-no-drop
- do not accept a queue-drop improvement claim from lag alone

## Lane Classification Rules

### Compatibility lane

Use this lane to validate:
- runtime mode truth tuple
- first-stable timing
- clean trust/degradation surface

Do not use this lane to claim queue-drop improvement.

### Default pressure lane

This is the canonical buffered-no-drop interpretation lane.

Expected baseline semantics:
- queue reaches saturation evidence (`high_water >= max_queue`)
- `dropped_oldest=0`
- trust/degradation codes remain absent
- `first_stable_timing_ms` stays comparable to the compatibility anchor

Use this lane to prove:
- no false-positive degradation/trust signaling
- no regression in user-visible responsiveness under the default deterministic profile

Do not use this lane to claim queue-drop improvement. Zero drop here means the lane remained buffered-no-drop, not that induced-pressure behavior improved.

### Induced drop-path lane

This is the authoritative lane for queue-drop improvement claims.

Required conditions:
- explicit `drop-path` classification, or equivalent evidence that drops/reconciliation/trust/degradation were actually exercised
- raw artifact linkage for `dropped_oldest`, `drop_ratio`, `lag_p95_ms`, and trust/degradation signals
- direct comparison against the historical drop-path anchor above

If the induced lane stays buffered-no-drop:
- record the run as valid evidence for classification drift
- do not count it as success for queue-drop reduction targets
- point follow-up work to the rerun/aggressive-profile bead instead of normalizing the result optimistically

## Interpretation Rules

1. Compare compatibility reruns against `compat-live-first-stable`.
2. Compare default backlog-pressure reruns against `default-pressure-buffered-no-drop`.
3. Compare induced-pressure reruns against `historical-drop-path-reference`.
4. Do not mix buffered-no-drop and drop-path conclusions in one metric claim.
5. Queue-drop improvement is incomplete unless the post-opt lane actually exercised induced drop-path behavior.

## Downstream Consumers

This frozen set is intended to feed:
- `bd-1mxy`
- `bd-3fnd`
- `bd-1w6i`
- `bd-1a7y`
- `bd-nxug`
- `bd-i1ft`

If any baseline value or interpretation rule must change, update this document first and record the reason in the same change.
