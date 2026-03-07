#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
RECORDIT_DMG="${RECORDIT_DMG:-$ROOT/dist/Recordit.dmg}"
RECORDIT_DMG_VOLNAME="${RECORDIT_DMG_VOLNAME:-Recordit}"
RECORDIT_DERIVED_DATA="${RECORDIT_DERIVED_DATA:-$ROOT/.build/recordit-derived-data}"
RECORDIT_XCODE_CONFIGURATION="${RECORDIT_XCODE_CONFIGURATION:-Release}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
OUT_DIR="${OUT_DIR:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_DMG_BUILD="${SKIP_DMG_BUILD:-0}"
ALLOW_PREFLIGHT_FAILURE="${ALLOW_PREFLIGHT_FAILURE:-0}"

usage() {
  cat <<'USAGE'
Usage: inspect_recordit_release_artifacts.sh [options]

Build or inspect the authoritative Recordit release artifacts and retain a
deterministic evidence bundle covering:
- Xcode-built Recordit.app under DerivedData
- signed dist/Recordit.app with nested release-context verification
- DMG image metadata, mount inventory, and mounted-app parity

Options:
  --out-dir PATH                 Output directory (default: artifacts/ops/release-artifact-inspection/<utc-stamp>)
  --recordit-app-bundle PATH     dist Recordit.app bundle to inspect (default: dist/Recordit.app)
  --recordit-dmg PATH            DMG artifact to inspect (default: dist/Recordit.dmg)
  --derived-data PATH            DerivedData root containing Xcode build products
  --xcode-configuration VALUE    Xcode configuration to inspect (default: Release)
  --sign-identity VALUE          Codesign identity for build/sign step (default: -)
  --dmg-volname VALUE            DMG volume name for build step (default: Recordit)
  --skip-build                   Skip `make sign-recordit-app`
  --skip-dmg-build               Skip DMG creation and inspect an existing DMG path
  --allow-preflight-failure      Pass through to nested release-context verification
  -h, --help                     Show this help text
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
    --derived-data)
      RECORDIT_DERIVED_DATA="$2"
      shift 2
      ;;
    --xcode-configuration)
      RECORDIT_XCODE_CONFIGURATION="$2"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --dmg-volname)
      RECORDIT_DMG_VOLNAME="$2"
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
    --allow-preflight-failure)
      ALLOW_PREFLIGHT_FAILURE=1
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
  OUT_DIR="$ROOT/artifacts/ops/release-artifact-inspection/$STAMP"
fi

OUT_DIR="$(python3 - "$OUT_DIR" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

mkdir -p "$OUT_DIR"
LOG_DIR="$OUT_DIR/logs"
ARTIFACT_DIR="$OUT_DIR/artifacts"
mkdir -p "$LOG_DIR" "$ARTIFACT_DIR"
SUMMARY_CSV="$OUT_DIR/summary.csv"
SUMMARY_JSON="$OUT_DIR/summary.json"
SUMMARY_ROWS_JSON="$OUT_DIR/checks.json"
STATUS_TXT="$OUT_DIR/status.txt"
PATHS_ENV="$OUT_DIR/paths.env"
METADATA_JSON="$OUT_DIR/metadata.json"
OVERALL_STATUS="pass"

printf 'check,status,detail,artifact\n' > "$SUMMARY_CSV"
evidence_write_metadata_json "$METADATA_JSON" "inspect_recordit_release_artifacts" "release_artifact_inspection" "$OUT_DIR" "$LOG_DIR" "$ARTIFACT_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" ""

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

append_summary() {
  local check="$1"
  local status="$2"
  local detail="$3"
  local artifact="$4"
  detail="${detail//$'\n'/ | }"
  detail="${detail//,/; }"
  artifact="${artifact//,/; }"
  printf '%s,%s,%s,%s\n' "$check" "$status" "$detail" "$artifact" >> "$SUMMARY_CSV"
}

mark_fail() {
  OVERALL_STATUS="fail"
}

write_note_log() {
  local name="$1"
  local message="$2"
  printf '[%s] %s\n' "$(timestamp)" "$message" > "$LOG_DIR/${name}.log"
}

run_optional_step() {
  local name="$1"
  shift
  local log_path="$LOG_DIR/${name}.log"
  set +e
  {
    printf '[%s] step=%s\n' "$(timestamp)" "$name"
    printf '[%s] cwd=%s\n' "$(timestamp)" "$ROOT"
    printf '[%s] cmd=' "$(timestamp)"
    printf '%q ' "$@"
    printf '\n'
    "$@"
  } > >(tee "$log_path") 2>&1
  local step_exit=$?
  set -e
  return "$step_exit"
}

write_inventory() {
  local root_path="$1"
  local csv_path="$2"
  local json_path="$3"

  python3 - "$root_path" "$csv_path" "$json_path" <<'PY'
from __future__ import annotations

import csv
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
csv_path = Path(sys.argv[2])
json_path = Path(sys.argv[3])
rows = []

if root.exists():
    for path in sorted(root.rglob('*')):
        rows.append(
            {
                'relative_path': path.relative_to(root).as_posix(),
                'kind': 'symlink' if path.is_symlink() else 'dir' if path.is_dir() else 'file',
                'size_bytes': path.lstat().st_size,
                'mode': oct(stat.S_IMODE(path.lstat().st_mode)),
                'symlink_target': os.readlink(path) if path.is_symlink() else '',
            }
        )

csv_path.parent.mkdir(parents=True, exist_ok=True)
with csv_path.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.DictWriter(handle, fieldnames=['relative_path', 'kind', 'size_bytes', 'mode', 'symlink_target'])
    writer.writeheader()
    writer.writerows(rows)

json_path.parent.mkdir(parents=True, exist_ok=True)
json_path.write_text(json.dumps(rows, indent=2, sort_keys=True) + '\n', encoding='utf-8')
PY
}

capture_bundle_payloads() {
  local bundle_path="$1"
  local csv_path="$2"
  local json_path="$3"

  python3 - "$bundle_path" "$csv_path" "$json_path" <<'PY'
from __future__ import annotations

import csv
import hashlib
import json
import plistlib
import sys
from pathlib import Path

bundle = Path(sys.argv[1])
csv_path = Path(sys.argv[2])
json_path = Path(sys.argv[3])
payloads = [
    'Contents/Info.plist',
    'Contents/Resources/runtime/bin/recordit',
    'Contents/Resources/runtime/bin/sequoia_capture',
    'Contents/Resources/runtime/models/whispercpp/ggml-tiny.en.bin',
    'Contents/Resources/runtime/artifact-manifest.json',
]
rows = []

for rel in payloads:
    path = bundle / rel
    row = {
        'relative_path': rel,
        'exists': path.exists(),
        'size_bytes': '',
        'sha256': '',
        'details': '',
    }
    if path.is_file():
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        row['size_bytes'] = path.stat().st_size
        row['sha256'] = digest.hexdigest()
        if rel.endswith('Info.plist'):
            with path.open('rb') as handle:
                plist = plistlib.load(handle)
            row['details'] = json.dumps(
                {
                    'CFBundleExecutable': plist.get('CFBundleExecutable', ''),
                    'CFBundleIdentifier': plist.get('CFBundleIdentifier', ''),
                    'CFBundleShortVersionString': plist.get('CFBundleShortVersionString', ''),
                    'CFBundleVersion': plist.get('CFBundleVersion', ''),
                },
                sort_keys=True,
            )
    else:
        row['details'] = 'missing'
    rows.append(row)

csv_path.parent.mkdir(parents=True, exist_ok=True)
with csv_path.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.DictWriter(handle, fieldnames=['relative_path', 'exists', 'size_bytes', 'sha256', 'details'])
    writer.writeheader()
    writer.writerows(rows)

json_path.parent.mkdir(parents=True, exist_ok=True)
json_path.write_text(json.dumps(rows, indent=2, sort_keys=True) + '\n', encoding='utf-8')

missing = [row['relative_path'] for row in rows if not row['exists']]
if missing:
    raise SystemExit('missing required payloads: ' + ', '.join(missing))
PY
}

compare_bundle_payloads() {
  local lhs_path="$1"
  local rhs_path="$2"
  local csv_path="$3"
  local json_path="$4"
  local lhs_label="$5"
  local rhs_label="$6"

  python3 - "$lhs_path" "$rhs_path" "$csv_path" "$json_path" "$lhs_label" "$rhs_label" <<'PY'
from __future__ import annotations

import csv
import hashlib
import json
import sys
from pathlib import Path

lhs = Path(sys.argv[1])
rhs = Path(sys.argv[2])
csv_path = Path(sys.argv[3])
json_path = Path(sys.argv[4])
lhs_label = sys.argv[5]
rhs_label = sys.argv[6]
payloads = [
    'Contents/Info.plist',
    'Contents/Resources/runtime/bin/recordit',
    'Contents/Resources/runtime/bin/sequoia_capture',
    'Contents/Resources/runtime/models/whispercpp/ggml-tiny.en.bin',
    'Contents/Resources/runtime/artifact-manifest.json',
]
rows = []
has_mismatch = False

def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

for rel in payloads:
    left = lhs / rel
    right = rhs / rel
    left_exists = left.is_file()
    right_exists = right.is_file()
    left_sha = file_hash(left) if left_exists else ''
    right_sha = file_hash(right) if right_exists else ''
    status = 'match'
    detail = ''
    if not left_exists or not right_exists:
        status = 'missing'
        detail = f'{lhs_label if not left_exists else rhs_label} missing'
        has_mismatch = True
    elif left_sha != right_sha:
        status = 'mismatch'
        detail = f'sha mismatch between {lhs_label} and {rhs_label}'
        has_mismatch = True
    rows.append(
        {
            'relative_path': rel,
            'status': status,
            f'{lhs_label}_sha256': left_sha,
            f'{rhs_label}_sha256': right_sha,
            'detail': detail,
        }
    )

csv_path.parent.mkdir(parents=True, exist_ok=True)
with csv_path.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.DictWriter(handle, fieldnames=['relative_path', 'status', f'{lhs_label}_sha256', f'{rhs_label}_sha256', 'detail'])
    writer.writeheader()
    writer.writerows(rows)

json_path.parent.mkdir(parents=True, exist_ok=True)
json_path.write_text(json.dumps(rows, indent=2, sort_keys=True) + '\n', encoding='utf-8')

if has_mismatch:
    raise SystemExit(f'payload mismatch detected between {lhs_label} and {rhs_label}')
PY
}

XCODE_APP_BUNDLE="$RECORDIT_DERIVED_DATA/Build/Products/$RECORDIT_XCODE_CONFIGURATION/Recordit.app"
DIST_VERIFY_DIR="$OUT_DIR/dist_release_context"
DMG_MOUNT_POINT=""

{
  printf 'ROOT=%q\n' "$ROOT"
  printf 'OUT_DIR=%q\n' "$OUT_DIR"
  printf 'RECORDIT_APP_BUNDLE=%q\n' "$RECORDIT_APP_BUNDLE"
  printf 'RECORDIT_DMG=%q\n' "$RECORDIT_DMG"
  printf 'RECORDIT_DMG_VOLNAME=%q\n' "$RECORDIT_DMG_VOLNAME"
  printf 'RECORDIT_DERIVED_DATA=%q\n' "$RECORDIT_DERIVED_DATA"
  printf 'RECORDIT_XCODE_CONFIGURATION=%q\n' "$RECORDIT_XCODE_CONFIGURATION"
  printf 'XCODE_APP_BUNDLE=%q\n' "$XCODE_APP_BUNDLE"
  printf 'DIST_VERIFY_DIR=%q\n' "$DIST_VERIFY_DIR"
  printf 'DMG_MOUNT_POINT=%q\n' "$DMG_MOUNT_POINT"
} > "$PATHS_ENV"

if [[ "$SKIP_BUILD" != "1" ]]; then
  if run_optional_step sign_recordit_app make -C "$ROOT" sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"; then
    append_summary "sign_recordit_app" "pass" "make sign-recordit-app completed" "$LOG_DIR/sign_recordit_app.log"
  else
    append_summary "sign_recordit_app" "fail" "make sign-recordit-app failed" "$LOG_DIR/sign_recordit_app.log"
    mark_fail
  fi
else
  write_note_log sign_recordit_app "skip-build requested"
  append_summary "sign_recordit_app" "skipped" "skip-build requested" "$LOG_DIR/sign_recordit_app.log"
fi

if [[ "$SKIP_DMG_BUILD" != "1" ]]; then
  if run_optional_step create_recordit_dmg "$ROOT/scripts/create_recordit_dmg.sh" --app "$RECORDIT_APP_BUNDLE" --output "$RECORDIT_DMG" --volname "$RECORDIT_DMG_VOLNAME"; then
    append_summary "create_recordit_dmg" "pass" "DMG build completed" "$LOG_DIR/create_recordit_dmg.log"
  else
    append_summary "create_recordit_dmg" "fail" "DMG build failed" "$LOG_DIR/create_recordit_dmg.log"
    mark_fail
  fi
else
  write_note_log create_recordit_dmg "skip-dmg-build requested"
  append_summary "create_recordit_dmg" "skipped" "skip-dmg-build requested" "$LOG_DIR/create_recordit_dmg.log"
fi

if [[ -d "$XCODE_APP_BUNDLE" ]]; then
  append_summary "xcode_bundle_exists" "pass" "Xcode-built Recordit.app present" "$XCODE_APP_BUNDLE"
else
  append_summary "xcode_bundle_exists" "fail" "Xcode-built Recordit.app missing" "$XCODE_APP_BUNDLE"
  mark_fail
fi

if [[ -d "$RECORDIT_APP_BUNDLE" ]]; then
  append_summary "dist_bundle_exists" "pass" "dist Recordit.app present" "$RECORDIT_APP_BUNDLE"
else
  append_summary "dist_bundle_exists" "fail" "dist Recordit.app missing" "$RECORDIT_APP_BUNDLE"
  mark_fail
fi

if [[ -d "$RECORDIT_APP_BUNDLE" ]]; then
  VERIFY_ARGS=("$ROOT/scripts/verify_recordit_release_context.sh" --skip-build --recordit-app-bundle "$RECORDIT_APP_BUNDLE" --out-dir "$DIST_VERIFY_DIR")
  if [[ "$ALLOW_PREFLIGHT_FAILURE" == "1" ]]; then
    VERIFY_ARGS+=(--allow-preflight-failure)
  fi
  if run_optional_step dist_release_context_verify "${VERIFY_ARGS[@]}"; then
    append_summary "dist_release_context_verify" "pass" "nested release-context verification passed" "$DIST_VERIFY_DIR/summary.csv"
  else
    append_summary "dist_release_context_verify" "fail" "nested release-context verification failed" "$DIST_VERIFY_DIR/summary.csv"
    mark_fail
  fi
else
  write_note_log dist_release_context_verify "dist bundle missing; nested verification skipped"
  append_summary "dist_release_context_verify" "skipped" "dist bundle missing; nested verification skipped" "$LOG_DIR/dist_release_context_verify.log"
fi

if [[ -d "$XCODE_APP_BUNDLE" ]]; then
  XCODE_INVENTORY_CSV="$ARTIFACT_DIR/xcode_bundle_inventory.csv"
  XCODE_INVENTORY_JSON="$ARTIFACT_DIR/xcode_bundle_inventory.json"
  XCODE_PAYLOAD_CSV="$ARTIFACT_DIR/xcode_bundle_payloads.csv"
  XCODE_PAYLOAD_JSON="$ARTIFACT_DIR/xcode_bundle_payloads.json"
  write_inventory "$XCODE_APP_BUNDLE" "$XCODE_INVENTORY_CSV" "$XCODE_INVENTORY_JSON"
  append_summary "xcode_bundle_inventory" "pass" "captured Xcode bundle inventory" "$XCODE_INVENTORY_JSON"
  if capture_bundle_payloads "$XCODE_APP_BUNDLE" "$XCODE_PAYLOAD_CSV" "$XCODE_PAYLOAD_JSON"; then
    append_summary "xcode_bundle_payloads" "pass" "captured Xcode bundle payload checksums" "$XCODE_PAYLOAD_JSON"
  else
    append_summary "xcode_bundle_payloads" "fail" "Xcode bundle payload capture failed" "$XCODE_PAYLOAD_JSON"
    mark_fail
  fi
fi

if [[ -d "$XCODE_APP_BUNDLE" && -d "$RECORDIT_APP_BUNDLE" ]]; then
  XCODE_DIST_PARITY_CSV="$ARTIFACT_DIR/xcode_vs_dist_runtime_parity.csv"
  XCODE_DIST_PARITY_JSON="$ARTIFACT_DIR/xcode_vs_dist_runtime_parity.json"
  if compare_bundle_payloads "$XCODE_APP_BUNDLE" "$RECORDIT_APP_BUNDLE" "$XCODE_DIST_PARITY_CSV" "$XCODE_DIST_PARITY_JSON" xcode dist; then
    append_summary "xcode_vs_dist_runtime_parity" "pass" "Xcode and dist runtime payloads match" "$XCODE_DIST_PARITY_JSON"
  else
    append_summary "xcode_vs_dist_runtime_parity" "fail" "Xcode and dist runtime payloads differ" "$XCODE_DIST_PARITY_JSON"
    mark_fail
  fi
fi

if [[ -f "$RECORDIT_DMG" ]]; then
  append_summary "dmg_exists" "pass" "DMG artifact present" "$RECORDIT_DMG"
else
  append_summary "dmg_exists" "fail" "DMG artifact missing" "$RECORDIT_DMG"
  mark_fail
fi

if [[ -f "$RECORDIT_DMG" ]]; then
  if run_optional_step dmg_imageinfo hdiutil imageinfo "$RECORDIT_DMG"; then
    append_summary "dmg_imageinfo" "pass" "captured DMG image info" "$LOG_DIR/dmg_imageinfo.log"
  else
    append_summary "dmg_imageinfo" "fail" "failed to capture DMG image info" "$LOG_DIR/dmg_imageinfo.log"
    mark_fail
  fi

  if run_optional_step dmg_checksum shasum -a 256 "$RECORDIT_DMG"; then
    append_summary "dmg_checksum" "pass" "captured DMG checksum" "$LOG_DIR/dmg_checksum.log"
  else
    append_summary "dmg_checksum" "fail" "failed to capture DMG checksum" "$LOG_DIR/dmg_checksum.log"
    mark_fail
  fi

  if command -v spctl >/dev/null 2>&1; then
    if run_optional_step dmg_spctl spctl --assess --type open --context context:primary-signature --verbose=4 "$RECORDIT_DMG"; then
      append_summary "dmg_spctl" "pass" "spctl assess passed for DMG" "$LOG_DIR/dmg_spctl.log"
    else
      append_summary "dmg_spctl" "warn" "spctl assess failed or returned non-zero; inspect log" "$LOG_DIR/dmg_spctl.log"
    fi
  else
    write_note_log dmg_spctl "spctl unavailable"
    append_summary "dmg_spctl" "skipped" "spctl unavailable" "$LOG_DIR/dmg_spctl.log"
  fi

  ATTACH_PLIST="$ARTIFACT_DIR/dmg_attach.plist"
  MOUNTED_DMG_APP=""
  MOUNTED=0
  detach_dmg() {
    if [[ "$MOUNTED" == "1" && -n "$DMG_MOUNT_POINT" ]]; then
      hdiutil detach "$DMG_MOUNT_POINT" >/dev/null 2>&1 || true
    fi
  }
  trap detach_dmg EXIT

  set +e
  {
    printf '[%s] step=%s\n' "$(timestamp)" "dmg_attach"
    printf '[%s] cwd=%s\n' "$(timestamp)" "$ROOT"
    printf '[%s] cmd=%q %q %q %q %q\n' "$(timestamp)" hdiutil attach -readonly -nobrowse -plist "$RECORDIT_DMG"
    hdiutil attach -readonly -nobrowse -plist "$RECORDIT_DMG" | tee "$ATTACH_PLIST"
  } > >(tee "$LOG_DIR/dmg_attach.log") 2>&1
  DMG_ATTACH_EXIT=$?
  set -e

  if [[ "$DMG_ATTACH_EXIT" -eq 0 ]]; then
    MOUNTED=1
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
    raise SystemExit('no mount-point found in hdiutil attach plist')
PY
)"
    MOUNTED_DMG_APP="$DMG_MOUNT_POINT/Recordit.app"
    append_summary "dmg_attach" "pass" "mounted DMG successfully" "$ATTACH_PLIST"
  else
    append_summary "dmg_attach" "fail" "failed to mount DMG" "$LOG_DIR/dmg_attach.log"
    mark_fail
  fi

  if [[ "$MOUNTED" == "1" ]]; then
    DMG_ROOT_INVENTORY_CSV="$ARTIFACT_DIR/dmg_root_inventory.csv"
    DMG_ROOT_INVENTORY_JSON="$ARTIFACT_DIR/dmg_root_inventory.json"
    write_inventory "$DMG_MOUNT_POINT" "$DMG_ROOT_INVENTORY_CSV" "$DMG_ROOT_INVENTORY_JSON"
    append_summary "dmg_root_inventory" "pass" "captured mounted DMG inventory" "$DMG_ROOT_INVENTORY_JSON"

    if [[ -L "$DMG_MOUNT_POINT/Applications" && "$(readlink "$DMG_MOUNT_POINT/Applications")" == "/Applications" ]]; then
      append_summary "dmg_applications_alias" "pass" "Applications alias present" "$DMG_ROOT_INVENTORY_JSON"
    else
      append_summary "dmg_applications_alias" "fail" "Applications alias missing or incorrect" "$DMG_ROOT_INVENTORY_JSON"
      mark_fail
    fi

    if [[ -d "$MOUNTED_DMG_APP" ]]; then
      DMG_APP_INVENTORY_CSV="$ARTIFACT_DIR/dmg_app_bundle_inventory.csv"
      DMG_APP_INVENTORY_JSON="$ARTIFACT_DIR/dmg_app_bundle_inventory.json"
      DMG_APP_PAYLOAD_CSV="$ARTIFACT_DIR/dmg_app_bundle_payloads.csv"
      DMG_APP_PAYLOAD_JSON="$ARTIFACT_DIR/dmg_app_bundle_payloads.json"
      write_inventory "$MOUNTED_DMG_APP" "$DMG_APP_INVENTORY_CSV" "$DMG_APP_INVENTORY_JSON"
      append_summary "dmg_app_bundle_inventory" "pass" "captured mounted Recordit.app inventory" "$DMG_APP_INVENTORY_JSON"
      if capture_bundle_payloads "$MOUNTED_DMG_APP" "$DMG_APP_PAYLOAD_CSV" "$DMG_APP_PAYLOAD_JSON"; then
        append_summary "dmg_app_bundle_payloads" "pass" "captured mounted Recordit.app payload checksums" "$DMG_APP_PAYLOAD_JSON"
      else
        append_summary "dmg_app_bundle_payloads" "fail" "mounted Recordit.app payload capture failed" "$DMG_APP_PAYLOAD_JSON"
        mark_fail
      fi
      if [[ -d "$RECORDIT_APP_BUNDLE" ]]; then
        DMG_DIST_PARITY_CSV="$ARTIFACT_DIR/dmg_vs_dist_runtime_parity.csv"
        DMG_DIST_PARITY_JSON="$ARTIFACT_DIR/dmg_vs_dist_runtime_parity.json"
        if compare_bundle_payloads "$MOUNTED_DMG_APP" "$RECORDIT_APP_BUNDLE" "$DMG_DIST_PARITY_CSV" "$DMG_DIST_PARITY_JSON" dmg dist; then
          append_summary "dmg_vs_dist_runtime_parity" "pass" "DMG-mounted and dist payloads match" "$DMG_DIST_PARITY_JSON"
        else
          append_summary "dmg_vs_dist_runtime_parity" "fail" "DMG-mounted and dist payloads differ" "$DMG_DIST_PARITY_JSON"
          mark_fail
        fi
      fi
    else
      append_summary "dmg_app_bundle_exists" "fail" "mounted Recordit.app missing" "$DMG_MOUNT_POINT"
      mark_fail
    fi
  fi

  detach_dmg
  trap - EXIT
fi

append_summary "paths_manifest" "pass" "captured resolved path manifest" "$PATHS_ENV"
echo "$OVERALL_STATUS" > "$STATUS_TXT"
cat >"$SUMMARY_JSON" <<JSON
{
  "artifact_track": "release_artifact_inspection",
  "scenario_id": "inspect_recordit_release_artifacts",
  "overall_status": "$OVERALL_STATUS",
  "summary_csv": "$SUMMARY_CSV",
  "checks_json": "$SUMMARY_ROWS_JSON",
  "paths_env": "$PATHS_ENV",
  "dist_release_context_dir": "$DIST_VERIFY_DIR",
  "recordit_app_bundle": "$RECORDIT_APP_BUNDLE",
  "recordit_dmg": "$RECORDIT_DMG",
  "xcode_app_bundle": "$XCODE_APP_BUNDLE"
}
JSON
evidence_csv_rows_to_json "$SUMMARY_CSV" "$SUMMARY_ROWS_JSON"
printf 'release artifact inspection complete: %s (%s)\n' "$OUT_DIR" "$OVERALL_STATUS"
if [[ "$OVERALL_STATUS" != "pass" ]]; then
  exit 1
fi
