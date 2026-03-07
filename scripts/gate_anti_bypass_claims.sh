#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
OUT_DIR="${OUT_DIR:-}"
CLAIM_LEVEL="${CLAIM_LEVEL:-real-environment-verified}"
MATRIX_CSV="${MATRIX_CSV:-$ROOT/docs/bd-39i6-canonical-downstream-matrix.csv}"
EXCEPTION_REGISTER_CSV="${EXCEPTION_REGISTER_CSV:-$ROOT/docs/bd-2mbp-critical-path-exception-register.csv}"

usage() {
  cat <<USAGE
Usage: $0 [options]

Evaluates whether a certifying coverage claim is invalidated by known seam-bearing
lanes (UI-test-mode, preview-DI, mock/stub, scripted-runtime, runtime-override).

Options:
  --out-dir PATH                 Output directory (default: artifacts/ci/gate_anti_bypass_claims/<utc-stamp>)
  --claim-level LEVEL            Claim level: real-environment-verified|partial|simulation-covered
  --matrix-csv PATH              Canonical matrix CSV path
  --exception-register-csv PATH  Exception register CSV path
  -h, --help                     Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --claim-level)
      CLAIM_LEVEL="$2"
      shift 2
      ;;
    --matrix-csv)
      MATRIX_CSV="$2"
      shift 2
      ;;
    --exception-register-csv)
      EXCEPTION_REGISTER_CSV="$2"
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
  OUT_DIR="$ROOT/artifacts/ci/gate_anti_bypass_claims/$STAMP"
fi

mkdir -p "$OUT_DIR"
SUMMARY_CSV="$OUT_DIR/summary.csv"
STATUS_JSON="$OUT_DIR/status.json"
STATUS_TXT="$OUT_DIR/status.txt"

set +e
python3 "$ROOT/scripts/gate_anti_bypass_claims.py" \
  --matrix-csv "$MATRIX_CSV" \
  --exception-register-csv "$EXCEPTION_REGISTER_CSV" \
  --claim-level "$CLAIM_LEVEL" \
  --summary-csv "$SUMMARY_CSV" \
  --status-json "$STATUS_JSON"
EXIT_CODE=$?
set -e

if [[ "$EXIT_CODE" -eq 0 ]]; then
  status="pass"
  detail="claim_level_${CLAIM_LEVEL}_accepted"
else
  status="failed"
  detail="claim_level_${CLAIM_LEVEL}_blocked_by_active_seams"
fi

cat >"$STATUS_TXT" <<STATUS
status=$status
detail=$detail
claim_level=$CLAIM_LEVEL
summary_path=$SUMMARY_CSV
status_json_path=$STATUS_JSON
matrix_csv_path=$MATRIX_CSV
exception_register_csv_path=$EXCEPTION_REGISTER_CSV
generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS

echo "GATE_ANTI_BYPASS_OUT=$OUT_DIR"
exit "$EXIT_CODE"
