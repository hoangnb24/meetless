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


def normalize_status(raw: str) -> str:
    return raw.strip().lower()


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
        }
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.setdefault("gate_pass", False)
    payload.setdefault("violation_count", 0)
    payload.setdefault("violations", [])
    payload["missing_status_json"] = False
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
        payload = json.loads(override_json.read_text(encoding="utf-8"))
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
    anti_bypass_pass = bool(anti_bypass.get("gate_pass", False)) and args.anti_bypass_exit_code == 0

    bead_statuses = load_bead_statuses(required_beads, args.bead_status_json)
    open_required_beads = [b for b in bead_statuses if b.status != "closed"]

    hard_blockers: list[str] = []
    if not anti_bypass_pass:
        hard_blockers.append("anti_bypass_certifying_claim_failed")
    if anti_bypass.get("missing_status_json"):
        hard_blockers.append("anti_bypass_status_missing")
    if hard_gaps:
        hard_blockers.append("downstream_matrix_has_uncovered_surfaces")
    if open_required_beads:
        hard_blockers.append("required_domain_beads_not_closed")

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
        ("anti_bypass_violation_count", str(int(anti_bypass.get("violation_count", 0)))),
        ("required_bead_count", str(len(required_beads))),
        ("required_bead_open_count", str(len(open_required_beads))),
        ("downstream_uncovered_count", str(len(hard_gaps))),
        ("downstream_partial_or_seam_count", str(len(soft_gaps))),
        ("critical_remaining_gap_count", str(len(critical_remaining))),
        ("hard_blocker_count", str(len(hard_blockers))),
        ("soft_blocker_count", str(len(soft_blockers))),
        ("hard_blockers", "|".join(hard_blockers)),
        ("soft_blockers", "|".join(soft_blockers)),
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
            "gate_pass": anti_bypass.get("gate_pass", False),
            "violation_count": anti_bypass.get("violation_count", 0),
            "violations": anti_bypass.get("violations", []),
            "missing_status_json": anti_bypass.get("missing_status_json", False),
        },
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
