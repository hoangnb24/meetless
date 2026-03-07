#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

ARTIFACT_ROOT=""
KEEP_GOING=0
SKIP_BUILD=0
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
GRACEFUL_DURATION_SEC="${GRACEFUL_DURATION_SEC:-3}"
EARLY_STOP_DELAY_SEC="${EARLY_STOP_DELAY_SEC:-0.05}"
PARTIAL_KILL_DELAY_SEC="${PARTIAL_KILL_DELAY_SEC:-0.05}"

usage() {
  cat <<'USAGE'
Usage: scripts/gate_packaged_stop_finalization_stress.sh [options]

Runs packaged/signed stop-finalization lifecycle scenarios and asserts canonical
session outcome taxonomy + retained diagnostics.

Scenarios:
  1) graceful-live-stop
  2) fallback-offline-after-live-doctor-failure
  3) early-stop-live-sigint
  4) partial-artifact-live-sigkill

Options:
  --artifact-root DIR   Scenario artifact root
  --keep-going          Continue scenarios after a failure
  --skip-build          Skip make sign-recordit-app
  --sign-identity ID    Codesign identity for sign-recordit-app (default: -)
  -h, --help            Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact-root)
      ARTIFACT_ROOT="${2:-}"
      shift 2
      ;;
    --keep-going)
      KEEP_GOING=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --sign-identity)
      SIGN_IDENTITY="${2:-}"
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

if [[ -z "$ARTIFACT_ROOT" ]]; then
  ARTIFACT_ROOT="$ROOT/artifacts/validation/bd-2kia/packaged-stop-finalization-$(date -u +%Y%m%dT%H%M%SZ)"
fi

if [[ ! -f "$FIXTURE" ]]; then
  echo "error: fixture missing: $FIXTURE" >&2
  exit 2
fi

mkdir -p "$ARTIFACT_ROOT"
LOG_DIR="$ARTIFACT_ROOT/logs"
SCENARIO_ROOT="$ARTIFACT_ROOT/scenarios"
mkdir -p "$LOG_DIR" "$SCENARIO_ROOT"

SUMMARY_ROWS_CSV="$ARTIFACT_ROOT/scenario_results.csv"
SUMMARY_CSV="$ARTIFACT_ROOT/summary.csv"
SUMMARY_JSON="$ARTIFACT_ROOT/summary.json"
STATUS_TXT="$ARTIFACT_ROOT/status.txt"
STATUS_JSON="$ARTIFACT_ROOT/status.json"
METADATA_JSON="$ARTIFACT_ROOT/metadata.json"

printf 'scenario,status,expected_outcome_code,observed_outcome_code,outcome_classification,manifest_status,run_exit_code,has_manifest,has_wav,has_jsonl,has_pending,has_retry_context,root_path,stdout_log,stderr_log,detail\n' > "$SUMMARY_ROWS_CSV"
printf 'key,value\n' > "$SUMMARY_CSV"
evidence_write_metadata_json "$METADATA_JSON" "bd-2kia_packaged_stop_finalization_stress" "packaged_stop_finalization_stress" "$ARTIFACT_ROOT" "$LOG_DIR" "$SCENARIO_ROOT" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" "$STATUS_JSON"

append_summary_kv() {
  local key="$1"
  local value="$2"
  value="${value//$'\n'/ | }"
  value="${value//,/; }"
  printf '%s,%s\n' "$key" "$value" >> "$SUMMARY_CSV"
}

classify_session_root() {
  local root_path="$1"
  python3 - "$root_path" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest = root / "session.manifest.json"
wav = root / "session.wav"
jsonl = root / "session.jsonl"
pending = root / "session.pending.json"
retry = root / "session.pending.retry.json"

has_manifest = manifest.is_file()
has_wav = wav.is_file()
has_jsonl = jsonl.is_file()
has_pending = pending.is_file()
has_retry = retry.is_file()

manifest_status = ""
trust_notice_count = 0

if has_manifest:
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            summary = payload.get("session_summary")
            if isinstance(summary, dict):
                manifest_status = str(summary.get("session_status", "")).strip().lower()
            if not manifest_status:
                manifest_status = str(payload.get("status", "")).strip().lower()
            trust = payload.get("trust")
            if isinstance(trust, dict):
                raw_count = trust.get("notice_count")
                if isinstance(raw_count, (int, float)):
                    trust_notice_count = max(0, int(raw_count))
                elif isinstance(raw_count, str):
                    try:
                        trust_notice_count = max(0, int(raw_count.strip()))
                    except ValueError:
                        trust_notice_count = 0
                elif isinstance(trust.get("notices"), list):
                    trust_notice_count = len(trust["notices"])
    except Exception:
        manifest_status = "invalid"

if manifest_status == "failed":
    classification = "finalized_failure"
elif manifest_status in {"ok", "degraded"}:
    classification = "finalized_success" if has_wav else "partial_artifact"
elif manifest_status == "pending":
    classification = "partial_artifact"
else:
    has_any = has_manifest or has_wav or has_jsonl or has_pending or has_retry
    classification = "partial_artifact" if has_any else "empty_root"

if classification == "empty_root":
    code = "empty_session_root"
elif classification == "partial_artifact":
    code = "partial_artifact_session"
elif classification == "finalized_failure":
    code = "finalized_failure"
else:
    code = "finalized_degraded_success" if (manifest_status == "degraded" or trust_notice_count > 0) else "finalized_success"

print(f"outcome_classification={classification}")
print(f"outcome_code={code}")
print(f"manifest_status={manifest_status}")
print(f"has_manifest={'true' if has_manifest else 'false'}")
print(f"has_wav={'true' if has_wav else 'false'}")
print(f"has_jsonl={'true' if has_jsonl else 'false'}")
print(f"has_pending={'true' if has_pending else 'false'}")
print(f"has_retry_context={'true' if has_retry else 'false'}")
print(f"trust_notice_count={trust_notice_count}")
PY
}

matches_expected_code() {
  local expected="$1"
  local observed="$2"

  if [[ "$expected" == "any" ]]; then
    return 0
  fi

  IFS='|' read -r -a expected_codes <<< "$expected"
  local code
  for code in "${expected_codes[@]}"; do
    if [[ "$code" == "$observed" ]]; then
      return 0
    fi
  done
  return 1
}

SCENARIO_FAIL_COUNT=0
SCENARIO_TOTAL=0

record_scenario() {
  local scenario="$1"
  local expected_code="$2"
  local run_exit_code="$3"
  local root_path="$4"
  local stdout_log="$5"
  local stderr_log="$6"
  local detail="$7"

  local outcome_classification=""
  local outcome_code=""
  local manifest_status=""
  local has_manifest=""
  local has_wav=""
  local has_jsonl=""
  local has_pending=""
  local has_retry_context=""

  while IFS='=' read -r key value; do
    case "$key" in
      outcome_classification) outcome_classification="$value" ;;
      outcome_code) outcome_code="$value" ;;
      manifest_status) manifest_status="$value" ;;
      has_manifest) has_manifest="$value" ;;
      has_wav) has_wav="$value" ;;
      has_jsonl) has_jsonl="$value" ;;
      has_pending) has_pending="$value" ;;
      has_retry_context) has_retry_context="$value" ;;
    esac
  done < <(classify_session_root "$root_path")

  local status="pass"
  if ! matches_expected_code "$expected_code" "$outcome_code"; then
    status="fail"
    detail="$detail | expected_outcome_code=$expected_code observed_outcome_code=$outcome_code"
  fi

  if [[ "$status" == "fail" ]]; then
    SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT + 1))
  fi
  SCENARIO_TOTAL=$((SCENARIO_TOTAL + 1))

  detail="${detail//$'\n'/ | }"
  detail="${detail//,/; }"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$scenario" \
    "$status" \
    "$expected_code" \
    "$outcome_code" \
    "$outcome_classification" \
    "$manifest_status" \
    "$run_exit_code" \
    "$has_manifest" \
    "$has_wav" \
    "$has_jsonl" \
    "$has_pending" \
    "$has_retry_context" \
    "$root_path" \
    "$stdout_log" \
    "$stderr_log" \
    "$detail" >> "$SUMMARY_ROWS_CSV"

  if [[ "$status" == "fail" && "$KEEP_GOING" -ne 1 ]]; then
    return 1
  fi

  return 0
}

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  set +e
  (
    cd "$ROOT"
    make sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"
  ) >"$LOG_DIR/sign_recordit_app.log" 2>&1
  BUILD_EXIT_CODE=$?
  set -e
else
  BUILD_EXIT_CODE=0
  printf 'skip-build requested\n' > "$LOG_DIR/sign_recordit_app.log"
fi

RUNTIME_BIN="$RECORDIT_APP_BUNDLE/Contents/Resources/runtime/bin/recordit"
MODEL="$RECORDIT_APP_BUNDLE/Contents/Resources/runtime/models/whispercpp/ggml-tiny.en.bin"

if [[ ! -x "$RUNTIME_BIN" ]]; then
  echo "error: runtime binary missing or not executable: $RUNTIME_BIN" >&2
  exit 2
fi
if [[ ! -f "$MODEL" ]]; then
  echo "error: bundled model missing: $MODEL" >&2
  exit 2
fi

set +e
"$ROOT/scripts/verify_recordit_release_context.sh" \
  --out-dir "$ARTIFACT_ROOT/release_context_verification" \
  --recordit-app-bundle "$RECORDIT_APP_BUNDLE" \
  --skip-build \
  --sign-identity "$SIGN_IDENTITY" >"$LOG_DIR/release_context_verification.log" 2>&1
VERIFY_EXIT_CODE=$?
set -e

run_graceful_live() {
  local scenario="graceful-live-stop"
  local scenario_root="$SCENARIO_ROOT/$scenario"
  local stdout_log="$LOG_DIR/$scenario.stdout.log"
  local stderr_log="$LOG_DIR/$scenario.stderr.log"
  mkdir -p "$scenario_root"
  set +e
  env RECORDIT_FAKE_CAPTURE_FIXTURE="$FIXTURE" \
    "$RUNTIME_BIN" run --mode live \
    --duration-sec "$GRACEFUL_DURATION_SEC" \
    --model "$MODEL" \
    --output-root "$scenario_root" \
    --json >"$stdout_log" 2>"$stderr_log"
  local run_exit_code=$?
  set -e
  record_scenario "$scenario" "finalized_success|finalized_degraded_success" "$run_exit_code" "$scenario_root" "$stdout_log" "$stderr_log" "graceful duration-sec=$GRACEFUL_DURATION_SEC"
}

run_fallback_offline() {
  local scenario="fallback-offline-after-live-doctor-failure"
  local scenario_root="$SCENARIO_ROOT/$scenario"
  local doctor_stdout="$LOG_DIR/$scenario.doctor.stdout.log"
  local doctor_stderr="$LOG_DIR/$scenario.doctor.stderr.log"
  local stdout_log="$LOG_DIR/$scenario.stdout.log"
  local stderr_log="$LOG_DIR/$scenario.stderr.log"
  mkdir -p "$scenario_root"

  local missing_model="$scenario_root/missing-live-model.bin"
  set +e
  "$RUNTIME_BIN" doctor --backend whispercpp --model "$missing_model" --json >"$doctor_stdout" 2>"$doctor_stderr"
  local doctor_exit_code=$?
  set -e

  set +e
  "$RUNTIME_BIN" run --mode offline \
    --input-wav "$FIXTURE" \
    --model "$MODEL" \
    --output-root "$scenario_root" \
    --json >"$stdout_log" 2>"$stderr_log"
  local run_exit_code=$?
  set -e

  record_scenario "$scenario" "finalized_success|finalized_degraded_success" "$run_exit_code" "$scenario_root" "$stdout_log" "$stderr_log" "live_doctor_exit=$doctor_exit_code fallback_mode=offline"
}

run_early_stop_sigint() {
  local scenario="early-stop-live-sigint"
  local scenario_root="$SCENARIO_ROOT/$scenario"
  local stdout_log="$LOG_DIR/$scenario.stdout.log"
  local stderr_log="$LOG_DIR/$scenario.stderr.log"
  mkdir -p "$scenario_root"

  set +e
  (
    env RECORDIT_FAKE_CAPTURE_FIXTURE="$FIXTURE" \
      "$RUNTIME_BIN" run --mode live \
      --model "$MODEL" \
      --output-root "$scenario_root" \
      --json >"$stdout_log" 2>"$stderr_log"
  ) &
  local pid=$!
  sleep "$EARLY_STOP_DELAY_SEC"
  local signal_sent="true"
  if ! kill -INT "$pid" 2>/dev/null; then
    signal_sent="false"
  fi
  wait "$pid"
  local run_exit_code=$?
  set -e

  record_scenario "$scenario" "finalized_success|finalized_degraded_success" "$run_exit_code" "$scenario_root" "$stdout_log" "$stderr_log" "signal=INT sent=$signal_sent delay_sec=$EARLY_STOP_DELAY_SEC"
}

run_partial_artifact_sigkill() {
  local scenario="partial-artifact-live-sigkill"
  local scenario_root="$SCENARIO_ROOT/$scenario"
  local stdout_log="$LOG_DIR/$scenario.stdout.log"
  local stderr_log="$LOG_DIR/$scenario.stderr.log"
  mkdir -p "$scenario_root"

  run_partial_attempt() {
    local delay_sec="$1"
    rm -rf "$scenario_root"
    mkdir -p "$scenario_root"
    set +e
    (
      env RECORDIT_FAKE_CAPTURE_FIXTURE="$FIXTURE" \
        "$RUNTIME_BIN" run --mode live \
        --model "$MODEL" \
        --output-root "$scenario_root" \
        --json >"$stdout_log" 2>"$stderr_log"
    ) &
    local pid=$!
    sleep "$delay_sec"
    local sent="true"
    if ! kill -KILL "$pid" 2>/dev/null; then
      sent="false"
    fi
    wait "$pid"
    local code=$?
    set -e
    printf '%s,%s\n' "$code" "$sent"
  }

  IFS=',' read -r run_exit_code signal_sent < <(run_partial_attempt "$PARTIAL_KILL_DELAY_SEC")
  local used_delay="$PARTIAL_KILL_DELAY_SEC"
  if [[ ! -f "$scenario_root/session.manifest.json" && ! -f "$scenario_root/session.jsonl" && ! -f "$scenario_root/session.wav" ]]; then
    IFS=',' read -r run_exit_code signal_sent < <(run_partial_attempt "0.10")
    used_delay="0.10"
  fi

  record_scenario "$scenario" "partial_artifact_session" "$run_exit_code" "$scenario_root" "$stdout_log" "$stderr_log" "signal=KILL sent=$signal_sent delay_sec=$used_delay"
}

run_graceful_live
run_fallback_offline
run_early_stop_sigint
run_partial_artifact_sigkill

append_summary_kv "artifact_root" "$ARTIFACT_ROOT"
append_summary_kv "summary_rows_csv" "$SUMMARY_ROWS_CSV"
append_summary_kv "build_exit_code" "$BUILD_EXIT_CODE"
append_summary_kv "release_context_verify_exit_code" "$VERIFY_EXIT_CODE"
append_summary_kv "scenario_total" "$SCENARIO_TOTAL"
append_summary_kv "scenario_fail_count" "$SCENARIO_FAIL_COUNT"
append_summary_kv "runtime_bin" "$RUNTIME_BIN"
append_summary_kv "bundled_model" "$MODEL"
append_summary_kv "fixture" "$FIXTURE"
append_summary_kv "keep_going" "$KEEP_GOING"
append_summary_kv "generated_at_utc" "$(evidence_timestamp)"

if [[ "$BUILD_EXIT_CODE" -eq 0 && "$VERIFY_EXIT_CODE" -eq 0 && "$SCENARIO_FAIL_COUNT" -eq 0 ]]; then
  GATE_PASS="true"
  STATUS="pass"
  DETAIL="packaged stop/finalization taxonomy scenarios satisfied"
else
  GATE_PASS="false"
  STATUS="failed"
  DETAIL="packaged stop/finalization taxonomy scenarios failed or release context verification failed"
fi
append_summary_kv "gate_pass" "$GATE_PASS"
append_summary_kv "status" "$STATUS"
append_summary_kv "detail" "$DETAIL"

cat >"$STATUS_TXT" <<STATUS
status=$STATUS
detail=$DETAIL
gate_pass=$GATE_PASS
artifact_root=$ARTIFACT_ROOT
summary_csv=$SUMMARY_CSV
summary_rows_csv=$SUMMARY_ROWS_CSV
summary_json=$SUMMARY_JSON
status_json=$STATUS_JSON
metadata_json=$METADATA_JSON
log_dir=$LOG_DIR
release_context_verify_exit_code=$VERIFY_EXIT_CODE
build_exit_code=$BUILD_EXIT_CODE
scenario_total=$SCENARIO_TOTAL
scenario_fail_count=$SCENARIO_FAIL_COUNT
runtime_bin=$RUNTIME_BIN
bundled_model=$MODEL
fixture=$FIXTURE
generated_at_utc=$(evidence_timestamp)
STATUS

evidence_csv_kv_to_json "$SUMMARY_CSV" "$SUMMARY_JSON"
evidence_kv_text_to_json "$STATUS_TXT" "$STATUS_JSON"

echo "GATE_PACKAGED_STOP_FINALIZATION_STRESS_OUT=$ARTIFACT_ROOT"
echo "GATE_PACKAGED_STOP_FINALIZATION_STRESS_SUMMARY_JSON=$SUMMARY_JSON"
echo "GATE_PACKAGED_STOP_FINALIZATION_STRESS_STATUS_JSON=$STATUS_JSON"

if [[ "$GATE_PASS" != "true" ]]; then
  exit 1
fi
