#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

SCENARIO_ID="default_user_journey_recordit_app"
OUT_DIR="${OUT_DIR:-}"

DMG_OUT_DIR="${DMG_OUT_DIR:-}"
XCTEST_OUT_DIR="${XCTEST_OUT_DIR:-}"
PACKAGED_LIVE_OUT_DIR="${PACKAGED_LIVE_OUT_DIR:-}"

RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
RECORDIT_DMG="${RECORDIT_DMG:-$ROOT/dist/Recordit.dmg}"
RECORDIT_DMG_VOLNAME="${RECORDIT_DMG_VOLNAME:-Recordit}"
PACKAGED_ROOT="${PACKAGED_ROOT:-$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"

SIGN_IDENTITY="${SIGN_IDENTITY:--}"
XCTEST_CONFIGURATION="${XCTEST_CONFIGURATION:-Debug}"
STRICT_UI_TESTS="${STRICT_UI_TESTS:-1}"

DURATION_SEC="${DURATION_SEC:-3}"
CHUNK_WINDOW_MS="${CHUNK_WINDOW_MS:-1800}"
CHUNK_STRIDE_MS="${CHUNK_STRIDE_MS:-300}"
CHUNK_QUEUE_CAP="${CHUNK_QUEUE_CAP:-4}"

OPEN_WAIT_SEC="${OPEN_WAIT_SEC:-3}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_DMG_BUILD="${SKIP_DMG_BUILD:-0}"

SKIP_DMG_PHASE=0
SKIP_XCTEST_PHASE=0
SKIP_PACKAGED_LIVE_PHASE=0
ALLOW_CAPABILITY_GATED=0

usage() {
  cat <<'USAGE'
Usage: gate_default_user_journey_e2e.sh [options]

Run the canonical default-user-journey verification lane:
1. DMG install/open proof (`gate_dmg_install_open.sh`)
2. onboarding + live-run UI evidence (`ci_recordit_xctest_evidence.sh`)
3. packaged live artifact/start-stop proof (`gate_packaged_live_smoke.sh`)
4. journey-level summary checks and one retained hybrid evidence contract root.

Options:
  --out-dir PATH                    Root evidence output directory
  --dmg-out-dir PATH                Child output for gate_dmg_install_open (default: <out>/dmg_install_open)
  --xctest-out-dir PATH             Child output for ci_recordit_xctest_evidence (default: <out>/xctest_evidence)
  --packaged-live-out-dir PATH      Child output for gate_packaged_live_smoke (default: <out>/packaged_live_smoke)

  --recordit-app-bundle PATH        Recordit.app bundle for DMG lane (default: dist/Recordit.app)
  --recordit-dmg PATH               DMG path for DMG lane (default: dist/Recordit.dmg)
  --dmg-volname VALUE               DMG volume name (default: Recordit)
  --packaged-root PATH              Packaged root used by packaged-live lane
  --model PATH                      ASR model for packaged-live lane
  --fixture PATH                    Input fixture wav for packaged-live lane

  --sign-identity VALUE             Codesign identity passed to child lanes (default: -)
  --xctest-configuration VALUE      Xcode configuration for xctest lane (default: Debug)
  --strict-ui-tests 0|1             CI_STRICT_UI_TESTS for xctest lane (default: 1)

  --duration-sec N                  Packaged live duration (default: 3)
  --chunk-window-ms N               Packaged live chunk window (default: 1800)
  --chunk-stride-ms N               Packaged live chunk stride (default: 300)
  --chunk-queue-cap N               Packaged live queue cap (default: 4)

  --open-wait-sec N                 DMG lane open wait seconds (default: 3)
  --skip-build                      Forwarded to DMG lane
  --skip-dmg-build                  Forwarded to DMG lane

  --skip-dmg-phase                  Skip DMG phase (requires --allow-capability-gated)
  --skip-xctest-phase               Skip xctest/xcuitest phase (requires --allow-capability-gated)
  --skip-packaged-live-phase        Skip packaged live phase (requires --allow-capability-gated)
  --allow-capability-gated          Permit skip flags and report a warn-capable hybrid root

  -h, --help                        Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --dmg-out-dir)
      DMG_OUT_DIR="$2"
      shift 2
      ;;
    --xctest-out-dir)
      XCTEST_OUT_DIR="$2"
      shift 2
      ;;
    --packaged-live-out-dir)
      PACKAGED_LIVE_OUT_DIR="$2"
      shift 2
      ;;
    --recordit-app-bundle)
      RECORDIT_APP_BUNDLE="$2"
      shift 2
      ;;
    --recordit-dmg)
      RECORDIT_DMG="$2"
      shift 2
      ;;
    --dmg-volname)
      RECORDIT_DMG_VOLNAME="$2"
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
    --xctest-configuration)
      XCTEST_CONFIGURATION="$2"
      shift 2
      ;;
    --strict-ui-tests)
      STRICT_UI_TESTS="$2"
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
    --open-wait-sec)
      OPEN_WAIT_SEC="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-dmg-build)
      SKIP_DMG_BUILD=1
      shift
      ;;
    --skip-dmg-phase)
      SKIP_DMG_PHASE=1
      shift
      ;;
    --skip-xctest-phase)
      SKIP_XCTEST_PHASE=1
      shift
      ;;
    --skip-packaged-live-phase)
      SKIP_PACKAGED_LIVE_PHASE=1
      shift
      ;;
    --allow-capability-gated)
      ALLOW_CAPABILITY_GATED=1
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

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 2
fi

if [[ "$SKIP_DMG_PHASE" == "1" || "$SKIP_XCTEST_PHASE" == "1" || "$SKIP_PACKAGED_LIVE_PHASE" == "1" ]]; then
  if [[ "$ALLOW_CAPABILITY_GATED" != "1" ]]; then
    echo "error: skip-phase flags require --allow-capability-gated" >&2
    exit 2
  fi
fi

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/ops/gate_default_user_journey_e2e/$STAMP"
fi

abs_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
}

OUT_DIR="$(abs_path "$OUT_DIR")"
RECORDIT_APP_BUNDLE="$(abs_path "$RECORDIT_APP_BUNDLE")"
RECORDIT_DMG="$(abs_path "$RECORDIT_DMG")"
PACKAGED_ROOT="$(abs_path "$PACKAGED_ROOT")"
MODEL="$(abs_path "$MODEL")"
FIXTURE="$(abs_path "$FIXTURE")"

if [[ -z "$DMG_OUT_DIR" ]]; then
  DMG_OUT_DIR="$OUT_DIR/dmg_install_open"
fi
if [[ -z "$XCTEST_OUT_DIR" ]]; then
  XCTEST_OUT_DIR="$OUT_DIR/xctest_evidence"
fi
if [[ -z "$PACKAGED_LIVE_OUT_DIR" ]]; then
  PACKAGED_LIVE_OUT_DIR="$OUT_DIR/packaged_live_smoke"
fi

DMG_OUT_DIR="$(abs_path "$DMG_OUT_DIR")"
XCTEST_OUT_DIR="$(abs_path "$XCTEST_OUT_DIR")"
PACKAGED_LIVE_OUT_DIR="$(abs_path "$PACKAGED_LIVE_OUT_DIR")"

mkdir -p "$OUT_DIR" "$OUT_DIR/logs" "$OUT_DIR/artifacts"

PHASES_NDJSON="$OUT_DIR/artifacts/phases.ndjson"
PHASE_MANIFEST="$OUT_DIR/artifacts/phases.json"
STATUS_JSON="$OUT_DIR/status.json"
JOURNEY_CHECKS_CSV="$OUT_DIR/artifacts/default_user_journey_checks.csv"
JOURNEY_CHECKS_JSON="$OUT_DIR/artifacts/default_user_journey_checks.json"
: > "$PHASES_NDJSON"

export ROOT
export DMG_OUT_DIR
export XCTEST_OUT_DIR
export PACKAGED_LIVE_OUT_DIR
export RECORDIT_APP_BUNDLE
export RECORDIT_DMG
export RECORDIT_DMG_VOLNAME
export PACKAGED_ROOT
export MODEL
export FIXTURE
export SIGN_IDENTITY
export XCTEST_CONFIGURATION
export STRICT_UI_TESTS
export DURATION_SEC
export CHUNK_WINDOW_MS
export CHUNK_STRIDE_MS
export CHUNK_QUEUE_CAP
export OPEN_WAIT_SEC
export SKIP_BUILD
export SKIP_DMG_BUILD
export JOURNEY_CHECKS_CSV
export JOURNEY_CHECKS_JSON

json_array_from_args() {
  python3 - "$@" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1:]))
PY
}

append_phase_record() {
  local phase_id="$1"
  local title="$2"
  local required="$3"
  local status="$4"
  local exit_classification="$5"
  local started_at_utc="$6"
  local ended_at_utc="$7"
  local command_display="$8"
  local command_argv_json="$9"
  local log_relpath="${10}"
  local stdout_relpath="${11}"
  local stderr_relpath="${12}"
  local primary_artifact_relpath="${13}"
  local notes="${14:-}"

  python3 - "$phase_id" "$title" "$required" "$status" "$exit_classification" "$started_at_utc" "$ended_at_utc" "$command_display" "$command_argv_json" "$log_relpath" "$stdout_relpath" "$stderr_relpath" "$primary_artifact_relpath" "$notes" >> "$PHASES_NDJSON" <<'PY'
import json
import sys

(
    phase_id,
    title,
    required,
    status,
    exit_classification,
    started_at_utc,
    ended_at_utc,
    command_display,
    command_argv_json,
    log_relpath,
    stdout_relpath,
    stderr_relpath,
    primary_artifact_relpath,
    notes,
) = sys.argv[1:]

payload = {
    "phase_id": phase_id,
    "title": title,
    "required": required == "true",
    "status": status,
    "exit_classification": exit_classification,
    "started_at_utc": started_at_utc,
    "ended_at_utc": ended_at_utc,
    "command_display": command_display,
    "command_argv": json.loads(command_argv_json),
    "log_relpath": log_relpath,
    "stdout_relpath": stdout_relpath,
    "stderr_relpath": stderr_relpath,
    "primary_artifact_relpath": primary_artifact_relpath,
}
if notes:
    payload["notes"] = notes
print(json.dumps(payload, sort_keys=True))
PY
}

run_phase_script() {
  local phase_id="$1"
  local title="$2"
  local required="$3"
  local failure_classification="$4"
  local script_body="$5"

  local primary_relpath="artifacts/${phase_id}.txt"
  local log_relpath="logs/${phase_id}.log"
  local stdout_relpath="logs/${phase_id}.stdout"
  local stderr_relpath="logs/${phase_id}.stderr"

  local command_display="bash -lc ${script_body//$'\n'/ }"
  local command_argv_json
  command_argv_json="$(json_array_from_args bash -lc "$script_body")"

  local started_at_utc
  local ended_at_utc
  local exit_code
  local status
  local exit_classification
  local notes=""

  started_at_utc="$(evidence_timestamp)"
  set +e
  evidence_capture_command_logs \
    "$OUT_DIR/$log_relpath" \
    "$OUT_DIR/$stdout_relpath" \
    "$OUT_DIR/$stderr_relpath" \
    bash -lc "$script_body"
  exit_code=$?
  set -e
  ended_at_utc="$(evidence_timestamp)"

  if [[ "$exit_code" -eq 0 ]]; then
    status="pass"
    exit_classification="success"
  else
    status="fail"
    exit_classification="$failure_classification"
    notes="command exited with code $exit_code"
  fi

  {
    printf 'phase_id=%s\n' "$phase_id"
    printf 'status=%s\n' "$status"
    printf 'required=%s\n' "$required"
    printf 'exit_code=%s\n' "$exit_code"
    printf 'started_at_utc=%s\n' "$started_at_utc"
    printf 'ended_at_utc=%s\n' "$ended_at_utc"
    printf 'command_display=%s\n' "$command_display"
  } > "$OUT_DIR/$primary_relpath"

  append_phase_record \
    "$phase_id" \
    "$title" \
    "$required" \
    "$status" \
    "$exit_classification" \
    "$started_at_utc" \
    "$ended_at_utc" \
    "$command_display" \
    "$command_argv_json" \
    "$log_relpath" \
    "$stdout_relpath" \
    "$stderr_relpath" \
    "$primary_relpath" \
    "$notes"

  [[ "$status" == "pass" ]]
}

record_skipped_phase() {
  local phase_id="$1"
  local title="$2"
  local required="$3"
  local notes="$4"
  local script_body="$5"

  local primary_relpath="artifacts/${phase_id}.txt"
  local log_relpath="logs/${phase_id}.log"
  local stdout_relpath="logs/${phase_id}.stdout"
  local stderr_relpath="logs/${phase_id}.stderr"

  local now
  now="$(evidence_timestamp)"
  local command_display="bash -lc ${script_body//$'\n'/ }"
  local command_argv_json
  command_argv_json="$(json_array_from_args bash -lc "$script_body")"

  : > "$OUT_DIR/$log_relpath"
  : > "$OUT_DIR/$stdout_relpath"
  : > "$OUT_DIR/$stderr_relpath"
  {
    printf 'phase_id=%s\n' "$phase_id"
    printf 'status=skipped\n'
    printf 'required=%s\n' "$required"
    printf 'notes=%s\n' "$notes"
  } > "$OUT_DIR/$primary_relpath"

  append_phase_record \
    "$phase_id" \
    "$title" \
    "$required" \
    "skipped" \
    "skip_requested" \
    "$now" \
    "$now" \
    "$command_display" \
    "$command_argv_json" \
    "$log_relpath" \
    "$stdout_relpath" \
    "$stderr_relpath" \
    "$primary_relpath" \
    "$notes"
}

PIPELINE_BLOCKED=0
CAPABILITY_GATED=0
if [[ "$SKIP_DMG_PHASE" == "1" || "$SKIP_XCTEST_PHASE" == "1" || "$SKIP_PACKAGED_LIVE_PHASE" == "1" ]]; then
  CAPABILITY_GATED=1
fi

run_dmg_script=$(cat <<'RUN_DMG'
env \
  ROOT="$ROOT" \
  OUT_DIR="$DMG_OUT_DIR" \
  RECORDIT_APP_BUNDLE="$RECORDIT_APP_BUNDLE" \
  RECORDIT_DMG="$RECORDIT_DMG" \
  RECORDIT_DMG_VOLNAME="$RECORDIT_DMG_VOLNAME" \
  SIGN_IDENTITY="$SIGN_IDENTITY" \
  OPEN_WAIT_SEC="$OPEN_WAIT_SEC" \
  SKIP_BUILD="$SKIP_BUILD" \
  SKIP_DMG_BUILD="$SKIP_DMG_BUILD" \
  "$ROOT/scripts/gate_dmg_install_open.sh"
RUN_DMG
)

if [[ "$SKIP_DMG_PHASE" == "1" ]]; then
  record_skipped_phase "dmg_install_open" "DMG install/open verification" "false" "skip-dmg-phase requested" "$run_dmg_script"
elif [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "dmg_install_open" "DMG install/open verification" "true" "blocked by prior required failure" "$run_dmg_script"
elif ! run_phase_script "dmg_install_open" "DMG install/open verification" "true" "product_failure" "$run_dmg_script"; then
  PIPELINE_BLOCKED=1
fi

run_xctest_script=$(cat <<'RUN_XCTEST'
env \
  ROOT="$ROOT" \
  XCTEST_EVIDENCE_OUT_DIR="$XCTEST_OUT_DIR" \
  CI_STRICT_UI_TESTS="$STRICT_UI_TESTS" \
  XCTEST_CONFIGURATION="$XCTEST_CONFIGURATION" \
  "$ROOT/scripts/ci_recordit_xctest_evidence.sh"
RUN_XCTEST
)

if [[ "$SKIP_XCTEST_PHASE" == "1" ]]; then
  record_skipped_phase "onboarding_and_live_ui" "Onboarding completion + live-run UI evidence" "false" "skip-xctest-phase requested" "$run_xctest_script"
elif [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "onboarding_and_live_ui" "Onboarding completion + live-run UI evidence" "true" "blocked by prior required failure" "$run_xctest_script"
elif ! run_phase_script "onboarding_and_live_ui" "Onboarding completion + live-run UI evidence" "true" "product_failure" "$run_xctest_script"; then
  PIPELINE_BLOCKED=1
fi

run_packaged_live_script=$(cat <<'RUN_PACKAGED'
env \
  ROOT="$ROOT" \
  OUT_DIR="$PACKAGED_LIVE_OUT_DIR" \
  PACKAGED_ROOT="$PACKAGED_ROOT" \
  MODEL="$MODEL" \
  FIXTURE="$FIXTURE" \
  SIGN_IDENTITY="$SIGN_IDENTITY" \
  DURATION_SEC="$DURATION_SEC" \
  CHUNK_WINDOW_MS="$CHUNK_WINDOW_MS" \
  CHUNK_STRIDE_MS="$CHUNK_STRIDE_MS" \
  CHUNK_QUEUE_CAP="$CHUNK_QUEUE_CAP" \
  "$ROOT/scripts/gate_packaged_live_smoke.sh"
RUN_PACKAGED
)

if [[ "$SKIP_PACKAGED_LIVE_PHASE" == "1" ]]; then
  record_skipped_phase "packaged_live_start_stop" "Packaged first live start/stop + artifact verification" "false" "skip-packaged-live-phase requested" "$run_packaged_live_script"
elif [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "packaged_live_start_stop" "Packaged first live start/stop + artifact verification" "true" "blocked by prior required failure" "$run_packaged_live_script"
elif ! run_phase_script "packaged_live_start_stop" "Packaged first live start/stop + artifact verification" "true" "product_failure" "$run_packaged_live_script"; then
  PIPELINE_BLOCKED=1
fi

run_journey_summary_script=$(cat <<'RUN_JOURNEY_SUMMARY'
SUMMARY_ARGS=(
  --dmg-status "$DMG_OUT_DIR/status.txt"
  --xctest-status-csv "$XCTEST_OUT_DIR/status.csv"
  --xctest-summary-json "$XCTEST_OUT_DIR/contracts/xctest/summary.json"
  --xcuitest-summary-json "$XCTEST_OUT_DIR/contracts/xcuitest/summary.json"
  --packaged-summary-csv "$PACKAGED_LIVE_OUT_DIR/summary.csv"
  --packaged-status-txt "$PACKAGED_LIVE_OUT_DIR/status.txt"
  --out-csv "$JOURNEY_CHECKS_CSV"
  --out-json "$JOURNEY_CHECKS_JSON"
)
if [[ "$CAPABILITY_GATED" != "1" ]]; then
  SUMMARY_ARGS+=(--require-pass)
fi
python3 "$ROOT/scripts/gate_default_user_journey_e2e_summary.py" "${SUMMARY_ARGS[@]}"
RUN_JOURNEY_SUMMARY
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "journey_summary_checks" "Journey-level summary validation" "true" "blocked by prior required failure" "$run_journey_summary_script"
else
  summary_required="true"
  if [[ "$CAPABILITY_GATED" == "1" ]]; then
    summary_required="false"
  fi
  if ! run_phase_script "journey_summary_checks" "Journey-level summary validation" "$summary_required" "contract_failure" "$run_journey_summary_script"; then
    if [[ "$summary_required" == "true" ]]; then
      PIPELINE_BLOCKED=1
    fi
  fi
fi

python3 - "$PHASES_NDJSON" "$PHASE_MANIFEST" <<'PY'
import json
import sys
from pathlib import Path

ndjson = Path(sys.argv[1])
out_path = Path(sys.argv[2])
phases = []
for raw in ndjson.read_text(encoding='utf-8').splitlines():
    line = raw.strip()
    if not line:
        continue
    phases.append(json.loads(line))
out_path.write_text(json.dumps({"phases": phases}, indent=2, sort_keys=True) + "\n", encoding='utf-8')
PY

evidence_render_contract \
  "$OUT_DIR" \
  "$SCENARIO_ID" \
  "hybrid-e2e" \
  "$PHASE_MANIFEST" \
  --generated-at-utc "$(evidence_timestamp)" \
  --artifact-root-relpath "artifacts" \
  --paths-env-entry "DMG_OUT_DIR=$DMG_OUT_DIR" \
  --paths-env-entry "XCTEST_OUT_DIR=$XCTEST_OUT_DIR" \
  --paths-env-entry "PACKAGED_LIVE_OUT_DIR=$PACKAGED_LIVE_OUT_DIR" \
  --paths-env-entry "JOURNEY_CHECKS_CSV=$JOURNEY_CHECKS_CSV" \
  --paths-env-entry "JOURNEY_CHECKS_JSON=$JOURNEY_CHECKS_JSON"

evidence_kv_text_to_json "$OUT_DIR/status.txt" "$STATUS_JSON"

echo "GATE_DEFAULT_USER_JOURNEY_OUT=$OUT_DIR"
echo "GATE_DEFAULT_USER_JOURNEY_SUMMARY=$OUT_DIR/summary.csv"
echo "GATE_DEFAULT_USER_JOURNEY_STATUS=$OUT_DIR/status.txt"
echo "GATE_DEFAULT_USER_JOURNEY_STATUS_JSON=$STATUS_JSON"

action_status="$(awk -F= '$1=="status" {print $2}' "$OUT_DIR/status.txt" | tail -n 1)"
if [[ "$action_status" == "fail" ]]; then
  exit 1
fi
