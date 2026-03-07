#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SCENARIO_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SHELL_SAFE_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
LANE_TYPES = {"shell-e2e", "packaged-e2e", "hybrid-e2e"}
PHASE_STATUS = {"pass", "warn", "fail", "skipped"}
EXIT_CLASSIFICATIONS = {
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


class RenderError(Exception):
    pass


@dataclass(frozen=True)
class PhaseRecord:
    phase_id: str
    title: str
    required: bool
    status: str
    exit_classification: str
    started_at_utc: str
    ended_at_utc: str
    command_display: str
    command_argv: list[str]
    log_relpath: str
    stdout_relpath: str
    stderr_relpath: str
    primary_artifact_relpath: str
    extra_artifact_relpaths: list[str]
    result_bundle_relpath: str | None
    notes: str | None

    def as_manifest_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "phase_id": self.phase_id,
            "title": self.title,
            "required": self.required,
            "status": self.status,
            "exit_classification": self.exit_classification,
            "started_at_utc": self.started_at_utc,
            "ended_at_utc": self.ended_at_utc,
            "command_display": self.command_display,
            "command_argv": self.command_argv,
            "log_relpath": self.log_relpath,
            "stdout_relpath": self.stdout_relpath,
            "stderr_relpath": self.stderr_relpath,
            "primary_artifact_relpath": self.primary_artifact_relpath,
        }
        if self.extra_artifact_relpaths:
            payload["extra_artifact_relpaths"] = self.extra_artifact_relpaths
        if self.result_bundle_relpath is not None:
            payload["result_bundle_relpath"] = self.result_bundle_relpath
        if self.notes is not None:
            payload["notes"] = self.notes
        return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render the shared shell e2e evidence contract from a phase manifest."
    )
    parser.add_argument("--root", required=True, type=Path, help="Evidence root directory")
    parser.add_argument("--scenario-id", required=True, help="Stable scenario identifier")
    parser.add_argument("--lane-type", required=True, choices=sorted(LANE_TYPES))
    parser.add_argument("--phase-manifest", required=True, type=Path, help="JSON file containing phases[]")
    parser.add_argument("--generated-at-utc", required=True, help="UTC RFC3339 timestamp with Z suffix")
    parser.add_argument("--artifact-root-relpath", default="artifacts")
    parser.add_argument("--paths-env-relpath", default="paths.env")
    parser.add_argument("--status-txt-relpath", default="status.txt")
    parser.add_argument("--summary-csv-relpath", default="summary.csv")
    parser.add_argument("--summary-json-relpath", default="summary.json")
    parser.add_argument("--manifest-relpath", default="evidence_contract.json")
    parser.add_argument(
        "--paths-env-entry",
        action="append",
        default=[],
        help="Additional KEY=VALUE line to include in paths.env",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable success/failure payload",
    )
    return parser.parse_args()


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise RenderError(message)


def require_timestamp(value: str, field: str) -> None:
    ensure(isinstance(value, str) and TIMESTAMP_RE.match(value) is not None, f"{field} must be UTC RFC3339 with Z suffix")


def is_safe_relpath(raw: str) -> bool:
    path = Path(raw)
    return bool(raw) and not path.is_absolute() and ".." not in path.parts


def require_relpath(root: Path, value: str, field: str, *, path_kind: str = "any", allow_empty: bool = False) -> None:
    ensure(isinstance(value, str), f"{field} must be a string")
    if allow_empty and value == "":
        return
    ensure(is_safe_relpath(value), f"{field} must be a safe relative path: {value}")
    resolved = root / value
    ensure(resolved.exists(), f"{field} does not exist under the evidence root: {value}")
    canonical = resolved.resolve(strict=True)
    ensure(canonical.is_relative_to(root.resolve(strict=True)), f"{field} must stay within the evidence root: {value}")
    if path_kind == "file":
        ensure(canonical.is_file(), f"{field} must resolve to a file: {value}")
    elif path_kind == "dir":
        ensure(canonical.is_dir(), f"{field} must resolve to a directory: {value}")


def load_phase_records(path: Path, root: Path) -> list[PhaseRecord]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RenderError(f"missing phase manifest: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RenderError(f"invalid JSON in phase manifest {path}: {exc}") from exc

    if isinstance(raw, dict):
        phases = raw.get("phases")
    else:
        phases = raw
    ensure(isinstance(phases, list) and phases, "phase manifest must contain a non-empty array of phase objects")

    seen_phase_ids: set[str] = set()
    records: list[PhaseRecord] = []
    for idx, phase in enumerate(phases):
        ensure(isinstance(phase, dict), f"phase[{idx}] must be an object")
        phase_id = phase.get("phase_id")
        ensure(isinstance(phase_id, str) and SCENARIO_RE.match(phase_id), f"phase[{idx}].phase_id is invalid")
        ensure(phase_id not in seen_phase_ids, f"duplicate phase_id: {phase_id}")
        seen_phase_ids.add(phase_id)

        title = phase.get("title")
        required = phase.get("required")
        status = phase.get("status")
        exit_classification = phase.get("exit_classification")
        started_at_utc = phase.get("started_at_utc")
        ended_at_utc = phase.get("ended_at_utc")
        command_display = phase.get("command_display")
        command_argv = phase.get("command_argv")
        log_relpath = phase.get("log_relpath")
        stdout_relpath = phase.get("stdout_relpath")
        stderr_relpath = phase.get("stderr_relpath")
        primary_artifact_relpath = phase.get("primary_artifact_relpath", "")
        extra_artifact_relpaths = phase.get("extra_artifact_relpaths", [])
        result_bundle_relpath = phase.get("result_bundle_relpath")
        notes = phase.get("notes")

        ensure(isinstance(title, str) and title, f"phase[{idx}].title must be non-empty")
        ensure(isinstance(required, bool), f"phase[{idx}].required must be boolean")
        ensure(status in PHASE_STATUS, f"phase[{idx}].status invalid")
        ensure(exit_classification in EXIT_CLASSIFICATIONS, f"phase[{idx}].exit_classification invalid")
        require_timestamp(started_at_utc, f"phase[{idx}].started_at_utc")
        require_timestamp(ended_at_utc, f"phase[{idx}].ended_at_utc")
        ensure(started_at_utc <= ended_at_utc, f"phase[{idx}] ended_at_utc must not be earlier than started_at_utc")
        ensure(isinstance(command_display, str) and command_display, f"phase[{idx}].command_display must be non-empty")
        ensure(isinstance(command_argv, list) and command_argv and all(isinstance(item, str) for item in command_argv), f"phase[{idx}].command_argv must be a non-empty string array")
        require_relpath(root, log_relpath, f"phase[{idx}].log_relpath", path_kind="file")
        require_relpath(root, stdout_relpath, f"phase[{idx}].stdout_relpath", path_kind="file")
        require_relpath(root, stderr_relpath, f"phase[{idx}].stderr_relpath", path_kind="file")
        require_relpath(root, primary_artifact_relpath, f"phase[{idx}].primary_artifact_relpath", allow_empty=True)
        ensure(isinstance(extra_artifact_relpaths, list), f"phase[{idx}].extra_artifact_relpaths must be an array")
        for extra_idx, relpath in enumerate(extra_artifact_relpaths):
            ensure(isinstance(relpath, str), f"phase[{idx}].extra_artifact_relpaths[{extra_idx}] must be a string")
            require_relpath(root, relpath, f"phase[{idx}].extra_artifact_relpaths[{extra_idx}]")
        if result_bundle_relpath is not None:
            ensure(isinstance(result_bundle_relpath, str), f"phase[{idx}].result_bundle_relpath must be a string")
            require_relpath(root, result_bundle_relpath, f"phase[{idx}].result_bundle_relpath", path_kind="dir")
        if notes is not None:
            ensure(isinstance(notes, str), f"phase[{idx}].notes must be a string when present")
        if status == "skipped":
            ensure(exit_classification == "skip_requested", f"phase[{idx}] skipped phases must use exit_classification=skip_requested")
            ensure(isinstance(notes, str) and notes, f"phase[{idx}] skipped phases must include notes")
        if exit_classification == "skip_requested":
            ensure(status == "skipped", f"phase[{idx}] exit_classification=skip_requested requires status=skipped")
        if exit_classification == "flake_retried":
            ensure(status != "skipped", f"phase[{idx}] exit_classification=flake_retried is invalid for skipped phases")
            ensure(isinstance(notes, str) and notes, f"phase[{idx}] exit_classification=flake_retried requires notes")

        records.append(
            PhaseRecord(
                phase_id=phase_id,
                title=title,
                required=required,
                status=status,
                exit_classification=exit_classification,
                started_at_utc=started_at_utc,
                ended_at_utc=ended_at_utc,
                command_display=command_display,
                command_argv=command_argv,
                log_relpath=log_relpath,
                stdout_relpath=stdout_relpath,
                stderr_relpath=stderr_relpath,
                primary_artifact_relpath=primary_artifact_relpath,
                extra_artifact_relpaths=list(extra_artifact_relpaths),
                result_bundle_relpath=result_bundle_relpath,
                notes=notes,
            )
        )
    return records


def compute_overall_status(phases: list[PhaseRecord]) -> str:
    statuses = {phase.status for phase in phases}
    if statuses == {"skipped"}:
        return "skipped"
    if any(phase.required and phase.status == "fail" for phase in phases):
        return "fail"
    if statuses == {"pass"}:
        return "pass"
    return "warn"


def write_paths_env(
    path: Path,
    root: Path,
    artifact_root_relpath: str,
    status_txt_relpath: str,
    summary_csv_relpath: str,
    summary_json_relpath: str,
    manifest_relpath: str,
    entries: list[str],
) -> None:
    base_entries = {
        "EVIDENCE_ROOT": str(root.resolve()),
        "ARTIFACT_ROOT": str((root / artifact_root_relpath).resolve()),
        "STATUS_TXT": str((root / status_txt_relpath).resolve()),
        "SUMMARY_CSV": str((root / summary_csv_relpath).resolve()),
        "SUMMARY_JSON": str((root / summary_json_relpath).resolve()),
        "MANIFEST": str((root / manifest_relpath).resolve()),
    }
    ordered_entries = list(base_entries.items())
    seen_keys = set(base_entries)
    for entry in entries:
        ensure("=" in entry, f"paths.env entry must be KEY=VALUE: {entry}")
        key, value = entry.split("=", 1)
        key = key.strip()
        ensure(key, f"paths.env entry has empty key: {entry}")
        ensure(SHELL_SAFE_ENV_KEY_RE.match(key) is not None, f"paths.env entry key must be shell-safe uppercase letters/digits/underscores: {key}")
        ensure(key not in seen_keys, f"paths.env entry duplicates reserved key: {key}")
        seen_keys.add(key)
        ordered_entries.append((key, value.strip()))
    path.write_text("\n".join(f"{key}={value}" for key, value in ordered_entries) + "\n", encoding="utf-8")


def write_summary_csv(path: Path, scenario_id: str, lane_type: str, phases: list[PhaseRecord]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(SUMMARY_HEADERS)
        for phase in phases:
            writer.writerow([
                scenario_id,
                lane_type,
                phase.phase_id,
                "true" if phase.required else "false",
                phase.status,
                phase.exit_classification,
                phase.started_at_utc,
                phase.ended_at_utc,
                phase.log_relpath,
                phase.primary_artifact_relpath,
            ])


def write_summary_json(path: Path, scenario_id: str, lane_type: str, overall_status: str, generated_at_utc: str, manifest_relpath: str, phases: list[PhaseRecord]) -> None:
    payload = {
        "scenario_id": scenario_id,
        "lane_type": lane_type,
        "contract_version": "1",
        "overall_status": overall_status,
        "phase_count": len(phases),
        "required_phase_count": sum(1 for phase in phases if phase.required),
        "failed_phase_count": sum(1 for phase in phases if phase.status == "fail"),
        "warn_phase_count": sum(1 for phase in phases if phase.status == "warn"),
        "skipped_phase_count": sum(1 for phase in phases if phase.status == "skipped"),
        "generated_at_utc": generated_at_utc,
        "manifest_relpath": manifest_relpath,
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_status_txt(path: Path, scenario_id: str, lane_type: str, overall_status: str, generated_at_utc: str, summary_csv_relpath: str, summary_json_relpath: str, manifest_relpath: str) -> None:
    lines = [
        f"status={overall_status}",
        f"scenario_id={scenario_id}",
        f"lane_type={lane_type}",
        f"generated_at_utc={generated_at_utc}",
        f"summary_csv={summary_csv_relpath}",
        f"summary_json={summary_json_relpath}",
        f"manifest={manifest_relpath}",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_manifest(path: Path, scenario_id: str, lane_type: str, generated_at_utc: str, artifact_root_relpath: str, overall_status: str, paths_env_relpath: str, status_txt_relpath: str, summary_csv_relpath: str, summary_json_relpath: str, phases: list[PhaseRecord]) -> None:
    payload = {
        "contract_name": "recordit-e2e-evidence",
        "contract_version": "1",
        "scenario_id": scenario_id,
        "lane_type": lane_type,
        "generated_at_utc": generated_at_utc,
        "artifact_root_relpath": artifact_root_relpath,
        "overall_status": overall_status,
        "paths_env_relpath": paths_env_relpath,
        "status_txt_relpath": status_txt_relpath,
        "summary_csv_relpath": summary_csv_relpath,
        "summary_json_relpath": summary_json_relpath,
        "phases": [phase.as_manifest_dict() for phase in phases],
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    try:
        root = args.root.resolve()
        ensure(root.is_dir(), f"evidence root must exist and be a directory: {args.root}")
        ensure(SCENARIO_RE.match(args.scenario_id) is not None, "scenario_id must be a stable lowercase identifier")
        require_timestamp(args.generated_at_utc, "generated_at_utc")
        require_relpath(root, args.artifact_root_relpath, "artifact_root_relpath", path_kind="dir")

        phases = load_phase_records(args.phase_manifest, root)
        overall_status = compute_overall_status(phases)

        paths_env_path = root / args.paths_env_relpath
        status_txt_path = root / args.status_txt_relpath
        summary_csv_path = root / args.summary_csv_relpath
        summary_json_path = root / args.summary_json_relpath
        manifest_path = root / args.manifest_relpath

        for target in [paths_env_path, status_txt_path, summary_csv_path, summary_json_path, manifest_path]:
            target.parent.mkdir(parents=True, exist_ok=True)

        write_paths_env(
            paths_env_path,
            root,
            args.artifact_root_relpath,
            args.status_txt_relpath,
            args.summary_csv_relpath,
            args.summary_json_relpath,
            args.manifest_relpath,
            args.paths_env_entry,
        )
        write_summary_csv(summary_csv_path, args.scenario_id, args.lane_type, phases)
        write_summary_json(summary_json_path, args.scenario_id, args.lane_type, overall_status, args.generated_at_utc, args.manifest_relpath, phases)
        write_status_txt(status_txt_path, args.scenario_id, args.lane_type, overall_status, args.generated_at_utc, args.summary_csv_relpath, args.summary_json_relpath, args.manifest_relpath)
        write_manifest(manifest_path, args.scenario_id, args.lane_type, args.generated_at_utc, args.artifact_root_relpath, overall_status, args.paths_env_relpath, args.status_txt_relpath, args.summary_csv_relpath, args.summary_json_relpath, phases)

        result = {
            "ok": True,
            "scenario_id": args.scenario_id,
            "lane_type": args.lane_type,
            "overall_status": overall_status,
            "phase_count": len(phases),
            "manifest_relpath": args.manifest_relpath,
        }
        if args.json:
            sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
        else:
            sys.stdout.write(f"rendered shell evidence contract for {args.scenario_id} ({overall_status})\n")
        return 0
    except RenderError as exc:
        if args.json:
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True) + "\n")
        else:
            sys.stderr.write(f"render_shell_e2e_evidence_contract.py: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
