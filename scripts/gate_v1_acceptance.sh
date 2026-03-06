#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
OUT_DIR="${OUT_DIR:-}"
RECORDIT_BUNDLE_CONFIGURATION="${RECORDIT_XCODE_CONFIGURATION:-Release}"
DURATION_SEC="${DURATION_SEC:-3}"
CHUNK_WINDOW_MS="${CHUNK_WINDOW_MS:-2000}"
CHUNK_STRIDE_MS="${CHUNK_STRIDE_MS:-500}"
CHUNK_QUEUE_CAP="${CHUNK_QUEUE_CAP:-4}"
RECORDIT_HANDOFF_INJECT_FAILURE="${RECORDIT_HANDOFF_INJECT_FAILURE:-}"

bool_text() {
  if [[ "$1" -eq 1 ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

usage() {
  cat <<USAGE
Usage: $0 [options]

Runs deterministic v1 acceptance checks for true live-stream runtime behavior:
- cold start first stable transcript emission during active runtime
- warm start first stable transcript emission during active runtime
- artifact truth checks for cold/warm runs
- non-blocking/degradation/trust checks via gate_backlog_pressure

Options:
  --out-dir PATH            Output directory (default: artifacts/bench/gate_v1_acceptance/<utc-stamp>)
  --model PATH              ASR model path (default: artifacts/bench/models/whispercpp/ggml-tiny.en.bin)
  --fixture PATH            Deterministic stereo fixture (default: artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav)
  --duration-sec N          Duration for cold/warm runs (default: 3)
  --chunk-window-ms N       Cold/warm live-stream chunk window (default: 2000)
  --chunk-stride-ms N       Cold/warm live-stream chunk stride (default: 500)
  --chunk-queue-cap N       Cold/warm live-stream queue cap (default: 4)
  -h, --help                Show this help text

Environment:
  RECORDIT_XCODE_CONFIGURATION  Configuration used for prebuilt handoff/embed probe (default: Release)
  RECORDIT_HANDOFF_INJECT_FAILURE  Optional seam failure injection for validation. Supported values: runtime_prepare_missing_manifest, runtime_prepare_missing_handoff_env, artifact_compare_manifest, artifact_compare_recordit, artifact_compare_capture, artifact_compare_model, manifest_parity_recordit
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
    --duration-sec)
      DURATION_SEC="$2"
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
  OUT_DIR="$ROOT/artifacts/bench/gate_v1_acceptance/$STAMP"
fi

if [[ ! -f "$MODEL" ]]; then
  echo "error: model does not exist: $MODEL" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE" ]]; then
  echo "error: fixture does not exist: $FIXTURE" >&2
  exit 2
fi

LOG_DIR="$OUT_DIR/logs"
SUMMARY_JSON="$OUT_DIR/summary.json"
STATUS_JSON="$OUT_DIR/status.json"
METADATA_JSON="$OUT_DIR/metadata.json"
BUILD_LOG="$LOG_DIR/build_transcribe_live.log"
BACKLOG_STDOUT_LOG="$LOG_DIR/backlog_pressure.stdout.log"
BACKLOG_STDERR_LOG="$LOG_DIR/backlog_pressure.stderr.log"
PREBUILT_RUNTIME_INPUT_DIR="$OUT_DIR/prebuilt_runtime_inputs"
COPY_ONLY_EMBED_ROOT="$OUT_DIR/copy_only_embed_probe"
COPY_ONLY_RUNTIME_ROOT="$COPY_ONLY_EMBED_ROOT/Contents/Resources/runtime"
PREBUILT_RUNTIME_PREPARE_LOG="$LOG_DIR/prebuilt_runtime_prepare.log"
PREBUILT_RUNTIME_HANDOFF_ENV="$PREBUILT_RUNTIME_INPUT_DIR/runtime_handoff.env"
PREBUILT_RUNTIME_MANIFEST="$PREBUILT_RUNTIME_INPUT_DIR/runtime/artifact-manifest.json"
COPY_ONLY_EMBED_LOG="$LOG_DIR/copy_only_embed.log"
COPY_ONLY_EMBED_COMPARE_LOG="$LOG_DIR/copy_only_embed_compare.log"
COPY_ONLY_EMBED_PARITY_LOG="$LOG_DIR/copy_only_embed_parity.log"

mkdir -p "$OUT_DIR/cold" "$OUT_DIR/warm" "$LOG_DIR" "$PREBUILT_RUNTIME_INPUT_DIR"

PREBUILT_RUNTIME_PREPARE_OK=0
PREBUILT_RUNTIME_MANIFEST_PRESENT=0
PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT=0
COPY_ONLY_EMBED_OK=0
COPY_ONLY_EMBED_MANIFEST_MATCH=0
COPY_ONLY_EMBED_RECORDIT_MATCH=0
COPY_ONLY_EMBED_CAPTURE_MATCH=0
COPY_ONLY_EMBED_MODEL_MATCH=0
COPY_ONLY_EMBED_PARITY_OK=0
HANDOFF_INTEGRATION_OK=0
HANDOFF_FAILURE_STAGE="pending"
HANDOFF_FAILURE_DETAIL="pending"

set +e
(
  cd "$ROOT"
  env \
    RECORDIT_RUNTIME_CONFIGURATION="$RECORDIT_BUNDLE_CONFIGURATION" \
    RECORDIT_RUNTIME_INPUT_DIR="$PREBUILT_RUNTIME_INPUT_DIR" \
    RECORDIT_DEFAULT_WHISPERCPP_MODEL="$MODEL" \
    "$ROOT/scripts/prepare_recordit_runtime_inputs.sh"
) >"$PREBUILT_RUNTIME_PREPARE_LOG" 2>&1
PREBUILT_RUNTIME_PREPARE_EXIT_CODE=$?
set -e
if [[ "$PREBUILT_RUNTIME_PREPARE_EXIT_CODE" -eq 0 ]]; then
  PREBUILT_RUNTIME_PREPARE_OK=1
fi
if [[ -f "$PREBUILT_RUNTIME_MANIFEST" ]]; then
  PREBUILT_RUNTIME_MANIFEST_PRESENT=1
fi
if [[ -f "$PREBUILT_RUNTIME_HANDOFF_ENV" ]]; then
  PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT=1
fi

case "$RECORDIT_HANDOFF_INJECT_FAILURE" in
  ""|artifact_compare_manifest|artifact_compare_recordit|artifact_compare_capture|artifact_compare_model|manifest_parity_recordit|runtime_prepare_missing_manifest|runtime_prepare_missing_handoff_env)
    ;;
  *)
    echo "error: unsupported RECORDIT_HANDOFF_INJECT_FAILURE value: $RECORDIT_HANDOFF_INJECT_FAILURE" >&2
    exit 2
    ;;
esac

if [[ "$RECORDIT_HANDOFF_INJECT_FAILURE" == "runtime_prepare_missing_manifest" ]]; then
  rm -f "$PREBUILT_RUNTIME_MANIFEST"
  PREBUILT_RUNTIME_MANIFEST_PRESENT=0
fi
if [[ "$RECORDIT_HANDOFF_INJECT_FAILURE" == "runtime_prepare_missing_handoff_env" ]]; then
  rm -f "$PREBUILT_RUNTIME_HANDOFF_ENV"
  PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT=0
fi

rm -rf "$COPY_ONLY_EMBED_ROOT"
mkdir -p "$COPY_ONLY_EMBED_ROOT"
set +e
(
  cd "$ROOT"
  env \
    RECORDIT_RUNTIME_INPUT_DIR="$PREBUILT_RUNTIME_INPUT_DIR" \
    TARGET_BUILD_DIR="$COPY_ONLY_EMBED_ROOT" \
    UNLOCALIZED_RESOURCES_FOLDER_PATH="Contents/Resources" \
    CONFIGURATION="$RECORDIT_BUNDLE_CONFIGURATION" \
    CARGO_BIN=/__bd_3jd2_copy_only_probe_should_not_use_cargo__ \
    "$ROOT/scripts/embed_recordit_runtime_binaries.sh"
) >"$COPY_ONLY_EMBED_LOG" 2>&1
COPY_ONLY_EMBED_EXIT_CODE=$?
set -e
if [[ "$COPY_ONLY_EMBED_EXIT_CODE" -eq 0 ]]; then
  COPY_ONLY_EMBED_OK=1
fi

: >"$COPY_ONLY_EMBED_PARITY_LOG"
if [[ "$COPY_ONLY_EMBED_OK" -eq 1 ]]; then
  case "$RECORDIT_HANDOFF_INJECT_FAILURE" in
    artifact_compare_manifest)
      python3 - "$COPY_ONLY_RUNTIME_ROOT/artifact-manifest.json" <<'PY_INJECT_MANIFEST'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
with path.open(encoding="utf-8") as handle:
    data = json.load(handle)
if isinstance(data.get("entries"), list) and data["entries"]:
    data["entries"][0]["sha256"] = "0" * 64
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY_INJECT_MANIFEST
      ;;
    artifact_compare_recordit)
      printf "__bd_3jd2_artifact_compare_recordit__\n" >>"$COPY_ONLY_RUNTIME_ROOT/bin/recordit"
      ;;
    artifact_compare_capture)
      printf "__bd_3jd2_artifact_compare_capture__\n" >>"$COPY_ONLY_RUNTIME_ROOT/bin/sequoia_capture"
      ;;
    artifact_compare_model)
      printf "__bd_3jd2_artifact_compare_model__\n" >>"$COPY_ONLY_RUNTIME_ROOT/models/whispercpp/ggml-tiny.en.bin"
      ;;
  esac
  if [[ -f "$PREBUILT_RUNTIME_MANIFEST" && -f "$COPY_ONLY_RUNTIME_ROOT/artifact-manifest.json" ]] && cmp -s "$PREBUILT_RUNTIME_MANIFEST" "$COPY_ONLY_RUNTIME_ROOT/artifact-manifest.json"; then
    COPY_ONLY_EMBED_MANIFEST_MATCH=1
  fi

  if [[ -f "$PREBUILT_RUNTIME_INPUT_DIR/runtime/bin/recordit" && -f "$COPY_ONLY_RUNTIME_ROOT/bin/recordit" ]] && cmp -s "$PREBUILT_RUNTIME_INPUT_DIR/runtime/bin/recordit" "$COPY_ONLY_RUNTIME_ROOT/bin/recordit"; then
    COPY_ONLY_EMBED_RECORDIT_MATCH=1
  fi

  if [[ -f "$PREBUILT_RUNTIME_INPUT_DIR/runtime/bin/sequoia_capture" && -f "$COPY_ONLY_RUNTIME_ROOT/bin/sequoia_capture" ]] && cmp -s "$PREBUILT_RUNTIME_INPUT_DIR/runtime/bin/sequoia_capture" "$COPY_ONLY_RUNTIME_ROOT/bin/sequoia_capture"; then
    COPY_ONLY_EMBED_CAPTURE_MATCH=1
  fi

  if [[ -f "$PREBUILT_RUNTIME_INPUT_DIR/runtime/models/whispercpp/ggml-tiny.en.bin" && -f "$COPY_ONLY_RUNTIME_ROOT/models/whispercpp/ggml-tiny.en.bin" ]] && cmp -s "$PREBUILT_RUNTIME_INPUT_DIR/runtime/models/whispercpp/ggml-tiny.en.bin" "$COPY_ONLY_RUNTIME_ROOT/models/whispercpp/ggml-tiny.en.bin"; then
    COPY_ONLY_EMBED_MODEL_MATCH=1
  fi

  if [[ "$RECORDIT_HANDOFF_INJECT_FAILURE" == "manifest_parity_recordit" ]]; then
    printf "__bd_3jd2_manifest_parity_recordit__\n" >>"$COPY_ONLY_RUNTIME_ROOT/bin/recordit"
  fi

  set +e
  python3 - "$COPY_ONLY_RUNTIME_ROOT/artifact-manifest.json" "$COPY_ONLY_RUNTIME_ROOT/bin/recordit" "$COPY_ONLY_RUNTIME_ROOT/bin/sequoia_capture" "$COPY_ONLY_RUNTIME_ROOT/models/whispercpp/ggml-tiny.en.bin" <<'PY_PARITY' >"$COPY_ONLY_EMBED_PARITY_LOG" 2>&1
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
actual_paths = {
    'recordit': Path(sys.argv[2]),
    'sequoia_capture': Path(sys.argv[3]),
    'whispercpp_default_model': Path(sys.argv[4]),
}

with manifest_path.open(encoding='utf-8') as handle:
    manifest = json.load(handle)

entries = manifest.get('entries')
if not isinstance(entries, list) or not entries:
    raise SystemExit(f'invalid or empty runtime artifact manifest: {manifest_path}')

expected = {}
for row in entries:
    if not isinstance(row, dict):
        raise SystemExit('runtime artifact manifest row must be an object')
    logical_name = str(row.get('logical_name', '')).strip()
    relative_path = str(row.get('path', '')).strip()
    sha256 = str(row.get('sha256', '')).strip()
    if not logical_name or not relative_path or not sha256:
        raise SystemExit(f'incomplete runtime artifact manifest row: {row!r}')
    if logical_name in expected:
        raise SystemExit(f'duplicate runtime artifact manifest row for {logical_name}')
    expected[logical_name] = (relative_path, sha256)

missing = sorted(set(actual_paths) - set(expected))
if missing:
    raise SystemExit(f'manifest missing expected artifact rows: {missing}')

unexpected = sorted(set(expected) - set(actual_paths))
if unexpected:
    raise SystemExit(f'manifest contains unexpected artifact rows: {unexpected}')

bundle_root = manifest_path.parent
for logical_name, actual_path in actual_paths.items():
    if not actual_path.is_file():
        raise SystemExit(f'missing actual artifact for {logical_name}: {actual_path}')
    relative_path, expected_sha = expected[logical_name]
    resolved = (bundle_root / relative_path).resolve()
    if resolved != actual_path.resolve():
        raise SystemExit(
            f'manifest path mismatch for {logical_name}: expected {resolved}, actual {actual_path.resolve()}'
        )
    sha = hashlib.sha256()
    with actual_path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            sha.update(chunk)
    actual_sha = sha.hexdigest()
    if actual_sha != expected_sha:
        raise SystemExit(
            f'sha256 mismatch for {logical_name}: manifest={expected_sha} actual={actual_sha}'
        )

print(f'validated {len(actual_paths)} runtime artifacts against {manifest_path}')
PY_PARITY
  COPY_ONLY_EMBED_PARITY_EXIT_CODE=$?
  set -e
  if [[ "$COPY_ONLY_EMBED_PARITY_EXIT_CODE" -eq 0 ]]; then
    COPY_ONLY_EMBED_PARITY_OK=1
  fi
else
  echo "copy_only_manifest_parity_ok=false" >"$COPY_ONLY_EMBED_PARITY_LOG"
fi

cat >"$COPY_ONLY_EMBED_COMPARE_LOG" <<COMPARE
manifest_copy_match=$(bool_text "$COPY_ONLY_EMBED_MANIFEST_MATCH")
recordit_copy_match=$(bool_text "$COPY_ONLY_EMBED_RECORDIT_MATCH")
capture_copy_match=$(bool_text "$COPY_ONLY_EMBED_CAPTURE_MATCH")
model_copy_match=$(bool_text "$COPY_ONLY_EMBED_MODEL_MATCH")
COMPARE

if [[ "$PREBUILT_RUNTIME_PREPARE_OK" -eq 1 && "$PREBUILT_RUNTIME_MANIFEST_PRESENT" -eq 1 && "$PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT" -eq 1 && "$COPY_ONLY_EMBED_OK" -eq 1 && "$COPY_ONLY_EMBED_MANIFEST_MATCH" -eq 1 && "$COPY_ONLY_EMBED_RECORDIT_MATCH" -eq 1 && "$COPY_ONLY_EMBED_CAPTURE_MATCH" -eq 1 && "$COPY_ONLY_EMBED_MODEL_MATCH" -eq 1 && "$COPY_ONLY_EMBED_PARITY_OK" -eq 1 ]]; then
  HANDOFF_INTEGRATION_OK=1
  HANDOFF_FAILURE_STAGE="none"
  HANDOFF_FAILURE_DETAIL="none"
elif [[ "$PREBUILT_RUNTIME_PREPARE_OK" -ne 1 ]]; then
  HANDOFF_FAILURE_STAGE="runtime_prepare"
  HANDOFF_FAILURE_DETAIL="prepare_script_exit_${PREBUILT_RUNTIME_PREPARE_EXIT_CODE}"
elif [[ "$PREBUILT_RUNTIME_MANIFEST_PRESENT" -ne 1 || "$PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT" -ne 1 ]]; then
  HANDOFF_FAILURE_STAGE="runtime_prepare_artifacts"
  if [[ "$PREBUILT_RUNTIME_MANIFEST_PRESENT" -ne 1 && "$PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT" -ne 1 ]]; then
    HANDOFF_FAILURE_DETAIL="missing_manifest_and_handoff_env"
  elif [[ "$PREBUILT_RUNTIME_MANIFEST_PRESENT" -ne 1 ]]; then
    HANDOFF_FAILURE_DETAIL="missing_manifest"
  else
    HANDOFF_FAILURE_DETAIL="missing_handoff_env"
  fi
elif [[ "$COPY_ONLY_EMBED_OK" -ne 1 ]]; then
  HANDOFF_FAILURE_STAGE="bundle_copy_assembly"
  HANDOFF_FAILURE_DETAIL="embed_script_exit_${COPY_ONLY_EMBED_EXIT_CODE}"
elif [[ "$COPY_ONLY_EMBED_MANIFEST_MATCH" -ne 1 || "$COPY_ONLY_EMBED_RECORDIT_MATCH" -ne 1 || "$COPY_ONLY_EMBED_CAPTURE_MATCH" -ne 1 || "$COPY_ONLY_EMBED_MODEL_MATCH" -ne 1 ]]; then
  HANDOFF_FAILURE_STAGE="artifact_compare"
  mismatch_fields=()
  [[ "$COPY_ONLY_EMBED_MANIFEST_MATCH" -ne 1 ]] && mismatch_fields+=(manifest)
  [[ "$COPY_ONLY_EMBED_RECORDIT_MATCH" -ne 1 ]] && mismatch_fields+=(recordit)
  [[ "$COPY_ONLY_EMBED_CAPTURE_MATCH" -ne 1 ]] && mismatch_fields+=(sequoia_capture)
  [[ "$COPY_ONLY_EMBED_MODEL_MATCH" -ne 1 ]] && mismatch_fields+=(default_model)
  IFS=, HANDOFF_FAILURE_DETAIL="mismatch:${mismatch_fields[*]}"
  unset IFS
elif [[ "$COPY_ONLY_EMBED_PARITY_OK" -ne 1 ]]; then
  HANDOFF_FAILURE_STAGE="manifest_parity"
  HANDOFF_FAILURE_DETAIL="manifest_parity_check_failed"
else
  HANDOFF_FAILURE_STAGE="unknown"
  HANDOFF_FAILURE_DETAIL="unclassified_handoff_failure"
fi

(
  cd "$ROOT"
  {
    echo "[gate-v1-acceptance] generated_at_utc=$(evidence_timestamp)"
    echo "[gate-v1-acceptance] cmd=DYLD_LIBRARY_PATH=/usr/lib/swift cargo build --quiet --bin transcribe-live"
    DYLD_LIBRARY_PATH=/usr/lib/swift cargo build --quiet --bin transcribe-live
  } >"$BUILD_LOG" 2>&1
)

BIN="$ROOT/target/debug/transcribe-live"
if [[ ! -x "$BIN" ]]; then
  echo "error: expected executable not found: $BIN" >&2
  exit 1
fi

run_live_case() {
  local case_name="$1"
  local case_dir="$OUT_DIR/$case_name"
  local input_wav="$case_dir/input.wav"
  local out_wav="$case_dir/session.wav"
  local out_jsonl="$case_dir/runtime.jsonl"
  local out_manifest="$case_dir/runtime.manifest.json"
  local stdout_log="$LOG_DIR/${case_name}.runtime.stdout.log"
  local time_log="$LOG_DIR/${case_name}.runtime.time.txt"

  mkdir -p "$case_dir"

  set +e
  (
    cd "$ROOT"
    /usr/bin/time -l env DYLD_LIBRARY_PATH=/usr/lib/swift RECORDIT_FAKE_CAPTURE_FIXTURE="$FIXTURE" "$BIN" \
      --duration-sec "$DURATION_SEC" \
      --live-stream \
      --input-wav "$input_wav" \
      --out-wav "$out_wav" \
      --out-jsonl "$out_jsonl" \
      --out-manifest "$out_manifest" \
      --asr-backend whispercpp \
      --asr-model "$MODEL" \
      --benchmark-runs 1 \
      --transcribe-channels mixed-fallback \
      --chunk-window-ms "$CHUNK_WINDOW_MS" \
      --chunk-stride-ms "$CHUNK_STRIDE_MS" \
      --chunk-queue-cap "$CHUNK_QUEUE_CAP"
  ) >"$stdout_log" 2>"$time_log"
  local exit_code=$?
  set -e

  if [[ "$exit_code" -ne 0 ]]; then
    echo "error: $case_name live run failed with exit code $exit_code" >&2
    echo "see: $stdout_log and $time_log" >&2
    exit "$exit_code"
  fi
}

run_live_case cold
run_live_case warm

BACKLOG_DIR="$OUT_DIR/backlog_pressure"
set +e
"$ROOT/scripts/gate_backlog_pressure.sh" \
  --out-dir "$BACKLOG_DIR" \
  --model "$MODEL" \
  --fixture "$FIXTURE" >"$BACKLOG_STDOUT_LOG" 2>"$BACKLOG_STDERR_LOG"
BACKLOG_EXIT_CODE=$?
set -e
if [[ "$BACKLOG_EXIT_CODE" -ne 0 ]]; then
  echo "error: backlog pressure gate failed with exit code $BACKLOG_EXIT_CODE" >&2
  echo "see: $BACKLOG_STDOUT_LOG and $BACKLOG_STDERR_LOG" >&2
  exit "$BACKLOG_EXIT_CODE"
fi

SUMMARY_CSV="$OUT_DIR/summary.csv"
STATUS_TXT="$OUT_DIR/status.txt"
evidence_write_metadata_json "$METADATA_JSON" "gate_v1_acceptance" "gate_v1_acceptance" "$OUT_DIR" "$LOG_DIR" "$OUT_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" "$STATUS_JSON"

python3 "$ROOT/scripts/gate_v1_acceptance_summary.py" \
  --cold-manifest "$OUT_DIR/cold/runtime.manifest.json" \
  --cold-jsonl "$OUT_DIR/cold/runtime.jsonl" \
  --warm-manifest "$OUT_DIR/warm/runtime.manifest.json" \
  --warm-jsonl "$OUT_DIR/warm/runtime.jsonl" \
  --backlog-manifest "$BACKLOG_DIR/runtime.manifest.json" \
  --backlog-summary "$BACKLOG_DIR/summary.csv" \
  --summary-csv "$SUMMARY_CSV" >/dev/null

BASE_GATE_PASS="$(awk -F, '$1=="gate_pass"{print $2}' "$SUMMARY_CSV" | tail -n 1 | tr -d '\r')"
python3 - "$SUMMARY_CSV" <<'PY_REWRITE_GATE_PASS'
import csv
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
rows = []
renamed = False
with summary_path.open(newline='', encoding='utf-8') as handle:
    reader = csv.reader(handle)
    rows = list(reader)

for row in rows:
    if row and row[0] == 'gate_pass':
        row[0] = 'base_gate_pass'
        renamed = True
        break

if not renamed:
    raise SystemExit(f'expected gate_pass row in {summary_path}')

with summary_path.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.writer(handle)
    writer.writerows(rows)
PY_REWRITE_GATE_PASS
{
  printf 'prebuilt_runtime_prepare_exit_code,%s\n' "$PREBUILT_RUNTIME_PREPARE_EXIT_CODE"
  printf 'prebuilt_runtime_prepare_ok,%s\n' "$(bool_text "$PREBUILT_RUNTIME_PREPARE_OK")"
  printf 'prebuilt_runtime_manifest_present,%s\n' "$(bool_text "$PREBUILT_RUNTIME_MANIFEST_PRESENT")"
  printf 'prebuilt_runtime_handoff_env_present,%s\n' "$(bool_text "$PREBUILT_RUNTIME_HANDOFF_ENV_PRESENT")"
  printf 'copy_only_embed_exit_code,%s\n' "$COPY_ONLY_EMBED_EXIT_CODE"
  printf 'copy_only_embed_ok,%s\n' "$(bool_text "$COPY_ONLY_EMBED_OK")"
  printf 'copy_only_embed_manifest_match,%s\n' "$(bool_text "$COPY_ONLY_EMBED_MANIFEST_MATCH")"
  printf 'copy_only_embed_recordit_match,%s\n' "$(bool_text "$COPY_ONLY_EMBED_RECORDIT_MATCH")"
  printf 'copy_only_embed_capture_match,%s\n' "$(bool_text "$COPY_ONLY_EMBED_CAPTURE_MATCH")"
  printf 'copy_only_embed_model_match,%s\n' "$(bool_text "$COPY_ONLY_EMBED_MODEL_MATCH")"
  printf 'copy_only_embed_manifest_parity_ok,%s\n' "$(bool_text "$COPY_ONLY_EMBED_PARITY_OK")"
  printf 'handoff_integration_ok,%s\n' "$(bool_text "$HANDOFF_INTEGRATION_OK")"
  printf 'handoff_failure_stage,%s\n' "$HANDOFF_FAILURE_STAGE"
  printf 'handoff_failure_detail,%s\n' "$HANDOFF_FAILURE_DETAIL"
  printf 'handoff_inject_failure,%s\n' "$RECORDIT_HANDOFF_INJECT_FAILURE"
} >>"$SUMMARY_CSV"

if [[ "$BASE_GATE_PASS" == "true" && "$HANDOFF_INTEGRATION_OK" -eq 1 ]]; then
  GATE_PASS="true"
  status="pass"
  detail="v1_acceptance_and_handoff_thresholds_satisfied"
else
  GATE_PASS="false"
  status="failed"
  detail="v1_acceptance_or_handoff_thresholds_failed"
fi
printf 'gate_pass,%s\n' "$GATE_PASS" >>"$SUMMARY_CSV"

evidence_csv_kv_to_json "$SUMMARY_CSV" "$SUMMARY_JSON"

cat >"$STATUS_TXT" <<STATUS
status=$status
detail=$detail
summary_path=$SUMMARY_CSV
summary_json=$SUMMARY_JSON
status_json=$STATUS_JSON
metadata_json=$METADATA_JSON
logs_dir=$LOG_DIR
build_log=$BUILD_LOG
cold_dir=$OUT_DIR/cold
warm_dir=$OUT_DIR/warm
backlog_dir=$BACKLOG_DIR
backlog_stdout_log=$BACKLOG_STDOUT_LOG
backlog_stderr_log=$BACKLOG_STDERR_LOG
recordit_bundle_configuration=$RECORDIT_BUNDLE_CONFIGURATION
recordit_default_whisper_model=$MODEL
prebuilt_runtime_input_dir=$PREBUILT_RUNTIME_INPUT_DIR
prebuilt_runtime_prepare_log=$PREBUILT_RUNTIME_PREPARE_LOG
prebuilt_runtime_handoff_env=$PREBUILT_RUNTIME_HANDOFF_ENV
prebuilt_runtime_manifest=$PREBUILT_RUNTIME_MANIFEST
copy_only_embed_root=$COPY_ONLY_EMBED_ROOT
copy_only_embed_log=$COPY_ONLY_EMBED_LOG
copy_only_embed_compare_log=$COPY_ONLY_EMBED_COMPARE_LOG
copy_only_embed_parity_log=$COPY_ONLY_EMBED_PARITY_LOG
handoff_failure_stage=$HANDOFF_FAILURE_STAGE
handoff_failure_detail=$HANDOFF_FAILURE_DETAIL
handoff_inject_failure=$RECORDIT_HANDOFF_INJECT_FAILURE
generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS

evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"

echo "GATE_V1_ACCEPTANCE_OUT=$OUT_DIR"
echo "GATE_V1_ACCEPTANCE_SUMMARY_JSON=$SUMMARY_JSON"
echo "GATE_V1_ACCEPTANCE_STATUS_JSON=$STATUS_JSON"
if [[ "$GATE_PASS" != "true" ]]; then
  exit 1
fi
