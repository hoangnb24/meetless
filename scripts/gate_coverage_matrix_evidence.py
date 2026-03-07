#!/usr/bin/env python3
"""CI gate for coverage-matrix completeness and required e2e evidence presence."""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_REQUIRED_DOWNSTREAM = [
    "onboarding-completion-routing",
    "permission-remediation",
    "startup-runtime-readiness",
    "preflight-contract-gating",
    "app-shell-runtime-lifecycle",
    "ui-automation-live-run",
    "packaged-local-app-path",
    "release-signing-notarization",
    "dmg-install-open",
    "production-app-journey",
]

DEFAULT_REQUIRED_CRITICAL = [
    "onboarding-completion",
    "permission-remediation",
    "live-readiness-contract",
    "runtime-binary-readiness",
    "app-shell-runtime-lifecycle",
    "ui-automation-live-run",
    "packaged-local-app-path",
    "release-signing-notarization",
    "dmg-install-open",
]

DEFAULT_REQUIRED_FAILURE_SCENARIOS = [
    "permission-denial-preflight",
    "missing-invalid-model",
    "missing-runtime-binary",
    "runtime-preflight-failure",
    "stop-timeout-class",
    "partial-artifact-forced-kill",
]

DEFAULT_CLAIM_SCAN_FILES = [
    "README.md",
    "docs/bd-b2qv-release-checklist.md",
]

CLAIM_PATTERNS = [
    re.compile(r"\bfull coverage\b", re.IGNORECASE),
    re.compile(r"\bfully verified\b", re.IGNORECASE),
    re.compile(r"\bcompletely tested\b", re.IGNORECASE),
    re.compile(r"\bcomprehensive coverage\b", re.IGNORECASE),
]


@dataclass
class Failure:
    code: str
    detail: str


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_csv_list(raw: str) -> list[str]:
    return [token.strip() for token in raw.split(",") if token.strip()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root",
    )
    parser.add_argument(
        "--downstream-matrix-csv",
        type=Path,
        default=Path("docs/bd-39i6-canonical-downstream-matrix.csv"),
    )
    parser.add_argument(
        "--critical-matrix-csv",
        type=Path,
        default=Path("docs/bd-39i6-critical-surface-coverage-matrix.csv"),
    )
    parser.add_argument("--default-journey-root", type=Path, required=True)
    parser.add_argument("--failure-matrix-root", type=Path, required=True)
    parser.add_argument(
        "--required-downstream-surfaces",
        default=",".join(DEFAULT_REQUIRED_DOWNSTREAM),
    )
    parser.add_argument(
        "--required-critical-surfaces",
        default=",".join(DEFAULT_REQUIRED_CRITICAL),
    )
    parser.add_argument(
        "--required-failure-scenarios",
        default=",".join(DEFAULT_REQUIRED_FAILURE_SCENARIOS),
    )
    parser.add_argument(
        "--claim-scan-files",
        default=",".join(DEFAULT_CLAIM_SCAN_FILES),
        help="Comma-separated repo-relative files scanned for certifying claim phrases",
    )
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--skip-contract-validation", action="store_true")
    return parser.parse_args()


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"csv file not found: {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"csv missing header: {path}")
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def parse_kv_csv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload: dict[str, str] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for idx, row in enumerate(reader):
            if not row:
                continue
            key = row[0].strip()
            value = row[1].strip() if len(row) > 1 else ""
            if idx == 0 and key.lower() == "key" and value.lower() == "value":
                continue
            payload[key] = value
    return payload


def parse_kv_text(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        payload[key.strip()] = value.strip()
    return payload


def run_contract_validator(root: Path, evidence_root: Path, expected_lane: str) -> tuple[bool, str]:
    cmd = [
        "python3",
        str(root / "scripts" / "validate_e2e_evidence_contract.py"),
        "--root",
        str(evidence_root),
        "--expect-lane-type",
        expected_lane,
        "--json",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode == 0:
        return True, proc.stdout.strip() or "contract_valid"
    message = proc.stderr.strip() or proc.stdout.strip() or f"validator_exit={proc.returncode}"
    return False, message


def check_matrix_rows(
    rows: list[dict[str, str]],
    required_keys: list[str],
    key_column: str,
    required_columns: list[str],
    failures: list[Failure],
    prefix: str,
) -> None:
    row_by_key = {row.get(key_column, ""): row for row in rows}
    for key in required_keys:
        row = row_by_key.get(key)
        if row is None:
            failures.append(Failure(f"{prefix}_missing_row", key))
            continue
        for column in required_columns:
            if not row.get(column, ""):
                failures.append(Failure(f"{prefix}_missing_{column}", key))


def check_default_journey_evidence(root: Path, failures: list[Failure], skip_contract: bool) -> None:
    required = [
        root / "evidence_contract.json",
        root / "summary.csv",
        root / "summary.json",
        root / "status.txt",
        root / "artifacts" / "default_user_journey_checks.csv",
    ]
    for path in required:
        if not path.exists():
            failures.append(Failure("default_journey_missing_artifact", str(path)))

    if not skip_contract:
        ok, detail = run_contract_validator(Path(__file__).resolve().parents[1], root, "hybrid-e2e")
        if not ok:
            failures.append(Failure("default_journey_contract_invalid", detail))

    checks = parse_kv_csv(root / "artifacts" / "default_user_journey_checks.csv")
    if not checks:
        failures.append(Failure("default_journey_checks_missing_or_invalid", str(root / "artifacts" / "default_user_journey_checks.csv")))
        return
    if "journey_claim_ready" not in checks:
        failures.append(Failure("default_journey_missing_journey_claim_ready", "journey_claim_ready key missing"))


def check_failure_matrix_evidence(
    root: Path,
    required_scenarios: list[str],
    failures: list[Failure],
    skip_contract: bool,
) -> None:
    required = [
        root / "evidence_contract.json",
        root / "summary.csv",
        root / "summary.json",
        root / "status.txt",
        root / "artifacts" / "failure_matrix.csv",
        root / "artifacts" / "failure_matrix_status.txt",
    ]
    for path in required:
        if not path.exists():
            failures.append(Failure("failure_matrix_missing_artifact", str(path)))

    if not skip_contract:
        ok, detail = run_contract_validator(Path(__file__).resolve().parents[1], root, "packaged-e2e")
        if not ok:
            failures.append(Failure("failure_matrix_contract_invalid", detail))

    csv_path = root / "artifacts" / "failure_matrix.csv"
    if not csv_path.exists():
        return
    rows = read_csv_rows(csv_path)
    by_scenario = {row.get("scenario_id", ""): row for row in rows}
    for scenario in required_scenarios:
        row = by_scenario.get(scenario)
        if row is None:
            failures.append(Failure("failure_matrix_missing_required_scenario", scenario))
            continue
        if row.get("status") != "pass":
            failures.append(Failure("failure_matrix_required_scenario_failed", f"{scenario} status={row.get('status','missing')}"))

    status_kv = parse_kv_text(root / "artifacts" / "failure_matrix_status.txt")
    if status_kv.get("status") != "pass":
        failures.append(Failure("failure_matrix_status_not_pass", status_kv.get("status", "missing")))


def run_certification_gate(repo_root: Path, out_dir: Path) -> tuple[str, list[Failure]]:
    cert_out = out_dir / "certification_policy"
    cmd = [
        str(repo_root / "scripts" / "gate_coverage_certification.sh"),
        "--out-dir",
        str(cert_out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    status_json = cert_out / "status.json"

    failures: list[Failure] = []
    verdict = "unknown"
    if status_json.exists():
        payload = json.loads(status_json.read_text(encoding="utf-8"))
        verdict = str(payload.get("verdict", "unknown"))
    else:
        failures.append(Failure("certification_status_missing", str(status_json)))

    if proc.returncode not in {0, 1}:
        failures.append(Failure("certification_gate_execution_error", proc.stderr.strip() or proc.stdout.strip() or f"exit={proc.returncode}"))
    return verdict, failures


def scan_claim_phrases(repo_root: Path, files: list[str]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for rel in files:
        path = repo_root / rel
        if not path.exists() or not path.is_file():
            continue
        for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            for pattern in CLAIM_PATTERNS:
                if pattern.search(line):
                    findings.append({
                        "file": rel,
                        "line": str(line_no),
                        "phrase": pattern.pattern,
                        "text": line.strip(),
                    })
                    break
    return findings


def write_summary_csv(path: Path, rows: list[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
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
    repo_root = args.root.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    downstream_csv = (repo_root / args.downstream_matrix_csv).resolve()
    critical_csv = (repo_root / args.critical_matrix_csv).resolve()

    required_downstream = parse_csv_list(args.required_downstream_surfaces)
    required_critical = parse_csv_list(args.required_critical_surfaces)
    required_failure_scenarios = parse_csv_list(args.required_failure_scenarios)
    claim_scan_files = parse_csv_list(args.claim_scan_files)

    failures: list[Failure] = []

    downstream_rows = read_csv_rows(downstream_csv)
    critical_rows = read_csv_rows(critical_csv)

    check_matrix_rows(
        downstream_rows,
        required_downstream,
        "surface_key",
        ["lane_id", "realism_class", "evidence_quality", "confidence_level", "gap_status", "remaining_gap", "follow_on_beads"],
        failures,
        "downstream",
    )
    check_matrix_rows(
        critical_rows,
        required_critical,
        "surface",
        ["strongest_lane", "layer", "realism", "remaining_gap", "follow_on_beads"],
        failures,
        "critical",
    )

    check_default_journey_evidence(args.default_journey_root.resolve(), failures, args.skip_contract_validation)
    check_failure_matrix_evidence(args.failure_matrix_root.resolve(), required_failure_scenarios, failures, args.skip_contract_validation)

    certification_verdict, cert_failures = run_certification_gate(repo_root, out_dir)
    failures.extend(cert_failures)

    claim_findings = scan_claim_phrases(repo_root, claim_scan_files)
    if claim_findings and certification_verdict != "true":
        for finding in claim_findings:
            failures.append(
                Failure(
                    "unsupported_certifying_claim_text",
                    f"{finding['file']}:{finding['line']} -> {finding['text']}",
                )
            )

    gate_pass = not failures
    generated = now_utc()

    summary_rows = [
        ("generated_at_utc", generated),
        ("artifact_track", "gate_coverage_matrix_evidence"),
        ("gate_pass", "true" if gate_pass else "false"),
        ("failure_count", str(len(failures))),
        ("required_downstream_surface_count", str(len(required_downstream))),
        ("required_critical_surface_count", str(len(required_critical))),
        ("required_failure_scenario_count", str(len(required_failure_scenarios))),
        ("certification_verdict", certification_verdict),
        ("claim_phrase_finding_count", str(len(claim_findings))),
    ]

    summary_csv = out_dir / "summary.csv"
    status_txt = out_dir / "status.txt"
    status_json = out_dir / "status.json"

    write_summary_csv(summary_csv, summary_rows)
    write_status_txt(status_txt, summary_rows)

    payload = {
        "generated_at_utc": generated,
        "artifact_track": "gate_coverage_matrix_evidence",
        "gate_pass": gate_pass,
        "certification_verdict": certification_verdict,
        "inputs": {
            "downstream_matrix_csv": str(downstream_csv),
            "critical_matrix_csv": str(critical_csv),
            "default_journey_root": str(args.default_journey_root.resolve()),
            "failure_matrix_root": str(args.failure_matrix_root.resolve()),
            "required_downstream_surfaces": required_downstream,
            "required_critical_surfaces": required_critical,
            "required_failure_scenarios": required_failure_scenarios,
            "claim_scan_files": claim_scan_files,
            "skip_contract_validation": args.skip_contract_validation,
        },
        "claim_phrase_findings": claim_findings,
        "failures": [{"code": f.code, "detail": f.detail} for f in failures],
    }
    status_json.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if gate_pass:
        return
    raise SystemExit("coverage-matrix/evidence gate failed; inspect status.json for deterministic missing rows/scenarios/artifacts")


if __name__ == "__main__":
    main()
