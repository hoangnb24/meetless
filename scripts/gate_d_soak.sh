#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
SOAK_SECONDS="${SOAK_SECONDS:-3600}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
INPUT="${INPUT:-$ROOT/artifacts/bench/corpus/gate_a/tts_phrase.wav}"
OUT_DIR="${OUT_DIR:-}"
LLM_ENDPOINT="${LLM_ENDPOINT:-http://127.0.0.1:9/v1/chat/completions}"
LLM_MODEL="${LLM_MODEL:-dummy}"
LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-80}"
LLM_MAX_QUEUE="${LLM_MAX_QUEUE:-1}"
LLM_RETRIES="${LLM_RETRIES:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seconds)
      SOAK_SECONDS="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --input)
      INPUT="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 [--seconds N] [--out-dir PATH] [--model PATH] [--input PATH]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/bench/gate_d/$STAMP"
fi

mkdir -p "$OUT_DIR/runs"

echo "run_index,start_utc,end_utc,exit_code,real_ms,max_rss_kb,wall_ms_p95,wall_ms_p50,cleanup_dropped_queue_full,cleanup_failed,cleanup_timed_out,mode_requested,mode_active,degradation_events" >"$OUT_DIR/runs.csv"

(
  cd "$ROOT"
  DYLD_LIBRARY_PATH=/usr/lib/swift cargo build --quiet --bin transcribe-live
)
BIN="$ROOT/target/debug/transcribe-live"
if [[ ! -x "$BIN" ]]; then
  echo "missing executable: $BIN" >&2
  exit 1
fi

start_epoch="$(date +%s)"
end_epoch=$((start_epoch + SOAK_SECONDS))
run=0
termination_reason=""

write_status_marker() {
  local status="$1"
  local detail="$2"
  cat >"$OUT_DIR/status.txt" <<EOF
status=$status
detail=$detail
generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

emit_summary_if_possible() {
  if [[ ! -f "$OUT_DIR/runs.csv" ]]; then
    return 0
  fi
  if [[ "$(wc -l <"$OUT_DIR/runs.csv")" -le 1 ]]; then
    return 0
  fi
  python3 "$ROOT/scripts/gate_d_summary.py" \
    --runs-csv "$OUT_DIR/runs.csv" \
    --summary-csv "$OUT_DIR/summary.csv" \
    --target-seconds "$SOAK_SECONDS" >/dev/null 2>&1 || true
}

finalize_soak() {
  local exit_status="$1"
  trap - EXIT INT TERM HUP
  set +e

  if [[ -n "$termination_reason" ]]; then
    write_status_marker "interrupted" "$termination_reason"
  elif [[ "$exit_status" -eq 0 ]]; then
    write_status_marker "completed" "normal_exit"
  else
    write_status_marker "failed" "exit_status=$exit_status"
  fi

  emit_summary_if_possible
  return "$exit_status"
}

trap 'termination_reason="SIGINT"; exit 130' INT
trap 'termination_reason="SIGTERM"; exit 143' TERM
trap 'termination_reason="SIGHUP"; exit 129' HUP
trap 'finalize_soak $?' EXIT

while [[ "$(date +%s)" -lt "$end_epoch" ]]; do
  run=$((run + 1))
  run_id="$(printf "%05d" "$run")"
  base="$OUT_DIR/runs/run_$run_id"
  manifest="$base.manifest.json"
  jsonl="$base.jsonl"
  start_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  set +e
  (
    cd "$ROOT"
    /usr/bin/time -l env DYLD_LIBRARY_PATH=/usr/lib/swift "$BIN" \
      --asr-backend whispercpp \
      --asr-model "$MODEL" \
      --input-wav "$INPUT" \
      --benchmark-runs 1 \
      --transcribe-channels mixed-fallback \
      --llm-cleanup \
      --llm-endpoint "$LLM_ENDPOINT" \
      --llm-model "$LLM_MODEL" \
      --llm-timeout-ms "$LLM_TIMEOUT_MS" \
      --llm-max-queue "$LLM_MAX_QUEUE" \
      --llm-retries "$LLM_RETRIES" \
      --out-jsonl "$jsonl" \
      --out-manifest "$manifest"
  ) >"$base.stdout.log" 2>"$base.time.txt"
  exit_code=$?
  set -e

  end_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  real_ms="$(awk '/real/{printf "%.3f", $1*1000; exit}' "$base.time.txt" || true)"
  max_rss_kb="$(awk '/maximum resident set size/{print $1; exit}' "$base.time.txt" || true)"
  real_ms="${real_ms:-0}"
  max_rss_kb="${max_rss_kb:-0}"

  if [[ -f "$manifest" ]] && jq -e . "$manifest" >/dev/null 2>&1; then
    wall_ms_p95="$(jq -r '.benchmark.wall_ms_p95 // 0' "$manifest" 2>/dev/null || echo 0)"
    wall_ms_p50="$(jq -r '.benchmark.wall_ms_p50 // 0' "$manifest" 2>/dev/null || echo 0)"
    cleanup_dropped_queue_full="$(jq -r '.cleanup_queue.dropped_queue_full // 0' "$manifest" 2>/dev/null || echo 0)"
    cleanup_failed="$(jq -r '.cleanup_queue.failed // 0' "$manifest" 2>/dev/null || echo 0)"
    cleanup_timed_out="$(jq -r '.cleanup_queue.timed_out // 0' "$manifest" 2>/dev/null || echo 0)"
    mode_requested="$(jq -r '.channel_mode_requested // "unknown"' "$manifest" 2>/dev/null || echo unknown)"
    mode_active="$(jq -r '.channel_mode // "unknown"' "$manifest" 2>/dev/null || echo unknown)"
    degradation_events="$(jq -r '(.degradation_events // []) | length' "$manifest" 2>/dev/null || echo 0)"
  else
    wall_ms_p95=0
    wall_ms_p50=0
    cleanup_dropped_queue_full=0
    cleanup_failed=0
    cleanup_timed_out=0
    mode_requested=unknown
    mode_active=unknown
    degradation_events=0
  fi

  echo "$run,$start_utc,$end_utc,$exit_code,$real_ms,$max_rss_kb,$wall_ms_p95,$wall_ms_p50,$cleanup_dropped_queue_full,$cleanup_failed,$cleanup_timed_out,$mode_requested,$mode_active,$degradation_events" >>"$OUT_DIR/runs.csv"
done

echo "GATE_D_OUT=$OUT_DIR"
