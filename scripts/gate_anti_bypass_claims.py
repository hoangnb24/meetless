#!/usr/bin/env python3
"""Gate certifying coverage claims when known bypass seams remain active."""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SEAM_FAMILY_ALIASES: dict[str, tuple[str, ...]] = {
    "ui_test_mode": ("ui_test_mode", "ui-test-mode", "recordit_ui_test_mode"),
    "preview_di": ("preview_di", "preview-di", "preview"),
    "mock": ("mock", "mockservices"),
    "stub": ("stub", "stubbed"),
    "scripted_runtime": ("scripted_runtime", "scripted runtime"),
    "runtime_override": ("runtime_override", "runtime override", "/usr/bin/true"),
}

TOKEN_TO_SEAM_FAMILY: dict[str, str] = {}
for seam_family, aliases in SEAM_FAMILY_ALIASES.items():
    for alias in aliases:
        TOKEN_TO_SEAM_FAMILY[alias] = seam_family


@dataclass(frozen=True)
class SurfaceViolation:
    surface_key: str
    gap_status: str
    lane_id: str
    seam_families: tuple[str, ...]
    seam_sources: tuple[str, ...]
    exception_ids: tuple[str, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--matrix-csv",
        type=Path,
        default=Path("docs/bd-39i6-canonical-downstream-matrix.csv"),
        help="Canonical downstream coverage matrix CSV",
    )
    parser.add_argument(
        "--exception-register-csv",
        type=Path,
        default=Path("docs/bd-2mbp-critical-path-exception-register.csv"),
        help="No-mock critical-path exception register CSV",
    )
    parser.add_argument(
        "--claim-level",
        choices=["real-environment-verified", "partial", "simulation-covered"],
        default="real-environment-verified",
        help="Claim level being evaluated",
    )
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--status-json", required=False, type=Path)
    return parser.parse_args()


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"csv file not found: {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"csv has no header row: {path}")
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def split_pipe_tokens(value: str) -> list[str]:
    tokens: list[str] = []
    for token in value.split("|"):
        token = token.strip()
        if token:
            tokens.append(token)
    return tokens


def canonicalize_token(token: str) -> str:
    lowered = token.strip().lower().replace(" ", "_").replace("-", "_")
    if lowered in TOKEN_TO_SEAM_FAMILY:
        return TOKEN_TO_SEAM_FAMILY[lowered]
    if "recordit_ui_test_mode" in lowered or "ui_test_mode" in lowered:
        return "ui_test_mode"
    if "preview" in lowered:
        return "preview_di"
    if "mock" in lowered:
        return "mock"
    if "stub" in lowered:
        return "stub"
    if "scripted_runtime" in lowered or "scripted" in lowered:
        return "scripted_runtime"
    if "runtime_override" in lowered or "/usr/bin/true" in lowered:
        return "runtime_override"
    return ""


def seam_families_from_matrix_row(row: dict[str, str]) -> set[str]:
    families: set[str] = set()
    for token in split_pipe_tokens(row.get("main_bypass_or_limit", "")):
        family = canonicalize_token(token)
        if family:
            families.add(family)
    for token in split_pipe_tokens(row.get("lane_id", "")):
        family = canonicalize_token(token)
        if family:
            families.add(family)
    return families


def seam_families_from_exception_row(row: dict[str, str]) -> set[str]:
    families: set[str] = set()
    for token in split_pipe_tokens(row.get("seam_family", "")):
        family = canonicalize_token(token)
        if family:
            families.add(family)
    for token in split_pipe_tokens(row.get("seam_detail", "")):
        family = canonicalize_token(token)
        if family:
            families.add(family)
    return families


def index_active_exceptions(
    exception_rows: list[dict[str, str]],
) -> dict[str, list[dict[str, str]]]:
    by_surface: dict[str, list[dict[str, str]]] = {}
    for row in exception_rows:
        status = row.get("status", "").strip().lower()
        if status not in {"active", "replacement_in_progress"}:
            continue
        surface_key = row.get("surface_key", "").strip()
        if not surface_key:
            continue
        by_surface.setdefault(surface_key, []).append(row)
    return by_surface


def analyze_claim(
    matrix_rows: list[dict[str, str]],
    exception_rows: list[dict[str, str]],
    claim_level: str,
) -> tuple[bool, list[SurfaceViolation], dict[str, int]]:
    active_exception_index = index_active_exceptions(exception_rows)
    violations: list[SurfaceViolation] = []
    seam_counts: dict[str, int] = {
        "ui_test_mode": 0,
        "preview_di": 0,
        "mock": 0,
        "stub": 0,
        "scripted_runtime": 0,
        "runtime_override": 0,
    }

    for row in matrix_rows:
        surface_key = row.get("surface_key", "")
        if not surface_key:
            continue
        matrix_families = seam_families_from_matrix_row(row)
        exception_records = active_exception_index.get(surface_key, [])
        exception_families: set[str] = set()
        for record in exception_records:
            exception_families.update(seam_families_from_exception_row(record))

        seam_families = matrix_families.union(exception_families)
        if not seam_families:
            continue
        for family in seam_families:
            if family in seam_counts:
                seam_counts[family] += 1

        seam_sources = split_pipe_tokens(row.get("main_bypass_or_limit", ""))
        for record in exception_records:
            seam_sources.extend(split_pipe_tokens(record.get("seam_detail", "")))
        exception_ids = [
            record.get("exception_id", "")
            for record in exception_records
            if record.get("exception_id", "")
        ]
        violations.append(
            SurfaceViolation(
                surface_key=surface_key,
                gap_status=row.get("gap_status", ""),
                lane_id=row.get("lane_id", ""),
                seam_families=tuple(sorted(seam_families)),
                seam_sources=tuple(sorted(set(seam_sources))),
                exception_ids=tuple(sorted(set(exception_ids))),
            )
        )

    requires_downgrade = len(violations) > 0
    gate_pass = True
    if claim_level == "real-environment-verified" and requires_downgrade:
        gate_pass = False
    return gate_pass, violations, seam_counts


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def write_summary_csv(
    path: Path,
    matrix_path: Path,
    exception_path: Path,
    claim_level: str,
    gate_pass: bool,
    violations: list[SurfaceViolation],
    seam_counts: dict[str, int],
) -> None:
    recommended_claim_level = (
        "simulation-covered" if violations else "real-environment-verified"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        writer.writerow(
            ["generated_at_utc", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")]
        )
        writer.writerow(["artifact_track", "gate_anti_bypass_claims"])
        writer.writerow(["matrix_csv", str(matrix_path)])
        writer.writerow(["exception_register_csv", str(exception_path)])
        writer.writerow(["claim_level", claim_level])
        writer.writerow(["gate_pass", bool_text(gate_pass)])
        writer.writerow(["recommended_claim_level", recommended_claim_level])
        writer.writerow(["seam_surface_count", len(violations)])
        writer.writerow(
            ["violating_surface_keys", "|".join(v.surface_key for v in violations)]
        )
        writer.writerow(["ui_test_mode_surface_count", seam_counts["ui_test_mode"]])
        writer.writerow(["preview_di_surface_count", seam_counts["preview_di"]])
        writer.writerow(["mock_surface_count", seam_counts["mock"]])
        writer.writerow(["stub_surface_count", seam_counts["stub"]])
        writer.writerow(["scripted_runtime_surface_count", seam_counts["scripted_runtime"]])
        writer.writerow(["runtime_override_surface_count", seam_counts["runtime_override"]])


def write_status_json(
    path: Path,
    claim_level: str,
    gate_pass: bool,
    violations: list[SurfaceViolation],
) -> None:
    payload = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "artifact_track": "gate_anti_bypass_claims",
        "claim_level": claim_level,
        "gate_pass": gate_pass,
        "recommended_claim_level": (
            "simulation-covered" if violations else "real-environment-verified"
        ),
        "violation_count": len(violations),
        "violations": [
            {
                "surface_key": v.surface_key,
                "gap_status": v.gap_status,
                "lane_id": v.lane_id,
                "seam_families": list(v.seam_families),
                "seam_sources": list(v.seam_sources),
                "exception_ids": list(v.exception_ids),
            }
            for v in violations
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    matrix_rows = read_csv_rows(args.matrix_csv)
    exception_rows = read_csv_rows(args.exception_register_csv)

    gate_pass, violations, seam_counts = analyze_claim(
        matrix_rows=matrix_rows,
        exception_rows=exception_rows,
        claim_level=args.claim_level,
    )
    write_summary_csv(
        path=args.summary_csv,
        matrix_path=args.matrix_csv,
        exception_path=args.exception_register_csv,
        claim_level=args.claim_level,
        gate_pass=gate_pass,
        violations=violations,
        seam_counts=seam_counts,
    )
    if args.status_json:
        write_status_json(
            path=args.status_json,
            claim_level=args.claim_level,
            gate_pass=gate_pass,
            violations=violations,
        )

    if not gate_pass:
        surface_list = ", ".join(v.surface_key for v in violations)
        raise SystemExit(
            "anti-bypass gate failed: certifying claim blocked by active seam-bearing "
            f"surfaces ({surface_list})"
        )


if __name__ == "__main__":
    main()
