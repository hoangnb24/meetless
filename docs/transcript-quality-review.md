# Transcript + Manifest Quality Review (bd-1b8)

## Scope

Review objective: assess readability, consistency, and trust/degradation signaling quality for recent `transcribe-live` runtime outputs.

Artifacts reviewed:
- `artifacts/validation/bd-3lv.runtime.jsonl`
- `artifacts/validation/bd-3lv.runtime.manifest.json`
- `artifacts/validation/bd-3lv.runtime.stdout.txt`
- `artifacts/validation/bd-z21.runtime.jsonl`
- `artifacts/validation/bd-z21.runtime.manifest.json`
- `artifacts/validation/bd-z21.runtime.stdout.txt`

## Rubric

Scoring scale: `1` (poor) to `5` (excellent).

Pass/Fail gates:
- `P0` (must pass): machine-parseable event structure, manifest/JSONL coherence, trust/degradation visibility when degradation occurs.
- `P1` (should pass): transcript readability and operator actionability.
- Go/No-go rule: all `P0` checks pass and average score >= `3.5`.

| Check | Priority | Evidence expectation |
|---|---|---|
| R1 Transcript readability format | P1 | Timestamped readable lines, clear channel labels |
| R2 Manifest/JSONL consistency | P0 | Mode, channels, counts, and transcript content align |
| R3 Degradation signaling completeness | P0 | Degradation events + trust notices include cause/impact/guidance |
| R4 Operator actionability | P1 | Output suggests clear next steps when degraded/failing |
| R5 Deterministic machine parsing | P0 | Stable JSON fields suitable for tooling/rubric automation |

## Results

### Artifact A: `bd-3lv` (separate mode, no degradation)

- R1: `5/5`  
  `stdout` and `manifest.transcript` show readable merged lines with stable timestamp format and overlap annotation.
- R2: `5/5`  
  `channel_mode_requested=separate`, `channel_mode=separate`, `event_channels=["mic","system"]`, and JSONL events are coherent.
- R3: `5/5`  
  No degradation expected and none reported (`degradation_events: []`).
- R4: `4/5`  
  Runtime summary and SLO reporting are clear; no operator ambiguity.
- R5: `5/5`  
  JSONL events have consistent keys and numeric timing fields.

Verdict: **PASS**.

### Artifact B: `bd-z21` (mixed-fallback degradation + cleanup failure)

- R1: `4/5`  
  Readable transcript retained in merged mode with explicit format metadata.
- R2: `5/5`  
  Requested/active mode transition (`mixed-fallback` -> `mixed`) is reflected in stdout, JSONL, and manifest consistently.
- R3: `5/5`  
  Degradation and trust notices include structured `code`, `cause`, `impact`, and `guidance`.
- R4: `5/5`  
  Guidance is actionable (`use separate with stereo input`, `validate cleanup endpoint or disable cleanup`).
- R5: `4/5`  
  Machine readability is strong; minor gap is limited provenance linkage for trust notices (see remediation).

Verdict: **PASS**.

## Overall Score and Decision

- Average score across all rubric dimensions/artifacts: **4.7 / 5.0**
- `P0` checks: **all pass**
- **Go/No-go decision: GO** for current transcript + manifest output quality.

## Findings

Strengths:
- Transcript readability contract is explicit and consistently rendered.
- Manifest and JSONL remain coherent across normal and degraded runs.
- Trust/degradation notices are concrete and user-actionable.
- Cleanup isolation semantics are visible without compromising transcript authority.

Remediation recommendations:
1. Add explicit temporal provenance to `trust_notice` records (`generated_unix_ms` or equivalent) for easier cross-event correlation in post-run audits.
2. Expand `event_counts` into explicit subcounts (for example `partial_count`, `final_count`, `control_event_count`) to simplify automatic quality checks without inferring semantics.
3. Document path convention explicitly in runtime manifest contract (`absolute` vs `repo-relative`) for fields like benchmark CSV paths to reduce integration ambiguity for downstream tooling.
