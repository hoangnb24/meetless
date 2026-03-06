#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="${XCTEST_EVIDENCE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${XCTEST_EVIDENCE_OUT_DIR:-$ROOT/artifacts/ci/xctest_evidence/$STAMP}"
DERIVED_DATA_PATH="${XCTEST_DERIVED_DATA_PATH:-$OUT_DIR/derived_data}"
DESTINATION="${XCTEST_DESTINATION:-platform=macOS}"
STRICT_UI_TESTS="${CI_STRICT_UI_TESTS:-0}"
UI_BOOTSTRAP_RETRIES="${XCTEST_UI_BOOTSTRAP_RETRIES:-1}"
XCTEST_CONFIGURATION="${XCTEST_CONFIGURATION:-Debug}"
RUNTIME_INPUT_DIR="${XCTEST_RUNTIME_INPUT_DIR:-$ROOT/.build/recordit-runtime-inputs/$XCTEST_CONFIGURATION}"

LOG_DIR="$OUT_DIR/logs"
RESULT_DIR="$OUT_DIR/xcresult"
STATUS_CSV="$OUT_DIR/status.csv"
SUMMARY_CSV="$OUT_DIR/summary.csv"
RESPONSIVENESS_SUMMARY_CSV="${XCTEST_RESPONSIVENESS_SUMMARY_PATH:-$OUT_DIR/responsiveness_budget_summary.csv}"

mkdir -p "$LOG_DIR" "$RESULT_DIR"

cat >"$STATUS_CSV" <<'CSV'
step,required,exit_code,result,log_path,result_bundle_path
CSV

overall_failure=0
steps_total=0
steps_failed=0
required_failed=0

record_step() {
  local step_name="$1"
  local required="$2"
  local exit_code="$3"
  local log_path="$4"
  local result_bundle_path="$5"
  local result="pass"

  steps_total=$((steps_total + 1))
  if [[ "$exit_code" -ne 0 ]]; then
    result="fail"
    steps_failed=$((steps_failed + 1))
    if [[ "$required" -eq 1 ]]; then
      required_failed=$((required_failed + 1))
      overall_failure=1
    fi
  fi

  printf '%s,%s,%s,%s,%s,%s\n' \
    "$step_name" "$required" "$exit_code" "$result" "$log_path" "$result_bundle_path" >>"$STATUS_CSV"
}

run_step() {
  local step_name="$1"
  local required="$2"
  local result_bundle_path="$3"
  shift 3

  local log_path="$LOG_DIR/${step_name}.log"
  echo "[ci-xctest] step=$step_name required=$required"
  echo "[ci-xctest] cmd=$*"

  set +e
  "$@" >"$log_path" 2>&1
  local rc=$?
  set -e

  record_step "$step_name" "$required" "$rc" "$log_path" "$result_bundle_path"
}

run_xcodebuild_step() {
  local step_name="$1"
  local required="$2"
  local result_bundle_path="$3"
  shift 3

  if [[ -n "$result_bundle_path" ]]; then
    run_step "$step_name" "$required" "$result_bundle_path" \
      env RECORDIT_RUNTIME_INPUT_DIR="$RUNTIME_INPUT_DIR" \
      xcodebuild "$@" -resultBundlePath "$result_bundle_path"
  else
    run_step "$step_name" "$required" "" \
      env RECORDIT_RUNTIME_INPUT_DIR="$RUNTIME_INPUT_DIR" \
      xcodebuild "$@"
  fi
}

is_ui_bootstrap_failure() {
  local log_path="$1"
  rg -q \
    "Early unexpected exit, operation never finished bootstrapping|Test crashed with signal kill before starting test execution" \
    "$log_path"
}

cleanup_ui_test_processes() {
  pkill -f "RecorditAppUITests-Runner|/Recordit.app/Contents/MacOS/Recordit" >/dev/null 2>&1 || true
}

run_xcodebuild_ui_step_with_bootstrap_retry() {
  local step_name="$1"
  local required="$2"
  local result_bundle_path="$3"
  shift 3

  local log_path="$LOG_DIR/${step_name}.log"
  local attempt=0
  local max_attempts=$((UI_BOOTSTRAP_RETRIES + 1))
  local rc=0

  : >"$log_path"
  while [[ "$attempt" -lt "$max_attempts" ]]; do
    attempt=$((attempt + 1))
    {
      echo "[ci-xctest] step=$step_name required=$required attempt=$attempt/$max_attempts"
      echo "[ci-xctest] cmd=xcodebuild $* -resultBundlePath $result_bundle_path"
    } | tee -a "$log_path"

    local attempt_log="${log_path}.attempt_${attempt}"
    rm -f "$attempt_log"
    rm -rf "$result_bundle_path"

    set +e
    env RECORDIT_RUNTIME_INPUT_DIR="$RUNTIME_INPUT_DIR" \
      xcodebuild "$@" -resultBundlePath "$result_bundle_path" >"$attempt_log" 2>&1
    rc=$?
    set -e

    cat "$attempt_log" >>"$log_path"
    echo >>"$log_path"

    if [[ "$rc" -eq 0 ]]; then
      break
    fi

    if [[ "$attempt" -lt "$max_attempts" ]] && is_ui_bootstrap_failure "$attempt_log"; then
      echo "[ci-xctest] bootstrap-flake detected for $step_name; retrying after process cleanup" | tee -a "$log_path"
      cleanup_ui_test_processes
      sleep 2
      continue
    fi

    break
  done

  record_step "$step_name" "$required" "$rc" "$log_path" "$result_bundle_path"
}

run_step \
  prepare_runtime_inputs \
  1 \
  "" \
  env RECORDIT_RUNTIME_CONFIGURATION="$XCTEST_CONFIGURATION" RECORDIT_RUNTIME_INPUT_DIR="$RUNTIME_INPUT_DIR" \
  "$ROOT/scripts/prepare_recordit_runtime_inputs.sh"

run_xcodebuild_step \
  build_for_testing \
  1 \
  "$RESULT_DIR/build_for_testing.xcresult" \
  build-for-testing \
  -project "$ROOT/Recordit.xcodeproj" \
  -scheme RecorditApp \
  -configuration "$XCTEST_CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH"

run_xcodebuild_step \
  unit_tests \
  1 \
  "$RESULT_DIR/recordit_app_tests.xcresult" \
  test \
  -project "$ROOT/Recordit.xcodeproj" \
  -scheme RecorditApp \
  -configuration "$XCTEST_CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -only-testing:RecorditAppTests

run_step \
  responsiveness_budget_gate \
  1 \
  "$RESULT_DIR/responsiveness_budget_gate.xcresult" \
  env RECORDIT_RESPONSIVENESS_ARTIFACT_PATH="$RESPONSIVENESS_SUMMARY_CSV" RECORDIT_RUNTIME_INPUT_DIR="$RUNTIME_INPUT_DIR" \
  xcodebuild \
  test \
  -project "$ROOT/Recordit.xcodeproj" \
  -scheme RecorditApp \
  -configuration "$XCTEST_CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -resultBundlePath "$RESULT_DIR/responsiveness_budget_gate.xcresult" \
  -only-testing:RecorditAppTests/RecorditAppTests/testAppLevelResponsivenessBudgetsForLiveRun

xctestrun_path="$(find "$DERIVED_DATA_PATH/Build/Products" -name '*.xctestrun' | head -n 1 || true)"
if [[ -z "$xctestrun_path" ]]; then
  echo "[ci-xctest] error: missing xctestrun file under $DERIVED_DATA_PATH/Build/Products"
  record_step "discover_xctestrun" 1 1 "" ""
else
  ui_required=0
  if [[ "$STRICT_UI_TESTS" == "1" ]]; then
    ui_required=1
  fi

  run_xcodebuild_ui_step_with_bootstrap_retry \
    uitest_onboarding_happy_path \
    "$ui_required" \
    "$RESULT_DIR/uitest_onboarding_happy_path.xcresult" \
    test-without-building \
    -xctestrun "$xctestrun_path" \
    -destination "$DESTINATION" \
    -only-testing:RecorditAppUITests/RecorditAppUITests/testFirstRunOnboardingHappyPathTransitionsToMainRuntime

  run_xcodebuild_ui_step_with_bootstrap_retry \
    uitest_permission_recovery \
    "$ui_required" \
    "$RESULT_DIR/uitest_permission_recovery.xcresult" \
    test-without-building \
    -xctestrun "$xctestrun_path" \
    -destination "$DESTINATION" \
    -only-testing:RecorditAppUITests/RecorditAppUITests/testPermissionDenialRemediationRecoversToOnboardingProgression

  run_xcodebuild_ui_step_with_bootstrap_retry \
    uitest_live_run_summary \
    "$ui_required" \
    "$RESULT_DIR/uitest_live_run_summary.xcresult" \
    test-without-building \
    -xctestrun "$xctestrun_path" \
    -destination "$DESTINATION" \
    -only-testing:RecorditAppUITests/RecorditAppUITests/testLiveRunStartStopShowsRuntimeStatusTranscriptAndSummary

  run_xcodebuild_ui_step_with_bootstrap_retry \
    uitest_runtime_recovery \
    "$ui_required" \
    "$RESULT_DIR/uitest_runtime_recovery.xcresult" \
    test-without-building \
    -xctestrun "$xctestrun_path" \
    -destination "$DESTINATION" \
    -only-testing:RecorditAppUITests/RecorditAppUITests/testRuntimeStopFailureShowsRecoveryAffordances
fi

step_result() {
  local step_name="$1"
  awk -F, -v name="$step_name" '$1 == name { value=$4 } END { if (value != "") print value }' "$STATUS_CSV"
}

csv_value() {
  local key="$1"
  local path="$2"
  if [[ ! -f "$path" ]]; then
    return 1
  fi
  awk -F, -v lookup="$key" '$1 == lookup { value=$2 } END { if (value != "") print value }' "$path"
}

responsiveness_step_result="$(step_result responsiveness_budget_gate)"
responsiveness_artifact_from_test=false
if [[ -f "$RESPONSIVENESS_SUMMARY_CSV" ]]; then
  responsiveness_artifact_from_test=true
fi
threshold_first_stable_transcript_budget_ok="$(csv_value threshold_first_stable_transcript_budget_ok "$RESPONSIVENESS_SUMMARY_CSV" || true)"
threshold_stop_to_summary_budget_ok="$(csv_value threshold_stop_to_summary_budget_ok "$RESPONSIVENESS_SUMMARY_CSV" || true)"
responsiveness_gate_pass="$(csv_value gate_pass "$RESPONSIVENESS_SUMMARY_CSV" || true)"
first_stable_transcript_observed_ms="$(csv_value first_stable_transcript_observed_ms "$RESPONSIVENESS_SUMMARY_CSV" || true)"
stop_to_summary_observed_ms="$(csv_value stop_to_summary_observed_ms "$RESPONSIVENESS_SUMMARY_CSV" || true)"

if [[ -z "$threshold_first_stable_transcript_budget_ok" ]]; then
  threshold_first_stable_transcript_budget_ok=$([[ "$responsiveness_step_result" == "pass" ]] && echo true || echo false)
fi
if [[ -z "$threshold_stop_to_summary_budget_ok" ]]; then
  threshold_stop_to_summary_budget_ok=$([[ "$responsiveness_step_result" == "pass" ]] && echo true || echo false)
fi
if [[ -z "$responsiveness_gate_pass" ]]; then
  responsiveness_gate_pass=$([[ "$responsiveness_step_result" == "pass" ]] && echo true || echo false)
fi

cat >"$RESPONSIVENESS_SUMMARY_CSV" <<CSV
artifact_track,recordit_app_responsiveness
source_test_artifact_present,$responsiveness_artifact_from_test
threshold_first_stable_transcript_budget_ok,$threshold_first_stable_transcript_budget_ok
threshold_stop_to_summary_budget_ok,$threshold_stop_to_summary_budget_ok
gate_pass,$responsiveness_gate_pass
first_stable_transcript_observed_ms,$first_stable_transcript_observed_ms
stop_to_summary_observed_ms,$stop_to_summary_observed_ms
CSV

cat >"$SUMMARY_CSV" <<CSV
artifact_track,ci_xctest_evidence
stamp,$STAMP
out_dir,$OUT_DIR
destination,$DESTINATION
strict_ui_tests,$STRICT_UI_TESTS
responsiveness_summary_csv,$RESPONSIVENESS_SUMMARY_CSV
steps_total,$steps_total
steps_failed,$steps_failed
required_failed,$required_failed
overall_status,$([[ "$overall_failure" -eq 0 ]] && echo pass || echo fail)
threshold_first_stable_transcript_budget_ok,$threshold_first_stable_transcript_budget_ok
threshold_stop_to_summary_budget_ok,$threshold_stop_to_summary_budget_ok
responsiveness_gate_pass,$responsiveness_gate_pass
first_stable_transcript_observed_ms,$first_stable_transcript_observed_ms
stop_to_summary_observed_ms,$stop_to_summary_observed_ms
CSV

echo "[ci-xctest] status_csv=$STATUS_CSV"
echo "[ci-xctest] summary_csv=$SUMMARY_CSV"

if [[ "$overall_failure" -ne 0 ]]; then
  echo "[ci-xctest] required steps failed"
  exit 1
fi

echo "[ci-xctest] completed"
