#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

SCENARIO_ID="dmg_install_open_verifier"
OUT_DIR="${OUT_DIR:-}"
RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
RECORDIT_DMG="${RECORDIT_DMG:-$ROOT/dist/Recordit.dmg}"
RECORDIT_DMG_VOLNAME="${RECORDIT_DMG_VOLNAME:-Recordit}"
INSTALL_DESTINATION="${INSTALL_DESTINATION:-}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_DMG_BUILD="${SKIP_DMG_BUILD:-0}"
OPEN_WAIT_SEC="${OPEN_WAIT_SEC:-3}"
KEEP_INSTALLED_APP="${KEEP_INSTALLED_APP:-0}"

usage() {
  cat <<'USAGE'
Usage: gate_dmg_install_open.sh [options]

Run retained DMG install-surface verification with standardized e2e evidence output.
This lane verifies:
- DMG build/reuse
- DMG mount and layout (`Recordit.app` + `Applications` link)
- install/copy to destination
- launch attempt of installed app

Options:
  --out-dir PATH              Output evidence directory (default: artifacts/ops/gate_dmg_install_open/<utc-stamp>)
  --recordit-app-bundle PATH  Source Recordit.app path for DMG build (default: dist/Recordit.app)
  --recordit-dmg PATH         DMG path to verify (default: dist/Recordit.dmg)
  --dmg-volname VALUE         DMG volume name for build step (default: Recordit)
  --install-destination PATH  Destination directory for installed app copy (default: <out-dir>/install-target)
  --sign-identity VALUE       Codesign identity passed to `make sign-recordit-app` (default: -)
  --skip-build                Skip `make sign-recordit-app`
  --skip-dmg-build            Skip DMG creation and reuse --recordit-dmg
  --open-wait-sec N           Seconds to wait after `open` before process check (default: 3)
  --keep-installed-app        Keep copied app under install destination after completion
  -h, --help                  Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
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
    --install-destination)
      INSTALL_DESTINATION="$2"
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
    --skip-dmg-build)
      SKIP_DMG_BUILD=1
      shift
      ;;
    --open-wait-sec)
      OPEN_WAIT_SEC="$2"
      shift 2
      ;;
    --keep-installed-app)
      KEEP_INSTALLED_APP=1
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

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/ops/gate_dmg_install_open/$STAMP"
fi

OUT_DIR="$(python3 - "$OUT_DIR" <<'PY'
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
RECORDIT_DMG="$(python3 - "$RECORDIT_DMG" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

if [[ -z "$INSTALL_DESTINATION" ]]; then
  INSTALL_DESTINATION="$OUT_DIR/install-target"
fi
INSTALL_DESTINATION="$(python3 - "$INSTALL_DESTINATION" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

mkdir -p "$OUT_DIR" "$OUT_DIR/logs" "$OUT_DIR/artifacts"

PHASES_NDJSON="$OUT_DIR/artifacts/phases.ndjson"
PHASE_MANIFEST="$OUT_DIR/artifacts/phases.json"
STATUS_JSON="$OUT_DIR/status.json"
: > "$PHASES_NDJSON"

ATTACH_PLIST="$OUT_DIR/artifacts/dmg_attach.plist"
MOUNT_POINT_TXT="$OUT_DIR/artifacts/dmg_mount_point.txt"
LAYOUT_REPORT="$OUT_DIR/artifacts/dmg_layout_report.txt"
INSTALL_REPORT="$OUT_DIR/artifacts/install_copy_report.txt"
OPEN_REPORT="$OUT_DIR/artifacts/open_launch_report.txt"
OPEN_PIDS="$OUT_DIR/artifacts/open_pids.txt"
DETACH_REPORT="$OUT_DIR/artifacts/dmg_detach_report.txt"

export ROOT
export SIGN_IDENTITY
export RECORDIT_APP_BUNDLE
export RECORDIT_DMG
export RECORDIT_DMG_VOLNAME
export INSTALL_DESTINATION
export ATTACH_PLIST
export MOUNT_POINT_TXT
export LAYOUT_REPORT
export INSTALL_REPORT
export OPEN_REPORT
export OPEN_PIDS
export OPEN_WAIT_SEC
export DETACH_REPORT

json_array_from_args() {
  python3 - "$@" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1:]))
PY
}

command_display_from_args() {
  local rendered
  printf -v rendered '%q ' "$@"
  rendered="${rendered% }"
  printf '%s' "$rendered"
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
  local status
  local exit_classification
  if [[ "$required" == "true" ]]; then
    status="fail"
    exit_classification="contract_failure"
  else
    status="pass"
    exit_classification="success"
  fi

  : > "$OUT_DIR/$log_relpath"
  : > "$OUT_DIR/$stdout_relpath"
  : > "$OUT_DIR/$stderr_relpath"
  {
    printf 'phase_id=%s\n' "$phase_id"
    printf 'status=%s\n' "$status"
    printf 'notes=%s\n' "$notes"
  } > "$OUT_DIR/$primary_relpath"

  append_phase_record \
    "$phase_id" \
    "$title" \
    "$required" \
    "$status" \
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

cleanup_mount() {
  if [[ -s "$MOUNT_POINT_TXT" ]]; then
    local mount_point
    mount_point="$(cat "$MOUNT_POINT_TXT")"
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
}
trap cleanup_mount EXIT

PIPELINE_BLOCKED=0

build_app_script=$(cat <<'BUILD_APP'
make -C "$ROOT" sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"
test -d "$RECORDIT_APP_BUNDLE"
BUILD_APP
)

if [[ "$SKIP_BUILD" == "1" ]]; then
  record_skipped_phase "build_app" "Build and sign Recordit.app" "false" "skip-build requested" "$build_app_script"
elif ! run_phase_script "build_app" "Build and sign Recordit.app" "false" "infra_failure" "$build_app_script"; then
  :
fi

build_dmg_script=$(cat <<'BUILD_DMG'
"$ROOT/scripts/create_recordit_dmg.sh" --app "$RECORDIT_APP_BUNDLE" --output "$RECORDIT_DMG" --volname "$RECORDIT_DMG_VOLNAME"
test -f "$RECORDIT_DMG"
BUILD_DMG
)

if [[ "$SKIP_DMG_BUILD" == "1" ]]; then
  record_skipped_phase "build_dmg" "Build Recordit DMG" "false" "skip-dmg-build requested" "$build_dmg_script"
elif [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "build_dmg" "Build Recordit DMG" "true" "blocked by prior required failure" "$build_dmg_script"
elif ! run_phase_script "build_dmg" "Build Recordit DMG" "true" "infra_failure" "$build_dmg_script"; then
  PIPELINE_BLOCKED=1
fi

attach_dmg_script=$(cat <<'ATTACH_DMG'
hdiutil attach -readonly -nobrowse -plist "$RECORDIT_DMG" > "$ATTACH_PLIST"
test -s "$ATTACH_PLIST"
ATTACH_DMG
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "attach_dmg" "Attach DMG" "true" "blocked by prior required failure" "$attach_dmg_script"
elif ! run_phase_script "attach_dmg" "Attach DMG" "true" "infra_failure" "$attach_dmg_script"; then
  PIPELINE_BLOCKED=1
fi

verify_layout_script=$(cat <<'VERIFY_LAYOUT'
DMG_MOUNT_POINT="$(python3 - "$ATTACH_PLIST" <<'PY'
from pathlib import Path
import plistlib
import sys

plist_path = Path(sys.argv[1])
with plist_path.open('rb') as handle:
    payload = plistlib.load(handle)
for entity in payload.get('system-entities', []):
    mount_point = entity.get('mount-point')
    if mount_point:
        print(mount_point)
        break
else:
    raise SystemExit('no mount-point found in attach plist')
PY
)"

printf '%s\n' "$DMG_MOUNT_POINT" > "$MOUNT_POINT_TXT"
test -d "$DMG_MOUNT_POINT/Recordit.app"
test -L "$DMG_MOUNT_POINT/Applications"
test "$(readlink "$DMG_MOUNT_POINT/Applications")" = "/Applications"
{
  printf 'mount_point=%s\n' "$DMG_MOUNT_POINT"
  printf 'recordit_app=%s\n' "$DMG_MOUNT_POINT/Recordit.app"
  printf 'applications_link_target=%s\n' "$(readlink "$DMG_MOUNT_POINT/Applications")"
  printf 'expected_volname=%s\n' "$RECORDIT_DMG_VOLNAME"
  printf 'mount_basename=%s\n' "$(basename "$DMG_MOUNT_POINT")"
  find "$DMG_MOUNT_POINT" -mindepth 1 -maxdepth 2 -print | sed "s|^$DMG_MOUNT_POINT/||" | sort
} > "$LAYOUT_REPORT"
VERIFY_LAYOUT
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "verify_layout" "Verify mounted DMG layout" "true" "blocked by prior required failure" "$verify_layout_script"
elif ! run_phase_script "verify_layout" "Verify mounted DMG layout" "true" "contract_failure" "$verify_layout_script"; then
  PIPELINE_BLOCKED=1
fi

copy_install_script=$(cat <<'COPY_INSTALL'
DMG_MOUNT_POINT="$(cat "$MOUNT_POINT_TXT")"
SRC_APP="$DMG_MOUNT_POINT/Recordit.app"
DST_APP="$INSTALL_DESTINATION/Recordit.app"
rm -rf "$DST_APP"
mkdir -p "$INSTALL_DESTINATION"
cp -R "$SRC_APP" "$DST_APP"
test -d "$DST_APP"
{
  printf 'source_app=%s\n' "$SRC_APP"
  printf 'installed_app=%s\n' "$DST_APP"
  printf 'installed_file_count='
  find "$DST_APP" -type f | wc -l | tr -d ' '
} > "$INSTALL_REPORT"
COPY_INSTALL
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "copy_install" "Copy app from DMG to install destination" "true" "blocked by prior required failure" "$copy_install_script"
elif ! run_phase_script "copy_install" "Copy app from DMG to install destination" "true" "infra_failure" "$copy_install_script"; then
  PIPELINE_BLOCKED=1
fi

open_app_script=$(cat <<'OPEN_APP'
DST_APP="$INSTALL_DESTINATION/Recordit.app"
test -d "$DST_APP"
open -n "$DST_APP"
sleep "$OPEN_WAIT_SEC"
if pgrep -x Recordit > "$OPEN_PIDS" 2>/dev/null; then
  OPEN_PROCESS_VISIBLE=true
else
  OPEN_PROCESS_VISIBLE=false
  : > "$OPEN_PIDS"
fi
osascript -e 'tell application "Recordit" to quit' >/dev/null 2>&1 || true
{
  printf 'installed_app=%s\n' "$DST_APP"
  printf 'open_wait_sec=%s\n' "$OPEN_WAIT_SEC"
  printf 'open_process_visible=%s\n' "$OPEN_PROCESS_VISIBLE"
  printf 'open_pids_file=%s\n' "$OPEN_PIDS"
} > "$OPEN_REPORT"
OPEN_APP
)

if [[ "$PIPELINE_BLOCKED" == "1" ]]; then
  record_skipped_phase "open_installed_app" "Launch installed app" "true" "blocked by prior required failure" "$open_app_script"
elif ! run_phase_script "open_installed_app" "Launch installed app" "true" "product_failure" "$open_app_script"; then
  PIPELINE_BLOCKED=1
fi

detach_dmg_script=$(cat <<'DETACH_DMG'
if [[ -s "$MOUNT_POINT_TXT" ]]; then
  DMG_MOUNT_POINT="$(cat "$MOUNT_POINT_TXT")"
  hdiutil detach "$DMG_MOUNT_POINT"
  printf 'detached_mount_point=%s\n' "$DMG_MOUNT_POINT" > "$DETACH_REPORT"
  : > "$MOUNT_POINT_TXT"
else
  printf 'detached_mount_point=\n' > "$DETACH_REPORT"
  printf 'detail=no mount point recorded\n' >> "$DETACH_REPORT"
fi
DETACH_DMG
)

if [[ -s "$MOUNT_POINT_TXT" ]]; then
  run_phase_script "detach_dmg" "Detach DMG" "false" "infra_failure" "$detach_dmg_script" || true
else
  record_skipped_phase "detach_dmg" "Detach DMG" "false" "no mounted DMG to detach" "$detach_dmg_script"
fi

if [[ "$KEEP_INSTALLED_APP" != "1" ]]; then
  rm -rf "$INSTALL_DESTINATION/Recordit.app"
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
  "packaged-e2e" \
  "$PHASE_MANIFEST" \
  --generated-at-utc "$(evidence_timestamp)" \
  --artifact-root-relpath "artifacts" \
  --paths-env-entry "RECORDIT_APP_BUNDLE=$RECORDIT_APP_BUNDLE" \
  --paths-env-entry "RECORDIT_DMG=$RECORDIT_DMG" \
  --paths-env-entry "RECORDIT_DMG_VOLNAME=$RECORDIT_DMG_VOLNAME" \
  --paths-env-entry "INSTALL_DESTINATION=$INSTALL_DESTINATION"

evidence_kv_text_to_json "$OUT_DIR/status.txt" "$STATUS_JSON"

echo "GATE_DMG_INSTALL_OPEN_OUT=$OUT_DIR"
echo "GATE_DMG_INSTALL_OPEN_SUMMARY=$OUT_DIR/summary.csv"
echo "GATE_DMG_INSTALL_OPEN_STATUS=$OUT_DIR/status.txt"
echo "GATE_DMG_INSTALL_OPEN_STATUS_JSON=$STATUS_JSON"

OVERALL_STATUS="$(awk -F= '$1=="status" {print $2}' "$OUT_DIR/status.txt" | tail -n 1)"
if [[ "$OVERALL_STATUS" == "fail" ]]; then
  exit 1
fi
