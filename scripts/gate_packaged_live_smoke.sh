#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
PACKAGED_ROOT="${PACKAGED_ROOT:-$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta}"
OUT_DIR="${OUT_DIR:-}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
DURATION_SEC="${DURATION_SEC:-3}"
CHUNK_WINDOW_MS="${CHUNK_WINDOW_MS:-1800}"
CHUNK_STRIDE_MS="${CHUNK_STRIDE_MS:-300}"
CHUNK_QUEUE_CAP="${CHUNK_QUEUE_CAP:-4}"
RECORDIT_HANDOFF_INJECT_FAILURE="${RECORDIT_HANDOFF_INJECT_FAILURE:-}"
WHISPER_HELPER="${WHISPER_HELPER:-$(command -v whisper-cli || true)}"
RECORDIT_BUNDLE_CONFIGURATION="${RECORDIT_XCODE_CONFIGURATION:-Release}"

usage() {
  cat <<'USAGE'
Usage: $0 [options]

Runs a signed-app live-stream smoke gate with deterministic fake capture input.
The gate validates packaged default semantics plus runtime compatibility:
- `Recordit.app` is the default packaged launch path (`run-recordit-app`)
- live-stream model doctor succeeds in the signed compatibility runtime executable
- live-stream runtime emits expected packaged artifacts and manifest labels
- prebuilt runtime-input handoff and copy-only embed seams retain explicit integration evidence

Options:
  --out-dir PATH            Output directory (default: <packaged-root>/gates/gate_packaged_live_smoke/<utc-stamp>)
  --packaged-root PATH      Packaged artifact root (default: ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta)
  --model PATH              ASR model path (default: artifacts/bench/models/whispercpp/ggml-tiny.en.bin)
  --fixture PATH            Deterministic fake-capture fixture (default: artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav)
  --whisper-helper PATH     whispercpp helper binary path (default: auto-detect via 'which whisper-cli')
  --sign-identity VALUE     Codesign identity passed to make sign-transcribe (default: -)
  --duration-sec N          Runtime duration for the smoke scenario (default: 3)
  --chunk-window-ms N       Chunk window for live-stream runtime (default: 1800)
  --chunk-stride-ms N       Chunk stride for live-stream runtime (default: 300)
  --chunk-queue-cap N       Chunk queue cap for live-stream runtime (default: 4)
  -h, --help                Show this help text

Environment:
  RECORDIT_XCODE_CONFIGURATION  Configuration used for prebuilt handoff/embed probe (default: Release)
  RECORDIT_HANDOFF_INJECT_FAILURE  Optional seam failure injection for validation. Supported values: runtime_prepare_missing_manifest, runtime_prepare_missing_handoff_env, artifact_compare_manifest, artifact_compare_recordit, artifact_compare_capture, artifact_compare_model, manifest_parity_recordit
USAGE
}

bool_text() {
  if [[ "$1" -eq 1 ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
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
    --whisper-helper)
      WHISPER_HELPER="$2"
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
if [[ -z "$WHISPER_HELPER" || ! -x "$WHISPER_HELPER" ]]; then
  echo "error: whisper helper is missing or not executable: $WHISPER_HELPER" >&2
  echo "hint: install whisper-cli or pass --whisper-helper <path>" >&2
  exit 2
fi

DOCTOR_DIR="$OUT_DIR/model_doctor"
RUNTIME_DIR="$OUT_DIR/runtime"
STAGED_INPUT_DIR="$OUT_DIR/staged_inputs"
PREBUILT_RUNTIME_INPUT_DIR="$OUT_DIR/prebuilt_runtime_inputs"
COPY_ONLY_EMBED_ROOT="$OUT_DIR/copy_only_embed_probe"
COPY_ONLY_RUNTIME_ROOT="$COPY_ONLY_EMBED_ROOT/Contents/Resources/runtime"
SHARED_STAGE_DIR="$PACKAGED_ROOT/gates/.shared"
LOG_DIR="$OUT_DIR/logs"
SUMMARY_CSV="$OUT_DIR/summary.csv"
SUMMARY_JSON="$OUT_DIR/summary.json"
STATUS_TXT="$OUT_DIR/status.txt"
STATUS_JSON="$OUT_DIR/status.json"
METADATA_JSON="$OUT_DIR/metadata.json"

mkdir -p "$DOCTOR_DIR" "$RUNTIME_DIR" "$STAGED_INPUT_DIR" "$PREBUILT_RUNTIME_INPUT_DIR" "$SHARED_STAGE_DIR" "$LOG_DIR"
evidence_write_metadata_json "$METADATA_JSON" "gate_packaged_live_smoke" "gate_packaged_live_smoke" "$OUT_DIR" "$LOG_DIR" "$OUT_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" "$STATUS_JSON"

STAGED_MODEL="$SHARED_STAGE_DIR/$(basename "$MODEL")"
STAGED_FIXTURE="$STAGED_INPUT_DIR/$(basename "$FIXTURE")"
STAGED_HELPER="$SHARED_STAGE_DIR/whisper-cli"
PREBUILT_RUNTIME_PREPARE_LOG="$LOG_DIR/prebuilt_runtime_prepare.log"
PREBUILT_RUNTIME_HANDOFF_ENV="$PREBUILT_RUNTIME_INPUT_DIR/runtime_handoff.env"
PREBUILT_RUNTIME_MANIFEST="$PREBUILT_RUNTIME_INPUT_DIR/runtime/artifact-manifest.json"
COPY_ONLY_EMBED_LOG="$LOG_DIR/copy_only_embed.log"
COPY_ONLY_EMBED_COMPARE_LOG="$LOG_DIR/copy_only_embed_compare.log"
COPY_ONLY_EMBED_PARITY_LOG="$LOG_DIR/copy_only_embed_parity.log"
RECORDIT_RUN_PLAN="$LOG_DIR/recordit_run_plan.log"
SIGNING_LOG="$LOG_DIR/signing.log"

if [[ ! -f "$STAGED_MODEL" ]] || ! cmp -s "$MODEL" "$STAGED_MODEL"; then
  cp "$MODEL" "$STAGED_MODEL"
fi

cp "$FIXTURE" "$STAGED_FIXTURE"
if [[ ! -f "$STAGED_HELPER" ]]; then
  cp "$WHISPER_HELPER" "$STAGED_HELPER"
fi
chmod +x "$STAGED_HELPER"

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
    echo "[gate-packaged-live-smoke] generated_at_utc=$(evidence_timestamp)"
    echo "[gate-packaged-live-smoke] cmd=RECORDIT_DEFAULT_WHISPERCPP_MODEL=$MODEL make sign-recordit-app RECORDIT_XCODE_CONFIGURATION=$RECORDIT_BUNDLE_CONFIGURATION RECORDIT_RUNTIME_INPUT_DIR=$PREBUILT_RUNTIME_INPUT_DIR SIGN_IDENTITY=$SIGN_IDENTITY"
    RECORDIT_DEFAULT_WHISPERCPP_MODEL="$MODEL" make sign-recordit-app RECORDIT_XCODE_CONFIGURATION="$RECORDIT_BUNDLE_CONFIGURATION" RECORDIT_RUNTIME_INPUT_DIR="$PREBUILT_RUNTIME_INPUT_DIR" SIGN_IDENTITY="$SIGN_IDENTITY"
    echo "[gate-packaged-live-smoke] cmd=make sign-transcribe SIGN_IDENTITY=$SIGN_IDENTITY"
    make sign-transcribe SIGN_IDENTITY="$SIGN_IDENTITY"
  } >"$SIGNING_LOG" 2>&1
)

RECORDIT_APP_BUNDLE="$ROOT/dist/Recordit.app"
if [[ ! -d "$RECORDIT_APP_BUNDLE" ]]; then
  echo "error: expected Recordit app bundle not found: $RECORDIT_APP_BUNDLE" >&2
  exit 1
fi

set +e
(
  cd "$ROOT"
  echo "[gate-packaged-live-smoke] cmd=RECORDIT_DEFAULT_WHISPERCPP_MODEL=$MODEL make -n run-recordit-app RECORDIT_XCODE_CONFIGURATION=$RECORDIT_BUNDLE_CONFIGURATION RECORDIT_RUNTIME_INPUT_DIR=$PREBUILT_RUNTIME_INPUT_DIR SIGN_IDENTITY=$SIGN_IDENTITY"
  RECORDIT_DEFAULT_WHISPERCPP_MODEL="$MODEL" make -n run-recordit-app RECORDIT_XCODE_CONFIGURATION="$RECORDIT_BUNDLE_CONFIGURATION" RECORDIT_RUNTIME_INPUT_DIR="$PREBUILT_RUNTIME_INPUT_DIR" SIGN_IDENTITY="$SIGN_IDENTITY"
) >"$RECORDIT_RUN_PLAN" 2>&1
RECORDIT_PLAN_EXIT_CODE=$?
set -e

APP_BIN="$("$ROOT/scripts/resolve_sequoiatranscribe_compat.sh" --root "$ROOT")"

DOCTOR_STDOUT="$LOG_DIR/model_doctor.stdout.log"
DOCTOR_TIME="$LOG_DIR/model_doctor.time.txt"
DOCTOR_INPUT_WAV="$DOCTOR_DIR/session.input.wav"
DOCTOR_OUT_WAV="$DOCTOR_DIR/session.wav"
DOCTOR_OUT_JSONL="$DOCTOR_DIR/session.jsonl"
DOCTOR_OUT_MANIFEST="$DOCTOR_DIR/session.manifest.json"

RUNTIME_STDOUT="$LOG_DIR/runtime.stdout.log"
RUNTIME_TIME="$LOG_DIR/runtime.time.txt"
RUNTIME_INPUT_WAV="$RUNTIME_DIR/session.input.wav"
RUNTIME_OUT_WAV="$RUNTIME_DIR/session.wav"
RUNTIME_JSONL="$RUNTIME_DIR/session.jsonl"
RUNTIME_MANIFEST="$RUNTIME_DIR/session.manifest.json"

RECORDIT_RUN_PLAN_COMPAT="$OUT_DIR/recordit_run_plan.log"
DOCTOR_STDOUT_COMPAT="$DOCTOR_DIR/model_doctor.stdout.log"
RUNTIME_STDOUT_COMPAT="$RUNTIME_DIR/runtime.stdout.log"
RUNTIME_TIME_COMPAT="$RUNTIME_DIR/runtime.time.txt"

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
  --recordit-plan-exit-code "$RECORDIT_PLAN_EXIT_CODE" \
  --recordit-run-plan "$RECORDIT_RUN_PLAN" \
  --recordit-app-bundle "$RECORDIT_APP_BUNDLE" \
  --doctor-exit-code "$DOCTOR_EXIT_CODE" \
  --doctor-stdout "$DOCTOR_STDOUT" \
  --runtime-exit-code "$RUNTIME_EXIT_CODE" \
  --runtime-stderr "$RUNTIME_TIME" \
  --runtime-input-wav "$RUNTIME_INPUT_WAV" \
  --runtime-manifest "$RUNTIME_MANIFEST" \
  --runtime-jsonl "$RUNTIME_JSONL" \
  --expected-artifact-root "$PACKAGED_ROOT" \
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
  detail="packaged_live_smoke_and_handoff_thresholds_satisfied"
else
  GATE_PASS="false"
  status="failed"
  detail="packaged_live_smoke_or_handoff_thresholds_failed"
fi
printf 'gate_pass,%s\n' "$GATE_PASS" >>"$SUMMARY_CSV"

cp "$RECORDIT_RUN_PLAN" "$RECORDIT_RUN_PLAN_COMPAT"
cp "$DOCTOR_STDOUT" "$DOCTOR_STDOUT_COMPAT"
cp "$RUNTIME_STDOUT" "$RUNTIME_STDOUT_COMPAT"
cp "$RUNTIME_TIME" "$RUNTIME_TIME_COMPAT"

evidence_csv_kv_to_json "$SUMMARY_CSV" "$SUMMARY_JSON"

cat >"$STATUS_TXT" <<STATUS
status=$status
detail=$detail
summary_path=$SUMMARY_CSV
summary_json=$SUMMARY_JSON
status_json=$STATUS_JSON
metadata_json=$METADATA_JSON
logs_dir=$LOG_DIR
recordit_run_plan_path=$RECORDIT_RUN_PLAN
recordit_run_plan_compat_path=$RECORDIT_RUN_PLAN_COMPAT
recordit_app_bundle_path=$RECORDIT_APP_BUNDLE
signing_log_path=$SIGNING_LOG
doctor_stdout_path=$DOCTOR_STDOUT
doctor_stdout_compat_path=$DOCTOR_STDOUT_COMPAT
doctor_time_path=$DOCTOR_TIME
runtime_manifest_path=$RUNTIME_MANIFEST
runtime_jsonl_path=$RUNTIME_JSONL
runtime_stdout_path=$RUNTIME_STDOUT
runtime_stdout_compat_path=$RUNTIME_STDOUT_COMPAT
runtime_time_path=$RUNTIME_TIME
runtime_time_compat_path=$RUNTIME_TIME_COMPAT
staged_model_path=$STAGED_MODEL
staged_fixture_path=$STAGED_FIXTURE
staged_helper_path=$STAGED_HELPER
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

echo "GATE_PACKAGED_LIVE_SMOKE_OUT=$OUT_DIR"
echo "GATE_PACKAGED_LIVE_SMOKE_SUMMARY_JSON=$SUMMARY_JSON"
echo "GATE_PACKAGED_LIVE_SMOKE_STATUS_JSON=$STATUS_JSON"
if [[ "$GATE_PASS" != "true" ]]; then
  exit 1
fi
