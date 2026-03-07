#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SCENARIO_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SHELL_SAFE_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ALLOWED_LANE_TYPES = {
    "shell-e2e",
    "packaged-e2e",
    "xctest-evidence",
    "xcuitest-evidence",
    "hybrid-e2e",
}
ALLOWED_STATUS = {"pass", "warn", "fail", "skipped"}
ALLOWED_EXIT_CLASSIFICATIONS = {
    "success",
    "product_failure",
    "infra_failure",
    "contract_failure",
    "flake_retried",
    "skip_requested",
}
SUMMARY_HEADERS = [
    "scenario_id",
    "lane_type",
    "phase_id",
    "required",
    "status",
    "exit_classification",
    "started_at_utc",
    "ended_at_utc",
    "log_path",
    "primary_artifact",
]
SUMMARY_JSON_KEYS = {
    "scenario_id",
    "lane_type",
    "contract_version",
    "overall_status",
    "phase_count",
    "required_phase_count",
    "failed_phase_count",
    "warn_phase_count",
    "skipped_phase_count",
    "generated_at_utc",
    "manifest_relpath",
}
STATUS_KEYS = {
    "status",
    "scenario_id",
    "lane_type",
    "generated_at_utc",
    "summary_csv",
    "summary_json",
    "manifest",
}

STATUS_EXIT_CLASSIFICATIONS = {
    "pass": {"success"},
    "warn": {"flake_retried"},
    "fail": {"product_failure", "infra_failure", "contract_failure"},
    "skipped": {"skip_requested"},
}
REQUIRED_PATHS_ENV_BASE_KEYS = (
    "EVIDENCE_ROOT",
    "ARTIFACT_ROOT",
    "STATUS_TXT",
    "SUMMARY_CSV",
    "SUMMARY_JSON",
    "MANIFEST",
)


class ValidationError(Exception):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a Recordit e2e evidence root against the shared bd-2grd contract."
    )
    parser.add_argument("--root", required=True, type=Path, help="Evidence root directory")
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Optional manifest path; defaults to <root>/evidence_contract.json",
    )
    parser.add_argument(
        "--expect-lane-type",
        choices=sorted(ALLOWED_LANE_TYPES),
        help="Assert the manifest lane_type",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable success/failure JSON",
    )
    return parser.parse_args()


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValidationError(f"missing JSON file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValidationError(f"invalid JSON in {path}: {exc}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise ValidationError(f"unable to read JSON file {path}: {exc}") from exc
    ensure(isinstance(data, dict), f"expected object JSON at {path}")
    return data


def is_relative_safe(relpath: str) -> bool:
    path = Path(relpath)
    return not path.is_absolute() and ".." not in path.parts


def require_timestamp(value: Any, field: str) -> None:
    ensure(isinstance(value, str), f"{field} must be a string")
    ensure(TIMESTAMP_RE.match(value) is not None, f"{field} must be UTC RFC3339 with Z suffix")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise ValidationError(f"{field} must be a valid UTC RFC3339 timestamp with Z suffix") from exc


def ensure_timestamp_order(started_at: str, ended_at: str, field_prefix: str) -> None:
    ensure(started_at <= ended_at, f"{field_prefix} ended_at_utc must not be earlier than started_at_utc")


def require_nonnegative_int(value: Any, field: str) -> int:
    ensure(type(value) is int and value >= 0, f"{field} must be a non-negative integer")
    return value



def ensure_phase_status_classification_consistent(status: str, exit_classification: str, field_prefix: str) -> None:
    allowed = STATUS_EXIT_CLASSIFICATIONS[status]
    ensure(
        exit_classification in allowed,
        f"{field_prefix} status={status} requires exit_classification in {sorted(allowed)}",
    )


def parse_key_value_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise ValidationError(f"unable to read key/value file {path}: {exc}") from exc
    for line_number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        ensure("=" in line, f"invalid key=value line in {path.name} at line {line_number}: {raw}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        ensure(key, f"invalid empty key in {path.name} at line {line_number}")
        ensure(key not in data, f"duplicate key '{key}' in {path.name}")
        data[key] = value
    return data


def require_relpath(
    root: Path,
    relpath: Any,
    field: str,
    allow_empty: bool = False,
    path_kind: str = "any",
) -> Path:
    ensure(isinstance(relpath, str), f"{field} must be a string")
    if allow_empty and relpath == "":
        return root
    ensure(relpath != "", f"{field} must not be empty")
    ensure(is_relative_safe(relpath), f"{field} must be a safe relative path: {relpath}")
    resolved = root / relpath
    ensure(resolved.exists(), f"{field} path does not exist: {relpath}")
    try:
        canonical = resolved.resolve(strict=True)
    except OSError as exc:
        raise ValidationError(f"unable to resolve {field} path {relpath}: {exc}") from exc
    ensure(canonical.is_relative_to(root), f"{field} must stay within the evidence root: {relpath}")
    if path_kind == "file":
        ensure(canonical.is_file(), f"{field} must resolve to a file: {relpath}")
    elif path_kind == "dir":
        ensure(canonical.is_dir(), f"{field} must resolve to a directory: {relpath}")
    return resolved


def validate_manifest(root: Path, manifest: dict[str, Any], expect_lane_type: str | None) -> None:
    ensure(manifest.get("contract_name") == "recordit-e2e-evidence", "contract_name must be recordit-e2e-evidence")
    ensure(manifest.get("contract_version") == "1", "contract_version must be 1")

    scenario_id = manifest.get("scenario_id")
    ensure(isinstance(scenario_id, str) and SCENARIO_RE.match(scenario_id), "scenario_id must be a stable lowercase identifier")

    lane_type = manifest.get("lane_type")
    ensure(lane_type in ALLOWED_LANE_TYPES, f"lane_type must be one of {sorted(ALLOWED_LANE_TYPES)}")
    if expect_lane_type is not None:
        ensure(lane_type == expect_lane_type, f"expected lane_type={expect_lane_type}, found {lane_type}")

    require_timestamp(manifest.get("generated_at_utc"), "generated_at_utc")
    ensure(manifest.get("overall_status") in ALLOWED_STATUS, "overall_status must be pass/warn/fail/skipped")

    artifact_root = manifest.get("artifact_root_relpath")
    ensure(isinstance(artifact_root, str) and artifact_root, "artifact_root_relpath must be present")
    require_relpath(root, artifact_root, "artifact_root_relpath", path_kind="dir")

    for field in [
        "paths_env_relpath",
        "status_txt_relpath",
        "summary_csv_relpath",
        "summary_json_relpath",
    ]:
        value = manifest.get(field)
        ensure(isinstance(value, str), f"{field} must be a string")
        require_relpath(root, value, field, path_kind="file")

    phases = manifest.get("phases")
    ensure(isinstance(phases, list) and phases, "phases must be a non-empty array")

    seen_phase_ids: set[str] = set()
    fail_required = False
    for idx, phase in enumerate(phases):
        ensure(isinstance(phase, dict), f"phase[{idx}] must be an object")
        phase_id = phase.get("phase_id")
        ensure(isinstance(phase_id, str) and SCENARIO_RE.match(phase_id), f"phase[{idx}].phase_id is invalid")
        ensure(phase_id not in seen_phase_ids, f"duplicate phase_id: {phase_id}")
        seen_phase_ids.add(phase_id)
        ensure(isinstance(phase.get("title"), str) and phase["title"], f"phase[{idx}].title must be non-empty")
        ensure(isinstance(phase.get("required"), bool), f"phase[{idx}].required must be boolean")
        ensure(phase.get("status") in ALLOWED_STATUS, f"phase[{idx}].status invalid")
        ensure(
            phase.get("exit_classification") in ALLOWED_EXIT_CLASSIFICATIONS,
            f"phase[{idx}].exit_classification invalid",
        )
        started_at = phase.get("started_at_utc")
        ended_at = phase.get("ended_at_utc")
        require_timestamp(started_at, f"phase[{idx}].started_at_utc")
        require_timestamp(ended_at, f"phase[{idx}].ended_at_utc")
        ensure_timestamp_order(started_at, ended_at, f"phase[{idx}]")
        ensure(
            isinstance(phase.get("command_display"), str) and phase["command_display"],
            f"phase[{idx}].command_display must be non-empty",
        )
        command_argv = phase.get("command_argv")
        ensure(isinstance(command_argv, list) and command_argv, f"phase[{idx}].command_argv must be a non-empty array")
        ensure(all(isinstance(item, str) for item in command_argv), f"phase[{idx}].command_argv must contain only strings")
        require_relpath(root, phase.get("log_relpath"), f"phase[{idx}].log_relpath", path_kind="file")
        require_relpath(root, phase.get("stdout_relpath"), f"phase[{idx}].stdout_relpath", path_kind="file")
        require_relpath(root, phase.get("stderr_relpath"), f"phase[{idx}].stderr_relpath", path_kind="file")
        primary_artifact = phase.get("primary_artifact_relpath")
        ensure(isinstance(primary_artifact, str), f"phase[{idx}].primary_artifact_relpath must be a string")
        if primary_artifact:
            require_relpath(root, primary_artifact, f"phase[{idx}].primary_artifact_relpath", path_kind="file")
        extra_artifacts = phase.get("extra_artifact_relpaths", [])
        ensure(isinstance(extra_artifacts, list), f"phase[{idx}].extra_artifact_relpaths must be an array when present")
        for extra_idx, relpath in enumerate(extra_artifacts):
            ensure(isinstance(relpath, str), f"phase[{idx}].extra_artifact_relpaths[{extra_idx}] must be a string")
            require_relpath(root, relpath, f"phase[{idx}].extra_artifact_relpaths[{extra_idx}]")
        result_bundle = phase.get("result_bundle_relpath")
        if result_bundle is not None:
            ensure(isinstance(result_bundle, str), f"phase[{idx}].result_bundle_relpath must be a string")
            require_relpath(root, result_bundle, f"phase[{idx}].result_bundle_relpath", path_kind="dir")
        notes = phase.get("notes")
        if notes is not None:
            ensure(isinstance(notes, str), f"phase[{idx}].notes must be a string when present")
        if phase["status"] == "skipped":
            ensure(phase["exit_classification"] == "skip_requested", f"phase[{idx}] skipped phases must use exit_classification=skip_requested")
            ensure(isinstance(notes, str) and notes.strip(), f"phase[{idx}] skipped phases must include notes")
        if phase["exit_classification"] == "skip_requested":
            ensure(phase["status"] == "skipped", f"phase[{idx}] exit_classification=skip_requested requires status=skipped")
        if phase["exit_classification"] == "flake_retried":
            ensure(phase["status"] != "skipped", f"phase[{idx}] exit_classification=flake_retried is invalid for skipped phases")
            ensure(isinstance(notes, str) and notes.strip(), f"phase[{idx}] exit_classification=flake_retried requires notes")
        ensure_phase_status_classification_consistent(
            phase["status"],
            phase["exit_classification"],
            f"phase[{idx}]",
        )
        if phase["required"] and phase["status"] == "fail":
            fail_required = True

    phase_statuses = {phase["status"] for phase in phases}
    if fail_required:
        ensure(manifest["overall_status"] == "fail", "overall_status must be fail when a required phase failed")

    if manifest["overall_status"] == "pass":
        ensure(phase_statuses == {"pass"}, "overall_status=pass requires every phase to have status=pass")
    elif manifest["overall_status"] == "warn":
        ensure(not fail_required, "overall_status=warn is invalid when a required phase failed")
        ensure(phase_statuses != {"pass"}, "overall_status=warn requires at least one non-pass phase status")
    elif manifest["overall_status"] == "fail":
        ensure(fail_required, "overall_status=fail requires at least one required phase failure")
    elif manifest["overall_status"] == "skipped":
        ensure(phase_statuses == {"skipped"}, "overall_status=skipped requires every phase to have status=skipped")


def validate_status_file(root: Path, manifest: dict[str, Any], manifest_path: Path) -> None:
    status_path = root / manifest["status_txt_relpath"]
    status_map = parse_key_value_file(status_path)
    missing = STATUS_KEYS - set(status_map)
    ensure(not missing, f"status.txt missing keys: {sorted(missing)}")
    ensure(status_map["status"] == manifest["overall_status"], "status.txt status must match manifest overall_status")
    ensure(status_map["scenario_id"] == manifest["scenario_id"], "status.txt scenario_id must match manifest")
    ensure(status_map["lane_type"] == manifest["lane_type"], "status.txt lane_type must match manifest")
    require_timestamp(status_map["generated_at_utc"], "status.txt generated_at_utc")
    ensure(status_map["generated_at_utc"] == manifest["generated_at_utc"], "status.txt generated_at_utc must match manifest")
    summary_csv_path = require_relpath(root, status_map["summary_csv"], "status.txt summary_csv", path_kind="file")
    summary_json_path = require_relpath(root, status_map["summary_json"], "status.txt summary_json", path_kind="file")
    manifest_relpath = require_relpath(root, status_map["manifest"], "status.txt manifest", path_kind="file")
    ensure(summary_csv_path == root / manifest["summary_csv_relpath"], "status.txt summary_csv must match manifest summary_csv_relpath")
    ensure(summary_json_path == root / manifest["summary_json_relpath"], "status.txt summary_json must match manifest summary_json_relpath")
    ensure(manifest_relpath == manifest_path, "status.txt manifest must match the validated manifest path")


def validate_paths_env_resolved_path(
    root: Path,
    value: str,
    expected_path: Path,
    field: str,
) -> None:
    ensure(value != "", f"paths.env {field} must not be empty")
    candidate = Path(value)
    if candidate.is_absolute():
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exc:
            raise ValidationError(f"paths.env {field} absolute path could not be resolved: {value}") from exc
    else:
        ensure(is_relative_safe(value), f"paths.env {field} must be a safe relative path or absolute path: {value}")
        try:
            resolved = (root / value).resolve(strict=True)
        except OSError as exc:
            raise ValidationError(f"paths.env {field} relative path could not be resolved: {value}") from exc
    ensure(resolved == expected_path, f"paths.env {field} must resolve to {expected_path}")


def validate_paths_env(root: Path, manifest: dict[str, Any], manifest_path: Path) -> None:
    paths_env_path = root / manifest["paths_env_relpath"]
    values = parse_key_value_file(paths_env_path)
    ensure(values, "paths.env must contain at least one key=value entry")
    for key in values:
        ensure(
            SHELL_SAFE_ENV_KEY_RE.match(key) is not None,
            f"paths.env key must be shell-safe uppercase letters/digits/underscores: {key}",
        )

    missing = [key for key in REQUIRED_PATHS_ENV_BASE_KEYS if key not in values]
    ensure(not missing, f"paths.env missing required base keys: {missing}")

    artifact_root = require_relpath(
        root,
        manifest["artifact_root_relpath"],
        "artifact_root_relpath",
        allow_empty=True,
        path_kind="dir",
    ).resolve(strict=True)
    validate_paths_env_resolved_path(root, values["EVIDENCE_ROOT"], root.resolve(strict=True), "EVIDENCE_ROOT")
    validate_paths_env_resolved_path(root, values["ARTIFACT_ROOT"], artifact_root, "ARTIFACT_ROOT")
    validate_paths_env_resolved_path(root, values["STATUS_TXT"], (root / manifest["status_txt_relpath"]).resolve(strict=True), "STATUS_TXT")
    validate_paths_env_resolved_path(root, values["SUMMARY_CSV"], (root / manifest["summary_csv_relpath"]).resolve(strict=True), "SUMMARY_CSV")
    validate_paths_env_resolved_path(root, values["SUMMARY_JSON"], (root / manifest["summary_json_relpath"]).resolve(strict=True), "SUMMARY_JSON")
    validate_paths_env_resolved_path(root, values["MANIFEST"], manifest_path.resolve(strict=True), "MANIFEST")


def validate_summary_json(root: Path, manifest: dict[str, Any], manifest_path: Path) -> None:
    summary = load_json(root / manifest["summary_json_relpath"])
    missing = SUMMARY_JSON_KEYS - set(summary)
    ensure(not missing, f"summary.json missing keys: {sorted(missing)}")
    ensure(summary["scenario_id"] == manifest["scenario_id"], "summary.json scenario_id must match manifest")
    ensure(summary["lane_type"] == manifest["lane_type"], "summary.json lane_type must match manifest")
    ensure(summary["contract_version"] == manifest["contract_version"], "summary.json contract_version must match manifest")
    ensure(summary["overall_status"] == manifest["overall_status"], "summary.json overall_status must match manifest")
    require_timestamp(summary["generated_at_utc"], "summary.json generated_at_utc")
    ensure(summary["generated_at_utc"] == manifest["generated_at_utc"], "summary.json generated_at_utc must match manifest")
    phase_count = len(manifest["phases"])
    summary_phase_count = require_nonnegative_int(summary["phase_count"], "summary.json phase_count")
    required_phase_count = sum(1 for phase in manifest["phases"] if phase["required"])
    failed_phase_count = sum(1 for phase in manifest["phases"] if phase["status"] == "fail")
    warn_phase_count = sum(1 for phase in manifest["phases"] if phase["status"] == "warn")
    skipped_phase_count = sum(1 for phase in manifest["phases"] if phase["status"] == "skipped")
    summary_required_phase_count = require_nonnegative_int(summary["required_phase_count"], "summary.json required_phase_count")
    summary_failed_phase_count = require_nonnegative_int(summary["failed_phase_count"], "summary.json failed_phase_count")
    summary_warn_phase_count = require_nonnegative_int(summary["warn_phase_count"], "summary.json warn_phase_count")
    summary_skipped_phase_count = require_nonnegative_int(summary["skipped_phase_count"], "summary.json skipped_phase_count")
    ensure(summary_phase_count == phase_count, "summary.json phase_count must match manifest phase count")
    ensure(summary_required_phase_count == required_phase_count, "summary.json required_phase_count must match manifest phases")
    ensure(summary_failed_phase_count == failed_phase_count, "summary.json failed_phase_count must match manifest phases")
    ensure(summary_warn_phase_count == warn_phase_count, "summary.json warn_phase_count must match manifest phases")
    ensure(summary_skipped_phase_count == skipped_phase_count, "summary.json skipped_phase_count must match manifest phases")
    manifest_relpath = require_relpath(root, summary["manifest_relpath"], "summary.json manifest_relpath", path_kind="file")
    ensure(manifest_relpath == manifest_path, "summary.json manifest_relpath must match the validated manifest path")


def validate_summary_csv(root: Path, manifest: dict[str, Any]) -> None:
    path = root / manifest["summary_csv_relpath"]
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            ensure(reader.fieldnames == SUMMARY_HEADERS, f"summary.csv headers must be exactly {SUMMARY_HEADERS}")
            rows = list(reader)
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ValidationError(f"unable to read summary.csv {path}: {exc}") from exc
    ensure(len(rows) == len(manifest["phases"]), "summary.csv must contain exactly one row per manifest phase")
    phase_map = {phase["phase_id"]: phase for phase in manifest["phases"]}
    csv_phase_ids = [row["phase_id"] for row in rows]
    ensure(len(set(csv_phase_ids)) == len(csv_phase_ids), "summary.csv phase_id values must be unique")
    ensure(set(csv_phase_ids) == set(phase_map), f"summary.csv phase_id set must match manifest phases: expected {sorted(phase_map)}, found {sorted(set(csv_phase_ids))}")
    manifest_phase_ids = [phase["phase_id"] for phase in manifest["phases"]]
    ensure(csv_phase_ids == manifest_phase_ids, f"summary.csv phase order must match manifest phases: expected {manifest_phase_ids}, found {csv_phase_ids}")
    for row in rows:
        extra_columns = row.get(None)
        ensure(not extra_columns, f"summary.csv row has unexpected extra columns: {extra_columns}")
        for header in SUMMARY_HEADERS:
            ensure(row.get(header) is not None, f"summary.csv row is missing a value for column {header}")
        phase_id = row["phase_id"]
        phase = phase_map[phase_id]
        ensure(row["scenario_id"] == manifest["scenario_id"], f"summary.csv row scenario_id mismatch for phase {phase_id}")
        ensure(row["lane_type"] == manifest["lane_type"], f"summary.csv row lane_type mismatch for phase {phase_id}")
        ensure(row["required"] in {"true", "false"}, f"summary.csv required must be true/false for phase {phase_id}")
        ensure(row["status"] in ALLOWED_STATUS, f"summary.csv status invalid for phase {phase_id}")
        ensure(row["exit_classification"] in ALLOWED_EXIT_CLASSIFICATIONS, f"summary.csv exit_classification invalid for phase {phase_id}")
        ensure(row["required"] == ("true" if phase["required"] else "false"), f"summary.csv required mismatch for phase {phase_id}")
        ensure(row["status"] == phase["status"], f"summary.csv status mismatch for phase {phase_id}")
        ensure(row["exit_classification"] == phase["exit_classification"], f"summary.csv exit_classification mismatch for phase {phase_id}")
        ensure(row["log_path"] == phase["log_relpath"], f"summary.csv log_path mismatch for phase {phase_id}")
        ensure(row["primary_artifact"] == phase["primary_artifact_relpath"], f"summary.csv primary_artifact mismatch for phase {phase_id}")
        require_timestamp(row["started_at_utc"], f"summary.csv started_at_utc for {phase_id}")
        require_timestamp(row["ended_at_utc"], f"summary.csv ended_at_utc for {phase_id}")
        ensure_timestamp_order(row["started_at_utc"], row["ended_at_utc"], f"summary.csv phase {phase_id}")
        ensure(row["started_at_utc"] == phase["started_at_utc"], f"summary.csv started_at_utc mismatch for phase {phase_id}")
        ensure(row["ended_at_utc"] == phase["ended_at_utc"], f"summary.csv ended_at_utc mismatch for phase {phase_id}")
        require_relpath(root, row["log_path"], f"summary.csv log_path for {phase_id}", path_kind="file")
        if row["primary_artifact"]:
            require_relpath(root, row["primary_artifact"], f"summary.csv primary_artifact for {phase_id}", path_kind="file")


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    manifest_path = (args.manifest or (root / "evidence_contract.json")).resolve()

    try:
        ensure(root.is_dir(), f"root directory does not exist: {root}")
        manifest = load_json(manifest_path)
        validate_manifest(root, manifest, args.expect_lane_type)
        validate_paths_env(root, manifest, manifest_path)
        validate_status_file(root, manifest, manifest_path)
        validate_summary_json(root, manifest, manifest_path)
        validate_summary_csv(root, manifest)
    except ValidationError as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1

    result = {
        "ok": True,
        "root": str(root),
        "manifest": str(manifest_path),
        "scenario_id": manifest["scenario_id"],
        "lane_type": manifest["lane_type"],
        "phase_count": len(manifest["phases"]),
        "overall_status": manifest["overall_status"],
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(
            "validated e2e evidence root: "
            f"scenario_id={result['scenario_id']} lane_type={result['lane_type']} "
            f"phase_count={result['phase_count']} overall_status={result['overall_status']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
