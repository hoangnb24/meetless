#!/usr/bin/env python3
"""Summarize packaged stop/finalization scenario artifacts with canonical outcome codes."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenarios-root", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--summary-json", required=True, type=Path)
    parser.add_argument("--status-path", required=True, type=Path)
    return parser.parse_args()


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


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def canonical_outcome(manifest: dict[str, Any], *, manifest_exists: bool, wav_exists: bool, jsonl_exists: bool, input_exists: bool) -> tuple[str, str, str, bool]:
    if manifest_exists:
        session_summary = manifest.get("session_summary")
        if not isinstance(session_summary, dict):
            session_summary = {}
        trust = manifest.get("trust")
        if not isinstance(trust, dict):
            trust = {}

        session_status = str(session_summary.get("session_status") or manifest.get("status") or "").strip().lower()
        degraded = bool(trust.get("degraded_mode_active"))

        if session_status in {"failed", "failure", "error"}:
            return ("finalized_failure", "finalized_failure", session_status, degraded)
        if session_status in {"degraded"}:
            return ("finalized_success", "finalized_degraded_success", session_status, True)
        if session_status in {"pending"}:
            return ("partial_artifact", "partial_artifact_session", session_status, degraded)
        if session_status in {"ok", "success", "completed"}:
            code = "finalized_degraded_success" if degraded else "finalized_success"
            return ("finalized_success", code, session_status, degraded)

        return ("finalized_failure", "finalized_failure", session_status or "unknown", degraded)

    if wav_exists or jsonl_exists or input_exists:
        return ("partial_artifact", "partial_artifact_session", "missing_manifest", False)
    return ("empty_root", "empty_session_root", "empty_root", False)


def scenario_rows(scenarios_root: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if not scenarios_root.is_dir():
        return rows

    for scenario_dir in sorted(p for p in scenarios_root.iterdir() if p.is_dir()):
        meta = load_json(scenario_dir / "scenario_meta.json")
        execution = load_json(scenario_dir / "execution.json")

        scenario_id = str(meta.get("scenario_id") or scenario_dir.name)
        expected_outcome_code = str(meta.get("expected_outcome_code") or "")
        expected_runtime_mode = str(meta.get("expected_runtime_mode") or "")
        expected_manifest_exists = bool(meta.get("expected_manifest_exists"))
        mode = str(meta.get("mode") or execution.get("mode") or "")

        session_root = Path(str(execution.get("session_root") or meta.get("session_root") or scenario_dir / "session"))
        manifest_path = session_root / "session.manifest.json"
        jsonl_path = session_root / "session.jsonl"
        wav_path = session_root / "session.wav"
        input_wav_path = session_root / "session.input.wav"

        manifest_exists = manifest_path.is_file()
        jsonl_exists = jsonl_path.is_file()
        wav_exists = wav_path.is_file()
        input_exists = input_wav_path.is_file()

        manifest = load_json(manifest_path)
        runtime_mode = str(manifest.get("runtime_mode") or "")
        outcome_classification, outcome_code, session_status, degraded_mode_active = canonical_outcome(
            manifest,
            manifest_exists=manifest_exists,
            wav_exists=wav_exists,
            jsonl_exists=jsonl_exists,
            input_exists=input_exists,
        )

        exit_code = execution.get("exit_code")
        exit_code_text = "" if exit_code is None else str(exit_code)
        signal_requested = str(execution.get("signal_requested") or "none")
        signal_sent = bool(execution.get("signal_sent"))
        runner_error = str(execution.get("runner_error") or "")

        checks = [
            outcome_code == expected_outcome_code,
            runtime_mode == expected_runtime_mode,
            manifest_exists == expected_manifest_exists,
            runner_error == "",
        ]
        status = "pass" if all(checks) else "fail"

        diagnostics = {
            "runner_error": runner_error,
            "session_status": session_status,
            "degraded_mode_active": degraded_mode_active,
            "signal_requested": signal_requested,
            "signal_sent": signal_sent,
            "manifest_exists": manifest_exists,
            "jsonl_exists": jsonl_exists,
            "wav_exists": wav_exists,
            "input_wav_exists": input_exists,
        }

        rows.append(
            {
                "scenario_id": scenario_id,
                "mode": mode,
                "status": status,
                "exit_code": exit_code_text,
                "signal_requested": signal_requested,
                "signal_sent": bool_text(signal_sent),
                "runtime_mode": runtime_mode,
                "session_status": session_status,
                "manifest_exists": bool_text(manifest_exists),
                "jsonl_exists": bool_text(jsonl_exists),
                "wav_exists": bool_text(wav_exists),
                "input_wav_exists": bool_text(input_exists),
                "outcome_classification": outcome_classification,
                "outcome_code": outcome_code,
                "expected_outcome_code": expected_outcome_code,
                "expected_runtime_mode": expected_runtime_mode,
                "expected_manifest_exists": bool_text(expected_manifest_exists),
                "session_root": str(session_root),
                "manifest_path": str(manifest_path),
                "stdout_log": str(execution.get("stdout_log") or meta.get("stdout_log") or ""),
                "stderr_log": str(execution.get("stderr_log") or meta.get("stderr_log") or ""),
                "diagnostics": json.dumps(diagnostics, sort_keys=True),
            }
        )

    return rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "scenario_id",
        "mode",
        "status",
        "exit_code",
        "signal_requested",
        "signal_sent",
        "runtime_mode",
        "session_status",
        "manifest_exists",
        "jsonl_exists",
        "wav_exists",
        "input_wav_exists",
        "outcome_classification",
        "outcome_code",
        "expected_outcome_code",
        "expected_runtime_mode",
        "expected_manifest_exists",
        "session_root",
        "manifest_path",
        "stdout_log",
        "stderr_log",
        "diagnostics",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(path: Path, rows: list[dict[str, str]], gate_pass: bool) -> None:
    payload = {
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "scenario_count": len(rows),
        "failure_count": sum(1 for row in rows if row.get("status") != "pass"),
        "gate_pass": gate_pass,
        "scenarios": rows,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_status(path: Path, rows: list[dict[str, str]], gate_pass: bool, summary_csv: Path, summary_json: Path) -> None:
    failure_count = sum(1 for row in rows if row.get("status") != "pass")
    lines = [
        f"status={'pass' if gate_pass else 'fail'}",
        f"scenario_count={len(rows)}",
        f"failure_count={failure_count}",
        f"summary_csv={summary_csv}",
        f"summary_json={summary_json}",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    rows = scenario_rows(args.scenarios_root)
    gate_pass = bool(rows) and all(row.get("status") == "pass" for row in rows)

    write_csv(args.summary_csv, rows)
    write_json(args.summary_json, rows, gate_pass)
    write_status(args.status_path, rows, gate_pass, args.summary_csv, args.summary_json)


if __name__ == "__main__":
    main()
