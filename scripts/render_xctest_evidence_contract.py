#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
SHARED_RENDERER_PATH = SCRIPT_PATH.with_name("render_shell_e2e_evidence_contract.py")

_spec = importlib.util.spec_from_file_location("recordit_shared_evidence_renderer", SHARED_RENDERER_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"unable to load shared renderer from {SHARED_RENDERER_PATH}")
_shared = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _shared
_spec.loader.exec_module(_shared)

LANE_TYPES = {"xctest-evidence", "xcuitest-evidence"}
FLAKE_MARKERS = (
    "bootstrap-flake detected",
    "Early unexpected exit, operation never finished bootstrapping",
    "Test crashed with signal kill before starting test execution",
)


@dataclass(frozen=True)
class PhaseSpec:
    step_name: str
    title: str
    primary_artifact_relpath: str = ""
    extra_artifact_relpaths: tuple[str, ...] = ()


PHASE_SPECS: dict[str, tuple[PhaseSpec, ...]] = {
    "xctest-evidence": (
        PhaseSpec("prepare_runtime_inputs", "Prepare runtime inputs", primary_artifact_relpath=""),
        PhaseSpec("build_for_testing", "Build for testing"),
        PhaseSpec("unit_tests", "Run unit tests"),
        PhaseSpec(
            "responsiveness_budget_gate",
            "Run responsiveness budget gate",
            primary_artifact_relpath="responsiveness_budget_summary.csv",
            extra_artifact_relpaths=("responsiveness_budget_summary.json",),
        ),
    ),
    "xcuitest-evidence": (
        PhaseSpec("build_for_testing", "Build for UI testing"),
        PhaseSpec("discover_xctestrun", "Discover xctestrun for UI bundle"),
        PhaseSpec("uitest_onboarding_happy_path", "Run onboarding happy-path UI test"),
        PhaseSpec("uitest_permission_recovery", "Run permission-recovery UI test"),
        PhaseSpec("uitest_live_run_summary", "Run live-run summary UI test"),
        PhaseSpec("uitest_runtime_recovery", "Run runtime-recovery UI test"),
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render XCTest/XCUITest retained-evidence contracts from ci_recordit_xctest_evidence outputs."
    )
    parser.add_argument("--root", required=True, type=Path, help="Evidence root directory")
    parser.add_argument("--scenario-id", required=True, help="Stable scenario identifier")
    parser.add_argument("--lane-type", required=True, choices=sorted(LANE_TYPES))
    parser.add_argument("--generated-at-utc", required=True, help="UTC RFC3339 timestamp with Z suffix")
    parser.add_argument("--status-csv-relpath", default="status.csv")
    parser.add_argument("--artifact-root-relpath", default=".")
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
    parser.add_argument("--json", action="store_true", help="Emit machine-readable success/failure payload")
    return parser.parse_args()


class RenderError(Exception):
    pass



def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise RenderError(message)



def utc_from_mtime(path: Path) -> str:
    stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return stamp.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")



def to_relpath(root: Path, raw: str) -> str:
    if not raw:
        return ""
    path = Path(raw)
    candidate = path if path.is_absolute() else (root / path)
    resolved = candidate.resolve(strict=True)
    try:
        return resolved.relative_to(root.resolve(strict=True)).as_posix()
    except ValueError as exc:
        raise RenderError(f"path must stay within evidence root: {raw}") from exc



def load_status_rows(status_csv_path: Path) -> dict[str, dict[str, str]]:
    ensure(status_csv_path.is_file(), f"status csv is missing: {status_csv_path}")
    with status_csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    ensure(rows, f"status csv has no step rows: {status_csv_path}")
    by_step: dict[str, dict[str, str]] = {}
    for row in rows:
        step = (row.get("step") or "").strip()
        ensure(step, "status csv row is missing step")
        by_step[step] = row
    return by_step



def command_display_for_step(step_name: str) -> str:
    if step_name == "prepare_runtime_inputs":
        return "scripts/prepare_recordit_runtime_inputs.sh"
    if step_name == "discover_xctestrun":
        return "find DerivedData/Build/Products -name '*.xctestrun' | head -n 1"
    if step_name == "build_for_testing":
        return "xcodebuild build-for-testing -project Recordit.xcodeproj -scheme RecorditApp"
    if step_name == "unit_tests":
        return "xcodebuild test -project Recordit.xcodeproj -scheme RecorditApp -only-testing:RecorditAppTests"
    if step_name == "responsiveness_budget_gate":
        return "xcodebuild test -project Recordit.xcodeproj -scheme RecorditApp -only-testing:RecorditAppTests/RecorditAppTests/testAppLevelResponsivenessBudgetsForLiveRun"
    if step_name.startswith("uitest_"):
        return f"xcodebuild test-without-building -only-testing:{step_name}"
    return step_name



def command_argv_for_display(command_display: str) -> list[str]:
    return ["bash", "-lc", command_display]



def infer_status_and_exit(row: dict[str, str], log_path: Path) -> tuple[str, str, str | None]:
    result = (row.get("result") or "").strip()
    required = (row.get("required") or "").strip() in {"1", "true", "True"}
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
    flake_retry = any(marker in log_text for marker in FLAKE_MARKERS) and result == "pass"
    if flake_retry:
        return "warn", "flake_retried", "bootstrap retry was required before the final successful UI pass"
    if result == "pass":
        return "pass", "success", None
    if row.get("step") == "discover_xctestrun":
        return "fail", "contract_failure", "xctestrun discovery failed, so UI execution could not proceed"
    if required:
        return "fail", "product_failure", None
    return "fail", "product_failure", None



def resolve_stream_relpath(root: Path, row: dict[str, str], key: str, fallback_key: str = "log_path") -> str:
    return to_relpath(root, (row.get(key) or row.get(fallback_key) or "").strip())



def build_phase_record(root: Path, row: dict[str, str], spec: PhaseSpec, generated_at_utc: str) -> _shared.PhaseRecord:
    log_relpath = to_relpath(root, (row.get("log_path") or "").strip())
    ensure(log_relpath, f"step {spec.step_name} is missing log_path")
    log_path = (root / log_relpath).resolve(strict=True)
    stdout_relpath = resolve_stream_relpath(root, row, "stdout_path")
    stderr_relpath = resolve_stream_relpath(root, row, "stderr_path")
    ensure(stdout_relpath, f"step {spec.step_name} is missing stdout_path/log_path")
    ensure(stderr_relpath, f"step {spec.step_name} is missing stderr_path/log_path")
    result_bundle_relpath = to_relpath(root, (row.get("result_bundle_path") or "").strip())
    status, exit_classification, notes = infer_status_and_exit(row, log_path)
    timestamp = utc_from_mtime(log_path) if log_path.exists() else generated_at_utc

    primary_artifact_relpath = ""
    if spec.primary_artifact_relpath:
        artifact_path = root / spec.primary_artifact_relpath
        if artifact_path.exists():
            primary_artifact_relpath = spec.primary_artifact_relpath

    extra_artifacts = [rel for rel in spec.extra_artifact_relpaths if (root / rel).exists()]

    return _shared.PhaseRecord(
        phase_id=spec.step_name,
        title=spec.title,
        required=(row.get("required") or "").strip() in {"1", "true", "True"},
        status=status,
        exit_classification=exit_classification,
        started_at_utc=timestamp,
        ended_at_utc=timestamp,
        command_display=command_display_for_step(spec.step_name),
        command_argv=command_argv_for_display(command_display_for_step(spec.step_name)),
        log_relpath=log_relpath,
        stdout_relpath=stdout_relpath,
        stderr_relpath=stderr_relpath,
        primary_artifact_relpath=primary_artifact_relpath,
        extra_artifact_relpaths=extra_artifacts,
        result_bundle_relpath=result_bundle_relpath or None,
        notes=notes,
    )



def load_phase_records(root: Path, lane_type: str, status_rows: dict[str, dict[str, str]], generated_at_utc: str) -> list[_shared.PhaseRecord]:
    phases: list[_shared.PhaseRecord] = []
    for spec in PHASE_SPECS[lane_type]:
        row = status_rows.get(spec.step_name)
        if row is None:
            continue
        phases.append(build_phase_record(root, row, spec, generated_at_utc))
    ensure(phases, f"no status rows matched lane_type={lane_type}")
    return phases



def main() -> int:
    args = parse_args()
    try:
        root = args.root.resolve()
        ensure(root.is_dir(), f"evidence root must exist and be a directory: {args.root}")
        ensure(_shared.SCENARIO_RE.match(args.scenario_id) is not None, "scenario_id must be a stable lowercase identifier")
        _shared.require_timestamp(args.generated_at_utc, "generated_at_utc")
        _shared.require_relpath(root, args.artifact_root_relpath, "artifact_root_relpath", path_kind="dir")

        status_rows = load_status_rows(root / args.status_csv_relpath)
        phases = load_phase_records(root, args.lane_type, status_rows, args.generated_at_utc)
        overall_status = _shared.compute_overall_status(phases)

        paths_env_path = root / args.paths_env_relpath
        status_txt_path = root / args.status_txt_relpath
        summary_csv_path = root / args.summary_csv_relpath
        summary_json_path = root / args.summary_json_relpath
        manifest_path = root / args.manifest_relpath
        for target in [paths_env_path, status_txt_path, summary_csv_path, summary_json_path, manifest_path]:
            target.parent.mkdir(parents=True, exist_ok=True)

        _shared.write_paths_env(
            paths_env_path,
            root,
            args.artifact_root_relpath,
            args.status_txt_relpath,
            args.summary_csv_relpath,
            args.summary_json_relpath,
            args.manifest_relpath,
            args.paths_env_entry,
        )
        _shared.write_summary_csv(summary_csv_path, args.scenario_id, args.lane_type, phases)
        _shared.write_summary_json(
            summary_json_path,
            args.scenario_id,
            args.lane_type,
            overall_status,
            args.generated_at_utc,
            args.manifest_relpath,
            phases,
        )
        _shared.write_status_txt(
            status_txt_path,
            args.scenario_id,
            args.lane_type,
            overall_status,
            args.generated_at_utc,
            args.summary_csv_relpath,
            args.summary_json_relpath,
            args.manifest_relpath,
        )
        _shared.write_manifest(
            manifest_path,
            args.scenario_id,
            args.lane_type,
            args.generated_at_utc,
            args.artifact_root_relpath,
            overall_status,
            args.paths_env_relpath,
            args.status_txt_relpath,
            args.summary_csv_relpath,
            args.summary_json_relpath,
            phases,
        )

        payload = {
            "ok": True,
            "scenario_id": args.scenario_id,
            "lane_type": args.lane_type,
            "overall_status": overall_status,
            "phase_count": len(phases),
            "manifest_relpath": args.manifest_relpath,
        }
        if args.json:
            sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
        else:
            sys.stdout.write(f"rendered xctest evidence contract for {args.scenario_id} ({overall_status})\n")
        return 0
    except (RenderError, _shared.RenderError) as exc:
        if args.json:
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True) + "\n")
        else:
            sys.stderr.write(f"render_xctest_evidence_contract.py: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
