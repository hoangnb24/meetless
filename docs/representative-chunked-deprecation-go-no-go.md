# Representative-Chunked Deprecation Go/No-Go Review (bd-119)

Date: 2026-03-01
Status: complete (`NO-GO` for deprecation on current evidence)
Owner: `HazyDune`

## Purpose

Decide whether to deprecate or retain representative chunk mode (`--live-chunked`)
after CLI v1 and packaged follow-on evidence are both available.

This review exists to prevent premature selector deprecation while preserving the
current compatibility contract:

- `--live-stream` is the true concurrent capture+transcribe path
- `--live-chunked` remains representative-chunked validation with compatibility labels

References:

- `docs/live-chunked-migration.md`
- `docs/packaged-live-stream-plumbing.md`
- `docs/gate-v1-acceptance.md`

## Current Decision State

`NO-GO` for deprecating representative chunk mode on the current host/state.

Rationale:

1. CLI-side evidence is available (`bd-nqn`/v1 acceptance gate landed).
2. Packaged diagnostics parity lane (`bd-3ma`) is complete.
3. Packaged smoke/gate evidence lane (`bd-3dx`) is complete and emits machine-readable no-go artifacts.
4. The current packaged run fails before manifest materialization, so it cannot prove signed-app `runtime_mode=live-stream`.
5. Remediation is explicitly tracked in `bd-y2v`; deprecation should not move ahead of that fix.

## Evidence Inputs Reviewed

Inputs reviewed for the final recommendation.

### A) CLI v1 Baseline (already available)

- `artifacts/bench/gate_v1_acceptance/<timestamp>/summary.csv`
- `gate_pass=true` with first-emit/artifact/trust checks passing

Current local evidence snapshot:

- `artifacts/tmp/gate_v1_acceptance_fake/summary.csv`
  - `gate_pass=true`
  - `cold_first_emit_during_active_ok=true`
  - `warm_first_emit_during_active_ok=true`
  - `cold_artifact_truth_ok=true`
  - `warm_artifact_truth_ok=true`
  - `backlog_gate_pass=true`
- `artifacts/tmp/gate_backlog_fake/summary.csv`
  - `gate_pass=true`
  - queue pressure/trust/reconciliation thresholds all `true`
- `artifacts/tmp/gate_d_fake/summary.csv`
  - `gate_pass=true`
  - harness reliability / latency drift / continuity visibility thresholds all `true`

### B) Packaged Diagnostics Parity (already available)

- `bd-3ma` closure evidence:
  - packaged live diagnostics invocation path documented
  - parser/test coverage proving `--live-stream --model-doctor` compatibility

### C) Packaged Live Smoke/Gate Evidence (available from `bd-3dx`)

Available evidence:

- `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T081827Z/summary.csv`
- `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T081827Z/status.txt`
- referenced runtime manifest path:
  - `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T081827Z/runtime/session.manifest.json`

Observed result from `summary.csv`:

- `gate_pass=false`
- `runtime_helper_exec_blocked=true`
- `runtime_manifest_exists=false`
- `runtime_mode_ok=false`
- `runtime_mode_status_ok=false`
- `runtime_transcript_surface_ok=false`
- `runtime_degradation_surface_ok=false`
- `runtime_error_line=...failed to execute \`whisper-cli\` prewarm probe: Operation not permitted...`

Interpretation:

- The packaged gate contract now exists and is producing the exact evidence shape this review required.
- The current signed-app runtime is still a no-go because ASR prewarm fails before the runtime manifest is emitted.
- Since no manifest exists, packaged evidence does not yet prove `runtime_mode=live-stream` under signed-app execution.

### D) Operator Messaging Readiness (partially available)

- migration guidance remains explicit:
  - `--live-stream` = true live
  - `--live-chunked` = representative compatibility path
- no doc ambiguity that interprets `runtime_mode=live-chunked` as true live proof

## Go Criteria

Recommend `GO` only if all are true:

1. CLI v1 acceptance gate passes deterministically.
2. Packaged diagnostics parity is validated and documented.
3. Packaged smoke/gate evidence passes with machine-readable artifacts.
4. No contract-level regressions in replay/schema compatibility.
5. Operator docs clearly preserve migration semantics during deprecation rollout.

## No-Go / Hold Criteria

Hold or reject deprecation if any are true:

1. Packaged smoke/gate evidence is missing or ambiguous.
2. Packaged live artifacts fail to prove `runtime_mode=live-stream`.
3. Trust/degradation signaling diverges between CLI and packaged paths.
4. Tooling still depends on `runtime_mode=live-chunked` as a true-live proxy.

## Final Decision Record

- Final recommendation: `NO-GO`
- Effective date: 2026-03-01
- Scope:
  - keep `--live-chunked` available as the representative compatibility path
  - do not start deprecation messaging/removal for representative-chunked yet
  - revisit only after `bd-y2v` produces a passing packaged smoke summary and manifest-backed signed-app evidence
- Evidence snapshot:
  - CLI acceptance artifact paths:
    - `artifacts/tmp/gate_v1_acceptance_fake/summary.csv`
    - `artifacts/tmp/gate_backlog_fake/summary.csv`
    - `artifacts/tmp/gate_d_fake/summary.csv`
  - packaged gate artifact paths:
    - `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T081827Z/summary.csv`
    - `/Users/themrb/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260301T081827Z/status.txt`
  - supporting docs/contracts:
    - `docs/live-chunked-migration.md`
    - `docs/packaged-live-stream-plumbing.md`
    - `docs/gate-v1-acceptance.md`

## Decision Summary

Representative-chunked should not be deprecated now.

Why:

1. CLI v1 evidence is good, but packaged evidence is still failing in the signed-app lane.
2. The packaged gate failure is not ambiguous; it is explicitly classified as helper execution blocked.
3. Because the runtime manifest is absent, there is no signed-app proof yet that packaged live execution reaches the expected `live-stream` runtime contract.
4. Deprecating representative-chunked before `bd-y2v` lands would remove a still-useful compatibility lane without equivalent packaged live proof.

Re-review trigger:

1. `bd-y2v` closes with a passing packaged smoke summary.
2. Signed-app artifacts include a materialized manifest with `runtime_mode=live-stream`.
3. Transcript/trust/degradation surfaces are present and consistent enough to meet the packaged gate contract.
