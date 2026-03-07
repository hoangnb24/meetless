#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
OUT_DIR="${OUT_DIR:-}"
DOWNSTREAM_MATRIX_CSV="${DOWNSTREAM_MATRIX_CSV:-docs/bd-39i6-canonical-downstream-matrix.csv}"
CRITICAL_MATRIX_CSV="${CRITICAL_MATRIX_CSV:-docs/bd-39i6-critical-surface-coverage-matrix.csv}"
DEFAULT_JOURNEY_ROOT="${DEFAULT_JOURNEY_ROOT:-}"
FAILURE_MATRIX_ROOT="${FAILURE_MATRIX_ROOT:-}"
SKIP_CONTRACT_VALIDATION=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Fail-fast CI/assertion gate for:
1. required matrix row/classification completeness,
2. required retained e2e evidence roots/scenarios,
3. unsupported certifying claim text when certification verdict is not true.

Options:
  --out-dir PATH               Output directory (default: artifacts/ci/gate_coverage_matrix_evidence/<utc-stamp>)
  --default-journey-root PATH  Evidence root from gate_default_user_journey_e2e
  --failure-matrix-root PATH   Evidence root from gate_packaged_failure_matrix
  --downstream-matrix-csv PATH Canonical downstream matrix CSV (repo-relative or absolute)
  --critical-matrix-csv PATH   Critical-surface matrix CSV (repo-relative or absolute)
  --skip-contract-validation   Skip validate_e2e_evidence_contract checks
  -h, --help                   Show this help text
USAGE
}

latest_dir() {
  local pattern_root="$1"
  if [[ ! -d "$pattern_root" ]]; then
    return 1
  fi
  ls -td "$pattern_root"/* 2>/dev/null | head -n 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --default-journey-root)
      DEFAULT_JOURNEY_ROOT="$2"
      shift 2
      ;;
    --failure-matrix-root)
      FAILURE_MATRIX_ROOT="$2"
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
    --skip-contract-validation)
      SKIP_CONTRACT_VALIDATION=1
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
  OUT_DIR="$ROOT/artifacts/ci/gate_coverage_matrix_evidence/$STAMP"
fi

if [[ -z "$DEFAULT_JOURNEY_ROOT" ]]; then
  DEFAULT_JOURNEY_ROOT="$(latest_dir "$ROOT/artifacts/ops/gate_default_user_journey_e2e" || true)"
fi
if [[ -z "$FAILURE_MATRIX_ROOT" ]]; then
  FAILURE_MATRIX_ROOT="$(latest_dir "$ROOT/artifacts/validation/bd-v502/gate_packaged_failure_matrix" || true)"
fi

if [[ -z "$DEFAULT_JOURNEY_ROOT" ]]; then
  echo "error: default journey evidence root is required (pass --default-journey-root)" >&2
  exit 2
fi
if [[ -z "$FAILURE_MATRIX_ROOT" ]]; then
  echo "error: failure matrix evidence root is required (pass --failure-matrix-root)" >&2
  exit 2
fi

ARGS=(
  --root "$ROOT"
  --out-dir "$OUT_DIR"
  --downstream-matrix-csv "$DOWNSTREAM_MATRIX_CSV"
  --critical-matrix-csv "$CRITICAL_MATRIX_CSV"
  --default-journey-root "$DEFAULT_JOURNEY_ROOT"
  --failure-matrix-root "$FAILURE_MATRIX_ROOT"
)

if [[ "$SKIP_CONTRACT_VALIDATION" == "1" ]]; then
  ARGS+=(--skip-contract-validation)
fi

python3 "$ROOT/scripts/gate_coverage_matrix_evidence.py" "${ARGS[@]}"

echo "GATE_COVERAGE_MATRIX_EVIDENCE_OUT=$OUT_DIR"
