#!/usr/bin/env python3
"""Summarize packaged failure-matrix scenarios into deterministic classifications."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TCC_FAILURE_IDS = {
    "screen_capture_access",
    "display_availability",
    "microphone_access",
}
RUNTIME_PREFLIGHT_IDS = {
    "out_wav",
    "out_jsonl",
    "out_manifest",
    "sample_rate",
}

REQUIRED_SCENARIOS = (
    "permission-denial-preflight",
    "missing-invalid-model",
    "missing-runtime-binary",
    "runtime-preflight-failure",
    "stop-timeout-class",
    "partial-artifact-forced-kill",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenarios-root", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--summary-json", required=True, type=Path)
    parser.add_argument("--status-path", required=True, type=Path)
    parser.add_argument(
        "--required-scenarios",
        nargs="*",
        default=list(REQUIRED_SCENARIOS),
        help="Required deterministic scenario IDs.",
    )
    return parser.parse_args()


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


def parse_json_object_from_text(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    raw = path.read_text(encoding="utf-8", errors="replace")
    stripped = raw.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            payload = json.loads(stripped)
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            pass

    for line in reversed(raw.splitlines()):
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def outcome_code_for_class(classification: str) -> str:
    mapping = {
        "permission_denial": "permission_denied",
        "missing_or_invalid_model": "missing_or_invalid_model",
        "missing_runtime_binary": "missing_runtime_binary",
        "runtime_preflight_failure": "runtime_preflight_failure",
        "stop_timeout": "stop_timeout",
        "partial_artifact": "partial_artifact_session",
        "unknown_failure": "unknown_failure",
    }
    return mapping.get(classification, "unknown_failure")


def classify_failure(
    *,
    meta: dict[str, Any],
    execution: dict[str, Any],
    session_root: Path,
    preflight_manifest: dict[str, Any],
    stdout_log: Path,
    stderr_log: Path,
) -> tuple[str, list[str], list[str]]:
    tcc_fail_ids: list[str] = []
    preflight_fail_ids: list[str] = []

    checks = preflight_manifest.get("checks")
    if isinstance(checks, list):
        for row in checks:
            if not isinstance(row, dict):
                continue
            check_id = str(row.get("id") or "").strip().lower()
            status = str(row.get("status") or "").strip().lower()
            if not check_id or status != "fail":
                continue
            preflight_fail_ids.append(check_id)
            if check_id in TCC_FAILURE_IDS:
                tcc_fail_ids.append(check_id)

    if bool(execution.get("missing_runtime_binary")):
        return ("missing_runtime_binary", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    stderr = stderr_log.read_text(encoding="utf-8", errors="replace") if stderr_log.is_file() else ""
    stdout = stdout_log.read_text(encoding="utf-8", errors="replace") if stdout_log.is_file() else ""
    runner_error = str(execution.get("runner_error") or "")
    combined = "\n".join([stderr, stdout, runner_error])

    if "No such file or directory" in combined or "not executable" in combined:
        return ("missing_runtime_binary", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if tcc_fail_ids:
        return ("permission_denial", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if "model_path" in preflight_fail_ids or "model_readability" in preflight_fail_ids:
        return ("missing_or_invalid_model", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if (
        "model_path\tFAIL" in combined
        or "model_path FAIL" in combined
        or "explicit `--asr-model` path does not exist" in combined
        or "model_path did not validate" in combined
    ):
        return ("missing_or_invalid_model", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if any(check_id in RUNTIME_PREFLIGHT_IDS for check_id in preflight_fail_ids):
        return ("runtime_preflight_failure", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    pending_exists = (session_root / "session.pending.json").is_file()
    retry_exists = (session_root / "session.pending.retry.json").is_file()
    if pending_exists and retry_exists:
        return ("stop_timeout", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    manifest_exists = (session_root / "session.manifest.json").is_file()
    jsonl_exists = (session_root / "session.jsonl").is_file()
    wav_exists = (session_root / "session.wav").is_file()
    input_exists = (session_root / "session.input.wav").is_file()
    if not manifest_exists and (jsonl_exists or wav_exists or input_exists or pending_exists or retry_exists):
        return ("partial_artifact", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if "model" in combined and "not" in combined and "found" in combined:
        return ("missing_or_invalid_model", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    if execution.get("exit_code") not in (None, 0, "0"):
        return ("runtime_preflight_failure", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))

    return ("unknown_failure", sorted(set(tcc_fail_ids)), sorted(set(preflight_fail_ids)))


def scenario_rows(scenarios_root: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if not scenarios_root.is_dir():
        return rows

    for scenario_dir in sorted(path for path in scenarios_root.iterdir() if path.is_dir()):
        meta = load_json(scenario_dir / "scenario_meta.json")
        execution = load_json(scenario_dir / "execution.json")

        scenario_id = str(meta.get("scenario_id") or scenario_dir.name)
        expected_failure_class = str(meta.get("expected_failure_class") or "")
        expected_outcome_code = str(meta.get("expected_outcome_code") or "")
        expected_nonzero_exit = bool(meta.get("expected_nonzero_exit", True))

        session_root = Path(str(execution.get("session_root") or meta.get("session_root") or (scenario_dir / "session")))
        stdout_log = Path(str(execution.get("stdout_log") or meta.get("stdout_log") or (scenario_dir / "stdout.log")))
        stderr_log = Path(str(execution.get("stderr_log") or meta.get("stderr_log") or (scenario_dir / "stderr.log")))
        preflight_manifest_path = Path(
            str(execution.get("preflight_manifest_path") or meta.get("preflight_manifest_path") or (scenario_dir / "preflight.manifest.json"))
        )

        preflight_manifest = load_json(preflight_manifest_path)
        if not preflight_manifest:
            preflight_manifest = parse_json_object_from_text(stdout_log)

        observed_failure_class, tcc_fail_ids, preflight_fail_ids = classify_failure(
            meta=meta,
            execution=execution,
            session_root=session_root,
            preflight_manifest=preflight_manifest,
            stdout_log=stdout_log,
            stderr_log=stderr_log,
        )
        observed_outcome_code = outcome_code_for_class(observed_failure_class)

        exit_code = execution.get("exit_code")
        try:
            exit_code_int = int(exit_code) if exit_code is not None and str(exit_code) != "" else None
        except ValueError:
            exit_code_int = None
        exit_nonzero_ok = (not expected_nonzero_exit) or (exit_code_int is not None and exit_code_int != 0)

        runner_error = str(execution.get("runner_error") or "")

        manifest_exists = (session_root / "session.manifest.json").is_file()
        jsonl_exists = (session_root / "session.jsonl").is_file()
        wav_exists = (session_root / "session.wav").is_file()
        input_exists = (session_root / "session.input.wav").is_file()
        pending_exists = (session_root / "session.pending.json").is_file()
        retry_exists = (session_root / "session.pending.retry.json").is_file()

        checks = [
            observed_failure_class == expected_failure_class,
            (not expected_outcome_code) or (observed_outcome_code == expected_outcome_code),
            exit_nonzero_ok,
            runner_error == "",
        ]
        status = "pass" if all(checks) else "fail"

        diagnostics = {
            "expected_nonzero_exit": expected_nonzero_exit,
            "preflight_overall_status": str(preflight_manifest.get("overall_status") or ""),
            "preflight_fail_ids": preflight_fail_ids,
            "tcc_fail_ids": tcc_fail_ids,
            "runner_error": runner_error,
        }

        rows.append(
            {
                "scenario_id": scenario_id,
                "status": status,
                "expected_failure_class": expected_failure_class,
                "observed_failure_class": observed_failure_class,
                "expected_outcome_code": expected_outcome_code,
                "outcome_code": observed_outcome_code,
                "exit_code": "" if exit_code_int is None else str(exit_code_int),
                "exit_nonzero_ok": bool_text(exit_nonzero_ok),
                "manifest_exists": bool_text(manifest_exists),
                "jsonl_exists": bool_text(jsonl_exists),
                "wav_exists": bool_text(wav_exists),
                "input_wav_exists": bool_text(input_exists),
                "pending_exists": bool_text(pending_exists),
                "retry_exists": bool_text(retry_exists),
                "preflight_manifest_exists": bool_text(preflight_manifest_path.is_file()),
                "tcc_fail_ids": "|".join(tcc_fail_ids),
                "session_root": str(session_root),
                "preflight_manifest_path": str(preflight_manifest_path),
                "stdout_log": str(stdout_log),
                "stderr_log": str(stderr_log),
                "started_at_utc": str(execution.get("started_at_utc") or ""),
                "ended_at_utc": str(execution.get("ended_at_utc") or ""),
                "runner_error": runner_error,
                "diagnostics": json.dumps(diagnostics, sort_keys=True),
            }
        )

    return rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "scenario_id",
        "status",
        "expected_failure_class",
        "observed_failure_class",
        "expected_outcome_code",
        "outcome_code",
        "exit_code",
        "exit_nonzero_ok",
        "manifest_exists",
        "jsonl_exists",
        "wav_exists",
        "input_wav_exists",
        "pending_exists",
        "retry_exists",
        "preflight_manifest_exists",
        "tcc_fail_ids",
        "session_root",
        "preflight_manifest_path",
        "stdout_log",
        "stderr_log",
        "started_at_utc",
        "ended_at_utc",
        "runner_error",
        "diagnostics",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(
    path: Path,
    rows: list[dict[str, str]],
    *,
    gate_pass: bool,
    required_scenarios: list[str],
    missing_required: list[str],
) -> None:
    payload = {
        "generated_at_utc": now_utc(),
        "scenario_count": len(rows),
        "failure_count": sum(1 for row in rows if row.get("status") != "pass"),
        "required_scenarios": required_scenarios,
        "missing_required_scenarios": missing_required,
        "gate_pass": gate_pass,
        "scenarios": rows,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_status(
    path: Path,
    *,
    gate_pass: bool,
    rows: list[dict[str, str]],
    required_scenarios: list[str],
    missing_required: list[str],
    summary_csv: Path,
    summary_json: Path,
) -> None:
    lines = [
        f"status={'pass' if gate_pass else 'fail'}",
        f"scenario_count={len(rows)}",
        f"failure_count={sum(1 for row in rows if row.get('status') != 'pass')}",
        f"required_scenario_count={len(required_scenarios)}",
        f"missing_required_count={len(missing_required)}",
        f"missing_required={','.join(missing_required)}",
        f"summary_csv={summary_csv}",
        f"summary_json={summary_json}",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    rows = scenario_rows(args.scenarios_root)
    required_scenarios = [item.strip() for item in args.required_scenarios if item.strip()]
    present = {row.get("scenario_id", "") for row in rows}
    missing_required = sorted(scenario for scenario in required_scenarios if scenario not in present)

    gate_pass = bool(rows) and not missing_required and all(row.get("status") == "pass" for row in rows)

    write_csv(args.summary_csv, rows)
    write_json(
        args.summary_json,
        rows,
        gate_pass=gate_pass,
        required_scenarios=required_scenarios,
        missing_required=missing_required,
    )
    write_status(
        args.status_path,
        gate_pass=gate_pass,
        rows=rows,
        required_scenarios=required_scenarios,
        missing_required=missing_required,
        summary_csv=args.summary_csv,
        summary_json=args.summary_json,
    )


if __name__ == "__main__":
    main()
