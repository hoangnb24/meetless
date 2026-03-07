#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/gate_stop_finalization_stress.sh [--artifact-root DIR] [--keep-going]

Runs stop/finalization stress lanes with scenario-labeled logs and per-scenario artifact roots.

Options:
  --artifact-root DIR  Root directory for scenario outputs
  --keep-going         Continue running remaining scenarios after a failure
  -h, --help           Show this help
EOF
}

ARTIFACT_ROOT=""
KEEP_GOING=0

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
  ARTIFACT_ROOT="artifacts/validation/bd-3niz/stop-stress-$(date -u +%Y%m%dT%H%M%SZ)"
fi

mkdir -p "$ARTIFACT_ROOT"
SUMMARY_CSV="$ARTIFACT_ROOT/summary.csv"
printf 'scenario,status,artifact_root,stdout_log,stderr_log\n' > "$SUMMARY_CSV"

FAIL_COUNT=0

run_scenario() {
  local scenario_id="$1"
  local artifact_env_name="$2"
  shift 2
  local scenario_root="$ARTIFACT_ROOT/$scenario_id"
  local stdout_log="$scenario_root/stdout.log"
  local stderr_log="$scenario_root/stderr.log"

  mkdir -p "$scenario_root"

  local status="pass"
  if [[ -n "$artifact_env_name" ]]; then
    local lane_artifacts="$scenario_root/artifacts"
    mkdir -p "$lane_artifacts"
    if ! env "$artifact_env_name=$lane_artifacts" "$@" >"$stdout_log" 2>"$stderr_log"; then
      status="fail"
    fi
  else
    if ! "$@" >"$stdout_log" 2>"$stderr_log"; then
      status="fail"
    fi
  fi

  printf '%s,%s,%s,%s,%s\n' \
    "$scenario_id" \
    "$status" \
    "$scenario_root" \
    "$stdout_log" \
    "$stderr_log" >> "$SUMMARY_CSV"

  if [[ "$status" == "fail" ]]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ "$KEEP_GOING" -ne 1 ]]; then
      return 1
    fi
  fi

  return 0
}

RUNTIME_STOP_BIN="$ARTIFACT_ROOT/runtime_stop_finalization_smoke.bin"
PROCESS_LIFECYCLE_BIN="$ARTIFACT_ROOT/process_lifecycle_integration_smoke.bin"

swiftc \
  app/Services/ServiceInterfaces.swift \
  app/Accessibility/AccessibilityContracts.swift \
  app/RuntimeStatus/ManifestFinalStatusMapper.swift \
  app/ViewModels/RuntimeViewModel.swift \
  app/ViewModels/runtime_stop_finalization_smoke.swift \
  -o "$RUNTIME_STOP_BIN"

swiftc \
  app/Accessibility/AccessibilityContracts.swift \
  app/Services/ServiceInterfaces.swift \
  app/Services/PendingSessionSidecarService.swift \
  app/Services/PendingSessionTransitionService.swift \
  app/Services/PendingSessionFinalizerService.swift \
  app/Services/PendingSessionTranscriptionService.swift \
  app/RuntimeStatus/ManifestFinalStatusMapper.swift \
  app/ViewModels/RuntimeViewModel.swift \
  app/Integration/process_lifecycle_integration_smoke.swift \
  -o "$PROCESS_LIFECYCLE_BIN"

run_scenario "runtime_stop_finalization_smoke" "RECORDIT_RUNTIME_STOP_FINALIZATION_SMOKE_ROOT" "$RUNTIME_STOP_BIN"
run_scenario "process_lifecycle_integration_smoke" "RECORDIT_PROCESS_LIFECYCLE_SMOKE_ROOT" "$PROCESS_LIFECYCLE_BIN"
run_scenario "live_stream_stop_marker_finalize_integration" "" cargo test --test live_stream_stop_marker_finalize_integration -- --nocapture

echo "$SUMMARY_CSV"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

