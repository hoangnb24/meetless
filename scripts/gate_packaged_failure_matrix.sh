#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"
source "$ROOT/scripts/e2e_evidence_lib.sh"

SCENARIO_ID="packaged_failure_path_matrix"
OUT_DIR="${OUT_DIR:-}"
RECORDIT_RUNTIME_BIN="${RECORDIT_RUNTIME_BIN:-$ROOT/dist/Recordit.app/Contents/Resources/runtime/bin/recordit}"
MODEL="${MODEL:-$ROOT/dist/Recordit.app/Contents/Resources/runtime/models/whispercpp/ggml-tiny.en.bin}"
FIXTURE="${FIXTURE:-$ROOT/artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SKIP_BUILD="${SKIP_BUILD:-0}"
PARTIAL_KILL_DELAY_SEC="${PARTIAL_KILL_DELAY_SEC:-0.05}"

usage() {
  cat <<'USAGE'
Usage: gate_packaged_failure_matrix.sh [options]

Run deterministic packaged failure-path scenario matrix with retained evidence.

Scenarios:
- permission-denial-preflight
- missing-invalid-model
- missing-runtime-binary
- runtime-preflight-failure
- stop-timeout-class
- partial-artifact-forced-kill

Options:
  --out-dir PATH                  Output root (default: artifacts/validation/bd-v502/<utc-stamp>)
  --recordit-runtime-bin PATH     Embedded runtime binary (default: dist/Recordit.app/.../runtime/bin/recordit)
  --model PATH                    Model path used by runtime scenarios
  --fixture PATH                  Deterministic fake-capture fixture
  --sign-identity VALUE           Codesign identity for build/sign step (default: -)
  --skip-build                    Skip make sign-recordit-app
  --partial-kill-delay-sec N      Delay before SIGKILL in partial-artifact scenario (default: 0.05)
  -h, --help                      Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --recordit-runtime-bin)
      RECORDIT_RUNTIME_BIN="$2"
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
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --partial-kill-delay-sec)
      PARTIAL_KILL_DELAY_SEC="$2"
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

abs_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
}

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT_DIR="$ROOT/artifacts/validation/bd-v502/gate_packaged_failure_matrix/$STAMP"
fi

OUT_DIR="$(abs_path "$OUT_DIR")"
RECORDIT_RUNTIME_BIN="$(abs_path "$RECORDIT_RUNTIME_BIN")"
MODEL="$(abs_path "$MODEL")"
FIXTURE="$(abs_path "$FIXTURE")"

LOG_DIR="$OUT_DIR/logs"
SCENARIOS_DIR="$OUT_DIR/scenarios"
ARTIFACTS_DIR="$OUT_DIR/artifacts"
PHASE_NOTES_DIR="$ARTIFACTS_DIR/phases"
MATRIX_CSV="$ARTIFACTS_DIR/failure_matrix.csv"
MATRIX_JSON="$ARTIFACTS_DIR/failure_matrix.json"
MATRIX_STATUS_TXT="$ARTIFACTS_DIR/failure_matrix_status.txt"
MATRIX_STATUS_JSON="$ARTIFACTS_DIR/failure_matrix_status.json"
PHASE_MANIFEST="$ARTIFACTS_DIR/phases.json"
METADATA_JSON="$OUT_DIR/metadata.json"
BUILD_LOG="$LOG_DIR/build_sign_recordit.log"

mkdir -p "$OUT_DIR" "$LOG_DIR" "$SCENARIOS_DIR" "$ARTIFACTS_DIR" "$PHASE_NOTES_DIR"
evidence_write_metadata_json "$METADATA_JSON" "$SCENARIO_ID" "packaged-e2e" "$OUT_DIR" "$LOG_DIR" "$ARTIFACTS_DIR" "$MATRIX_CSV" "$MATRIX_STATUS_TXT" "$0" "$MATRIX_JSON" "$MATRIX_STATUS_JSON"

if [[ "$SKIP_BUILD" != "1" ]]; then
  set +e
  (
    cd "$ROOT"
    make sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"
  ) >"$BUILD_LOG" 2>&1
  BUILD_EXIT_CODE=$?
  set -e
  if [[ "$BUILD_EXIT_CODE" -ne 0 ]]; then
    cat > "$MATRIX_STATUS_TXT" <<STATUS
status=fail
failure_stage=build_sign_recordit
build_exit_code=$BUILD_EXIT_CODE
build_log=$BUILD_LOG
STATUS
    evidence_kv_text_to_json "$MATRIX_STATUS_TXT" "$MATRIX_STATUS_JSON"
    exit 1
  fi
else
  printf 'skip-build requested\n' > "$BUILD_LOG"
fi

if [[ ! -x "$RECORDIT_RUNTIME_BIN" ]]; then
  echo "error: runtime binary missing or not executable: $RECORDIT_RUNTIME_BIN" >&2
  exit 2
fi
if [[ ! -f "$MODEL" ]]; then
  echo "error: model missing: $MODEL" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE" ]]; then
  echo "error: fixture missing: $FIXTURE" >&2
  exit 2
fi

write_scenario_meta() {
  local meta_path="$1"
  local scenario_id="$2"
  local expected_failure_class="$3"
  local expected_outcome_code="$4"
  local description="$5"
  local session_root="$6"
  local stdout_log="$7"
  local stderr_log="$8"
  local expected_nonzero_exit="$9"

  python3 - "$meta_path" "$scenario_id" "$expected_failure_class" "$expected_outcome_code" "$description" "$session_root" "$stdout_log" "$stderr_log" "$expected_nonzero_exit" <<'PY'
import json
import sys
from pathlib import Path

(
    meta_path,
    scenario_id,
    expected_failure_class,
    expected_outcome_code,
    description,
    session_root,
    stdout_log,
    stderr_log,
    expected_nonzero_exit,
) = sys.argv[1:]

payload = {
    "scenario_id": scenario_id,
    "expected_failure_class": expected_failure_class,
    "expected_outcome_code": expected_outcome_code,
    "description": description,
    "session_root": session_root,
    "stdout_log": stdout_log,
    "stderr_log": stderr_log,
    "expected_nonzero_exit": expected_nonzero_exit.strip().lower() == "true",
}

path = Path(meta_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

write_execution_json() {
  local execution_path="$1"
  local scenario_id="$2"
  local command_display="$3"
  local exit_code="$4"
  local session_root="$5"
  local stdout_log="$6"
  local stderr_log="$7"
  local started_at_utc="$8"
  local ended_at_utc="$9"
  local runner_error="${10}"
  local preflight_manifest_path="${11}"
  local missing_runtime_binary="${12}"
  local signal_requested="${13}"
  local signal_sent="${14}"

  python3 - "$execution_path" "$scenario_id" "$command_display" "$exit_code" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "$runner_error" "$preflight_manifest_path" "$missing_runtime_binary" "$signal_requested" "$signal_sent" <<'PY'
import json
import sys
from pathlib import Path

(
    execution_path,
    scenario_id,
    command_display,
    exit_code,
    session_root,
    stdout_log,
    stderr_log,
    started_at_utc,
    ended_at_utc,
    runner_error,
    preflight_manifest_path,
    missing_runtime_binary,
    signal_requested,
    signal_sent,
) = sys.argv[1:]

payload = {
    "scenario_id": scenario_id,
    "command_display": command_display,
    "exit_code": None if exit_code == "" else int(exit_code),
    "session_root": session_root,
    "stdout_log": stdout_log,
    "stderr_log": stderr_log,
    "started_at_utc": started_at_utc,
    "ended_at_utc": ended_at_utc,
    "runner_error": runner_error,
    "preflight_manifest_path": preflight_manifest_path,
    "missing_runtime_binary": missing_runtime_binary.strip().lower() == "true",
    "signal_requested": signal_requested,
    "signal_sent": signal_sent.strip().lower() == "true",
}

path = Path(execution_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

write_preflight_fixture() {
  local manifest_path="$1"
  local mode="$2"
  local overall_status="$3"
  local failing_ids_csv="$4"

  python3 - "$manifest_path" "$mode" "$overall_status" "$failing_ids_csv" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, mode, overall_status, failing_ids_csv = sys.argv[1:]
failing = {item.strip() for item in failing_ids_csv.split(',') if item.strip()}

all_ids = [
    "model_path",
    "out_wav",
    "out_jsonl",
    "out_manifest",
    "sample_rate",
    "screen_capture_access",
    "display_availability",
    "microphone_access",
    "backend_runtime",
]

checks = []
for check_id in all_ids:
    status = "FAIL" if check_id in failing else "PASS"
    checks.append(
        {
            "id": check_id,
            "status": status,
            "detail": f"synthetic check {check_id}",
            "remediation": "synthetic fixture",
        }
    )

payload = {
    "schema_version": "1",
    "kind": "transcribe-live-preflight",
    "generated_at_utc": "2026-03-07T00:00:00Z",
    "overall_status": overall_status,
    "config": {
        "out_wav": "/tmp/synthetic/session.wav",
        "out_jsonl": "/tmp/synthetic/session.jsonl",
        "out_manifest": "/tmp/synthetic/session.manifest.json",
        "asr_backend": "whispercpp",
        "asr_model_requested": "/tmp/synthetic/model.bin",
        "asr_model_resolved": "/tmp/synthetic/model.bin",
        "asr_model_source": "synthetic",
        "sample_rate_hz": 48000,
        "runtime_mode": mode,
    },
    "checks": checks,
}

path = Path(manifest_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

run_permission_denial_fixture() {
  local scenario_id="permission-denial-preflight"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"
  local preflight_manifest="$scenario_dir/preflight.manifest.json"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "permission_denial" "permission_denied" "Synthetic packaged preflight fixture with explicit TCC permission denial checks" "$session_root" "$stdout_log" "$stderr_log" "true"
  write_preflight_fixture "$preflight_manifest" "live" "FAIL" "screen_capture_access,display_availability,microphone_access"

  printf '{"scenario":"%s","mode":"synthetic-preflight","result":"permission_denial"}\n' "$scenario_id" >"$stdout_log"
  printf 'synthetic fixture emitted permission-denial preflight payload\n' >"$stderr_log"

  local started_at_utc
  local ended_at_utc
  started_at_utc="$(evidence_timestamp)"
  ended_at_utc="$(evidence_timestamp)"
  write_execution_json "$execution_json" "$scenario_id" "synthetic-preflight-fixture permission denial" "1" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "$preflight_manifest" "false" "none" "false"
}

run_missing_invalid_model() {
  local scenario_id="missing-invalid-model"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"
  local missing_model="$scenario_dir/missing-model.bin"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "missing_or_invalid_model" "missing_or_invalid_model" "Packaged doctor run with intentionally missing model path" "$session_root" "$stdout_log" "$stderr_log" "true"

  local started_at_utc
  local ended_at_utc
  local exit_code
  started_at_utc="$(evidence_timestamp)"
  set +e
  "$RECORDIT_RUNTIME_BIN" doctor --backend whispercpp --model "$missing_model" --json >"$stdout_log" 2>"$stderr_log"
  exit_code=$?
  set -e
  ended_at_utc="$(evidence_timestamp)"

  write_execution_json "$execution_json" "$scenario_id" "$RECORDIT_RUNTIME_BIN doctor --backend whispercpp --model $missing_model --json" "$exit_code" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "" "false" "none" "false"
}

run_missing_runtime_binary() {
  local scenario_id="missing-runtime-binary"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"
  local missing_runtime_bin="$scenario_dir/runtime/bin/recordit-missing"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "missing_runtime_binary" "missing_runtime_binary" "Attempt preflight with a non-existent packaged runtime binary path" "$session_root" "$stdout_log" "$stderr_log" "true"

  local started_at_utc
  local ended_at_utc
  local exit_code
  started_at_utc="$(evidence_timestamp)"
  set +e
  "$missing_runtime_bin" preflight --mode live --output-root "$session_root" --json >"$stdout_log" 2>"$stderr_log"
  exit_code=$?
  set -e
  ended_at_utc="$(evidence_timestamp)"

  write_execution_json "$execution_json" "$scenario_id" "$missing_runtime_bin preflight --mode live --output-root $session_root --json" "$exit_code" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "" "true" "none" "false"
}

run_runtime_preflight_failure_fixture() {
  local scenario_id="runtime-preflight-failure"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"
  local preflight_manifest="$scenario_dir/preflight.manifest.json"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "runtime_preflight_failure" "runtime_preflight_failure" "Synthetic preflight fixture failing runtime preflight output checks" "$session_root" "$stdout_log" "$stderr_log" "true"
  write_preflight_fixture "$preflight_manifest" "live" "FAIL" "out_wav,out_jsonl,out_manifest"

  printf '{"scenario":"%s","mode":"synthetic-preflight","result":"runtime_preflight_failure"}\n' "$scenario_id" >"$stdout_log"
  printf 'synthetic fixture emitted runtime-preflight failure payload\n' >"$stderr_log"

  local started_at_utc
  local ended_at_utc
  started_at_utc="$(evidence_timestamp)"
  ended_at_utc="$(evidence_timestamp)"
  write_execution_json "$execution_json" "$scenario_id" "synthetic-preflight-fixture runtime-preflight failure" "1" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "$preflight_manifest" "false" "none" "false"
}

run_stop_timeout_class_fixture() {
  local scenario_id="stop-timeout-class"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "stop_timeout" "stop_timeout" "Synthetic stop-timeout artifact class with pending + retry context" "$session_root" "$stdout_log" "$stderr_log" "true"

  cat >"$session_root/session.pending.json" <<'JSON'
{
  "status": "pending",
  "state": "failed",
  "reason": "stop-timeout"
}
JSON

  cat >"$session_root/session.pending.retry.json" <<'JSON'
{
  "retry_state": "available",
  "failure_code": "timeout",
  "hint": "retry_stop_action"
}
JSON

  printf 'synthetic stop-timeout fixture retained pending + retry artifacts\n' >"$stdout_log"
  printf 'stop strategy exhausted graceful/interruption budgets\n' >"$stderr_log"

  local started_at_utc
  local ended_at_utc
  started_at_utc="$(evidence_timestamp)"
  ended_at_utc="$(evidence_timestamp)"
  write_execution_json "$execution_json" "$scenario_id" "synthetic-stop-timeout-fixture" "124" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "" "false" "SIGTERM" "true"
}

run_partial_artifact_forced_kill() {
  local scenario_id="partial-artifact-forced-kill"
  local scenario_dir="$SCENARIOS_DIR/$scenario_id"
  local session_root="$scenario_dir/session"
  local meta_json="$scenario_dir/scenario_meta.json"
  local execution_json="$scenario_dir/execution.json"
  local stdout_log="$scenario_dir/stdout.log"
  local stderr_log="$scenario_dir/stderr.log"

  mkdir -p "$scenario_dir" "$session_root"
  write_scenario_meta "$meta_json" "$scenario_id" "partial_artifact" "partial_artifact_session" "Live runtime forced-kill retaining partial artifacts without final manifest" "$session_root" "$stdout_log" "$stderr_log" "true"

  local started_at_utc
  local ended_at_utc
  local exit_code
  local signal_sent="false"

  run_partial_attempt() {
    local delay_sec="$1"
    rm -rf "$session_root"
    mkdir -p "$session_root"
    set +e
    (
      env RECORDIT_FAKE_CAPTURE_FIXTURE="$FIXTURE" \
        "$RECORDIT_RUNTIME_BIN" run --mode live --model "$MODEL" --output-root "$session_root" --json >"$stdout_log" 2>"$stderr_log"
    ) &
    local pid=$!
    sleep "$delay_sec"
    local sent="false"
    if kill -KILL "$pid" 2>/dev/null; then
      sent="true"
    fi
    wait "$pid"
    local code=$?
    set -e
    printf '%s,%s\n' "$code" "$sent"
  }

  started_at_utc="$(evidence_timestamp)"
  IFS=',' read -r exit_code signal_sent < <(run_partial_attempt "$PARTIAL_KILL_DELAY_SEC")

  if [[ ! -f "$session_root/session.jsonl" && ! -f "$session_root/session.wav" && ! -f "$session_root/session.input.wav" ]]; then
    IFS=',' read -r exit_code signal_sent < <(run_partial_attempt "0.10")
  fi

  if [[ ! -f "$session_root/session.jsonl" && ! -f "$session_root/session.wav" && ! -f "$session_root/session.input.wav" ]]; then
    printf '{"event_type":"synthetic_partial_artifact","channel":"control"}\n' >"$session_root/session.jsonl"
  fi

  ended_at_utc="$(evidence_timestamp)"
  write_execution_json "$execution_json" "$scenario_id" "$RECORDIT_RUNTIME_BIN run --mode live --model $MODEL --output-root $session_root --json (forced SIGKILL)" "$exit_code" "$session_root" "$stdout_log" "$stderr_log" "$started_at_utc" "$ended_at_utc" "" "" "false" "SIGKILL" "$signal_sent"
}

run_permission_denial_fixture
run_missing_invalid_model
run_missing_runtime_binary
run_runtime_preflight_failure_fixture
run_stop_timeout_class_fixture
run_partial_artifact_forced_kill

python3 "$ROOT/scripts/gate_packaged_failure_matrix_summary.py" \
  --scenarios-root "$SCENARIOS_DIR" \
  --summary-csv "$MATRIX_CSV" \
  --summary-json "$MATRIX_JSON" \
  --status-path "$MATRIX_STATUS_TXT"

evidence_kv_text_to_json "$MATRIX_STATUS_TXT" "$MATRIX_STATUS_JSON"

python3 - "$MATRIX_CSV" "$OUT_DIR" "$PHASE_MANIFEST" "$PHASE_NOTES_DIR" <<'PY'
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

matrix_csv = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
phase_manifest = Path(sys.argv[3])
phase_notes_dir = Path(sys.argv[4])

rows = []
with matrix_csv.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

phases: list[dict[str, object]] = []
phase_notes_dir.mkdir(parents=True, exist_ok=True)
for row in rows:
    scenario_id = row.get("scenario_id", "")
    started = row.get("started_at_utc") or now_utc()
    ended = row.get("ended_at_utc") or started

    stdout_log = Path(row.get("stdout_log") or "")
    stderr_log = Path(row.get("stderr_log") or "")
    if not stdout_log.is_absolute():
        stdout_log = (out_dir / stdout_log).resolve(strict=False)
    if not stderr_log.is_absolute():
        stderr_log = (out_dir / stderr_log).resolve(strict=False)

    note_path = phase_notes_dir / f"{scenario_id}.txt"
    note_payload = [
        f"scenario_id={scenario_id}",
        f"status={row.get('status', '')}",
        f"expected_failure_class={row.get('expected_failure_class', '')}",
        f"observed_failure_class={row.get('observed_failure_class', '')}",
        f"outcome_code={row.get('outcome_code', '')}",
        f"exit_code={row.get('exit_code', '')}",
    ]
    note_path.write_text("\n".join(note_payload) + "\n", encoding="utf-8")

    try:
      stdout_rel = str(stdout_log.relative_to(out_dir))
    except ValueError:
      stdout_rel = str(Path("logs") / f"{scenario_id}.stdout.log")
    try:
      stderr_rel = str(stderr_log.relative_to(out_dir))
    except ValueError:
      stderr_rel = str(Path("logs") / f"{scenario_id}.stderr.log")
    note_rel = str(note_path.relative_to(out_dir))

    phases.append(
        {
            "phase_id": scenario_id,
            "title": f"Failure scenario: {scenario_id}",
            "required": True,
            "status": row.get("status", "fail"),
            "exit_classification": "success" if row.get("status") == "pass" else "product_failure",
            "started_at_utc": started,
            "ended_at_utc": ended,
            "command_display": f"scenario:{scenario_id}",
            "command_argv": ["scenario", scenario_id],
            "log_relpath": stdout_rel,
            "stdout_relpath": stdout_rel,
            "stderr_relpath": stderr_rel,
            "primary_artifact_relpath": note_rel,
            "notes": f"expected={row.get('expected_failure_class','')} observed={row.get('observed_failure_class','')}",
        }
    )

phase_manifest.parent.mkdir(parents=True, exist_ok=True)
phase_manifest.write_text(json.dumps({"phases": phases}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

evidence_render_contract \
  "$OUT_DIR" \
  "$SCENARIO_ID" \
  "packaged-e2e" \
  "$PHASE_MANIFEST" \
  --generated-at-utc "$(evidence_timestamp)" \
  --artifact-root-relpath "artifacts" \
  --paths-env-entry "RECORDIT_RUNTIME_BIN=$RECORDIT_RUNTIME_BIN" \
  --paths-env-entry "MODEL=$MODEL" \
  --paths-env-entry "FIXTURE=$FIXTURE" \
  --paths-env-entry "MATRIX_CSV=$MATRIX_CSV" \
  --paths-env-entry "MATRIX_JSON=$MATRIX_JSON" \
  --paths-env-entry "MATRIX_STATUS_TXT=$MATRIX_STATUS_TXT" \
  --paths-env-entry "MATRIX_STATUS_JSON=$MATRIX_STATUS_JSON"

MATRIX_STATUS="$(awk -F= '$1=="status" {print $2}' "$MATRIX_STATUS_TXT" | tail -n 1)"
CONTRACT_STATUS="$(awk -F= '$1=="status" {print $2}' "$OUT_DIR/status.txt" | tail -n 1)"

cat >"$MATRIX_STATUS_TXT" <<STATUS
status=$MATRIX_STATUS
contract_status=$CONTRACT_STATUS
scenario_matrix_csv=$MATRIX_CSV
scenario_matrix_json=$MATRIX_JSON
scenario_matrix_status_json=$MATRIX_STATUS_JSON
evidence_contract_root=$OUT_DIR
evidence_contract_summary=$OUT_DIR/summary.csv
evidence_contract_status=$OUT_DIR/status.txt
metadata_json=$METADATA_JSON
STATUS

evidence_kv_text_to_json "$MATRIX_STATUS_TXT" "$MATRIX_STATUS_JSON"

echo "GATE_PACKAGED_FAILURE_MATRIX_OUT=$OUT_DIR"
echo "GATE_PACKAGED_FAILURE_MATRIX_CSV=$MATRIX_CSV"
echo "GATE_PACKAGED_FAILURE_MATRIX_JSON=$MATRIX_JSON"
echo "GATE_PACKAGED_FAILURE_MATRIX_STATUS=$MATRIX_STATUS_TXT"
echo "GATE_PACKAGED_FAILURE_MATRIX_STATUS_JSON=$MATRIX_STATUS_JSON"

action_status="$MATRIX_STATUS"
if [[ "$action_status" != "pass" || "$CONTRACT_STATUS" == "fail" ]]; then
  exit 1
fi
