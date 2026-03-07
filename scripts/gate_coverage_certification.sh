#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"

OUT_DIR="${OUT_DIR:-}"
CLAIM_LEVEL="${CLAIM_LEVEL:-real-environment-verified}"
DOWNSTREAM_MATRIX_CSV="${DOWNSTREAM_MATRIX_CSV:-$ROOT/docs/bd-39i6-canonical-downstream-matrix.csv}"
CRITICAL_MATRIX_CSV="${CRITICAL_MATRIX_CSV:-$ROOT/docs/bd-39i6-critical-surface-coverage-matrix.csv}"
REQUIRED_BEADS="${REQUIRED_BEADS:-bd-tr8z,bd-diqp,bd-p77p,bd-39i6,bd-11vg,bd-2j49}"
BEAD_STATUS_JSON="${BEAD_STATUS_JSON:-}"

usage() {
  cat <<USAGE
Usage: $0 [options]

Compute final certifying-coverage verdict (true|false|unproven) by combining:
1. anti-bypass certifying-claim gate,
2. canonical downstream + critical-surface matrix gap signals,
3. required domain-bead closure states.

Options:
  --out-dir PATH               Output directory (default: artifacts/ci/gate_coverage_certification/<utc-stamp>)
  --claim-level LEVEL          Claim level passed to anti-bypass lane (default: real-environment-verified)
  --downstream-matrix-csv PATH Canonical downstream matrix CSV
  --critical-matrix-csv PATH   Critical-surface matrix CSV
  --required-beads IDS         Comma-separated required bead IDs
  --bead-status-json PATH      Optional JSON bead status override map
  -h, --help                   Show this help text
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
    --downstream-matrix-csv)
      DOWNSTREAM_MATRIX_CSV="$2"
      shift 2
      ;;
    --critical-matrix-csv)
      CRITICAL_MATRIX_CSV="$2"
      shift 2
      ;;
    --required-beads)
      REQUIRED_BEADS="$2"
      shift 2
      ;;
    --bead-status-json)
      BEAD_STATUS_JSON="$2"
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
  OUT_DIR="$ROOT/artifacts/ci/gate_coverage_certification/$STAMP"
fi
mkdir -p "$OUT_DIR"

SUMMARY_CSV="$OUT_DIR/summary.csv"
STATUS_JSON="$OUT_DIR/status.json"
STATUS_TXT="$OUT_DIR/status.txt"
ANTI_BYPASS_OUT="$OUT_DIR/anti_bypass"

set +e
"$ROOT/scripts/gate_anti_bypass_claims.sh" \
  --out-dir "$ANTI_BYPASS_OUT" \
  --claim-level "$CLAIM_LEVEL"
ANTI_BYPASS_EXIT=$?
set -e

PY_ARGS=(
  --downstream-matrix-csv "$DOWNSTREAM_MATRIX_CSV"
  --critical-matrix-csv "$CRITICAL_MATRIX_CSV"
  --anti-bypass-status-json "$ANTI_BYPASS_OUT/status.json"
  --anti-bypass-exit-code "$ANTI_BYPASS_EXIT"
  --required-beads "$REQUIRED_BEADS"
  --summary-csv "$SUMMARY_CSV"
  --status-json "$STATUS_JSON"
  --status-txt "$STATUS_TXT"
)

if [[ -n "$BEAD_STATUS_JSON" ]]; then
  PY_ARGS+=(--bead-status-json "$BEAD_STATUS_JSON")
fi

set +e
python3 "$ROOT/scripts/gate_coverage_certification.py" "${PY_ARGS[@]}"
CERT_EXIT=$?
set -e

echo "GATE_COVERAGE_CERTIFICATION_OUT=$OUT_DIR"
exit "$CERT_EXIT"
