#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "gate_coverage_certification.py"


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


class GateCoverageCertificationTests(unittest.TestCase):
    def _write_evidence_root(self, root: Path, malformed: bool) -> None:
        root.mkdir(parents=True, exist_ok=True)
        logs = root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "phase.log").write_text("phase-log\n", encoding="utf-8")

        if malformed:
            (root / "status.txt").write_text("status=pass\n", encoding="utf-8")
            (root / "summary.csv").write_text("key,value\nstatus,pass\n", encoding="utf-8")
            (root / "evidence_contract.json").write_text("{\"phases\": []}\n", encoding="utf-8")
            return

        (root / "status.txt").write_text("status=pass\nscenario_id=nm\n", encoding="utf-8")
        (root / "summary.csv").write_text(
            "scenario_id,lane_type,phase_id,required,status,exit_classification,started_at_utc,ended_at_utc,log_path,primary_artifact\n"
            "nm,packaged-e2e,phase_a,true,pass,success,2026-03-07T00:00:00Z,2026-03-07T00:00:01Z,logs/phase.log,artifacts/a.txt\n",
            encoding="utf-8",
        )
        (root / "summary.json").write_text("{\"overall_status\":\"pass\"}\n", encoding="utf-8")
        (root / "paths.env").write_text("EVIDENCE_ROOT=/tmp/example\n", encoding="utf-8")
        (root / "evidence_contract.json").write_text(
            json.dumps(
                {
                    "contract_name": "recordit-e2e-evidence",
                    "phases": [{"phase_id": "phase_a", "status": "pass"}],
                }
            )
            + "\n",
            encoding="utf-8",
        )

    def _run_gate(
        self,
        downstream_rows: list[list[str]],
        critical_rows: list[list[str]],
        anti_bypass_payload: dict,
        anti_bypass_exit: int,
        bead_statuses: dict[str, str],
        required_beads: str,
        required_evidence_layouts: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict, list[list[str]], list[str]]:
        with tempfile.TemporaryDirectory(prefix="gate_coverage_cert_") as tmp:
            root = Path(tmp)
            downstream_csv = root / "downstream.csv"
            critical_csv = root / "critical.csv"
            anti_json = root / "anti" / "status.json"
            bead_json = root / "beads.json"
            summary_csv = root / "summary.csv"
            status_json = root / "status.json"
            status_txt = root / "status.txt"
            required_root_specs: list[str] = []

            write_csv(
                downstream_csv,
                ["surface_key", "gap_status", "remaining_gap", "follow_on_beads"],
                downstream_rows,
            )
            write_csv(
                critical_csv,
                ["surface", "gap_status", "remaining_gap", "follow_on_beads"],
                critical_rows,
            )
            anti_json.parent.mkdir(parents=True, exist_ok=True)
            anti_json.write_text(json.dumps(anti_bypass_payload), encoding="utf-8")
            bead_json.write_text(json.dumps(bead_statuses), encoding="utf-8")

            if required_evidence_layouts:
                for lane_id, mode in required_evidence_layouts.items():
                    evidence_root = root / f"evidence_{lane_id}"
                    if mode == "valid":
                        self._write_evidence_root(evidence_root, malformed=False)
                    elif mode == "malformed":
                        self._write_evidence_root(evidence_root, malformed=True)
                    elif mode == "missing":
                        pass
                    else:
                        raise ValueError(f"unknown evidence mode: {mode}")
                    required_root_specs.append(f"{lane_id}={evidence_root}")
            cmd = [
                "python3",
                str(SCRIPT),
                "--downstream-matrix-csv",
                str(downstream_csv),
                "--critical-matrix-csv",
                str(critical_csv),
                "--anti-bypass-status-json",
                str(anti_json),
                "--anti-bypass-exit-code",
                str(anti_bypass_exit),
                "--required-beads",
                required_beads,
                "--bead-status-json",
                str(bead_json),
                "--summary-csv",
                str(summary_csv),
                "--status-json",
                str(status_json),
                "--status-txt",
                str(status_txt),
            ]
            for spec in required_root_specs:
                cmd.extend(["--required-evidence-root", spec])

            proc = subprocess.run(cmd, text=True, capture_output=True, check=False)

            payload = json.loads(status_json.read_text(encoding="utf-8"))
            with summary_csv.open(encoding="utf-8", newline="") as handle:
                summary_rows = list(csv.reader(handle))
            status_lines = status_txt.read_text(encoding="utf-8").strip().splitlines()
            return proc, payload, summary_rows, status_lines

    def test_true_verdict_when_all_requirements_are_satisfied(self) -> None:
        proc, payload, summary_rows, status_lines = self._run_gate(
            downstream_rows=[
                ["packaged-local-app-path", "covered", "", ""],
            ],
            critical_rows=[
                ["dmg-install-open", "covered", "", ""],
            ],
            anti_bypass_payload={"gate_pass": True, "violation_count": 0, "violations": []},
            anti_bypass_exit=0,
            bead_statuses={
                "bd-tr8z": "closed",
                "bd-diqp": "closed",
                "bd-p77p": "closed",
            },
            required_beads="bd-tr8z,bd-diqp,bd-p77p",
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertEqual(payload["verdict"], "true")
        self.assertTrue(payload["certifying_claim_allowed"])
        self.assertIn(["verdict", "true"], summary_rows)
        self.assertTrue(any(line == "verdict=true" for line in status_lines))

    def test_unproven_verdict_when_only_soft_gaps_remain(self) -> None:
        proc, payload, _, _ = self._run_gate(
            downstream_rows=[
                ["packaged-local-app-path", "partial", "first live stop not covered", "bd-78qy"],
            ],
            critical_rows=[
                ["dmg-install-open", "covered", "", ""],
            ],
            anti_bypass_payload={"gate_pass": True, "violation_count": 0, "violations": []},
            anti_bypass_exit=0,
            bead_statuses={
                "bd-tr8z": "closed",
                "bd-diqp": "closed",
                "bd-p77p": "closed",
            },
            required_beads="bd-tr8z,bd-diqp,bd-p77p",
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload["verdict"], "unproven")
        self.assertFalse(payload["certifying_claim_allowed"])

    def test_false_verdict_when_hard_blockers_exist(self) -> None:
        proc, payload, _, _ = self._run_gate(
            downstream_rows=[
                ["production-app-journey", "uncovered", "no real app journey lane", "bd-2ph4|bd-11vg"],
            ],
            critical_rows=[
                ["release-signing-notarization", "partial", "requires retained GA-grade evidence", "bd-13tm|bd-3p9b"],
            ],
            anti_bypass_payload={"gate_pass": False, "violation_count": 2, "violations": [{"surface_key": "ui-automation-live-run"}]},
            anti_bypass_exit=1,
            bead_statuses={
                "bd-tr8z": "closed",
                "bd-diqp": "open",
                "bd-p77p": "closed",
            },
            required_beads="bd-tr8z,bd-diqp,bd-p77p",
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload["verdict"], "false")
        self.assertFalse(payload["certifying_claim_allowed"])
        self.assertTrue(payload["open_required_beads"])

    def test_false_verdict_when_required_evidence_root_is_missing(self) -> None:
        proc, payload, _, _ = self._run_gate(
            downstream_rows=[["packaged-local-app-path", "covered", "", ""]],
            critical_rows=[["dmg-install-open", "covered", "", ""]],
            anti_bypass_payload={"gate_pass": True, "violation_count": 0, "violations": []},
            anti_bypass_exit=0,
            bead_statuses={"bd-tr8z": "closed"},
            required_beads="bd-tr8z",
            required_evidence_layouts={"nm06": "missing"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload["verdict"], "false")
        self.assertIn("required_evidence_missing_or_malformed", payload["hard_blockers"])

    def test_false_verdict_when_required_evidence_root_is_malformed(self) -> None:
        proc, payload, _, _ = self._run_gate(
            downstream_rows=[["packaged-local-app-path", "covered", "", ""]],
            critical_rows=[["dmg-install-open", "covered", "", ""]],
            anti_bypass_payload={"gate_pass": True, "violation_count": 0, "violations": []},
            anti_bypass_exit=0,
            bead_statuses={"bd-tr8z": "closed"},
            required_beads="bd-tr8z",
            required_evidence_layouts={"nm07": "malformed"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload["verdict"], "false")
        evidence = payload["required_evidence"]
        self.assertTrue(evidence)
        self.assertFalse(evidence[0]["valid"])


if __name__ == "__main__":
    unittest.main()
