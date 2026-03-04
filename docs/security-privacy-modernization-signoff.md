# Security/Privacy Sign-Off For Modernization Changes

Bead: `bd-18yj`  
Date: 2026-03-04  
Status: pass-with-residuals

## Scope

This sign-off covers the high-sensitivity surfaces changed during modernization:

1. scratch/temp-audio lifecycle handling
2. replay JSON ingestion hardening

Goal: confirm no new high-risk behavior was introduced while retaining operational diagnosability.

## Surface 1: Scratch/Temp-Audio Lifecycle

### Controls Confirmed

- Temp-audio policy is explicit (`DeleteAlways`, `RetainOnFailure`, `RetainAlways`) and enforced through `TempAudioPolicy` contract surfaces.
- Worker-local PCM scratch materialization validates target safety before overwrite:
  - symlink targets are rejected
  - non-file targets are rejected
- Cleanup is safety-first:
  - symlink/non-file targets are retained for manual review (not auto-deleted)
  - metadata/delete failures default to retain-for-review behavior
- Worker-local scratch reuse lowers path churn and narrows accidental path-sprawl risk.

### Evidence Anchors

- `src/bin/transcribe_live/asr_backend.rs`
- `src/live_asr_pool.rs`
- `docs/temp-audio-security-policy.md`

Test evidence in tree includes policy matrix and safety behaviors (retain/delete policy semantics, symlink/non-file retention, worker-local scratch reuse and retry behavior).

## Surface 2: Replay Ingestion Hardening

### Controls Confirmed

- Bounded ingestion guardrails:
  - `REPLAY_JSONL_MAX_LINE_BYTES=1_048_576`
  - `REPLAY_TRANSCRIPT_TEXT_MAX_BYTES=262_144`
- Replay parsing is typed via `RuntimeJsonlEvent` parse path, with explicit diagnostics for:
  - invalid JSON decoding
  - unknown event types
  - per-event payload mismatch
- Replay error output is categorized with line context (`line_too_large`, `text_too_large`, `payload_mismatch`, `json_decode`, `unknown_event_type`, fallback `parse_error`).

### Evidence Anchors

- `src/bin/transcribe_live/contracts_models.rs` (`parse_runtime_jsonl_event_line`)
- `src/bin/transcribe_live/app.rs` (replay bounds + categorized replay diagnostics)
- unit tests in `transcribe-live` binary test module for oversized/malformed replay rows and trust/transcript mismatch diagnostics

## Findings Summary

| Area | Finding | Severity | Status | Mitigation |
|---|---|---|---|---|
| Temp-audio safety | No new unsafe delete behavior observed; symlink/non-file safeguards present | low | closed | keep policy tests as required release gate inputs |
| Replay ingestion | Typed parser path with bounds and line-level diagnostics is active | low | closed | retain replay parser regression tests in Phase 2 evidence suite |
| Privacy residual | `RetainOnFailure` intentionally keeps failed temp artifacts (may contain sensitive audio) | medium | open (accepted) | operator hygiene: clear retained temp artifacts after triage; keep retention mode explicit in runbooks |
| Evidence continuity | Historical baseline artifacts are not always retained, limiting some comparative analyses | medium | open | establish durable artifact retention index for benchmark/security postmortems |

## Sign-Off Decision

No new blocker-grade security/privacy regression is identified for the reviewed modernization surfaces.

This lane is approved for integrated closeout with the residual risks above explicitly tracked and operationally mitigated.

## Integration Link

Integrated closeout reference:
- `docs/final-acceptance-closeout-review.md`
