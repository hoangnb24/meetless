#!/usr/bin/env python3
"""Aggregate journey-level checks for gate_default_user_journey_e2e."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dmg-status", required=True, type=Path)
    parser.add_argument("--xctest-status-csv", required=True, type=Path)
    parser.add_argument("--xctest-summary-json", required=True, type=Path)
    parser.add_argument("--xcuitest-summary-json", required=True, type=Path)
    parser.add_argument("--packaged-summary-csv", required=True, type=Path)
    parser.add_argument("--packaged-status-txt", required=True, type=Path)
    parser.add_argument("--out-csv", required=True, type=Path)
    parser.add_argument("--out-json", type=Path)
    parser.add_argument("--require-pass", action="store_true")
    return parser.parse_args()


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def parse_kv_text(path: Path) -> dict[str, str]:
    payload: dict[str, str] = {}
    if not path.is_file():
        return payload
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        payload[key.strip()] = value.strip()
    return payload


def parse_kv_csv(path: Path) -> dict[str, str]:
    payload: dict[str, str] = {}
    if not path.is_file():
        return payload
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        for index, row in enumerate(reader):
            if not row:
                continue
            key = row[0].strip()
            value = "" if len(row) < 2 else row[1].strip()
            if index == 0 and key.lower() == "key" and value.lower() == "value":
                continue
            payload[key] = value
    return payload


def parse_step_results(path: Path) -> dict[str, str]:
    payload: dict[str, str] = {}
    if not path.is_file():
        return payload

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            step = str(row.get("step", "")).strip()
            result = str(row.get("result", "")).strip()
            if step:
                payload[step] = result
    return payload


def parse_summary_status(path: Path) -> str:
    if not path.is_file():
        return "missing"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return "invalid"
    if not isinstance(payload, dict):
        return "invalid"
    value = payload.get("overall_status")
    if isinstance(value, str) and value:
        return value
    return "missing"


def main() -> None:
    args = parse_args()

    dmg_status = parse_kv_text(args.dmg_status)
    dmg_pass = dmg_status.get("status") == "pass"

    xctest_steps = parse_step_results(args.xctest_status_csv)
    onboarding_happy_path_pass = xctest_steps.get("uitest_onboarding_happy_path") == "pass"
    live_run_summary_pass = xctest_steps.get("uitest_live_run_summary") == "pass"
    xctest_steps_present = bool(xctest_steps)

    xctest_overall_status = parse_summary_status(args.xctest_summary_json)
    xcuitest_overall_status = parse_summary_status(args.xcuitest_summary_json)

    packaged_summary = parse_kv_csv(args.packaged_summary_csv)
    packaged_status = parse_kv_text(args.packaged_status_txt)

    packaged_gate_pass = packaged_summary.get("gate_pass") == "true"
    packaged_artifacts_ok = all(
        packaged_summary.get(key) == "true"
        for key in [
            "runtime_manifest_exists",
            "runtime_jsonl_exists",
            "runtime_out_wav_truth_ok",
            "runtime_artifact_root_ok",
        ]
    )

    journey_claim_ready = all(
        [
            dmg_pass,
            xctest_steps_present,
            onboarding_happy_path_pass,
            live_run_summary_pass,
            xctest_overall_status in {"pass", "warn"},
            xcuitest_overall_status in {"pass", "warn"},
            packaged_gate_pass,
            packaged_artifacts_ok,
        ]
    )

    summary: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "artifact_track": "gate_default_user_journey_e2e",
        "dmg_status_file": str(args.dmg_status),
        "xctest_status_csv": str(args.xctest_status_csv),
        "xctest_summary_json": str(args.xctest_summary_json),
        "xcuitest_summary_json": str(args.xcuitest_summary_json),
        "packaged_summary_csv": str(args.packaged_summary_csv),
        "packaged_status_txt": str(args.packaged_status_txt),
        "dmg_phase_pass": bool_text(dmg_pass),
        "xctest_steps_present": bool_text(xctest_steps_present),
        "onboarding_happy_path_pass": bool_text(onboarding_happy_path_pass),
        "live_run_summary_pass": bool_text(live_run_summary_pass),
        "xctest_overall_status": xctest_overall_status,
        "xcuitest_overall_status": xcuitest_overall_status,
        "packaged_gate_pass": bool_text(packaged_gate_pass),
        "packaged_artifacts_ok": bool_text(packaged_artifacts_ok),
        "packaged_status": packaged_status.get("status", "missing"),
        "journey_claim_ready": bool_text(journey_claim_ready),
    }

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        for key, value in summary.items():
            writer.writerow([key, value])

    if args.out_json is not None:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.require_pass and not journey_claim_ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
