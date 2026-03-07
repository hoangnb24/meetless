#!/usr/bin/env python3
"""Regression checks for the bd-2grd e2e evidence contract validator."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = PROJECT_ROOT / "scripts" / "validate_e2e_evidence_contract.py"


class E2EEvidenceContractValidatorTests(unittest.TestCase):
    maxDiff = None

    def make_evidence_root(
        self,
        *,
        scenario_id: str = "packaged-live-pass",
        lane_type: str = "packaged-e2e",
        overall_status: str = "pass",
        phases: list[dict[str, Any]] | None = None,
    ) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        (root / "logs").mkdir()
        (root / "artifacts").mkdir()

        phase_list = phases or [
            {
                "phase_id": "launch_app",
                "title": "Launch packaged app",
                "required": True,
                "status": "pass",
                "exit_classification": "success",
                "started_at_utc": "2026-03-06T12:00:00Z",
                "ended_at_utc": "2026-03-06T12:00:05Z",
                "command_display": "open dist/Recordit.app",
                "command_argv": ["open", "dist/Recordit.app"],
                "log_relpath": "logs/launch_app.log",
                "stdout_relpath": "logs/launch_app.stdout",
                "stderr_relpath": "logs/launch_app.stderr",
                "primary_artifact_relpath": "artifacts/launch.txt",
            }
        ]

        for phase in phase_list:
            for key in ("log_relpath", "stdout_relpath", "stderr_relpath"):
                path = root / phase[key]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"{phase['phase_id']} {key}\n", encoding="utf-8")
            primary_artifact = phase.get("primary_artifact_relpath", "")
            if primary_artifact:
                path = root / primary_artifact
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"artifact for {phase['phase_id']}\n", encoding="utf-8")
            result_bundle = phase.get("result_bundle_relpath")
            if result_bundle:
                (root / result_bundle).mkdir(parents=True, exist_ok=True)
            for extra_artifact in phase.get("extra_artifact_relpaths", []):
                path = root / extra_artifact
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"extra artifact for {phase['phase_id']}\n", encoding="utf-8")

        generated_at_utc = "2026-03-06T12:00:06Z"

        manifest = {
            "contract_name": "recordit-e2e-evidence",
            "contract_version": "1",
            "scenario_id": scenario_id,
            "lane_type": lane_type,
            "generated_at_utc": generated_at_utc,
            "artifact_root_relpath": "artifacts",
            "overall_status": overall_status,
            "paths_env_relpath": "paths.env",
            "status_txt_relpath": "status.txt",
            "summary_csv_relpath": "summary.csv",
            "summary_json_relpath": "summary.json",
            "phases": phase_list,
        }
        (root / "evidence_contract.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )

        (root / "paths.env").write_text(
            "\n".join([
                "EVIDENCE_ROOT=.",
                "ARTIFACT_ROOT=artifacts",
                "STATUS_TXT=status.txt",
                "SUMMARY_CSV=summary.csv",
                "SUMMARY_JSON=summary.json",
                "MANIFEST=evidence_contract.json",
                f"SCENARIO_ID={scenario_id}",
            ])
            + "\n",
            encoding="utf-8",
        )
        (root / "status.txt").write_text(
            "\n".join(
                [
                    f"status={overall_status}",
                    f"scenario_id={scenario_id}",
                    f"lane_type={lane_type}",
                    f"generated_at_utc={generated_at_utc}",
                    "summary_csv=summary.csv",
                    "summary_json=summary.json",
                    "manifest=evidence_contract.json",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        with (root / "summary.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                [
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
            )
            for phase in phase_list:
                writer.writerow(
                    [
                        scenario_id,
                        lane_type,
                        phase["phase_id"],
                        "true" if phase["required"] else "false",
                        phase["status"],
                        phase["exit_classification"],
                        phase["started_at_utc"],
                        phase["ended_at_utc"],
                        phase["log_relpath"],
                        phase["primary_artifact_relpath"],
                    ]
                )

        summary = {
            "scenario_id": scenario_id,
            "lane_type": lane_type,
            "contract_version": "1",
            "overall_status": overall_status,
            "phase_count": len(phase_list),
            "required_phase_count": sum(1 for phase in phase_list if phase["required"]),
            "failed_phase_count": sum(1 for phase in phase_list if phase["status"] == "fail"),
            "warn_phase_count": sum(1 for phase in phase_list if phase["status"] == "warn"),
            "skipped_phase_count": sum(1 for phase in phase_list if phase["status"] == "skipped"),
            "generated_at_utc": generated_at_utc,
            "manifest_relpath": "evidence_contract.json",
        }
        (root / "summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )
        return root

    def run_validator(self, root: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), "--root", str(root), "--json", *extra_args],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-minimal-pass"
        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "packaged-live-pass")

    def test_warn_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-minimal-warn"
        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "packaged-live-warn")
        self.assertEqual(payload["overall_status"], "warn")

    def test_skipped_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-minimal-skipped"
        result = self.run_validator(root, "--expect-lane-type", "shell-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "packaged-live-skipped")
        self.assertEqual(payload["overall_status"], "skipped")

    def test_fail_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-minimal-fail"
        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "packaged-live-fail")
        self.assertEqual(payload["overall_status"], "fail")

    def test_multiphase_xctest_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xctest-multiphase-pass"
        result = self.run_validator(root, "--expect-lane-type", "xctest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xctest-smoke")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "pass")

    def test_multiphase_xctest_warn_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xctest-multiphase-warn"
        result = self.run_validator(root, "--expect-lane-type", "xctest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xctest-smoke-warn")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "warn")

    def test_multiphase_xctest_fail_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xctest-multiphase-fail"
        result = self.run_validator(root, "--expect-lane-type", "xctest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xctest-smoke-fail")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "fail")

    def test_multiphase_xcuitest_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xcuitest-multiphase-pass"
        result = self.run_validator(root, "--expect-lane-type", "xcuitest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xcuitest-happy-path")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "pass")

    def test_multiphase_xcuitest_fail_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xcuitest-multiphase-fail"
        result = self.run_validator(root, "--expect-lane-type", "xcuitest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xcuitest-failure-path")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "fail")

    def test_multiphase_xcuitest_warn_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-xcuitest-multiphase-warn"
        result = self.run_validator(root, "--expect-lane-type", "xcuitest-evidence")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recorditapp-xcuitest-happy-path-warn")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "warn")

    def test_multiphase_hybrid_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-hybrid-multiphase-pass"
        result = self.run_validator(root, "--expect-lane-type", "hybrid-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recordit-hybrid-smoke")
        self.assertEqual(payload["phase_count"], 2)
        self.assertEqual(payload["overall_status"], "pass")

    def test_multiphase_hybrid_warn_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-hybrid-multiphase-warn"
        result = self.run_validator(root, "--expect-lane-type", "hybrid-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recordit-hybrid-smoke-warn")
        self.assertEqual(payload["phase_count"], 3)
        self.assertEqual(payload["overall_status"], "warn")

    def test_multiphase_hybrid_fail_example_fixture_passes_validator(self) -> None:
        root = PROJECT_ROOT / "tests" / "e2e_evidence_contract" / "fixtures" / "recordit-e2e-evidence-hybrid-multiphase-fail"
        result = self.run_validator(root, "--expect-lane-type", "hybrid-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scenario_id"], "recordit-hybrid-smoke-fail")
        self.assertEqual(payload["phase_count"], 3)
        self.assertEqual(payload["overall_status"], "fail")

    def test_valid_minimal_packaged_evidence_root_passes(self) -> None:
        root = self.make_evidence_root()
        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "pass")
        self.assertEqual(payload["lane_type"], "packaged-e2e")
        self.assertEqual(payload["phase_count"], 1)

    def test_warn_lane_accepts_non_required_failed_phase(self) -> None:
        root = self.make_evidence_root(
            scenario_id="warn-lane",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "prepare",
                    "title": "Prepare runtime inputs",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:02Z",
                    "command_display": "prepare runtime",
                    "command_argv": ["prepare"],
                    "log_relpath": "logs/prepare.log",
                    "stdout_relpath": "logs/prepare.stdout",
                    "stderr_relpath": "logs/prepare.stderr",
                    "primary_artifact_relpath": "artifacts/prepare.txt",
                },
                {
                    "phase_id": "optional_ui_probe",
                    "title": "Optional UI probe",
                    "required": False,
                    "status": "fail",
                    "exit_classification": "product_failure",
                    "started_at_utc": "2026-03-06T12:00:03Z",
                    "ended_at_utc": "2026-03-06T12:00:04Z",
                    "command_display": "run optional UI probe",
                    "command_argv": ["probe"],
                    "log_relpath": "logs/optional_ui_probe.log",
                    "stdout_relpath": "logs/optional_ui_probe.stdout",
                    "stderr_relpath": "logs/optional_ui_probe.stderr",
                    "primary_artifact_relpath": "artifacts/optional_ui_probe.txt",
                },
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "warn")
        self.assertEqual(payload["phase_count"], 2)

    def test_warn_lane_allows_optional_skipped_phase(self) -> None:
        root = self.make_evidence_root(
            scenario_id="warn-with-skipped-optional",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "required_lane",
                    "title": "Required lane",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:02Z",
                    "command_display": "required lane",
                    "command_argv": ["required-lane"],
                    "log_relpath": "logs/required_lane.log",
                    "stdout_relpath": "logs/required_lane.stdout",
                    "stderr_relpath": "logs/required_lane.stderr",
                    "primary_artifact_relpath": "artifacts/required_lane.txt",
                },
                {
                    "phase_id": "optional_lane",
                    "title": "Optional lane",
                    "required": False,
                    "status": "skipped",
                    "exit_classification": "skip_requested",
                    "started_at_utc": "2026-03-06T12:00:03Z",
                    "ended_at_utc": "2026-03-06T12:00:03Z",
                    "command_display": "optional lane",
                    "command_argv": ["optional-lane"],
                    "log_relpath": "logs/optional_lane.log",
                    "stdout_relpath": "logs/optional_lane.stdout",
                    "stderr_relpath": "logs/optional_lane.stderr",
                    "primary_artifact_relpath": "",
                    "notes": "optional lane intentionally skipped in capability-gated mode",
                },
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "warn")
        self.assertEqual(payload["phase_count"], 2)

    def test_fail_lane_accepts_required_failed_phase(self) -> None:
        root = self.make_evidence_root(
            scenario_id="fail-lane",
            overall_status="fail",
            phases=[
                {
                    "phase_id": "prepare",
                    "title": "Prepare runtime inputs",
                    "required": True,
                    "status": "fail",
                    "exit_classification": "product_failure",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:02Z",
                    "command_display": "prepare runtime",
                    "command_argv": ["prepare"],
                    "log_relpath": "logs/prepare.log",
                    "stdout_relpath": "logs/prepare.stdout",
                    "stderr_relpath": "logs/prepare.stderr",
                    "primary_artifact_relpath": "artifacts/prepare.txt",
                    "notes": "runtime preflight failed with a required blocker",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "fail")

    def test_skipped_lane_accepts_skip_requested_phase_with_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="skipped-lane",
            overall_status="skipped",
            phases=[
                {
                    "phase_id": "gate_skip",
                    "title": "Skip before execution",
                    "required": True,
                    "status": "skipped",
                    "exit_classification": "skip_requested",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "skip lane",
                    "command_argv": ["skip"],
                    "log_relpath": "logs/gate_skip.log",
                    "stdout_relpath": "logs/gate_skip.stdout",
                    "stderr_relpath": "logs/gate_skip.stderr",
                    "primary_artifact_relpath": "",
                    "notes": "lane skipped because the caller requested record-only mode",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "skipped")

    def test_bool_count_in_summary_json_is_rejected(self) -> None:
        root = self.make_evidence_root(scenario_id="bool-count")
        summary_path = root / "summary.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["failed_phase_count"] = False
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary.json failed_phase_count must be a non-negative integer", payload["error"])

    def test_status_manifest_mismatch_is_rejected(self) -> None:
        root = self.make_evidence_root(scenario_id="bad-status-manifest")
        (root / "other_manifest.json").write_text("{}\n", encoding="utf-8")
        (root / "status.txt").write_text(
            "\n".join(
                [
                    "status=pass",
                    "scenario_id=bad-status-manifest",
                    "lane_type=packaged-e2e",
                    "generated_at_utc=2026-03-06T12:00:06Z",
                    "summary_csv=summary.csv",
                    "summary_json=summary.json",
                    "manifest=other_manifest.json",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("status.txt manifest must match the validated manifest path", payload["error"])

    def test_status_txt_rejects_duplicate_keys(self) -> None:
        root = self.make_evidence_root(scenario_id="status-duplicate-key")
        status_path = root / "status.txt"
        status_path.write_text(
            status_path.read_text(encoding="utf-8") + "status=warn\n",
            encoding="utf-8",
        )


        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("duplicate key 'status' in status.txt", payload["error"])

    def test_paths_env_rejects_non_shell_safe_key(self) -> None:
        root = self.make_evidence_root(scenario_id="paths-env-bad-key")
        paths_env = root / "paths.env"
        paths_env.write_text(
            paths_env.read_text(encoding="utf-8") + "bad-key=value\n",
            encoding="utf-8",
        )

        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("paths.env key must be shell-safe", payload["error"])

    def test_paths_env_requires_shared_base_entries(self) -> None:
        root = self.make_evidence_root(scenario_id="paths-env-missing-base")
        paths_env = root / "paths.env"
        lines = [
            line
            for line in paths_env.read_text(encoding="utf-8").splitlines()
            if not line.startswith("SUMMARY_JSON=")
        ]
        paths_env.write_text("\n".join(lines) + "\n", encoding="utf-8")

        result = self.run_validator(root, "--expect-lane-type", "packaged-e2e")
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("paths.env missing required base keys", payload["error"])

    def test_paths_env_rejects_malformed_key_value_line(self) -> None:
        root = self.make_evidence_root(scenario_id="paths-env-malformed-line")
        paths_env = root / "paths.env"
        paths_env.write_text(
            paths_env.read_text(encoding="utf-8") + "BROKEN LINE WITHOUT EQUALS\n",
            encoding="utf-8",
        )


        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("invalid key=value line in paths.env", payload["error"])

    def test_non_utf8_summary_csv_fails_cleanly(self) -> None:
        root = self.make_evidence_root(scenario_id="summary-csv-nonutf8")
        summary_csv = root / "summary.csv"
        summary_csv.write_bytes(b"\xff\xfe\x00broken")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("unable to read summary.csv", payload["error"])

    def test_summary_csv_rejects_extra_trailing_columns(self) -> None:
        root = self.make_evidence_root(scenario_id="summary-extra-columns")
        summary_csv = root / "summary.csv"
        rows = summary_csv.read_text(encoding="utf-8").splitlines()
        rows[1] = rows[1] + ",unexpected_extra_value"
        summary_csv.write_text("\n".join(rows) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary.csv row has unexpected extra columns", payload["error"])

    def test_summary_csv_phase_order_must_match_manifest_order(self) -> None:
        root = self.make_evidence_root(
            scenario_id="summary-phase-order-mismatch",
            lane_type="hybrid-e2e",
            overall_status="pass",
            phases=[
                {
                    "phase_id": "prepare_runtime",
                    "title": "Prepare runtime",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:02:00Z",
                    "command_display": "prepare runtime",
                    "command_argv": ["prepare-runtime"],
                    "log_relpath": "logs/prepare_runtime.log",
                    "stdout_relpath": "logs/prepare_runtime.stdout",
                    "stderr_relpath": "logs/prepare_runtime.stderr",
                    "primary_artifact_relpath": "artifacts/runtime.txt",
                },
                {
                    "phase_id": "verify_app_state",
                    "title": "Verify app state",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T12:02:05Z",
                    "ended_at_utc": "2026-03-06T12:04:00Z",
                    "command_display": "verify app",
                    "command_argv": ["verify-app"],
                    "log_relpath": "logs/verify_app_state.log",
                    "stdout_relpath": "logs/verify_app_state.stdout",
                    "stderr_relpath": "logs/verify_app_state.stderr",
                    "primary_artifact_relpath": "artifacts/app-state.txt",
                },
            ],
        )
        summary_csv = root / "summary.csv"
        rows = summary_csv.read_text(encoding="utf-8").splitlines()
        rows[1], rows[2] = rows[2], rows[1]
        summary_csv.write_text("\n".join(rows) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary.csv phase order must match manifest phases", payload["error"])

    def test_summary_csv_relpath_must_resolve_to_file(self) -> None:
        root = self.make_evidence_root(scenario_id="summary-csv-dir")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["summary_csv_relpath"] = "."
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary_csv_relpath must resolve to a file: .", payload["error"])

    def test_unreadable_summary_csv_fails_cleanly(self) -> None:
        root = self.make_evidence_root(scenario_id="summary-csv-perms")
        summary_csv = root / "summary.csv"
        summary_csv.chmod(0)
        self.addCleanup(lambda: summary_csv.chmod(0o644))

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("unable to read summary.csv", payload["error"])

    def test_manifest_generated_at_requires_string_type(self) -> None:
        root = self.make_evidence_root(scenario_id="null-manifest-generated-at")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generated_at_utc"] = None
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("generated_at_utc must be a string", payload["error"])

    def test_manifest_generated_at_requires_real_calendar_time_value(self) -> None:
        root = self.make_evidence_root(scenario_id="invalid-generated-at-value")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generated_at_utc"] = "2026-99-99T99:99:99Z"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        status_path = root / "status.txt"
        status_path.write_text(
            status_path.read_text(encoding="utf-8").replace(
                "generated_at_utc=2026-03-06T12:00:06Z",
                "generated_at_utc=2026-99-99T99:99:99Z",
            ),
            encoding="utf-8",
        )

        summary_path = root / "summary.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["generated_at_utc"] = "2026-99-99T99:99:99Z"
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("generated_at_utc must be a valid UTC RFC3339 timestamp with Z suffix", payload["error"])

    def test_phase_log_relpath_requires_string_type(self) -> None:
        root = self.make_evidence_root(scenario_id="null-log-relpath")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["phases"][0]["log_relpath"] = None
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("phase[0].log_relpath must be a string", payload["error"])

    def test_summary_manifest_relpath_requires_string_type(self) -> None:
        root = self.make_evidence_root(scenario_id="null-summary-manifest")
        summary_path = root / "summary.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["manifest_relpath"] = None
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary.json manifest_relpath must be a string", payload["error"])

    def test_primary_artifact_must_resolve_to_file(self) -> None:
        root = self.make_evidence_root(scenario_id="primary-artifact-dir")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["phases"][0]["primary_artifact_relpath"] = "artifacts"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        summary_path = root / "summary.csv"
        rows = summary_path.read_text(encoding="utf-8").splitlines()
        rows[1] = rows[1].replace("artifacts/launch.txt", "artifacts")
        summary_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("phase[0].primary_artifact_relpath must resolve to a file: artifacts", payload["error"])

    def test_phase_notes_require_string_when_present(self) -> None:
        root = self.make_evidence_root(
            scenario_id="warn-note-type",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "optional_probe",
                    "title": "Optional probe",
                    "required": False,
                    "status": "warn",
                    "exit_classification": "infra_failure",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:01Z",
                    "command_display": "optional probe",
                    "command_argv": ["probe"],
                    "log_relpath": "logs/optional_probe.log",
                    "stdout_relpath": "logs/optional_probe.stdout",
                    "stderr_relpath": "logs/optional_probe.stderr",
                    "primary_artifact_relpath": "",
                    "notes": 7,
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("phase[0].notes must be a string when present", payload["error"])

    def test_skipped_phase_requires_skip_classification_and_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="skipped-without-notes",
            overall_status="skipped",
            phases=[
                {
                    "phase_id": "gate_skip",
                    "title": "Skip before execution",
                    "required": True,
                    "status": "skipped",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "skip lane",
                    "command_argv": ["skip"],
                    "log_relpath": "logs/gate_skip.log",
                    "stdout_relpath": "logs/gate_skip.stdout",
                    "stderr_relpath": "logs/gate_skip.stderr",
                    "primary_artifact_relpath": "",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("skipped phases must use exit_classification=skip_requested", payload["error"])

    def test_skipped_phase_requires_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="skipped-missing-notes",
            overall_status="skipped",
            phases=[
                {
                    "phase_id": "gate_skip",
                    "title": "Skip before execution",
                    "required": True,
                    "status": "skipped",
                    "exit_classification": "skip_requested",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "skip lane",
                    "command_argv": ["skip"],
                    "log_relpath": "logs/gate_skip.log",
                    "stdout_relpath": "logs/gate_skip.stdout",
                    "stderr_relpath": "logs/gate_skip.stderr",
                    "primary_artifact_relpath": "",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("skipped phases must include notes", payload["error"])

    def test_skip_requested_exit_classification_requires_skipped_status(self) -> None:
        root = self.make_evidence_root(
            scenario_id="skip-requested-not-skipped",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "optional_gate",
                    "title": "Optional gate",
                    "required": False,
                    "status": "warn",
                    "exit_classification": "skip_requested",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "optional gate",
                    "command_argv": ["gate"],
                    "log_relpath": "logs/optional_gate.log",
                    "stdout_relpath": "logs/optional_gate.stdout",
                    "stderr_relpath": "logs/optional_gate.stderr",
                    "primary_artifact_relpath": "",
                    "notes": "caller requested skip but status was left as warn",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("exit_classification=skip_requested requires status=skipped", payload["error"])

    def test_flake_retried_exit_classification_requires_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="flake-retried-missing-notes",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "retrying_probe",
                    "title": "Retrying probe",
                    "required": False,
                    "status": "warn",
                    "exit_classification": "flake_retried",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "retrying probe",
                    "command_argv": ["probe"],
                    "log_relpath": "logs/retrying_probe.log",
                    "stdout_relpath": "logs/retrying_probe.stdout",
                    "stderr_relpath": "logs/retrying_probe.stderr",
                    "primary_artifact_relpath": "",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("exit_classification=flake_retried requires notes", payload["error"])

    def test_pass_status_rejects_failure_exit_classification(self) -> None:
        root = self.make_evidence_root(scenario_id="pass-with-product-failure")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["phases"][0]["exit_classification"] = "product_failure"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("phase[0] status=pass requires exit_classification in ['success']", payload["error"])

    def test_fail_status_rejects_success_exit_classification(self) -> None:
        root = self.make_evidence_root(scenario_id="fail-with-success-classification", overall_status="fail")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["phases"][0]["status"] = "fail"
        manifest["phases"][0]["exit_classification"] = "success"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn(
            "phase[0] status=fail requires exit_classification in ['contract_failure', 'infra_failure', 'product_failure']",
            payload["error"],
        )

    def test_skipped_phase_rejects_whitespace_only_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="skipped-whitespace-notes",
            overall_status="skipped",
            phases=[
                {
                    "phase_id": "gate_skip",
                    "title": "Skip before execution",
                    "required": True,
                    "status": "skipped",
                    "exit_classification": "skip_requested",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "skip lane",
                    "command_argv": ["skip"],
                    "log_relpath": "logs/gate_skip.log",
                    "stdout_relpath": "logs/gate_skip.stdout",
                    "stderr_relpath": "logs/gate_skip.stderr",
                    "primary_artifact_relpath": "",
                    "notes": "   ",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("skipped phases must include notes", payload["error"])

    def test_flake_retried_rejects_whitespace_only_notes(self) -> None:
        root = self.make_evidence_root(
            scenario_id="flake-retried-whitespace-notes",
            overall_status="warn",
            phases=[
                {
                    "phase_id": "retrying_probe",
                    "title": "Retrying probe",
                    "required": False,
                    "status": "warn",
                    "exit_classification": "flake_retried",
                    "started_at_utc": "2026-03-06T12:00:00Z",
                    "ended_at_utc": "2026-03-06T12:00:00Z",
                    "command_display": "retrying probe",
                    "command_argv": ["probe"],
                    "log_relpath": "logs/retrying_probe.log",
                    "stdout_relpath": "logs/retrying_probe.stdout",
                    "stderr_relpath": "logs/retrying_probe.stderr",
                    "primary_artifact_relpath": "",
                    "notes": "   ",
                }
            ],
        )
        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("exit_classification=flake_retried requires notes", payload["error"])

    def test_symlinked_log_path_cannot_escape_evidence_root(self) -> None:
        root = self.make_evidence_root(scenario_id="symlink-log-escape")
        external_dir = tempfile.TemporaryDirectory()
        self.addCleanup(external_dir.cleanup)
        external_log = Path(external_dir.name) / "external.log"
        external_log.write_text("outside evidence root\n", encoding="utf-8")
        log_path = root / "logs" / "launch_app.log"
        log_path.unlink()
        log_path.symlink_to(external_log)

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("must stay within the evidence root", payload["error"])


    def test_symlinked_artifact_root_cannot_escape_evidence_root(self) -> None:
        root = self.make_evidence_root(scenario_id="symlink-artifact-root-escape")
        external_dir = tempfile.TemporaryDirectory()
        self.addCleanup(external_dir.cleanup)
        external_artifacts = Path(external_dir.name) / "artifacts"
        external_artifacts.mkdir()
        artifact_root = root / "artifacts"
        shutil.rmtree(artifact_root)
        artifact_root.symlink_to(external_artifacts, target_is_directory=True)

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("artifact_root_relpath must stay within the evidence root", payload["error"])


    def test_status_generated_at_utc_must_match_manifest(self) -> None:
        root = self.make_evidence_root(scenario_id="status-generated-at-mismatch")
        status_path = root / "status.txt"
        status_path.write_text(
            status_path.read_text(encoding="utf-8").replace(
                "generated_at_utc=2026-03-06T12:00:06Z",
                "generated_at_utc=2026-03-06T12:09:59Z",
            ),
            encoding="utf-8",
        )

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("status.txt generated_at_utc must match manifest", payload["error"])

    def test_summary_json_generated_at_utc_must_match_manifest(self) -> None:
        root = self.make_evidence_root(scenario_id="summary-generated-at-mismatch")
        summary_path = root / "summary.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["generated_at_utc"] = "2026-03-06T12:10:00Z"
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("summary.json generated_at_utc must match manifest", payload["error"])

    def test_result_bundle_relpath_must_resolve_to_directory(self) -> None:
        root = self.make_evidence_root(scenario_id="result-bundle-file")
        manifest_path = root / "evidence_contract.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["phases"][0]["result_bundle_relpath"] = "artifacts/launch.txt"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        result = self.run_validator(root)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("result_bundle_relpath must resolve to a directory", payload["error"])


if __name__ == "__main__":
    unittest.main()
