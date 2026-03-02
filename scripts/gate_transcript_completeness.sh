#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
OUT_DIR="${OUT_DIR:-}"
CHUNK_WINDOW_MS="${CHUNK_WINDOW_MS:-1200}"
CHUNK_STRIDE_MS="${CHUNK_STRIDE_MS:-120}"
CHUNK_QUEUE_CAP="${CHUNK_QUEUE_CAP:-2}"
MIN_COMPLETENESS_GAIN="${MIN_COMPLETENESS_GAIN:-0.25}"
MIN_POST_COMPLETENESS="${MIN_POST_COMPLETENESS:-0.95}"
MAX_PRE_COMPLETENESS="${MAX_PRE_COMPLETENESS:-0.80}"

usage() {
  echo "Usage: $0 [options]"
  cat <<'USAGE'
Runs a transcript-completeness gate under intentionally induced near-live backlog.
The gate reuses the deterministic backlog-pressure scenario, then compares replay
readability before/after reconciliation (`reconciled_final` events) when
reconciliation is applied, or validates parity when the run stayed buffered.

Options:
  --out-dir PATH                 Output directory (default: artifacts/bench/gate_transcript_completeness/<utc-stamp>)
  --model PATH                   ASR model path (default: artifacts/bench/models/whispercpp/ggml-tiny.en.bin)
  --fixture PATH                 Deterministic stereo fixture (default: artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav)
  --chunk-window-ms N            Near-live chunk window (default: 1200)
  --chunk-stride-ms N            Near-live chunk stride (default: 120)
  --chunk-queue-cap N            Near-live queue cap (default: 2)
  --min-completeness-gain F      Minimum post-pre completeness gain (default: 0.25)
  --min-post-completeness F      Minimum post-reconciliation completeness (default: 0.95)
  --max-pre-completeness F       Maximum allowed pre-reconciliation completeness (default: 0.80)
  -h, --help                     Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --fixture)
      FIXTURE="$2"
      shift 2
      ;;
    --chunk-window-ms)
      CHUNK_WINDOW_MS="$2"
      shift 2
      ;;
    --chunk-stride-ms)
      CHUNK_STRIDE_MS="$2"
      shift 2
      ;;
    --chunk-queue-cap)
      CHUNK_QUEUE_CAP="$2"
      shift 2
      ;;
    --min-completeness-gain)
      MIN_COMPLETENESS_GAIN="$2"
      shift 2
      ;;
    --min-post-completeness)
      MIN_POST_COMPLETENESS="$2"
      shift 2
      ;;
    --max-pre-completeness)
      MAX_PRE_COMPLETENESS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 2
fi

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/bench/gate_transcript_completeness/$STAMP"
fi
mkdir -p "$OUT_DIR"

BACKLOG_OUT="$OUT_DIR/backlog_pressure"
BACKLOG_SUMMARY="$BACKLOG_OUT/summary.csv"
PRE_JSONL="$OUT_DIR/pre_reconciliation.jsonl"
PRE_REPLAY="$OUT_DIR/pre_replay.txt"
POST_REPLAY="$OUT_DIR/post_replay.txt"
SUMMARY_CSV="$OUT_DIR/summary.csv"
STATUS_TXT="$OUT_DIR/status.txt"

"$ROOT/scripts/gate_backlog_pressure.sh" \
  --out-dir "$BACKLOG_OUT" \
  --model "$MODEL" \
  --fixture "$FIXTURE" \
  --chunk-window-ms "$CHUNK_WINDOW_MS" \
  --chunk-stride-ms "$CHUNK_STRIDE_MS" \
  --chunk-queue-cap "$CHUNK_QUEUE_CAP"

if [[ ! -f "$BACKLOG_OUT/runtime.jsonl" ]]; then
  echo "error: expected runtime jsonl missing: $BACKLOG_OUT/runtime.jsonl" >&2
  exit 1
fi

grep -v '"event_type":"reconciled_final"' "$BACKLOG_OUT/runtime.jsonl" >"$PRE_JSONL"

(
  cd "$ROOT"
  DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live --replay-jsonl "$PRE_JSONL"
) >"$PRE_REPLAY"
(
  cd "$ROOT"
  DYLD_LIBRARY_PATH=/usr/lib/swift target/debug/transcribe-live --replay-jsonl "$BACKLOG_OUT/runtime.jsonl"
) >"$POST_REPLAY"

python3 "$ROOT/scripts/gate_transcript_completeness_summary.py" \
  --runtime-jsonl "$BACKLOG_OUT/runtime.jsonl" \
  --backlog-summary-csv "$BACKLOG_SUMMARY" \
  --pre-replay "$PRE_REPLAY" \
  --post-replay "$POST_REPLAY" \
  --summary-csv "$SUMMARY_CSV" \
  --min-completeness-gain "$MIN_COMPLETENESS_GAIN" \
  --min-post-completeness "$MIN_POST_COMPLETENESS" \
  --max-pre-completeness "$MAX_PRE_COMPLETENESS" >/dev/null

GATE_PASS="$(awk -F, '$1=="gate_pass"{print $2}' "$SUMMARY_CSV" | tail -n 1 | tr -d '\r')"
if [[ "$GATE_PASS" == "true" ]]; then
  status="pass"
  detail="transcript_completeness_thresholds_satisfied"
else
  status="failed"
  detail="transcript_completeness_thresholds_failed"
fi

cat >"$STATUS_TXT" <<STATUS
status=$status
detail=$detail
summary_path=$SUMMARY_CSV
backlog_dir=$BACKLOG_OUT
pre_replay_path=$PRE_REPLAY
post_replay_path=$POST_REPLAY
generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS

echo "GATE_TRANSCRIPT_COMPLETENESS_OUT=$OUT_DIR"
if [[ "$GATE_PASS" != "true" ]]; then
  exit 1
fi
