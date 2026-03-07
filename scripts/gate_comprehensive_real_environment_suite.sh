#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

SCENARIO_ID="recordit_comprehensive_real_environment_suite"
OUT_DIR="${OUT_DIR:-}"

DEFAULT_JOURNEY_OUT_DIR="${DEFAULT_JOURNEY_OUT_DIR:-}"
STOP_TAXONOMY_OUT_DIR="${STOP_TAXONOMY_OUT_DIR:-}"
RELEASE_CONTEXT_OUT_DIR="${RELEASE_CONTEXT_OUT_DIR:-}"
ANTI_BYPASS_OUT_DIR="${ANTI_BYPASS_OUT_DIR:-}"
MOCK_EXCEPTION_OUT_DIR="${MOCK_EXCEPTION_OUT_DIR:-}"

RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
RECORDIT_DMG="${RECORDIT_DMG:-$ROOT/dist/Recordit.dmg}"
PACKAGED_ROOT="${PACKAGED_ROOT:-$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta}"
MODEL="${MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
OFFLINE_INPUT="${OFFLINE_INPUT:-$ROOT/artifacts/bench/corpus/gate_a/tts_phrase.wav}"

SIGN_IDENTITY="${SIGN_IDENTITY:--}"
XCTEST_CONFIGURATION="${XCTEST_CONFIGURATION:-Debug}"
STRICT_UI_TESTS="${STRICT_UI_TESTS:-1}"
CLAIM_LEVEL="${CLAIM_LEVEL:-real-environment-verified}"
POLICY_MODE="${POLICY_MODE:-fail}"
SKIP_BUILD="${SKIP_BUILD:-0}"

ALLOW_CAPABILITY_GATED=0
DRY_RUN=0

SKIP_DEFAULT_JOURNEY_PHASE=0
SKIP_STOP_TAXONOMY_PHASE=0
SKIP_RELEASE_CONTEXT_PHASE=0
SKIP_ANTI_BYPASS_PHASE=0
SKIP_MOCK_EXCEPTION_PHASE=0

usage() {
  cat <<'USAGE'
Usage: gate_comprehensive_real_environment_suite.sh [options]

Runs the master comprehensive real-environment verification orchestration for Recordit.
The suite executes these lanes (unless explicitly skipped/capability-gated):
1. default-user-journey packaged app proof
2. packaged stop/finalization taxonomy proof
3. release-context verification (codesign/runtime payload/Gatekeeper posture)
4. anti-bypass certifying-claim guard
5. mock/fixture exception-register enforcement guard

Preflight checks always record capability and environment posture, including:
- signing/build inputs
- model/fixture/runtime artifact paths
- macOS + command availability assumptions
- GUI/TCC expectations for UI-driven phases
- deterministic evidence root layout and contract references

Options:
  --out-dir PATH                      Root evidence output directory
  --default-journey-out-dir PATH      Child output for gate_default_user_journey_e2e.sh
  --stop-taxonomy-out-dir PATH        Child output for gate_packaged_stop_finalization_taxonomy.sh
  --release-context-out-dir PATH      Child output for verify_recordit_release_context.sh
  --anti-bypass-out-dir PATH          Child output for gate_anti_bypass_claims.sh
  --mock-exception-out-dir PATH       Child output for gate_mock_exception_register.sh

  --recordit-app-bundle PATH          Recordit.app bundle path
  --recordit-dmg PATH                 Recordit.dmg path
  --packaged-root PATH                Packaged artifacts root used by packaged lanes
  --model PATH                        ASR model path
  --fixture PATH                      Live fixture WAV path
  --offline-input PATH                Offline fallback WAV path

  --sign-identity VALUE               Codesign identity passed to child lanes (default: -)
  --xctest-configuration VALUE        xcodebuild configuration for default journey lane
  --strict-ui-tests 0|1               strict UI mode for default journey lane
  --claim-level LEVEL                 anti-bypass claim level (real-environment-verified|partial|simulation-covered)
  --policy-mode MODE                  mock exception policy mode (fail|warn)
  --skip-build                        forward skip-build to child lanes that support it

  --allow-capability-gated            permit preflight capability gating instead of hard-fail
  --dry-run                           emit full orchestration contract without executing child lanes

  --skip-default-journey-phase        skip default journey lane (requires --allow-capability-gated)
  --skip-stop-taxonomy-phase          skip stop taxonomy lane (requires --allow-capability-gated)
  --skip-release-context-phase        skip release-context lane (requires --allow-capability-gated)
  --skip-anti-bypass-phase            skip anti-bypass lane (requires --allow-capability-gated)
  --skip-mock-exception-phase         skip mock-exception lane (requires --allow-capability-gated)

  -h, --help                          Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --default-journey-out-dir)
      DEFAULT_JOURNEY_OUT_DIR="$2"
      shift 2
      ;;
    --stop-taxonomy-out-dir)
      STOP_TAXONOMY_OUT_DIR="$2"
      shift 2
      ;;
    --release-context-out-dir)
      RELEASE_CONTEXT_OUT_DIR="$2"
      shift 2
      ;;
    --anti-bypass-out-dir)
      ANTI_BYPASS_OUT_DIR="$2"
      shift 2
      ;;
    --mock-exception-out-dir)
      MOCK_EXCEPTION_OUT_DIR="$2"
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
    --offline-input)
      OFFLINE_INPUT="$2"
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
    --claim-level)
      CLAIM_LEVEL="$2"
      shift 2
      ;;
    --policy-mode)
      POLICY_MODE="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --allow-capability-gated)
      ALLOW_CAPABILITY_GATED=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-default-journey-phase)
      SKIP_DEFAULT_JOURNEY_PHASE=1
      shift
      ;;
    --skip-stop-taxonomy-phase)
      SKIP_STOP_TAXONOMY_PHASE=1
      shift
      ;;
    --skip-release-context-phase)
      SKIP_RELEASE_CONTEXT_PHASE=1
      shift
      ;;
    --skip-anti-bypass-phase)
      SKIP_ANTI_BYPASS_PHASE=1
      shift
      ;;
    --skip-mock-exception-phase)
      SKIP_MOCK_EXCEPTION_PHASE=1
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

if [[ "$SKIP_DEFAULT_JOURNEY_PHASE" == "1" || "$SKIP_STOP_TAXONOMY_PHASE" == "1" || "$SKIP_RELEASE_CONTEXT_PHASE" == "1" || "$SKIP_ANTI_BYPASS_PHASE" == "1" || "$SKIP_MOCK_EXCEPTION_PHASE" == "1" ]]; then
  if [[ "$ALLOW_CAPABILITY_GATED" != "1" ]]; then
    echo "error: skip-phase flags require --allow-capability-gated" >&2
    exit 2
  fi
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 2
fi

abs_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
}

join_with_semicolon() {
  local out=""
  local item
  for item in "$@"; do
    if [[ -z "$item" ]]; then
      continue
    fi
    if [[ -n "$out" ]]; then
      out+="; "
    fi
    out+="$item"
  done
  printf '%s' "$out"
}

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/ops/gate_comprehensive_real_environment_suite/$STAMP"
fi

OUT_DIR="$(abs_path "$OUT_DIR")"
RECORDIT_APP_BUNDLE="$(abs_path "$RECORDIT_APP_BUNDLE")"
RECORDIT_DMG="$(abs_path "$RECORDIT_DMG")"
PACKAGED_ROOT="$(abs_path "$PACKAGED_ROOT")"
MODEL="$(abs_path "$MODEL")"
FIXTURE="$(abs_path "$FIXTURE")"
OFFLINE_INPUT="$(abs_path "$OFFLINE_INPUT")"

if [[ -z "$DEFAULT_JOURNEY_OUT_DIR" ]]; then
  DEFAULT_JOURNEY_OUT_DIR="$OUT_DIR/default_user_journey"
fi
if [[ -z "$STOP_TAXONOMY_OUT_DIR" ]]; then
  STOP_TAXONOMY_OUT_DIR="$OUT_DIR/packaged_stop_taxonomy"
fi
if [[ -z "$RELEASE_CONTEXT_OUT_DIR" ]]; then
  RELEASE_CONTEXT_OUT_DIR="$OUT_DIR/release_context"
fi
if [[ -z "$ANTI_BYPASS_OUT_DIR" ]]; then
  ANTI_BYPASS_OUT_DIR="$OUT_DIR/anti_bypass"
fi
if [[ -z "$MOCK_EXCEPTION_OUT_DIR" ]]; then
  MOCK_EXCEPTION_OUT_DIR="$OUT_DIR/mock_exception_register"
fi

DEFAULT_JOURNEY_OUT_DIR="$(abs_path "$DEFAULT_JOURNEY_OUT_DIR")"
STOP_TAXONOMY_OUT_DIR="$(abs_path "$STOP_TAXONOMY_OUT_DIR")"
RELEASE_CONTEXT_OUT_DIR="$(abs_path "$RELEASE_CONTEXT_OUT_DIR")"
ANTI_BYPASS_OUT_DIR="$(abs_path "$ANTI_BYPASS_OUT_DIR")"
MOCK_EXCEPTION_OUT_DIR="$(abs_path "$MOCK_EXCEPTION_OUT_DIR")"

mkdir -p "$OUT_DIR" "$OUT_DIR/logs" "$OUT_DIR/artifacts"

PHASES_NDJSON="$OUT_DIR/artifacts/phases.ndjson"
PHASE_MANIFEST="$OUT_DIR/artifacts/phases.json"
PRECONDITIONS_JSON="$OUT_DIR/artifacts/preconditions.json"
SUITE_CHECKS_CSV="$OUT_DIR/artifacts/suite_checks.csv"
SUITE_CHECKS_JSON="$OUT_DIR/artifacts/suite_checks.json"
CONTRACT_REFERENCES_TXT="$OUT_DIR/artifacts/contract_references.txt"
STATUS_JSON="$OUT_DIR/status.json"

: > "$PHASES_NDJSON"

export ROOT
export OUT_DIR
export DEFAULT_JOURNEY_OUT_DIR
export STOP_TAXONOMY_OUT_DIR
export RELEASE_CONTEXT_OUT_DIR
export ANTI_BYPASS_OUT_DIR
export MOCK_EXCEPTION_OUT_DIR
export RECORDIT_APP_BUNDLE
export RECORDIT_DMG
export PACKAGED_ROOT
export MODEL
export FIXTURE
export OFFLINE_INPUT
export SIGN_IDENTITY
export XCTEST_CONFIGURATION
export STRICT_UI_TESTS
export CLAIM_LEVEL
export POLICY_MODE
export SKIP_BUILD
export SUITE_CHECKS_CSV
export SUITE_CHECKS_JSON

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
  local exit_classification="${6:-skip_requested}"

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
    "$exit_classification" \
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

command_present() {
  if command -v "$1" >/dev/null 2>&1; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

is_darwin=0
if [[ "$(uname -s)" == "Darwin" ]]; then
  is_darwin=1
fi

has_xcodebuild="$(command_present xcodebuild)"
has_hdiutil="$(command_present hdiutil)"
has_spctl="$(command_present spctl)"
has_codesign="$(command_present codesign)"
has_make="$(command_present make)"
has_bash="$(command_present bash)"
has_osascript="$(command_present osascript)"

gui_session=0
if [[ "$is_darwin" == "1" ]]; then
  if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
    gui_session=1
  fi
fi

has_model=0
has_fixture=0
has_offline_input=0
has_app_bundle=0
has_dmg=0

[[ -f "$MODEL" ]] && has_model=1
[[ -f "$FIXTURE" ]] && has_fixture=1
[[ -f "$OFFLINE_INPUT" ]] && has_offline_input=1
[[ -d "$RECORDIT_APP_BUNDLE" ]] && has_app_bundle=1
[[ -f "$RECORDIT_DMG" ]] && has_dmg=1

default_missing=()
[[ "$is_darwin" == "1" ]] || default_missing+=("requires macOS host")
[[ "$has_xcodebuild" == "1" ]] || default_missing+=("xcodebuild missing")
[[ "$has_hdiutil" == "1" ]] || default_missing+=("hdiutil missing")
[[ "$has_model" == "1" ]] || default_missing+=("model missing: $MODEL")
[[ "$has_fixture" == "1" ]] || default_missing+=("fixture missing: $FIXTURE")
[[ "$has_app_bundle" == "1" ]] || default_missing+=("Recordit.app missing: $RECORDIT_APP_BUNDLE")
[[ "$has_dmg" == "1" ]] || default_missing+=("Recordit.dmg missing: $RECORDIT_DMG")
[[ "$gui_session" == "1" ]] || default_missing+=("no launchctl gui session (TCC/UI automation may not be available)")

stop_taxonomy_missing=()
[[ "$is_darwin" == "1" ]] || stop_taxonomy_missing+=("requires macOS host")
[[ "$has_model" == "1" ]] || stop_taxonomy_missing+=("model missing: $MODEL")
[[ "$has_fixture" == "1" ]] || stop_taxonomy_missing+=("fixture missing: $FIXTURE")
[[ "$has_offline_input" == "1" ]] || stop_taxonomy_missing+=("offline input missing: $OFFLINE_INPUT")
[[ "$has_app_bundle" == "1" ]] || stop_taxonomy_missing+=("Recordit.app missing: $RECORDIT_APP_BUNDLE")

release_context_missing=()
[[ "$is_darwin" == "1" ]] || release_context_missing+=("requires macOS host")
[[ "$has_codesign" == "1" ]] || release_context_missing+=("codesign missing")
[[ "$has_spctl" == "1" ]] || release_context_missing+=("spctl missing")
[[ "$has_app_bundle" == "1" ]] || release_context_missing+=("Recordit.app missing: $RECORDIT_APP_BUNDLE")

anti_bypass_missing=()
[[ "$has_bash" == "1" ]] || anti_bypass_missing+=("bash missing")

mock_exception_missing=()
[[ "$has_bash" == "1" ]] || mock_exception_missing+=("bash missing")

DEFAULT_MISSING_NOTE="$(join_with_semicolon "${default_missing[@]}")"
STOP_TAXONOMY_MISSING_NOTE="$(join_with_semicolon "${stop_taxonomy_missing[@]}")"
RELEASE_CONTEXT_MISSING_NOTE="$(join_with_semicolon "${release_context_missing[@]}")"
ANTI_BYPASS_MISSING_NOTE="$(join_with_semicolon "${anti_bypass_missing[@]}")"
MOCK_EXCEPTION_MISSING_NOTE="$(join_with_semicolon "${mock_exception_missing[@]}")"

export is_darwin
export has_xcodebuild
export has_hdiutil
export has_spctl
export has_codesign
export has_make
export has_osascript
export gui_session
export DEFAULT_MISSING_NOTE
export STOP_TAXONOMY_MISSING_NOTE
export RELEASE_CONTEXT_MISSING_NOTE
export ANTI_BYPASS_MISSING_NOTE
export MOCK_EXCEPTION_MISSING_NOTE

python3 - "$PRECONDITIONS_JSON" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

out_path = sys.argv[1]

def split_notes(value: str):
    value = value.strip()
    if not value:
        return []
    return [item.strip() for item in value.split(";") if item.strip()]

payload = {
    "schema_version": 1,
    "scenario_id": "recordit_comprehensive_real_environment_suite",
    "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "global_capabilities": {
        "is_darwin": os.environ["is_darwin"],
        "has_xcodebuild": os.environ["has_xcodebuild"],
        "has_hdiutil": os.environ["has_hdiutil"],
        "has_spctl": os.environ["has_spctl"],
        "has_codesign": os.environ["has_codesign"],
        "has_make": os.environ["has_make"],
        "has_osascript": os.environ["has_osascript"],
        "has_launchctl_gui_session": os.environ["gui_session"],
    },
    "inputs": {
        "recordit_app_bundle": os.environ["RECORDIT_APP_BUNDLE"],
        "recordit_dmg": os.environ["RECORDIT_DMG"],
        "packaged_root": os.environ["PACKAGED_ROOT"],
        "model": os.environ["MODEL"],
        "fixture": os.environ["FIXTURE"],
        "offline_input": os.environ["OFFLINE_INPUT"],
        "sign_identity": os.environ["SIGN_IDENTITY"],
        "skip_build": os.environ["SKIP_BUILD"],
    },
    "tcc_expectations": {
        "note": "UI-driven phases expect a logged-in GUI user session with Screen Recording + Microphone permissions granted for Recordit and relevant automation hosts.",
        "gui_session_detected": os.environ["gui_session"],
    },
    "lane_capability_requirements": {
        "default_user_journey": split_notes(os.environ["DEFAULT_MISSING_NOTE"]),
        "packaged_stop_taxonomy": split_notes(os.environ["STOP_TAXONOMY_MISSING_NOTE"]),
        "release_context": split_notes(os.environ["RELEASE_CONTEXT_MISSING_NOTE"]),
        "anti_bypass_guard": split_notes(os.environ["ANTI_BYPASS_MISSING_NOTE"]),
        "mock_exception_guard": split_notes(os.environ["MOCK_EXCEPTION_MISSING_NOTE"]),
    },
    "evidence_contract_references": [
        "docs/bd-8ydu-shell-e2e-evidence-contract.md",
        "docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md",
        "docs/bd-2j49-cross-lane-e2e-evidence-standard.md",
    ],
}

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

cat > "$CONTRACT_REFERENCES_TXT" <<REFS
shell_evidence_contract=docs/bd-8ydu-shell-e2e-evidence-contract.md
xctest_xcuitest_contract=docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md
cross_lane_standard=docs/bd-2j49-cross-lane-e2e-evidence-standard.md
minimum_non_mock_matrix=docs/bd-sy9l-minimum-non-mock-verification-matrix.md
REFS

PIPELINE_BLOCKED=0
CAPABILITY_GATED=0
if [[ "$SKIP_DEFAULT_JOURNEY_PHASE" == "1" || "$SKIP_STOP_TAXONOMY_PHASE" == "1" || "$SKIP_RELEASE_CONTEXT_PHASE" == "1" || "$SKIP_ANTI_BYPASS_PHASE" == "1" || "$SKIP_MOCK_EXCEPTION_PHASE" == "1" ]]; then
  CAPABILITY_GATED=1
fi

preflight_command_display="internal preflight capability scanner"
preflight_command_argv_json="$(json_array_from_args internal preflight capability scanner)"
preflight_log_relpath="logs/preflight_capability_checks.log"
preflight_stdout_relpath="logs/preflight_capability_checks.stdout"
preflight_stderr_relpath="logs/preflight_capability_checks.stderr"
preflight_primary_relpath="artifacts/preflight_capability_checks.txt"
preflight_started="$(evidence_timestamp)"
preflight_ended="$preflight_started"
preflight_notes=""
preflight_status="pass"
preflight_exit_classification="success"
preflight_required="true"

preflight_failures=()
if [[ "$SKIP_DEFAULT_JOURNEY_PHASE" != "1" && -n "$DEFAULT_MISSING_NOTE" ]]; then
  preflight_failures+=("default_user_journey: $DEFAULT_MISSING_NOTE")
fi
if [[ "$SKIP_STOP_TAXONOMY_PHASE" != "1" && -n "$STOP_TAXONOMY_MISSING_NOTE" ]]; then
  preflight_failures+=("packaged_stop_taxonomy: $STOP_TAXONOMY_MISSING_NOTE")
fi
if [[ "$SKIP_RELEASE_CONTEXT_PHASE" != "1" && -n "$RELEASE_CONTEXT_MISSING_NOTE" ]]; then
  preflight_failures+=("release_context: $RELEASE_CONTEXT_MISSING_NOTE")
fi
if [[ "$SKIP_ANTI_BYPASS_PHASE" != "1" && -n "$ANTI_BYPASS_MISSING_NOTE" ]]; then
  preflight_failures+=("anti_bypass_guard: $ANTI_BYPASS_MISSING_NOTE")
fi
if [[ "$SKIP_MOCK_EXCEPTION_PHASE" != "1" && -n "$MOCK_EXCEPTION_MISSING_NOTE" ]]; then
  preflight_failures+=("mock_exception_guard: $MOCK_EXCEPTION_MISSING_NOTE")
fi

preflight_failure_note="$(join_with_semicolon "${preflight_failures[@]}")"

if [[ "$DRY_RUN" == "1" ]]; then
  preflight_status="skipped"
  preflight_exit_classification="skip_requested"
  preflight_required="false"
  preflight_notes="dry-run requested; capability report captured without executing child lanes"
  CAPABILITY_GATED=1
elif [[ "$CAPABILITY_GATED" == "1" ]]; then
  preflight_status="skipped"
  preflight_exit_classification="skip_requested"
  preflight_required="false"
  preflight_notes="capability-gated execution requested via explicit skip flags"
elif [[ -n "$preflight_failure_note" ]]; then
  if [[ "$ALLOW_CAPABILITY_GATED" == "1" ]]; then
    preflight_status="skipped"
    preflight_exit_classification="skip_requested"
    preflight_required="false"
    preflight_notes="capability-gated execution enabled; missing capabilities: $preflight_failure_note"
    CAPABILITY_GATED=1
  else
    preflight_status="fail"
    preflight_exit_classification="precondition_failure"
    preflight_required="true"
    preflight_notes="missing required capabilities: $preflight_failure_note"
    PIPELINE_BLOCKED=1
  fi
fi

printf '%s\n' "preflight_status=$preflight_status" > "$OUT_DIR/$preflight_primary_relpath"
printf '%s\n' "required=$preflight_required" >> "$OUT_DIR/$preflight_primary_relpath"
printf '%s\n' "notes=$preflight_notes" >> "$OUT_DIR/$preflight_primary_relpath"
printf '%s\n' "preconditions_json=$PRECONDITIONS_JSON" >> "$OUT_DIR/$preflight_primary_relpath"

{
  printf '[%s] preflight_status=%s\n' "$(evidence_timestamp)" "$preflight_status"
  printf '[%s] preflight_required=%s\n' "$(evidence_timestamp)" "$preflight_required"
  printf '[%s] notes=%s\n' "$(evidence_timestamp)" "$preflight_notes"
  printf '[%s] preconditions_json=%s\n' "$(evidence_timestamp)" "$PRECONDITIONS_JSON"
} > "$OUT_DIR/$preflight_log_relpath"
cp "$OUT_DIR/$preflight_log_relpath" "$OUT_DIR/$preflight_stdout_relpath"
: > "$OUT_DIR/$preflight_stderr_relpath"

append_phase_record \
  "preflight_capability_checks" \
  "Preflight capabilities, inputs, and TCC assumptions" \
  "$preflight_required" \
  "$preflight_status" \
  "$preflight_exit_classification" \
  "$preflight_started" \
  "$preflight_ended" \
  "$preflight_command_display" \
  "$preflight_command_argv_json" \
  "$preflight_log_relpath" \
  "$preflight_stdout_relpath" \
  "$preflight_stderr_relpath" \
  "$preflight_primary_relpath" \
  "$preflight_notes"

run_default_journey_script=$(cat <<'RUN_DEFAULT'
env \
  ROOT="$ROOT" \
  OUT_DIR="$DEFAULT_JOURNEY_OUT_DIR" \
  RECORDIT_APP_BUNDLE="$RECORDIT_APP_BUNDLE" \
  RECORDIT_DMG="$RECORDIT_DMG" \
  PACKAGED_ROOT="$PACKAGED_ROOT" \
  MODEL="$MODEL" \
  FIXTURE="$FIXTURE" \
  SIGN_IDENTITY="$SIGN_IDENTITY" \
  XCTEST_CONFIGURATION="$XCTEST_CONFIGURATION" \
  STRICT_UI_TESTS="$STRICT_UI_TESTS" \
  SKIP_BUILD="$SKIP_BUILD" \
  "$ROOT/scripts/gate_default_user_journey_e2e.sh"
RUN_DEFAULT
)

run_stop_taxonomy_script=$(cat <<'RUN_STOP_TAX'
env \
  ROOT="$ROOT" \
  OUT_DIR="$STOP_TAXONOMY_OUT_DIR" \
  RECORDIT_APP_BUNDLE="$RECORDIT_APP_BUNDLE" \
  MODEL="$MODEL" \
  LIVE_FIXTURE="$FIXTURE" \
  OFFLINE_INPUT="$OFFLINE_INPUT" \
  SIGN_IDENTITY="$SIGN_IDENTITY" \
  SKIP_BUILD="$SKIP_BUILD" \
  "$ROOT/scripts/gate_packaged_stop_finalization_taxonomy.sh"
RUN_STOP_TAX
)

run_release_context_script=$(cat <<'RUN_RELEASE'
env \
  ROOT="$ROOT" \
  OUT_DIR="$RELEASE_CONTEXT_OUT_DIR" \
  RECORDIT_APP_BUNDLE="$RECORDIT_APP_BUNDLE" \
  SIGN_IDENTITY="$SIGN_IDENTITY" \
  SKIP_BUILD="$SKIP_BUILD" \
  "$ROOT/scripts/verify_recordit_release_context.sh"
RUN_RELEASE
)

run_anti_bypass_script=$(cat <<'RUN_ANTI_BYPASS'
env \
  ROOT="$ROOT" \
  "$ROOT/scripts/gate_anti_bypass_claims.sh" \
    --out-dir "$ANTI_BYPASS_OUT_DIR" \
    --claim-level "$CLAIM_LEVEL"
RUN_ANTI_BYPASS
)

run_mock_exception_script=$(cat <<'RUN_MOCK_EXCEPTION'
env \
  ROOT="$ROOT" \
  "$ROOT/scripts/gate_mock_exception_register.sh" \
    --out-dir "$MOCK_EXCEPTION_OUT_DIR" \
    --policy-mode "$POLICY_MODE"
RUN_MOCK_EXCEPTION
)

execute_or_skip_phase() {
  local phase_id="$1"
  local title="$2"
  local failure_classification="$3"
  local script_body="$4"
  local explicit_skip_flag="$5"
  local capability_note="$6"

  if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
    record_skipped_phase "$phase_id" "$title" "true" "blocked by prior required failure" "$script_body"
    return
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    record_skipped_phase "$phase_id" "$title" "false" "dry-run requested" "$script_body"
    CAPABILITY_GATED=1
    return
  fi

  if [[ "$explicit_skip_flag" == "1" ]]; then
    record_skipped_phase "$phase_id" "$title" "false" "skip flag requested" "$script_body"
    CAPABILITY_GATED=1
    return
  fi

  if [[ -n "$capability_note" && "$ALLOW_CAPABILITY_GATED" == "1" ]]; then
    local skip_reason="capability-gated: $capability_note"
    record_skipped_phase "$phase_id" "$title" "false" "$skip_reason" "$script_body"
    CAPABILITY_GATED=1
    return
  fi

  if [[ -n "$capability_note" ]]; then
    record_skipped_phase "$phase_id" "$title" "true" "blocked by missing capability: $capability_note" "$script_body" "precondition_failure"
    PIPELINE_BLOCKED=1
    return
  fi

  if ! run_phase_script "$phase_id" "$title" "true" "$failure_classification" "$script_body"; then
    PIPELINE_BLOCKED=1
  fi
}

execute_or_skip_phase \
  "default_user_journey" \
  "Default-user-journey packaged app verification" \
  "product_failure" \
  "$run_default_journey_script" \
  "$SKIP_DEFAULT_JOURNEY_PHASE" \
  "$DEFAULT_MISSING_NOTE"

execute_or_skip_phase \
  "packaged_stop_taxonomy" \
  "Packaged stop/finalization taxonomy verification" \
  "product_failure" \
  "$run_stop_taxonomy_script" \
  "$SKIP_STOP_TAXONOMY_PHASE" \
  "$STOP_TAXONOMY_MISSING_NOTE"

execute_or_skip_phase \
  "release_context_verification" \
  "Release-context signing/runtime verification" \
  "product_failure" \
  "$run_release_context_script" \
  "$SKIP_RELEASE_CONTEXT_PHASE" \
  "$RELEASE_CONTEXT_MISSING_NOTE"

execute_or_skip_phase \
  "anti_bypass_guard" \
  "Anti-bypass certifying-claim guard" \
  "contract_failure" \
  "$run_anti_bypass_script" \
  "$SKIP_ANTI_BYPASS_PHASE" \
  "$ANTI_BYPASS_MISSING_NOTE"

execute_or_skip_phase \
  "mock_exception_guard" \
  "Mock/fixture exception-register enforcement" \
  "contract_failure" \
  "$run_mock_exception_script" \
  "$SKIP_MOCK_EXCEPTION_PHASE" \
  "$MOCK_EXCEPTION_MISSING_NOTE"

run_suite_summary_script=$(cat <<'RUN_SUITE_SUMMARY'
python3 - "$SUITE_CHECKS_CSV" "$SUITE_CHECKS_JSON" "$OUT_DIR/artifacts/phases.ndjson" "$CAPABILITY_GATED" <<'PY_INNER'
import csv
import json
import sys
from pathlib import Path

csv_path = Path(sys.argv[1])
json_path = Path(sys.argv[2])
phases_ndjson = Path(sys.argv[3])
capability_gated = sys.argv[4] == "1"

rows = []
for raw in phases_ndjson.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line:
        continue
    entry = json.loads(line)
    rows.append(
        {
            "phase_id": entry.get("phase_id", ""),
            "status": entry.get("status", ""),
            "required": str(entry.get("required", False)).lower(),
            "exit_classification": entry.get("exit_classification", ""),
            "notes": entry.get("notes", ""),
            "contract": "recordit-e2e-evidence-v1",
        }
    )

with csv_path.open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(
        handle,
        fieldnames=["phase_id", "status", "required", "exit_classification", "notes", "contract"],
    )
    writer.writeheader()
    writer.writerows(rows)

summary = {
    "scenario_id": "recordit_comprehensive_real_environment_suite",
    "capability_gated": capability_gated,
    "phase_count": len(rows),
    "required_failures": [r["phase_id"] for r in rows if r["required"] == "true" and r["status"] == "fail"],
    "required_skipped": [r["phase_id"] for r in rows if r["required"] == "true" and r["status"] == "skipped"],
    "warn_or_skipped": [r["phase_id"] for r in rows if r["status"] in {"warn", "skipped"}],
}
json_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

if summary["required_failures"]:
    raise SystemExit(1)
if summary["required_skipped"]:
    raise SystemExit(1)
PY_INNER
RUN_SUITE_SUMMARY
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase \
    "suite_summary_checks" \
    "Comprehensive suite summary and contract checks" \
    "true" \
    "blocked by prior required failure" \
    "$run_suite_summary_script"
elif [[ "$DRY_RUN" == "1" ]]; then
  record_skipped_phase \
    "suite_summary_checks" \
    "Comprehensive suite summary and contract checks" \
    "false" \
    "dry-run requested" \
    "$run_suite_summary_script"
else
  if ! run_phase_script \
      "suite_summary_checks" \
      "Comprehensive suite summary and contract checks" \
      "true" \
      "contract_failure" \
      "$run_suite_summary_script"; then
    PIPELINE_BLOCKED=1
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
  --paths-env-entry "DEFAULT_JOURNEY_OUT_DIR=$DEFAULT_JOURNEY_OUT_DIR" \
  --paths-env-entry "STOP_TAXONOMY_OUT_DIR=$STOP_TAXONOMY_OUT_DIR" \
  --paths-env-entry "RELEASE_CONTEXT_OUT_DIR=$RELEASE_CONTEXT_OUT_DIR" \
  --paths-env-entry "ANTI_BYPASS_OUT_DIR=$ANTI_BYPASS_OUT_DIR" \
  --paths-env-entry "MOCK_EXCEPTION_OUT_DIR=$MOCK_EXCEPTION_OUT_DIR" \
  --paths-env-entry "PRECONDITIONS_JSON=$PRECONDITIONS_JSON" \
  --paths-env-entry "SUITE_CHECKS_CSV=$SUITE_CHECKS_CSV" \
  --paths-env-entry "SUITE_CHECKS_JSON=$SUITE_CHECKS_JSON" \
  --paths-env-entry "CONTRACT_REFERENCES=$CONTRACT_REFERENCES_TXT"

evidence_kv_text_to_json "$OUT_DIR/status.txt" "$STATUS_JSON"

echo "GATE_COMPREHENSIVE_REAL_ENV_OUT=$OUT_DIR"
echo "GATE_COMPREHENSIVE_REAL_ENV_SUMMARY=$OUT_DIR/summary.csv"
echo "GATE_COMPREHENSIVE_REAL_ENV_STATUS=$OUT_DIR/status.txt"
echo "GATE_COMPREHENSIVE_REAL_ENV_STATUS_JSON=$STATUS_JSON"

action_status="$(awk -F= '$1=="status" {print $2}' "$OUT_DIR/status.txt" | tail -n 1)"
if [[ "$action_status" == "fail" ]]; then
  exit 1
fi
exit 0
