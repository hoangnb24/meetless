#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

RECORDIT_DMG="${RECORDIT_DMG:-$ROOT/dist/Recordit.dmg}"
RECORDIT_DMG_NAME="${RECORDIT_DMG_NAME:-$(basename "$RECORDIT_DMG")}"
RECORDIT_DMG_VOLNAME="${RECORDIT_DMG_VOLNAME:-Recordit}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
OUT_DIR="${OUT_DIR:-}"
SKIP_DMG_BUILD="${SKIP_DMG_BUILD:-0}"
ALLOW_SPCTL_FAILURE="${ALLOW_SPCTL_FAILURE:-0}"

usage() {
  cat <<'USAGE'
Usage: notarize_recordit_release_dmg.sh [options]

Automate release-finalization for a distributable Recordit DMG with retained
notarization/stapling/Gatekeeper evidence.

The script performs this ordered path:
1. Build/create DMG (unless --skip-dmg-build)
2. Sign + verify DMG
3. Submit to notarytool and wait for verdict
4. Fetch notary log by submission ID
5. Staple and validate ticket
6. Gatekeeper assess the stapled DMG (spctl)

Options:
  --recordit-dmg PATH          DMG to notarize (default: dist/Recordit.dmg)
  --dmg-name NAME              DMG name passed to build step (default: basename of --recordit-dmg)
  --dmg-volname NAME           DMG volume name for build step (default: Recordit)
  --sign-identity VALUE        Signing identity for DMG signing and build step (default: -)
  --notary-profile PROFILE     Keychain profile for notarytool (required)
  --out-dir PATH               Output evidence root (default: artifacts/releases/notary/<utc-stamp>)
  --skip-dmg-build             Skip `make create-recordit-dmg` and use existing DMG path
  --allow-spctl-failure        Mark Gatekeeper assess as warn instead of fail
  -h, --help                   Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recordit-dmg)
      RECORDIT_DMG="$2"
      shift 2
      ;;
    --dmg-name)
      RECORDIT_DMG_NAME="$2"
      shift 2
      ;;
    --dmg-volname)
      RECORDIT_DMG_VOLNAME="$2"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --notary-profile)
      NOTARY_PROFILE="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --skip-dmg-build)
      SKIP_DMG_BUILD=1
      shift
      ;;
    --allow-spctl-failure)
      ALLOW_SPCTL_FAILURE=1
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

if [[ -z "$NOTARY_PROFILE" ]]; then
  echo "error: --notary-profile (or NOTARY_PROFILE) is required" >&2
  exit 2
fi

for cmd in python3 codesign xcrun shasum; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 2
  fi
done

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/releases/notary/$STAMP"
fi

OUT_DIR="$(python3 - "$OUT_DIR" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
)"

mkdir -p "$OUT_DIR"
LOG_DIR="$OUT_DIR/logs"
PACKAGING_DIR="$OUT_DIR/packaging"
NOTARY_DIR="$OUT_DIR/notary"
RELEASE_DIR="$OUT_DIR/release"
mkdir -p "$LOG_DIR" "$PACKAGING_DIR" "$NOTARY_DIR" "$RELEASE_DIR"

SUMMARY_CSV="$OUT_DIR/summary.csv"
SUMMARY_JSON="$OUT_DIR/summary.json"
SUMMARY_ROWS_JSON="$OUT_DIR/checks.json"
STATUS_TXT="$OUT_DIR/status.txt"
METADATA_JSON="$OUT_DIR/metadata.json"
PATHS_ENV="$OUT_DIR/paths.env"
FAILURE_SIGNATURES_JSON="$NOTARY_DIR/failure-signatures.json"
NOTARY_SUBMIT_JSON="$NOTARY_DIR/notary-submit.json"
NOTARY_OUTCOME_JSON="$NOTARY_DIR/notary-outcome.json"
NOTARY_LOG_JSON="$NOTARY_DIR/notary-log.json"
OVERALL_STATUS="pass"

printf 'check,status,detail,artifact\n' > "$SUMMARY_CSV"
evidence_write_metadata_json "$METADATA_JSON" "recordit_notarize_release_dmg" "release_notary" "$OUT_DIR" "$LOG_DIR" "$OUT_DIR" "$SUMMARY_CSV" "$STATUS_TXT" "$0" "$SUMMARY_JSON" ""

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

capture_failure_signatures() {
  python3 - "$FAILURE_SIGNATURES_JSON" "$NOTARY_SUBMIT_JSON" "$NOTARY_LOG_JSON" "$LOG_DIR/notary_submit.log" "$LOG_DIR/stapler_validate.log" "$LOG_DIR/spctl_assess.log" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

output_path = Path(sys.argv[1])
inputs = [Path(p) for p in sys.argv[2:]]
patterns = [
    ("notary_status_invalid", re.compile(r'"status"\s*:\s*"Invalid"', re.IGNORECASE)),
    ("notary_rejected", re.compile(r'\brejected\b', re.IGNORECASE)),
    ("missing_signature", re.compile(r'no usable signature|not signed', re.IGNORECASE)),
    ("staple_missing_ticket", re.compile(r'ticket|staple', re.IGNORECASE)),
    ("gatekeeper_rejected", re.compile(r'spctl.*rejected|rejected', re.IGNORECASE)),
]

hits = []
for path in inputs:
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    for code, pattern in patterns:
        match = pattern.search(text)
        if match is None:
            continue
        snippet = text[max(0, match.start() - 80):match.end() + 80]
        snippet = " ".join(snippet.split())
        hits.append({
            "code": code,
            "source": str(path),
            "snippet": snippet[:240],
        })

# De-duplicate preserving order.
seen: set[tuple[str, str]] = set()
unique_hits = []
for hit in hits:
    key = (hit["code"], hit["source"])
    if key in seen:
        continue
    seen.add(key)
    unique_hits.append(hit)

output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps({"signatures": unique_hits}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

if [[ "$SKIP_DMG_BUILD" != "1" ]]; then
  if run_optional_step build_dmg make -C "$ROOT" create-recordit-dmg RECORDIT_DMG_NAME="$RECORDIT_DMG_NAME" RECORDIT_DMG_VOLNAME="$RECORDIT_DMG_VOLNAME" SIGN_IDENTITY="$SIGN_IDENTITY"; then
    append_summary "build_dmg" "pass" "create-recordit-dmg completed" "$LOG_DIR/build_dmg.log"
  else
    append_summary "build_dmg" "fail" "create-recordit-dmg failed" "$LOG_DIR/build_dmg.log"
    mark_fail
  fi
else
  write_note_log build_dmg "skip-dmg-build requested"
  append_summary "build_dmg" "skipped" "skip-dmg-build requested" "$LOG_DIR/build_dmg.log"
fi

if [[ ! -f "$RECORDIT_DMG" ]]; then
  append_summary "dmg_exists" "fail" "DMG not found" "$RECORDIT_DMG"
  mark_fail
  echo "fail" > "$STATUS_TXT"
  exit 1
fi
append_summary "dmg_exists" "pass" "DMG present" "$RECORDIT_DMG"

{
  printf 'ROOT=%q\n' "$ROOT"
  printf 'OUT_DIR=%q\n' "$OUT_DIR"
  printf 'RECORDIT_DMG=%q\n' "$RECORDIT_DMG"
  printf 'RECORDIT_DMG_NAME=%q\n' "$RECORDIT_DMG_NAME"
  printf 'RECORDIT_DMG_VOLNAME=%q\n' "$RECORDIT_DMG_VOLNAME"
  printf 'SIGN_IDENTITY=%q\n' "$SIGN_IDENTITY"
  printf 'NOTARY_PROFILE=%q\n' "$NOTARY_PROFILE"
  printf 'NOTARY_SUBMIT_JSON=%q\n' "$NOTARY_SUBMIT_JSON"
  printf 'NOTARY_LOG_JSON=%q\n' "$NOTARY_LOG_JSON"
  printf 'NOTARY_OUTCOME_JSON=%q\n' "$NOTARY_OUTCOME_JSON"
} > "$PATHS_ENV"

if run_optional_step dmg_checksum shasum -a 256 "$RECORDIT_DMG"; then
  cp "$LOG_DIR/dmg_checksum.log" "$PACKAGING_DIR/dmg.sha256"
  append_summary "dmg_checksum" "pass" "captured DMG checksum" "$PACKAGING_DIR/dmg.sha256"
else
  append_summary "dmg_checksum" "fail" "failed to compute DMG checksum" "$LOG_DIR/dmg_checksum.log"
  mark_fail
fi

if run_optional_step dmg_codesign codesign --force --sign "$SIGN_IDENTITY" "$RECORDIT_DMG"; then
  append_summary "dmg_codesign" "pass" "DMG signing completed" "$LOG_DIR/dmg_codesign.log"
else
  append_summary "dmg_codesign" "fail" "DMG signing failed" "$LOG_DIR/dmg_codesign.log"
  mark_fail
fi

if run_optional_step dmg_codesign_verify codesign --verify --verbose=2 "$RECORDIT_DMG"; then
  append_summary "dmg_codesign_verify" "pass" "DMG signature verify succeeded" "$LOG_DIR/dmg_codesign_verify.log"
else
  append_summary "dmg_codesign_verify" "fail" "DMG signature verify failed" "$LOG_DIR/dmg_codesign_verify.log"
  mark_fail
fi

if [[ "$OVERALL_STATUS" == "pass" ]]; then
  printf '[%s] cmd=xcrun notarytool submit %q --keychain-profile %q --wait --output-format json\n' "$(timestamp)" "$RECORDIT_DMG" "$NOTARY_PROFILE" > "$LOG_DIR/notary_submit.log"
  set +e
  xcrun notarytool submit "$RECORDIT_DMG" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$NOTARY_SUBMIT_JSON" 2>>"$LOG_DIR/notary_submit.log"
  submit_exit=$?
  set -e
  if [[ "$submit_exit" -eq 0 ]]; then
    append_summary "notary_submit" "pass" "notarytool submit completed" "$NOTARY_SUBMIT_JSON"
  else
    append_summary "notary_submit" "fail" "notarytool submit failed" "$LOG_DIR/notary_submit.log"
    mark_fail
  fi
else
  write_note_log notary_submit "skipped due to earlier failures"
  append_summary "notary_submit" "skipped" "skipped due to earlier failures" "$LOG_DIR/notary_submit.log"
fi

submission_id=""
submission_status=""
if [[ -f "$NOTARY_SUBMIT_JSON" ]]; then
  readarray -t submit_meta < <(python3 - "$NOTARY_SUBMIT_JSON" "$NOTARY_OUTCOME_JSON" "$RECORDIT_DMG" <<'PY'
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

submit_path = Path(sys.argv[1])
outcome_path = Path(sys.argv[2])
dmg_path = sys.argv[3]

payload = json.loads(submit_path.read_text(encoding="utf-8"))
submission_id = payload.get("id") or payload.get("submissionId") or ""
status = payload.get("status") or payload.get("statusSummary") or "unknown"
message = payload.get("message") or payload.get("statusMessage") or ""
outcome = {
    "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "submission_id": submission_id,
    "status": status,
    "message": message,
    "dmg_path": dmg_path,
    "submit_json_path": str(submit_path),
}
outcome_path.write_text(json.dumps(outcome, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(submission_id)
print(status)
print(message.replace("\n", " "))
PY
)
  submission_id="${submit_meta[0]:-}"
  submission_status="${submit_meta[1]:-unknown}"
  submission_message="${submit_meta[2]:-}"
  if [[ "${submission_status,,}" == "accepted" ]]; then
    append_summary "notary_status" "pass" "notary status accepted" "$NOTARY_OUTCOME_JSON"
  else
    append_summary "notary_status" "fail" "notary status=${submission_status} message=${submission_message}" "$NOTARY_OUTCOME_JSON"
    mark_fail
  fi
else
  append_summary "notary_status" "fail" "missing notary submit JSON" "$NOTARY_SUBMIT_JSON"
  mark_fail
fi

if [[ -n "$submission_id" ]]; then
  if run_optional_step notary_log xcrun notarytool log "$submission_id" --keychain-profile "$NOTARY_PROFILE"; then
    cp "$LOG_DIR/notary_log.log" "$NOTARY_LOG_JSON"
    append_summary "notary_log" "pass" "captured notary log for submission" "$NOTARY_LOG_JSON"
  else
    append_summary "notary_log" "warn" "failed to capture notary log" "$LOG_DIR/notary_log.log"
  fi
else
  write_note_log notary_log "submission id unavailable; skipping"
  append_summary "notary_log" "skipped" "submission id unavailable" "$LOG_DIR/notary_log.log"
fi

if [[ "$OVERALL_STATUS" == "pass" ]]; then
  if run_optional_step stapler_staple xcrun stapler staple "$RECORDIT_DMG"; then
    append_summary "stapler_staple" "pass" "stapler staple succeeded" "$LOG_DIR/stapler_staple.log"
  else
    append_summary "stapler_staple" "fail" "stapler staple failed" "$LOG_DIR/stapler_staple.log"
    mark_fail
  fi

  if run_optional_step stapler_validate xcrun stapler validate "$RECORDIT_DMG"; then
    append_summary "stapler_validate" "pass" "stapler validate succeeded" "$LOG_DIR/stapler_validate.log"
  else
    append_summary "stapler_validate" "fail" "stapler validate failed" "$LOG_DIR/stapler_validate.log"
    mark_fail
  fi
else
  write_note_log stapler_staple "skipped due to non-accepted notarization"
  write_note_log stapler_validate "skipped due to non-accepted notarization"
  append_summary "stapler_staple" "skipped" "skipped due to non-accepted notarization" "$LOG_DIR/stapler_staple.log"
  append_summary "stapler_validate" "skipped" "skipped due to non-accepted notarization" "$LOG_DIR/stapler_validate.log"
fi

if command -v spctl >/dev/null 2>&1; then
  if run_optional_step spctl_assess spctl --assess --type open --context context:primary-signature --verbose=4 "$RECORDIT_DMG"; then
    append_summary "spctl_assess" "pass" "Gatekeeper assess passed" "$LOG_DIR/spctl_assess.log"
  else
    if [[ "$ALLOW_SPCTL_FAILURE" == "1" ]]; then
      append_summary "spctl_assess" "warn" "Gatekeeper assess failed; allow-spctl-failure enabled" "$LOG_DIR/spctl_assess.log"
    else
      append_summary "spctl_assess" "fail" "Gatekeeper assess failed" "$LOG_DIR/spctl_assess.log"
      mark_fail
    fi
  fi
else
  write_note_log spctl_assess "spctl unavailable"
  append_summary "spctl_assess" "skipped" "spctl unavailable" "$LOG_DIR/spctl_assess.log"
fi

capture_failure_signatures
if [[ -f "$FAILURE_SIGNATURES_JSON" ]]; then
  signature_count="$(python3 - "$FAILURE_SIGNATURES_JSON" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
print(len(payload.get('signatures', [])))
PY
)"
  append_summary "failure_signatures" "pass" "captured ${signature_count} signature(s)" "$FAILURE_SIGNATURES_JSON"
fi

evidence_csv_rows_to_json "$SUMMARY_CSV" "$SUMMARY_ROWS_JSON"
python3 - "$SUMMARY_CSV" "$SUMMARY_JSON" <<'PY'
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

csv_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
rows = []
with csv_path.open(newline='', encoding='utf-8') as handle:
    rows = list(csv.DictReader(handle))
payload = {
    "schema_version": 1,
    "rows": rows,
}
out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding='utf-8')
PY

printf '%s\n' "$OVERALL_STATUS" > "$STATUS_TXT"
if [[ "$OVERALL_STATUS" == "pass" ]]; then
  echo "notarize_recordit_release_dmg: PASS"
  exit 0
fi

echo "notarize_recordit_release_dmg: FAIL" >&2
exit 1
