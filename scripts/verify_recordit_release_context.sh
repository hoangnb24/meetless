#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"
RECORDIT_APP_BUNDLE="${RECORDIT_APP_BUNDLE:-$ROOT/dist/Recordit.app}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
OUT_DIR="${OUT_DIR:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
ALLOW_PREFLIGHT_FAILURE="${ALLOW_PREFLIGHT_FAILURE:-0}"

usage() {
  cat <<'USAGE'
Usage: verify_recordit_release_context.sh [options]

Verify the Recordit.app release context with verbose, timestamped logs.
The script checks:
- signed app bundle presence
- codesign verification and entitlements surface
- bundled runtime/model payload inventory and checksums
- packaged-app preflight using the embedded `recordit` binary

Options:
  --out-dir PATH               Output directory (default: artifacts/ops/release-context/<utc-stamp>)
  --recordit-app-bundle PATH   Recordit.app bundle to inspect (default: dist/Recordit.app)
  --sign-identity VALUE        Codesign identity for build/sign step (default: -)
  --skip-build                 Skip `make sign-recordit-app`
  --allow-preflight-failure    Do not fail the script if packaged preflight exits non-zero
  -h, --help                   Show this help text
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
    --sign-identity)
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
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
  OUT_DIR="$ROOT/artifacts/ops/release-context/$STAMP"
fi

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
evidence_write_metadata_json "$METADATA_JSON" "verify_recordit_release_context" "release_context_verification" "$OUT_DIR" "$LOG_DIR" "$ARTIFACT_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" ""

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
  printf '[%s] %s
' "$(timestamp)" "$message" > "$LOG_DIR/${name}.log"
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

if [[ "$SKIP_BUILD" != "1" ]]; then
  if run_optional_step build_and_sign make -C "$ROOT" sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"; then
    append_summary "build_and_sign" "pass" "make sign-recordit-app completed" "$LOG_DIR/build_and_sign.log"
  else
    append_summary "build_and_sign" "fail" "make sign-recordit-app failed" "$LOG_DIR/build_and_sign.log"
    mark_fail
  fi
else
  write_note_log build_and_sign "skip-build requested"
  append_summary "build_and_sign" "skipped" "skip-build requested" "$LOG_DIR/build_and_sign.log"
fi

if [[ ! -d "$RECORDIT_APP_BUNDLE" ]]; then
  echo "error: Recordit.app bundle not found: $RECORDIT_APP_BUNDLE" >&2
  append_summary "app_bundle_exists" "fail" "bundle missing" "$RECORDIT_APP_BUNDLE"
  echo "fail" > "$STATUS_TXT"
  exit 1
fi
append_summary "app_bundle_exists" "pass" "bundle present" "$RECORDIT_APP_BUNDLE"

APP_EXECUTABLE="$RECORDIT_APP_BUNDLE/Contents/MacOS/Recordit"
RUNTIME_ROOT="$RECORDIT_APP_BUNDLE/Contents/Resources/runtime"
RECORDIT_BIN="$RUNTIME_ROOT/bin/recordit"
CAPTURE_BIN="$RUNTIME_ROOT/bin/sequoia_capture"
MODEL_PATH="$RUNTIME_ROOT/models/whispercpp/ggml-tiny.en.bin"
RUNTIME_ARTIFACT_MANIFEST="$RUNTIME_ROOT/artifact-manifest.json"
PREFLIGHT_OUT_DIR="$ARTIFACT_DIR/preflight-live"

{
  printf 'ROOT=%q\n' "$ROOT"
  printf 'OUT_DIR=%q\n' "$OUT_DIR"
  printf 'RECORDIT_APP_BUNDLE=%q\n' "$RECORDIT_APP_BUNDLE"
  printf 'APP_EXECUTABLE=%q\n' "$APP_EXECUTABLE"
  printf 'RUNTIME_ROOT=%q\n' "$RUNTIME_ROOT"
  printf 'RECORDIT_BIN=%q\n' "$RECORDIT_BIN"
  printf 'CAPTURE_BIN=%q\n' "$CAPTURE_BIN"
  printf 'MODEL_PATH=%q\n' "$MODEL_PATH"
  printf 'RUNTIME_ARTIFACT_MANIFEST=%q\n' "$RUNTIME_ARTIFACT_MANIFEST"
  printf 'PREFLIGHT_OUT_DIR=%q\n' "$PREFLIGHT_OUT_DIR"
} > "$PATHS_ENV"

if run_optional_step codesign_verify codesign --verify --deep --strict --verbose=2 "$RECORDIT_APP_BUNDLE"; then
  append_summary "codesign_verify" "pass" "codesign verify succeeded" "$LOG_DIR/codesign_verify.log"
else
  append_summary "codesign_verify" "fail" "codesign verify failed" "$LOG_DIR/codesign_verify.log"
  mark_fail
fi

if run_optional_step codesign_display codesign -d --verbose=4 "$RECORDIT_APP_BUNDLE"; then
  append_summary "codesign_display" "pass" "captured verbose codesign display" "$LOG_DIR/codesign_display.log"
else
  append_summary "codesign_display" "fail" "failed to capture verbose codesign display" "$LOG_DIR/codesign_display.log"
  mark_fail
fi

if run_optional_step entitlements_dump codesign -d --entitlements :- --verbose=2 "$RECORDIT_APP_BUNDLE"; then
  append_summary "entitlements_dump" "pass" "captured signed entitlements" "$LOG_DIR/entitlements_dump.log"
else
  append_summary "entitlements_dump" "fail" "failed to dump signed entitlements" "$LOG_DIR/entitlements_dump.log"
  mark_fail
fi

if command -v spctl >/dev/null 2>&1; then
  if run_optional_step spctl_assess spctl --assess --type execute --verbose=4 "$RECORDIT_APP_BUNDLE"; then
    append_summary "spctl_assess" "pass" "spctl assess passed" "$LOG_DIR/spctl_assess.log"
  else
    append_summary "spctl_assess" "warn" "spctl assess failed or returned non-zero; inspect log" "$LOG_DIR/spctl_assess.log"
  fi
else
  write_note_log spctl_assess "spctl unavailable"
  append_summary "spctl_assess" "skipped" "spctl unavailable" "$LOG_DIR/spctl_assess.log"
fi

if run_optional_step bundle_inventory find "$RECORDIT_APP_BUNDLE/Contents" -maxdepth 6 -type f -print; then
  append_summary "bundle_inventory" "pass" "captured app bundle file inventory" "$LOG_DIR/bundle_inventory.log"
else
  append_summary "bundle_inventory" "fail" "failed to capture app bundle inventory" "$LOG_DIR/bundle_inventory.log"
  mark_fail
fi

payload_ready=1
for path in "$APP_EXECUTABLE" "$RECORDIT_BIN" "$CAPTURE_BIN"; do
  if [[ ! -x "$path" ]]; then
    append_summary "runtime_payload" "fail" "missing executable payload: $path" "$path"
    payload_ready=0
    mark_fail
  fi
done
if [[ ! -f "$MODEL_PATH" ]]; then
  append_summary "runtime_payload" "fail" "missing bundled model: $MODEL_PATH" "$MODEL_PATH"
  payload_ready=0
  mark_fail
fi
if [[ "$payload_ready" -eq 1 ]]; then
  append_summary "runtime_payload" "pass" "runtime executables and default model present" "$PATHS_ENV"

  if [[ -f "$RUNTIME_ARTIFACT_MANIFEST" ]]; then
    append_summary "runtime_artifact_manifest" "pass" "runtime artifact manifest present" "$RUNTIME_ARTIFACT_MANIFEST"
  else
    append_summary "runtime_artifact_manifest" "fail" "runtime artifact manifest missing" "$RUNTIME_ARTIFACT_MANIFEST"
    write_note_log runtime_artifact_manifest_parity "runtime artifact manifest missing; parity step skipped"
    append_summary "runtime_artifact_manifest_parity" "skipped" "runtime artifact manifest missing; parity step skipped" "$LOG_DIR/runtime_artifact_manifest_parity.log"
    mark_fail
  fi

  if run_optional_step payload_checksums shasum -a 256 "$APP_EXECUTABLE" "$RECORDIT_BIN" "$CAPTURE_BIN" "$MODEL_PATH"; then
    append_summary "payload_checksums" "pass" "captured checksums for app/runtime/model payloads" "$LOG_DIR/payload_checksums.log"
  else
    append_summary "payload_checksums" "fail" "failed to capture payload checksums" "$LOG_DIR/payload_checksums.log"
    mark_fail
  fi

  if [[ -f "$RUNTIME_ARTIFACT_MANIFEST" ]]; then
    if run_optional_step runtime_artifact_manifest_parity python3 - "$RUNTIME_ARTIFACT_MANIFEST" "$RECORDIT_BIN" "$CAPTURE_BIN" "$MODEL_PATH" <<'PY_PARITY'
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
    then
      append_summary "runtime_artifact_manifest_parity" "pass" "runtime artifact manifest matches bundled payload checksums" "$LOG_DIR/runtime_artifact_manifest_parity.log"
    else
      append_summary "runtime_artifact_manifest_parity" "fail" "runtime artifact manifest mismatch" "$LOG_DIR/runtime_artifact_manifest_parity.log"
      mark_fail
    fi
  fi

  mkdir -p "$PREFLIGHT_OUT_DIR"
  if run_optional_step packaged_preflight env RECORDIT_ASR_MODEL="$MODEL_PATH" "$RECORDIT_BIN" preflight --mode live --output-root "$PREFLIGHT_OUT_DIR" --json; then
    append_summary "packaged_preflight" "pass" "embedded recordit preflight succeeded" "$LOG_DIR/packaged_preflight.log"
  elif [[ "$ALLOW_PREFLIGHT_FAILURE" == "1" ]]; then
    append_summary "packaged_preflight" "warn" "embedded recordit preflight failed but allow-preflight-failure is set" "$LOG_DIR/packaged_preflight.log"
  else
    append_summary "packaged_preflight" "fail" "embedded recordit preflight failed" "$LOG_DIR/packaged_preflight.log"
    mark_fail
  fi
else
  write_note_log runtime_artifact_manifest "runtime payload incomplete; manifest availability check skipped"
  write_note_log runtime_artifact_manifest_parity "runtime payload incomplete; manifest parity skipped"
  write_note_log payload_checksums "runtime payload incomplete; checksum step skipped"
  write_note_log packaged_preflight "runtime payload incomplete; packaged preflight skipped"
  append_summary "runtime_artifact_manifest" "skipped" "runtime payload incomplete; manifest availability check skipped" "$LOG_DIR/runtime_artifact_manifest.log"
  append_summary "runtime_artifact_manifest_parity" "skipped" "runtime payload incomplete; manifest parity skipped" "$LOG_DIR/runtime_artifact_manifest_parity.log"
  append_summary "payload_checksums" "skipped" "runtime payload incomplete; checksum step skipped" "$LOG_DIR/payload_checksums.log"
  append_summary "packaged_preflight" "skipped" "runtime payload incomplete; packaged preflight skipped" "$LOG_DIR/packaged_preflight.log"
fi

append_summary "paths_manifest" "pass" "captured resolved path manifest" "$PATHS_ENV"
echo "$OVERALL_STATUS" > "$STATUS_TXT"
cat >"$SUMMARY_JSON" <<JSON
{
  "artifact_track": "release_context_verification",
  "scenario_id": "verify_recordit_release_context",
  "overall_status": "$OVERALL_STATUS",
  "summary_csv": "$SUMMARY_CSV",
  "checks_json": "$SUMMARY_ROWS_JSON",
  "paths_env": "$PATHS_ENV",
  "recordit_app_bundle": "$RECORDIT_APP_BUNDLE",
  "runtime_artifact_manifest": "$RUNTIME_ARTIFACT_MANIFEST"
}
JSON
evidence_csv_rows_to_json "$SUMMARY_CSV" "$SUMMARY_ROWS_JSON"
printf 'verification complete: %s (%s)\n' "$OUT_DIR" "$OVERALL_STATUS"
if [[ "$OVERALL_STATUS" != "pass" ]]; then
  exit 1
fi
