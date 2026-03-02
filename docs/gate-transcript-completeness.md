# Gate: Transcript Completeness Under Backlog Pressure

This gate validates transcript completeness under intentionally induced near-live
backlog pressure with profile-aware semantics.

It reuses the deterministic backlog-pressure scenario (`gate_backlog_pressure.sh`),
then compares replay readability:

- **pre-reconciliation**: `reconciled_final` events removed
- **post-reconciliation**: full runtime JSONL

For `pressure_profile=buffered-no-drop`, those two replay surfaces are expected to
remain equivalent because no reconciliation path was needed.

## Run

```bash
scripts/gate_transcript_completeness.sh
```

Optional tuning:

```bash
scripts/gate_transcript_completeness.sh \
  --chunk-window-ms 1200 \
  --chunk-stride-ms 120 \
  --chunk-queue-cap 2 \
  --min-completeness-gain 0.25 \
  --min-post-completeness 0.95 \
  --max-pre-completeness 0.80
```

Artifacts are written to:

- `artifacts/bench/gate_transcript_completeness/<timestamp>/backlog_pressure/`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/pre_replay.txt`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/post_replay.txt`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/summary.csv`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/status.txt`

## Acceptance Bar

The gate passes only if all threshold rows in `summary.csv` are true.

Common checks:

1. `pressure_profile` is known (`drop-path` or `buffered-no-drop`)
2. replay output includes per-channel sections
3. runtime JSONL includes `chunk_queue` evidence rows

Profile-specific checks:

4. `pressure_profile=drop-path`
   - reconciliation artifacts exist (`reconciled_final` present)
   - backlog drop is confirmed (`chunk_queue.dropped_oldest > 0`)
   - reconciliation signaling is explicit (`reconciliation_applied` trust + `reconciliation_applied_after_backpressure` degradation)
   - completeness gain remains meaningful:
     - `post_completeness - pre_completeness >= min_completeness_gain`
     - `post_completeness >= min_post_completeness`
     - `pre_completeness <= max_pre_completeness`
5. `pressure_profile=buffered-no-drop`
   - trust/degradation reconciliation signals remain absent (no false positive reconciliation alarms)
   - completeness remains high without reconciliation:
     - `pre_completeness >= min_post_completeness`
     - `post_completeness >= min_post_completeness`
     - `post_completeness` does not regress vs `pre_completeness`

Canonical token source is profile-aware:

- `drop-path`: `reconciled_final`
- `buffered-no-drop`: stable final transcript events (`final`/`llm_final`/`reconciled_final`)
