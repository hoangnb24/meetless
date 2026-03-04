# bd-qgwp Evidence: Schema-Tolerant Manifest Signal Extraction

Date: 2026-03-04  
Bead: `bd-qgwp`

## Scope Delivered

1. Added canonical extractor helper:
   - `scripts/manifest_signal_extract.py`
2. Wired backlog-pressure summary script to shared extractor:
   - `scripts/gate_backlog_pressure_summary.py`
3. Added regression checks (fixture + null-trust fallback):
   - `tests/test_manifest_signal_extract.py`
4. Added operator runbook usage snippet:
   - `docs/transcribe-operator-runbook.md`

## Why This Change

Ops drills and summaries now use one schema-tolerant extraction path for trust/degradation codes:
- primary source: `trust.notices[].code`
- fallback source: `session_summary.trust_notices.top_codes[]`

This avoids parser fragility across mixed manifest shapes and keeps incident triage scripts deterministic.

## Validation Commands

```bash
python3 -m unittest discover -s tests -p 'test_manifest_signal_extract.py'
python3 scripts/manifest_signal_extract.py --manifest artifacts/validation/bd-1qfx/representative-chunked.runtime.manifest.json
TMP_SUMMARY=$(mktemp) && \
python3 scripts/gate_backlog_pressure_summary.py \
  --manifest artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.manifest.json \
  --jsonl artifacts/bench/gate_backlog_pressure/20260304T034834Z/runtime.jsonl \
  --summary-csv "$TMP_SUMMARY" \
  --min-drop-ratio 0.15 \
  --max-drop-ratio 0.8 \
  --min-lag-p95-ms 240 && \
head -n 15 "$TMP_SUMMARY" && rm -f "$TMP_SUMMARY"
```

All commands passed.

## UBS Scan

```bash
UBS_MAX_DIR_SIZE_MB=5000 ubs \
  scripts/manifest_signal_extract.py \
  scripts/gate_backlog_pressure_summary.py \
  tests/test_manifest_signal_extract.py \
  docs/transcribe-operator-runbook.md \
  docs/ops-simulation-drill-evidence.md
```

Result: no critical findings. One warning was reported by ast-grep on existing JSONL parsing style in `scripts/gate_backlog_pressure_summary.py`; behavior remains guarded by try/except in that parser.
