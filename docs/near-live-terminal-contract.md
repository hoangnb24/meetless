# Near-Live Terminal UX Contract (bd-279)

Date: 2026-02-28  
Status: normative contract for downstream near-live runtime tasks (`bd-1h4`, `bd-iv6`)

## Purpose

Define stable terminal behavior for near-live mode so operators get:

- concise progress by default
- opt-in diagnostics without changing runtime semantics
- deterministic end-of-session summary for health/trust/artifact review

## Scope

Applies when near-live mode is active (`--live-chunked` in the live CLI contract).

Does not change JSONL/manifest semantics. Terminal output is a presentation layer over the same runtime event stream.

## Output Profiles

### Profile A: Concise Default

Default profile is optimized for human readability on long sessions.

Required behavior:

1. Print a single session header block at start:
   - mode (`near-live`)
   - channel mode (requested/active)
   - chunk policy (`window_ms`, `stride_ms`, queue cap)
   - artifact destinations (`out_wav`, `out_jsonl`, `out_manifest`)
2. Emit transcript lines only for stable user-facing events (`final` and `llm_final`).
3. Emit trust/degradation notices only when state changes.
4. Emit periodic heartbeat at a fixed cadence (default `10s`) with compact counters.
5. Print one deterministic end-of-session summary block.

Line format for transcript rows:

`[MM:SS.mmm-MM:SS.mmm] <channel>: <text>`

Optional overlap annotation remains bounded and deterministic:

`(overlap<=120ms with <channel>)`

### Profile B: Verbose Diagnostics

Verbose profile is opt-in (for operator debugging) and must preserve runtime behavior.

Required behavior:

1. Include all concise output.
2. Add structured control-event lines for queue pressure, chunk scheduling, and mode transitions.
3. Add per-heartbeat expanded telemetry snapshot.
4. Never alter scheduling, ASR queue policy, or transcript ordering.

## Deterministic End-of-Session Summary

Summary must be emitted exactly once and in fixed field order:

1. `session_status` (`ok|degraded|failed`)
2. `duration_sec`
3. `channel_mode_requested`
4. `channel_mode_active`
5. `transcript_events` (`partial`, `final`, `llm_final`, `reconciled_final`)
6. `chunk_queue` (`submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `drain_completed`)
7. `chunk_lag` (`lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
8. `trust_notices` count and top codes
9. `degradation_events` count and top codes
10. `cleanup_queue` summary
11. `artifacts` (`out_wav`, `out_jsonl`, `out_manifest`)

Field omission is not allowed in successful runs. Unknown values must be rendered as explicit sentinel values (`<unavailable>`), not silently skipped.

## UX Guardrails

1. Concise profile must stay readable within an 80-column terminal without line wrapping for summary keys.
2. Trust/degradation notices must include:
   - `code`
   - user impact statement
   - one immediate remediation hint
3. Log-noise controls must be deterministic:
   - identical inputs and runtime decisions produce identical terminal line ordering
4. Terminal profile changes must not change JSONL/manifest content.

## Mapping to Machine Artifacts

Terminal summary fields must map directly to existing or planned JSONL/manifest keys so replay and automation can verify consistency:

- `channel_mode_*` -> manifest `channel_mode_requested`, `channel_mode`
- transcript counts -> JSONL event type counts (`partial`, `final`, `llm_final`, `reconciled_final`)
- transcript event timeline -> manifest `events[]` and JSONL transcript events (replay-safe ordering)
- trust/degradation counts -> JSONL `trust_notice` and `mode_degradation`
- queue counters -> manifest/JSONL near-live `chunk_queue` telemetry and `cleanup_queue` telemetry
- artifact paths -> runtime output destinations

## Acceptance for bd-279

1. Concise and verbose profiles are explicitly defined and non-overlapping.
2. End summary field set and order are deterministic and documented.
3. Trust/degradation messaging requirements are explicit.
4. Downstream implementation tasks can execute without additional UX ambiguity.
