#!/usr/bin/env python3
"""Certify (or block) full-coverage claims from matrix + gate + bead status inputs."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


DEFAULT_REQUIRED_BEADS = [
    "bd-tr8z",  # readiness parity feature
    "bd-diqp",  # bundled runtime/model parity feature
    "bd-p77p",  # stop/finalization protection feature
    "bd-39i6",  # canonical downstream matrix inventory
    "bd-11vg",  # critical-surface gap report
    "bd-2j49",  # cross-lane evidence standard
]

HARD_BLOCKING_GAP_STATUSES = {"uncovered"}
SOFT_BLOCKING_GAP_STATUSES = {"partial", "covered-with-seams"}


@dataclass(frozen=True)
class BeadStatus:
    bead_id: str
    status: str


@dataclass(frozen=True)
class MatrixGap:
    surface_key: str
    gap_status: str
    remaining_gap: str
    follow_on_beads: str


@dataclass(frozen=True)
class EvidenceRootCheck:
    lane_id: str
    root: str
    errors: tuple[str, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--downstream-matrix-csv",
        type=Path,
        default=Path("docs/bd-39i6-canonical-downstream-matrix.csv"),
        help="Canonical downstream coverage matrix CSV",
    )
    parser.add_argument(
        "--critical-matrix-csv",
        type=Path,
        default=Path("docs/bd-39i6-critical-surface-coverage-matrix.csv"),
        help="Critical-surface matrix CSV",
    )
    parser.add_argument(
        "--anti-bypass-status-json",
        type=Path,
        required=True,
        help="Status JSON produced by scripts/gate_anti_bypass_claims.py",
    )
    parser.add_argument(
        "--anti-bypass-exit-code",
        type=int,
        default=0,
        help="Exit code from gate_anti_bypass_claims.sh (0 pass, non-zero fail)",
    )
    parser.add_argument(
        "--required-beads",
        default=",".join(DEFAULT_REQUIRED_BEADS),
        help="Comma-separated bead IDs required for certifying coverage claims",
    )
    parser.add_argument(
        "--bead-status-json",
        type=Path,
        default=None,
        help="Optional JSON object mapping bead IDs to statuses; if omitted, uses `br show`",
    )
    parser.add_argument(
        "--required-evidence-root",
        action="append",
        default=[],
        help="Required e2e evidence root (lane_id=path or path). May be repeated.",
    )
    parser.add_argument(
        "--required-evidence-files",
        default="evidence_contract.json,status.txt,summary.csv,summary.json,paths.env",
        help="Comma-separated files that must exist under each required evidence root",
    )
    parser.add_argument("--summary-csv", type=Path, required=True)
    parser.add_argument("--status-json", type=Path, required=True)
    parser.add_argument("--status-txt", type=Path, required=True)
    return parser.parse_args()


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"csv file not found: {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"csv has no header row: {path}")
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def split_csv_list(raw: str) -> list[str]:
    values = []
    for token in raw.split(","):
        token = token.strip()
        if token:
            values.append(token)
    return values


def parse_required_evidence_root(spec: str) -> tuple[str, Path]:
    raw = spec.strip()
    if not raw:
        raise SystemExit("required evidence root spec cannot be empty")
    if "=" in raw:
        lane_id, path_raw = raw.split("=", 1)
        lane_id = lane_id.strip() or "unnamed"
    else:
        path_raw = raw
        lane_id = Path(path_raw).name or "unnamed"
    root = Path(path_raw.strip()).expanduser().resolve(strict=False)
    return lane_id, root


def validate_required_evidence_root(lane_id: str, root: Path, required_files: list[str]) -> EvidenceRootCheck:
    errors: list[str] = []
    if not root.exists() or not root.is_dir():
        errors.append("root_missing")
        return EvidenceRootCheck(lane_id=lane_id, root=str(root), errors=tuple(errors))

    for rel in required_files:
        target = root / rel
        if not target.exists():
            errors.append(f"missing:{rel}")

    logs_dir = root / "logs"
    if not logs_dir.is_dir():
        errors.append("missing:logs/")
    else:
        has_log_file = any(path.is_file() for path in logs_dir.rglob("*"))
        if not has_log_file:
            errors.append("logs_empty")

    contract_path = root / "evidence_contract.json"
    if contract_path.exists():
        try:
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            phases = contract.get("phases", [])
            if not isinstance(phases, list) or not phases:
                errors.append("malformed:evidence_contract.phases")
        except Exception:
            errors.append("malformed:evidence_contract.json")

    status_path = root / "status.txt"
    if status_path.exists():
        try:
            lines = status_path.read_text(encoding="utf-8").splitlines()
            status_map = {}
            for raw_line in lines:
                line = raw_line.strip()
                if not line or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                status_map[key.strip()] = value.strip()
            if not status_map.get("status"):
                errors.append("malformed:status.txt")
        except Exception:
            errors.append("malformed:status.txt")

    summary_path = root / "summary.csv"
    if summary_path.exists():
        try:
            with summary_path.open(encoding="utf-8", newline="") as handle:
                reader = csv.DictReader(handle)
                fieldnames = reader.fieldnames or []
                rows = list(reader)
            if "phase_id" not in fieldnames or "status" not in fieldnames:
                errors.append("malformed:summary.csv.header")
            if not rows:
                errors.append("malformed:summary.csv.empty")
        except Exception:
            errors.append("malformed:summary.csv")

    return EvidenceRootCheck(lane_id=lane_id, root=str(root), errors=tuple(errors))


def normalize_status(raw: str) -> str:
    return raw.strip().lower()


def parse_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on", "pass"}:
            return True
        if normalized in {"0", "false", "no", "n", "off", "fail"}:
            return False
    return default


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def gather_downstream_gaps(rows: Iterable[dict[str, str]]) -> tuple[list[MatrixGap], list[MatrixGap]]:
    hard: list[MatrixGap] = []
    soft: list[MatrixGap] = []
    for row in rows:
        gap_status = normalize_status(row.get("gap_status", ""))
        if not gap_status:
            continue
        surface_key = row.get("surface_key", "") or row.get("surface", "")
        gap = MatrixGap(
            surface_key=surface_key,
            gap_status=gap_status,
            remaining_gap=row.get("remaining_gap", ""),
            follow_on_beads=row.get("follow_on_beads", ""),
        )
        if gap_status in HARD_BLOCKING_GAP_STATUSES:
            hard.append(gap)
        elif gap_status in SOFT_BLOCKING_GAP_STATUSES:
            soft.append(gap)
    return hard, soft


def gather_critical_remaining_gaps(rows: Iterable[dict[str, str]]) -> list[MatrixGap]:
    gaps: list[MatrixGap] = []
    for row in rows:
        remaining = row.get("remaining_gap", "").strip()
        if not remaining:
            continue
        lowered = remaining.lower()
        if lowered in {"none", "n/a", "na", "-"}:
            continue
        gaps.append(
            MatrixGap(
                surface_key=row.get("surface", "") or row.get("surface_key", ""),
                gap_status=normalize_status(row.get("gap_status", "")),
                remaining_gap=remaining,
                follow_on_beads=row.get("follow_on_beads", ""),
            )
        )
    return gaps


def read_anti_bypass(path: Path) -> dict:
    if not path.exists():
        return {
            "gate_pass": False,
            "violation_count": -1,
            "violations": [],
            "missing_status_json": True,
            "malformed_status_json": False,
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "gate_pass": False,
            "violation_count": -1,
            "violations": [],
            "missing_status_json": False,
            "malformed_status_json": True,
        }
    if not isinstance(payload, dict):
        return {
            "gate_pass": False,
            "violation_count": -1,
            "violations": [],
            "missing_status_json": False,
            "malformed_status_json": True,
        }
    payload.setdefault("gate_pass", False)
    payload.setdefault("violation_count", 0)
    payload.setdefault("violations", [])
    payload["gate_pass"] = parse_bool(payload.get("gate_pass", False), default=False)
    if not isinstance(payload.get("violations"), list):
        payload["violations"] = []
    payload["violation_count"] = safe_int(payload.get("violation_count", 0), default=0)
    payload["missing_status_json"] = False
    payload["malformed_status_json"] = False
    return payload


def bead_status_from_br(bead_id: str) -> BeadStatus:
    proc = subprocess.run(
        ["br", "show", bead_id, "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return BeadStatus(bead_id=bead_id, status="unknown")

    try:
        payload = json.loads(proc.stdout)
        status = normalize_status(str(payload[0].get("status", "unknown")))
    except Exception:
        status = "unknown"
    if not status:
        status = "unknown"
    return BeadStatus(bead_id=bead_id, status=status)


def load_bead_statuses(required_beads: list[str], override_json: Path | None) -> list[BeadStatus]:
    if override_json is not None:
        payload: dict[str, object]
        try:
            parsed = json.loads(override_json.read_text(encoding="utf-8"))
            payload = parsed if isinstance(parsed, dict) else {}
        except Exception:
            payload = {}
        statuses: list[BeadStatus] = []
        for bead_id in required_beads:
            raw = str(payload.get(bead_id, "unknown"))
            statuses.append(BeadStatus(bead_id=bead_id, status=normalize_status(raw) or "unknown"))
        return statuses

    return [bead_status_from_br(bead_id) for bead_id in required_beads]


def write_summary_csv(path: Path, rows: list[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        for key, value in rows:
            writer.writerow([key, value])


def write_status_txt(path: Path, rows: list[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for key, value in rows:
            handle.write(f"{key}={value}\n")


def main() -> None:
    args = parse_args()
    required_beads = split_csv_list(args.required_beads)

    downstream_rows = read_csv_rows(args.downstream_matrix_csv)
    critical_rows = read_csv_rows(args.critical_matrix_csv)

    hard_gaps, soft_gaps = gather_downstream_gaps(downstream_rows)
    critical_remaining = gather_critical_remaining_gaps(critical_rows)

    anti_bypass = read_anti_bypass(args.anti_bypass_status_json)
    anti_bypass_pass = parse_bool(anti_bypass.get("gate_pass", False), default=False) and args.anti_bypass_exit_code == 0

    bead_statuses = load_bead_statuses(required_beads, args.bead_status_json)
    open_required_beads = [b for b in bead_statuses if b.status != "closed"]

    required_evidence_files = split_csv_list(args.required_evidence_files)
    required_evidence_checks: list[EvidenceRootCheck] = []
    for spec in args.required_evidence_root:
        lane_id, root = parse_required_evidence_root(spec)
        required_evidence_checks.append(
            validate_required_evidence_root(lane_id=lane_id, root=root, required_files=required_evidence_files)
        )
    invalid_required_evidence = [check for check in required_evidence_checks if check.errors]

    hard_blockers: list[str] = []
    if not anti_bypass_pass:
        hard_blockers.append("anti_bypass_certifying_claim_failed")
    if anti_bypass.get("missing_status_json"):
        hard_blockers.append("anti_bypass_status_missing")
    if anti_bypass.get("malformed_status_json"):
        hard_blockers.append("anti_bypass_status_malformed")
    if hard_gaps:
        hard_blockers.append("downstream_matrix_has_uncovered_surfaces")
    if open_required_beads:
        hard_blockers.append("required_domain_beads_not_closed")
    if invalid_required_evidence:
        hard_blockers.append("required_evidence_missing_or_malformed")

    soft_blockers: list[str] = []
    if soft_gaps:
        soft_blockers.append("downstream_matrix_has_partial_or_seam_surfaces")
    if critical_remaining:
        soft_blockers.append("critical_surface_matrix_has_remaining_gaps")

    if hard_blockers:
        verdict = "false"
        certifying_claim_allowed = "false"
    elif soft_blockers:
        verdict = "unproven"
        certifying_claim_allowed = "false"
    else:
        verdict = "true"
        certifying_claim_allowed = "true"

    generated_at = now_utc()

    summary_rows = [
        ("generated_at_utc", generated_at),
        ("artifact_track", "gate_coverage_certification"),
        ("verdict", verdict),
        ("certifying_claim_allowed", certifying_claim_allowed),
        ("anti_bypass_pass", "true" if anti_bypass_pass else "false"),
        ("anti_bypass_violation_count", str(safe_int(anti_bypass.get("violation_count", 0), default=0))),
        ("required_bead_count", str(len(required_beads))),
        ("required_bead_open_count", str(len(open_required_beads))),
        ("downstream_uncovered_count", str(len(hard_gaps))),
        ("downstream_partial_or_seam_count", str(len(soft_gaps))),
        ("critical_remaining_gap_count", str(len(critical_remaining))),
        ("hard_blocker_count", str(len(hard_blockers))),
        ("soft_blocker_count", str(len(soft_blockers))),
        ("hard_blockers", "|".join(hard_blockers)),
        ("soft_blockers", "|".join(soft_blockers)),
        ("required_evidence_root_count", str(len(required_evidence_checks))),
        ("required_evidence_invalid_count", str(len(invalid_required_evidence))),
    ]

    write_summary_csv(args.summary_csv, summary_rows)
    write_status_txt(args.status_txt, summary_rows)

    status_payload = {
        "generated_at_utc": generated_at,
        "artifact_track": "gate_coverage_certification",
        "verdict": verdict,
        "certifying_claim_allowed": certifying_claim_allowed == "true",
        "inputs": {
            "downstream_matrix_csv": str(args.downstream_matrix_csv),
            "critical_matrix_csv": str(args.critical_matrix_csv),
            "anti_bypass_status_json": str(args.anti_bypass_status_json),
            "anti_bypass_exit_code": args.anti_bypass_exit_code,
            "required_beads": required_beads,
            "required_evidence_root_specs": args.required_evidence_root,
            "required_evidence_files": required_evidence_files,
        },
        "hard_blockers": hard_blockers,
        "soft_blockers": soft_blockers,
        "open_required_beads": [
            {
                "bead_id": b.bead_id,
                "status": b.status,
            }
            for b in open_required_beads
        ],
        "downstream_uncovered": [
            {
                "surface_key": gap.surface_key,
                "gap_status": gap.gap_status,
                "remaining_gap": gap.remaining_gap,
                "follow_on_beads": gap.follow_on_beads,
            }
            for gap in hard_gaps
        ],
        "downstream_partial_or_seam": [
            {
                "surface_key": gap.surface_key,
                "gap_status": gap.gap_status,
                "remaining_gap": gap.remaining_gap,
                "follow_on_beads": gap.follow_on_beads,
            }
            for gap in soft_gaps
        ],
        "critical_remaining_gaps": [
            {
                "surface_key": gap.surface_key,
                "remaining_gap": gap.remaining_gap,
                "follow_on_beads": gap.follow_on_beads,
            }
            for gap in critical_remaining
        ],
        "anti_bypass": {
            "gate_pass": parse_bool(anti_bypass.get("gate_pass", False), default=False),
            "violation_count": safe_int(anti_bypass.get("violation_count", 0), default=0),
            "violations": anti_bypass.get("violations", []),
            "missing_status_json": anti_bypass.get("missing_status_json", False),
            "malformed_status_json": anti_bypass.get("malformed_status_json", False),
        },
        "required_evidence": [
            {
                "lane_id": check.lane_id,
                "root": check.root,
                "valid": not check.errors,
                "errors": list(check.errors),
            }
            for check in required_evidence_checks
        ],
    }
    args.status_json.parent.mkdir(parents=True, exist_ok=True)
    args.status_json.write_text(json.dumps(status_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if verdict == "true":
        return
    if verdict == "unproven":
        raise SystemExit(
            "coverage certification is UNPROVEN: no hard blocker, but remaining partial/seam or explicit remaining-gap evidence blocks certifying claims"
        )
    raise SystemExit(
        "coverage certification is FALSE: hard blockers remain (anti-bypass/domain-bead closure/uncovered surfaces)"
    )


if __name__ == "__main__":
    main()
