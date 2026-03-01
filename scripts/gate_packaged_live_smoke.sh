#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
PACKAGED_ROOT="${PACKAGED_ROOT:-$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta}"
OUT_DIR="${OUT_DIR:-}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
DURATION_SEC="${DURATION_SEC:-3}"
CHUNK_WINDOW_MS="${CHUNK_WINDOW_MS:-1800}"
CHUNK_STRIDE_MS="${CHUNK_STRIDE_MS:-300}"
CHUNK_QUEUE_CAP="${CHUNK_QUEUE_CAP:-4}"

usage() {
  cat <<USAGE
Usage: $0 [options]

Runs a signed-app live-stream smoke gate with deterministic fake capture input.
The gate validates two packaged scenarios:
- live-stream model doctor succeeds in the signed app executable
- live-stream runtime emits the expected packaged artifacts and manifest labels

Options:
  --out-dir PATH            Output directory (default: <packaged-root>/gates/gate_packaged_live_smoke/<utc-stamp>)
  --packaged-root PATH      Packaged artifact root (default: ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta)
  --model PATH              ASR model path (default: artifacts/bench/models/whispercpp/ggml-tiny.en.bin)
  --fixture PATH            Deterministic fake-capture fixture (default: artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav)
  --sign-identity VALUE     Codesign identity passed to make sign-transcribe (default: -)
  --duration-sec N          Runtime duration for the smoke scenario (default: 3)
  --chunk-window-ms N       Chunk window for live-stream runtime (default: 1800)
  --chunk-stride-ms N       Chunk stride for live-stream runtime (default: 300)
  --chunk-queue-cap N       Chunk queue cap for live-stream runtime (default: 4)
  -h, --help                Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --packaged-root)
      PACKAGED_ROOT="$2"
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
    --sign-identity)
      SIGN_IDENTITY="$2"
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
  OUT_DIR="$PACKAGED_ROOT/gates/gate_packaged_live_smoke/$STAMP"
fi

ABS_PACKAGED_ROOT="$(python3 - "$PACKAGED_ROOT" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
ABS_OUT_DIR="$(python3 - "$OUT_DIR" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

case "$ABS_OUT_DIR/" in
  "$ABS_PACKAGED_ROOT/"*) ;;
  *)
    echo "error: --out-dir must be inside --packaged-root for signed-app sandbox compatibility" >&2
    echo "       packaged-root: $ABS_PACKAGED_ROOT" >&2
    echo "       out-dir:       $ABS_OUT_DIR" >&2
    exit 2
    ;;
esac

if [[ ! -f "$MODEL" ]]; then
  echo "error: model does not exist: $MODEL" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE" ]]; then
  echo "error: fixture does not exist: $FIXTURE" >&2
  exit 2
fi

DOCTOR_DIR="$OUT_DIR/model_doctor"
RUNTIME_DIR="$OUT_DIR/runtime"
STAGED_INPUT_DIR="$OUT_DIR/staged_inputs"
SHARED_STAGE_DIR="$PACKAGED_ROOT/gates/.shared"
SUMMARY_CSV="$OUT_DIR/summary.csv"
STATUS_TXT="$OUT_DIR/status.txt"

mkdir -p "$DOCTOR_DIR" "$RUNTIME_DIR" "$STAGED_INPUT_DIR" "$SHARED_STAGE_DIR"

STAGED_MODEL="$SHARED_STAGE_DIR/$(basename "$MODEL")"
STAGED_FIXTURE="$STAGED_INPUT_DIR/$(basename "$FIXTURE")"

if [[ ! -f "$STAGED_MODEL" ]]; then
  EXISTING_STAGED_MODEL="$(find "$PACKAGED_ROOT/gates/gate_packaged_live_smoke" -path "*/staged_inputs/$(basename "$MODEL")" -type f -print -quit 2>/dev/null || true)"
  if [[ -n "$EXISTING_STAGED_MODEL" ]]; then
    STAGED_MODEL="$EXISTING_STAGED_MODEL"
  else
    cp "$MODEL" "$STAGED_MODEL"
  fi
fi

cp "$FIXTURE" "$STAGED_FIXTURE"

(
  cd "$ROOT"
  make sign-transcribe SIGN_IDENTITY="$SIGN_IDENTITY" >/dev/null
)

APP_BIN="$ROOT/dist/SequoiaTranscribe.app/Contents/MacOS/SequoiaTranscribe"
if [[ ! -x "$APP_BIN" ]]; then
  echo "error: expected signed app executable not found: $APP_BIN" >&2
  exit 1
fi

DOCTOR_STDOUT="$DOCTOR_DIR/model_doctor.stdout.log"
DOCTOR_TIME="$DOCTOR_DIR/model_doctor.time.txt"
DOCTOR_INPUT_WAV="$DOCTOR_DIR/session.input.wav"
DOCTOR_OUT_WAV="$DOCTOR_DIR/session.wav"
DOCTOR_OUT_JSONL="$DOCTOR_DIR/session.jsonl"
DOCTOR_OUT_MANIFEST="$DOCTOR_DIR/session.manifest.json"

RUNTIME_STDOUT="$RUNTIME_DIR/runtime.stdout.log"
RUNTIME_TIME="$RUNTIME_DIR/runtime.time.txt"
RUNTIME_INPUT_WAV="$RUNTIME_DIR/session.input.wav"
RUNTIME_OUT_WAV="$RUNTIME_DIR/session.wav"
RUNTIME_JSONL="$RUNTIME_DIR/session.jsonl"
RUNTIME_MANIFEST="$RUNTIME_DIR/session.manifest.json"

set +e
(
  cd "$ROOT"
  /usr/bin/time -l "$APP_BIN" \
    --duration-sec "$DURATION_SEC" \
    --live-stream \
    --model-doctor \
    --input-wav "$DOCTOR_INPUT_WAV" \
    --out-wav "$DOCTOR_OUT_WAV" \
    --out-jsonl "$DOCTOR_OUT_JSONL" \
    --out-manifest "$DOCTOR_OUT_MANIFEST" \
    --asr-backend whispercpp \
    --asr-model "$STAGED_MODEL"
) >"$DOCTOR_STDOUT" 2>"$DOCTOR_TIME"
DOCTOR_EXIT_CODE=$?

(
  cd "$ROOT"
  /usr/bin/time -l env RECORDIT_FAKE_CAPTURE_FIXTURE="$STAGED_FIXTURE" "$APP_BIN" \
    --duration-sec "$DURATION_SEC" \
    --live-stream \
    --input-wav "$RUNTIME_INPUT_WAV" \
    --out-wav "$RUNTIME_OUT_WAV" \
    --out-jsonl "$RUNTIME_JSONL" \
    --out-manifest "$RUNTIME_MANIFEST" \
    --asr-backend whispercpp \
    --asr-model "$STAGED_MODEL" \
    --benchmark-runs 1 \
    --transcribe-channels mixed-fallback \
    --chunk-window-ms "$CHUNK_WINDOW_MS" \
    --chunk-stride-ms "$CHUNK_STRIDE_MS" \
    --chunk-queue-cap "$CHUNK_QUEUE_CAP"
) >"$RUNTIME_STDOUT" 2>"$RUNTIME_TIME"
RUNTIME_EXIT_CODE=$?
set -e

python3 "$ROOT/scripts/gate_packaged_live_smoke_summary.py" \
  --doctor-exit-code "$DOCTOR_EXIT_CODE" \
  --doctor-stdout "$DOCTOR_STDOUT" \
  --runtime-exit-code "$RUNTIME_EXIT_CODE" \
  --runtime-stderr "$RUNTIME_TIME" \
  --runtime-input-wav "$RUNTIME_INPUT_WAV" \
  --runtime-manifest "$RUNTIME_MANIFEST" \
  --runtime-jsonl "$RUNTIME_JSONL" \
  --expected-artifact-root "$PACKAGED_ROOT" \
  --summary-csv "$SUMMARY_CSV" >/dev/null

GATE_PASS="$(awk -F, '$1=="gate_pass"{print $2}' "$SUMMARY_CSV" | tail -n 1 | tr -d '\r')"
if [[ "$GATE_PASS" == "true" ]]; then
  status="pass"
  detail="packaged_live_smoke_thresholds_satisfied"
else
  status="failed"
  detail="packaged_live_smoke_thresholds_failed"
fi

cat >"$STATUS_TXT" <<STATUS
status=$status
detail=$detail
summary_path=$SUMMARY_CSV
doctor_stdout_path=$DOCTOR_STDOUT
doctor_time_path=$DOCTOR_TIME
runtime_manifest_path=$RUNTIME_MANIFEST
runtime_jsonl_path=$RUNTIME_JSONL
runtime_stdout_path=$RUNTIME_STDOUT
runtime_time_path=$RUNTIME_TIME
staged_model_path=$STAGED_MODEL
staged_fixture_path=$STAGED_FIXTURE
generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS

echo "GATE_PACKAGED_LIVE_SMOKE_OUT=$OUT_DIR"
if [[ "$GATE_PASS" != "true" ]]; then
  exit 1
fi
