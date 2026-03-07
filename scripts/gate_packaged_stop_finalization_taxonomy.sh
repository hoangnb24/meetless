#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

SCENARIO_ID="packaged_stop_finalization_taxonomy"
OUT_DIR="${OUT_DIR:-}"
RECORDIT_RUNTIME_BIN="${RECORDIT_RUNTIME_BIN:-$ROOT/dist/Recordit.app/Contents/Resources/runtime/bin/recordit}"
RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
LIVE_FIXTURE="${LIVE_FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
OFFLINE_INPUT="${OFFLINE_INPUT:-$ROOT/artifacts/bench/corpus/gate_a/tts_phrase.wav}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_RELEASE_CONTEXT="${SKIP_RELEASE_CONTEXT:-0}"
LIVE_DURATION_SEC="${LIVE_DURATION_SEC:-2}"
OFFLINE_DURATION_SEC="${OFFLINE_DURATION_SEC:-2}"
EARLY_STOP_SIGNAL_DELAY_SEC="${EARLY_STOP_SIGNAL_DELAY_SEC:-1.2}"
FORCED_KILL_SIGNAL_DELAY_SEC="${FORCED_KILL_SIGNAL_DELAY_SEC:-0.4}"

usage() {
  cat <<'USAGE'
Usage: gate_packaged_stop_finalization_taxonomy.sh [options]

Run packaged/signed lifecycle scenario verification against Recordit's embedded runtime
binary and classify canonical stop/finalization outcomes.

Scenarios:
- graceful_stop_live
- fallback_record_only_offline
- early_stop_live_interrupt
- partial_artifact_forced_kill

Options:
  --out-dir PATH                     Output directory (default: artifacts/validation/bd-2kia/<utc-stamp>)
  --recordit-runtime-bin PATH        Runtime binary path (default: dist/Recordit.app/.../runtime/bin/recordit)
  --recordit-app-bundle PATH         Recordit.app bundle path (default: dist/Recordit.app)
  --model PATH                       ASR model path (default: artifacts/bench/models/whispercpp/ggml-tiny.en.bin)
  --live-fixture PATH                Deterministic stereo fixture for live mode (default: artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav)
  --offline-input PATH               Offline input WAV path (default: artifacts/bench/corpus/gate_a/tts_phrase.wav)
  --sign-identity VALUE              Codesign identity for build/sign step (default: -)
  --skip-build                       Skip `make sign-recordit-app`
  --skip-release-context             Skip release-context verification phase
  --live-duration-sec N              Duration for graceful live scenario (default: 2)
  --offline-duration-sec N           Duration for offline fallback scenario (default: 2)
  --early-stop-delay-sec N           Delay before SIGINT in early-stop scenario (default: 1.2)
  --forced-kill-delay-sec N          Delay before SIGKILL in forced-kill scenario (default: 0.4)
  -h, --help                         Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --recordit-runtime-bin)
      RECORDIT_RUNTIME_BIN="$2"
      shift 2
      ;;
    --recordit-app-bundle)
      RECORDIT_APP_BUNDLE="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --live-fixture)
      LIVE_FIXTURE="$2"
      shift 2
      ;;
    --offline-input)
      OFFLINE_INPUT="$2"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-release-context)
      SKIP_RELEASE_CONTEXT=1
      shift
      ;;
    --live-duration-sec)
      LIVE_DURATION_SEC="$2"
      shift 2
      ;;
    --offline-duration-sec)
      OFFLINE_DURATION_SEC="$2"
      shift 2
      ;;
    --early-stop-delay-sec)
      EARLY_STOP_SIGNAL_DELAY_SEC="$2"
      shift 2
      ;;
    --forced-kill-delay-sec)
      FORCED_KILL_SIGNAL_DELAY_SEC="$2"
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
  OUT_DIR="$ROOT/artifacts/validation/bd-2kia/gate_packaged_stop_finalization_taxonomy/$STAMP"
fi

OUT_DIR="$(python3 - "$OUT_DIR" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
RECORDIT_RUNTIME_BIN="$(python3 - "$RECORDIT_RUNTIME_BIN" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
RECORDIT_APP_BUNDLE="$(python3 - "$RECORDIT_APP_BUNDLE" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
MODEL="$(python3 - "$MODEL" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
LIVE_FIXTURE="$(python3 - "$LIVE_FIXTURE" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"
OFFLINE_INPUT="$(python3 - "$OFFLINE_INPUT" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

LOG_DIR="$OUT_DIR/logs"
SCENARIOS_DIR="$OUT_DIR/scenarios"
SUMMARY_CSV="$OUT_DIR/summary.csv"
SUMMARY_JSON="$OUT_DIR/summary.json"
STATUS_TXT="$OUT_DIR/status.txt"
STATUS_JSON="$OUT_DIR/status.json"
METADATA_JSON="$OUT_DIR/metadata.json"
BUILD_LOG="$LOG_DIR/build_sign_recordit.log"
RELEASE_CONTEXT_LOG="$LOG_DIR/release_context_verification.log"
RELEASE_CONTEXT_OUT="$OUT_DIR/release_context_verification"

mkdir -p "$OUT_DIR" "$LOG_DIR" "$SCENARIOS_DIR"

evidence_write_metadata_json "$METADATA_JSON" "$SCENARIO_ID" "packaged-e2e" "$OUT_DIR" "$LOG_DIR" "$SCENARIOS_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" "$STATUS_JSON"

if [[ "$SKIP_BUILD" != "1" ]]; then
  set +e
  (
    cd "$ROOT"
    make sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"
  ) >"$BUILD_LOG" 2>&1
  BUILD_EXIT_CODE=$?
  set -e
  if [[ "$BUILD_EXIT_CODE" -ne 0 ]]; then
    echo "error: build/sign step failed. see $BUILD_LOG" >&2
    cat > "$STATUS_TXT" <<STATUS
status=fail
failure_stage=build_sign_recordit
build_exit_code=$BUILD_EXIT_CODE
build_log=$BUILD_LOG
STATUS
    evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"
    exit 1
  fi
else
  printf 'skip-build requested\n' > "$BUILD_LOG"
fi

if [[ ! -x "$RECORDIT_RUNTIME_BIN" ]]; then
  echo "error: runtime binary is missing or not executable: $RECORDIT_RUNTIME_BIN" >&2
  cat > "$STATUS_TXT" <<STATUS
status=fail
failure_stage=runtime_bin_missing
runtime_bin=$RECORDIT_RUNTIME_BIN
STATUS
  evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"
  exit 1
fi

if [[ ! -d "$RECORDIT_APP_BUNDLE" ]]; then
  echo "error: Recordit app bundle missing: $RECORDIT_APP_BUNDLE" >&2
  cat > "$STATUS_TXT" <<STATUS
status=fail
failure_stage=recordit_bundle_missing
recordit_app_bundle=$RECORDIT_APP_BUNDLE
STATUS
  evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "error: model file missing: $MODEL" >&2
  exit 2
fi
if [[ ! -f "$LIVE_FIXTURE" ]]; then
  echo "error: live fixture missing: $LIVE_FIXTURE" >&2
  exit 2
fi
if [[ ! -f "$OFFLINE_INPUT" ]]; then
  echo "error: offline input missing: $OFFLINE_INPUT" >&2
  exit 2
fi

RELEASE_CONTEXT_EXIT_CODE=0
if [[ "$SKIP_RELEASE_CONTEXT" != "1" ]]; then
  set +e
  (
    cd "$ROOT"
    "$ROOT/scripts/verify_recordit_release_context.sh" \
      --out-dir "$RELEASE_CONTEXT_OUT" \
      --recordit-app-bundle "$RECORDIT_APP_BUNDLE" \
      --sign-identity "$SIGN_IDENTITY" \
      --skip-build
  ) >"$RELEASE_CONTEXT_LOG" 2>&1
  RELEASE_CONTEXT_EXIT_CODE=$?
  set -e
else
  printf 'skip-release-context requested\n' > "$RELEASE_CONTEXT_LOG"
fi

run_recordit_scenario() {
  local scenario_id="$1"
  local mode="$2"
  local duration_sec="$3"
  local signal_name="$4"
  local signal_delay_sec="$5"
  local expected_outcome_code="$6"
  local expected_runtime_mode="$7"
  local expected_manifest_exists="$8"
  local description="$9"

  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"
  local execution_json="$scenario_dir/execution.json"
  local meta_json="$scenario_dir/scenario_meta.json"

  mkdir -p "$scenario_dir"

  python3 - "$meta_json" "$scenario_id" "$mode" "$description" "$expected_outcome_code" "$expected_runtime_mode" "$expected_manifest_exists" "$session_root" "$stdout_log" "$stderr_log" <<'PY'
import json
import sys
from pathlib import Path

(
    out_path,
    scenario_id,
    mode,
    description,
    expected_outcome_code,
    expected_runtime_mode,
    expected_manifest_exists,
    session_root,
    stdout_log,
    stderr_log,
) = sys.argv[1:]

payload = {
    "scenario_id": scenario_id,
    "mode": mode,
    "description": description,
    "expected_outcome_code": expected_outcome_code,
    "expected_runtime_mode": expected_runtime_mode,
    "expected_manifest_exists": expected_manifest_exists.strip().lower() == "true",
    "session_root": session_root,
    "stdout_log": stdout_log,
    "stderr_log": stderr_log,
}

path = Path(out_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

  python3 - \
    "$RECORDIT_RUNTIME_BIN" \
    "$MODEL" \
    "$LIVE_FIXTURE" \
    "$OFFLINE_INPUT" \
    "$mode" \
    "$duration_sec" \
    "$signal_name" \
    "$signal_delay_sec" \
    "$session_root" \
    "$stdout_log" \
    "$stderr_log" \
    "$execution_json" <<'PY'
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

(
    runtime_bin,
    model,
    live_fixture,
    offline_input,
    mode,
    duration_sec,
    signal_name,
    signal_delay_sec,
    session_root,
    stdout_log,
    stderr_log,
    execution_json,
) = sys.argv[1:]

session_root_path = Path(session_root)
session_root_path.mkdir(parents=True, exist_ok=True)
Path(stdout_log).parent.mkdir(parents=True, exist_ok=True)
Path(stderr_log).parent.mkdir(parents=True, exist_ok=True)

cmd = [runtime_bin, "run", "--mode", mode, "--output-root", str(session_root_path), "--model", model, "--json"]
if duration_sec and duration_sec != "none":
    cmd.extend(["--duration-sec", duration_sec])
if mode == "offline":
    cmd.extend(["--input-wav", offline_input])

env = dict(os.environ)
if mode == "live":
    env["RECORDIT_FAKE_CAPTURE_FIXTURE"] = live_fixture

signal_sent = False
signal_requested = signal_name if signal_name not in {"", "none"} else "none"
exit_code = None
runner_error = ""

try:
    with open(stdout_log, "wb") as out_handle, open(stderr_log, "wb") as err_handle:
        proc = subprocess.Popen(cmd, stdout=out_handle, stderr=err_handle, env=env)
        if signal_requested != "none":
            delay = float(signal_delay_sec)
            time.sleep(delay)
            if signal_requested == "SIGINT":
                proc.send_signal(signal.SIGINT)
                signal_sent = True
            elif signal_requested == "SIGKILL":
                proc.kill()
                signal_sent = True
            else:
                runner_error = f"unsupported signal requested: {signal_requested}"
        exit_code = proc.wait(timeout=120)
except Exception as exc:  # noqa: BLE001
    runner_error = f"runner exception: {exc!r}"

payload = {
    "command": cmd,
    "mode": mode,
    "duration_sec": duration_sec,
    "signal_requested": signal_requested,
    "signal_delay_sec": signal_delay_sec,
    "signal_sent": signal_sent,
    "exit_code": exit_code,
    "session_root": str(session_root_path),
    "stdout_log": stdout_log,
    "stderr_log": stderr_log,
    "runner_error": runner_error,
}

Path(execution_json).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

run_recordit_scenario \
  "graceful_stop_live" \
  "live" \
  "$LIVE_DURATION_SEC" \
  "none" \
  "0" \
  "finalized_success" \
  "live-stream" \
  "true" \
  "Live-mode graceful stop/finalization in signed packaged runtime"

run_recordit_scenario \
  "fallback_record_only_offline" \
  "offline" \
  "$OFFLINE_DURATION_SEC" \
  "none" \
  "0" \
  "finalized_success" \
  "representative-offline" \
  "true" \
  "Record-only/offline fallback scenario in signed packaged runtime"

run_recordit_scenario \
  "early_stop_live_interrupt" \
  "live" \
  "none" \
  "SIGINT" \
  "$EARLY_STOP_SIGNAL_DELAY_SEC" \
  "finalized_success" \
  "live-stream" \
  "true" \
  "Live-mode early stop via SIGINT while preserving finalized artifacts"

run_recordit_scenario \
  "partial_artifact_forced_kill" \
  "live" \
  "none" \
  "SIGKILL" \
  "$FORCED_KILL_SIGNAL_DELAY_SEC" \
  "partial_artifact_session" \
  "live-stream" \
  "false" \
  "Forced kill to retain partial artifacts without final manifest"

python3 "$ROOT/scripts/gate_packaged_stop_finalization_summary.py" \
  --scenarios-root "$SCENARIOS_DIR" \
  --summary-csv "$SUMMARY_CSV" \
  --summary-json "$SUMMARY_JSON" \
  --status-path "$STATUS_TXT"

SUMMARY_STATUS="$(awk -F= '$1=="status" {print $2}' "$STATUS_TXT" | tail -n 1)"
if [[ "$SUMMARY_STATUS" != "pass" ]]; then
  FINAL_STATUS="fail"
else
  FINAL_STATUS="pass"
fi

if [[ "$SKIP_RELEASE_CONTEXT" != "1" && "$RELEASE_CONTEXT_EXIT_CODE" -ne 0 ]]; then
  FINAL_STATUS="fail"
fi

python3 - \
  "$STATUS_TXT" \
  "$SUMMARY_CSV" \
  "$SUMMARY_JSON" \
  "$BUILD_LOG" \
  "$RELEASE_CONTEXT_LOG" \
  "$RELEASE_CONTEXT_EXIT_CODE" \
  "$SKIP_RELEASE_CONTEXT" \
  "$FINAL_STATUS" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

(
    status_path,
    summary_csv,
    summary_json,
    build_log,
    release_context_log,
    release_context_exit_code,
    skip_release_context,
    final_status,
) = sys.argv[1:]

status = {}
for raw in Path(status_path).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or "=" not in line:
        continue
    key, value = line.split("=", 1)
    status[key] = value

status["summary_csv"] = summary_csv
status["summary_json"] = summary_json
status["build_log"] = build_log
status["release_context_log"] = release_context_log
status["release_context_exit_code"] = release_context_exit_code
status["release_context_skipped"] = "true" if skip_release_context == "1" else "false"
status["release_context_ok"] = "true" if (skip_release_context == "1" or release_context_exit_code == "0") else "false"
status["status"] = final_status

lines = [f"{k}={v}" for k, v in sorted(status.items())]
Path(status_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"

echo "GATE_PACKAGED_STOP_FINALIZATION_OUT=$OUT_DIR"
echo "GATE_PACKAGED_STOP_FINALIZATION_SUMMARY=$SUMMARY_CSV"
echo "GATE_PACKAGED_STOP_FINALIZATION_STATUS=$STATUS_TXT"
echo "GATE_PACKAGED_STOP_FINALIZATION_STATUS_JSON=$STATUS_JSON"

if [[ "$FINAL_STATUS" != "pass" ]]; then
  exit 1
fi
