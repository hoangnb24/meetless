#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RENDERER = PROJECT_ROOT / "scripts" / "render_xctest_evidence_contract.py"
VALIDATOR = PROJECT_ROOT / "scripts" / "validate_e2e_evidence_contract.py"


class RenderXCTestEvidenceContractTests(unittest.TestCase):
    maxDiff = None

    def make_root(self) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        (root / "logs").mkdir(parents=True)
        (root / "xcresult" / "build_for_testing.xcresult").mkdir(parents=True)
        (root / "xcresult" / "recordit_app_tests.xcresult").mkdir(parents=True)
        (root / "xcresult" / "responsiveness_budget_gate.xcresult").mkdir(parents=True)
        (root / "xcresult" / "uitest_onboarding_happy_path.xcresult").mkdir(parents=True)
        (root / "xcresult" / "uitest_permission_recovery.xcresult").mkdir(parents=True)
        (root / "xcresult" / "uitest_live_run_summary.xcresult").mkdir(parents=True)
        (root / "xcresult" / "uitest_runtime_recovery.xcresult").mkdir(parents=True)
        (root / "responsiveness_budget_summary.csv").write_text(
            "artifact_track,recordit_app_responsiveness\n"
            "gate_pass,true\n"
            "threshold_first_stable_transcript_budget_ok,true\n",
            encoding="utf-8",
        )
        (root / "responsiveness_budget_summary.json").write_text(
            json.dumps({"gate_pass": "true"}, indent=2) + "\n",
            encoding="utf-8",
        )
        return root

    def write_status_csv(self, root: Path, *, include_split_streams: bool = True) -> None:
        rows = [
            {
                "step": "prepare_runtime_inputs",
                "required": "1",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "prepare_runtime_inputs.log"),
                "stdout_path": str(root / "logs" / "prepare_runtime_inputs.stdout.log"),
                "stderr_path": str(root / "logs" / "prepare_runtime_inputs.stderr.log"),
                "result_bundle_path": "",
            },
            {
                "step": "build_for_testing",
                "required": "1",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "build_for_testing.log"),
                "stdout_path": str(root / "logs" / "build_for_testing.stdout.log"),
                "stderr_path": str(root / "logs" / "build_for_testing.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "build_for_testing.xcresult"),
            },
            {
                "step": "unit_tests",
                "required": "1",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "unit_tests.log"),
                "stdout_path": str(root / "logs" / "unit_tests.stdout.log"),
                "stderr_path": str(root / "logs" / "unit_tests.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "recordit_app_tests.xcresult"),
            },
            {
                "step": "responsiveness_budget_gate",
                "required": "1",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "responsiveness_budget_gate.log"),
                "stdout_path": str(root / "logs" / "responsiveness_budget_gate.stdout.log"),
                "stderr_path": str(root / "logs" / "responsiveness_budget_gate.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "responsiveness_budget_gate.xcresult"),
            },
            {
                "step": "discover_xctestrun",
                "required": "1",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "discover_xctestrun.log"),
                "stdout_path": str(root / "logs" / "discover_xctestrun.stdout.log"),
                "stderr_path": str(root / "logs" / "discover_xctestrun.stderr.log"),
                "result_bundle_path": "",
            },
            {
                "step": "uitest_onboarding_happy_path",
                "required": "0",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "uitest_onboarding_happy_path.log"),
                "stdout_path": str(root / "logs" / "uitest_onboarding_happy_path.stdout.log"),
                "stderr_path": str(root / "logs" / "uitest_onboarding_happy_path.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "uitest_onboarding_happy_path.xcresult"),
            },
            {
                "step": "uitest_permission_recovery",
                "required": "0",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "uitest_permission_recovery.log"),
                "stdout_path": str(root / "logs" / "uitest_permission_recovery.stdout.log"),
                "stderr_path": str(root / "logs" / "uitest_permission_recovery.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "uitest_permission_recovery.xcresult"),
            },
            {
                "step": "uitest_live_run_summary",
                "required": "0",
                "exit_code": "65",
                "result": "fail",
                "log_path": str(root / "logs" / "uitest_live_run_summary.log"),
                "stdout_path": str(root / "logs" / "uitest_live_run_summary.stdout.log"),
                "stderr_path": str(root / "logs" / "uitest_live_run_summary.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "uitest_live_run_summary.xcresult"),
            },
            {
                "step": "uitest_runtime_recovery",
                "required": "0",
                "exit_code": "0",
                "result": "pass",
                "log_path": str(root / "logs" / "uitest_runtime_recovery.log"),
                "stdout_path": str(root / "logs" / "uitest_runtime_recovery.stdout.log"),
                "stderr_path": str(root / "logs" / "uitest_runtime_recovery.stderr.log"),
                "result_bundle_path": str(root / "xcresult" / "uitest_runtime_recovery.xcresult"),
            },
        ]
        fieldnames = ["step", "required", "exit_code", "result", "log_path"]
        if include_split_streams:
            fieldnames.extend(["stdout_path", "stderr_path"])
        fieldnames.append("result_bundle_path")
        with (root / "status.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            if not include_split_streams:
                rows = [
                    {
                        "step": row["step"],
                        "required": row["required"],
                        "exit_code": row["exit_code"],
                        "result": row["result"],
                        "log_path": row["log_path"],
                        "result_bundle_path": row["result_bundle_path"],
                    }
                    for row in rows
                ]
            writer.writerows(rows)

        combined_logs = {
            "prepare_runtime_inputs.log": "[stdout] prepared runtime inputs\n",
            "build_for_testing.log": "[stdout] xcodebuild build-for-testing ok\n",
            "unit_tests.log": "[stdout] unit tests passed\n",
            "responsiveness_budget_gate.log": "[stdout] responsiveness gate passed\n",
            "discover_xctestrun.log": "[stdout] found runner bundle\n",
            "uitest_onboarding_happy_path.log": "[stderr] bootstrap-flake detected for uitest_onboarding_happy_path; retrying after process cleanup\n[stdout] final pass\n",
            "uitest_permission_recovery.log": "[stdout] permission recovery pass\n",
            "uitest_live_run_summary.log": "[stderr] UI assertion failed on summary screen\n",
            "uitest_runtime_recovery.log": "[stdout] runtime recovery pass\n",
        }
        stdout_logs = {
            "prepare_runtime_inputs.stdout.log": "prepared runtime inputs\n",
            "build_for_testing.stdout.log": "xcodebuild build-for-testing ok\n",
            "unit_tests.stdout.log": "unit tests passed\n",
            "responsiveness_budget_gate.stdout.log": "responsiveness gate passed\n",
            "discover_xctestrun.stdout.log": "found runner bundle\n",
            "uitest_onboarding_happy_path.stdout.log": "final pass\n",
            "uitest_permission_recovery.stdout.log": "permission recovery pass\n",
            "uitest_live_run_summary.stdout.log": "",
            "uitest_runtime_recovery.stdout.log": "runtime recovery pass\n",
        }
        stderr_logs = {
            "prepare_runtime_inputs.stderr.log": "",
            "build_for_testing.stderr.log": "",
            "unit_tests.stderr.log": "",
            "responsiveness_budget_gate.stderr.log": "",
            "discover_xctestrun.stderr.log": "",
            "uitest_onboarding_happy_path.stderr.log": "bootstrap-flake detected for uitest_onboarding_happy_path; retrying after process cleanup\n",
            "uitest_permission_recovery.stderr.log": "",
            "uitest_live_run_summary.stderr.log": "UI assertion failed on summary screen\n",
            "uitest_runtime_recovery.stderr.log": "",
        }
        for name, content in combined_logs.items():
            (root / "logs" / name).write_text(content, encoding="utf-8")
        if include_split_streams:
            for name, content in stdout_logs.items():
                (root / "logs" / name).write_text(content, encoding="utf-8")
            for name, content in stderr_logs.items():
                (root / "logs" / name).write_text(content, encoding="utf-8")

    def run_renderer(self, root: Path, lane_type: str, *extra_args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(RENDERER),
                "--root",
                str(root),
                "--scenario-id",
                f"recorditapp-{lane_type}",
                "--lane-type",
                lane_type,
                "--generated-at-utc",
                "2026-03-06T15:40:00Z",
                "--json",
                *extra_args,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def run_validator(self, root: Path, lane_type: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                "--root",
                str(root),
                "--expect-lane-type",
                lane_type,
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_xctest_renderer_outputs_validator_compatible_contract(self) -> None:
        root = self.make_root()
        self.write_status_csv(root)

        render = self.run_renderer(root, "xctest-evidence")
        self.assertEqual(render.returncode, 0, render.stderr)
        payload = json.loads(render.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "pass")
        self.assertEqual(payload["phase_count"], 4)

        validate = self.run_validator(root, "xctest-evidence")
        self.assertEqual(validate.returncode, 0, validate.stderr)
        validator_payload = json.loads(validate.stdout)
        self.assertTrue(validator_payload["ok"])
        self.assertEqual(validator_payload["overall_status"], "pass")

        manifest = json.loads((root / "evidence_contract.json").read_text(encoding="utf-8"))
        responsiveness = next(phase for phase in manifest["phases"] if phase["phase_id"] == "responsiveness_budget_gate")
        self.assertEqual(responsiveness["primary_artifact_relpath"], "responsiveness_budget_summary.csv")
        self.assertIn("responsiveness_budget_summary.json", responsiveness["extra_artifact_relpaths"])
        self.assertEqual(responsiveness["stdout_relpath"], "logs/responsiveness_budget_gate.stdout.log")
        self.assertEqual(responsiveness["stderr_relpath"], "logs/responsiveness_budget_gate.stderr.log")

    def test_xcuitest_renderer_marks_flake_retried_and_optional_failures(self) -> None:
        root = self.make_root()
        self.write_status_csv(root)

        render = self.run_renderer(root, "xcuitest-evidence")
        self.assertEqual(render.returncode, 0, render.stderr)
        payload = json.loads(render.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "warn")
        self.assertEqual(payload["phase_count"], 6)

        validate = self.run_validator(root, "xcuitest-evidence")
        self.assertEqual(validate.returncode, 0, validate.stderr)
        validator_payload = json.loads(validate.stdout)
        self.assertTrue(validator_payload["ok"])
        self.assertEqual(validator_payload["overall_status"], "warn")

        manifest = json.loads((root / "evidence_contract.json").read_text(encoding="utf-8"))
        onboarding = next(phase for phase in manifest["phases"] if phase["phase_id"] == "uitest_onboarding_happy_path")
        self.assertEqual(onboarding["status"], "warn")
        self.assertEqual(onboarding["exit_classification"], "flake_retried")
        self.assertIn("bootstrap retry", onboarding["notes"])
        self.assertEqual(onboarding["log_relpath"], "logs/uitest_onboarding_happy_path.log")
        self.assertEqual(onboarding["stdout_relpath"], "logs/uitest_onboarding_happy_path.stdout.log")
        self.assertEqual(onboarding["stderr_relpath"], "logs/uitest_onboarding_happy_path.stderr.log")

        live_run = next(phase for phase in manifest["phases"] if phase["phase_id"] == "uitest_live_run_summary")
        self.assertEqual(live_run["status"], "fail")
        self.assertEqual(live_run["exit_classification"], "product_failure")

    def test_renderer_backfills_stdout_and_stderr_when_status_csv_has_legacy_columns_only(self) -> None:
        root = self.make_root()
        self.write_status_csv(root, include_split_streams=False)

        render = self.run_renderer(root, "xctest-evidence")
        self.assertEqual(render.returncode, 0, render.stderr)

        manifest = json.loads((root / "evidence_contract.json").read_text(encoding="utf-8"))
        build_for_testing = next(phase for phase in manifest["phases"] if phase["phase_id"] == "build_for_testing")
        self.assertEqual(build_for_testing["log_relpath"], "logs/build_for_testing.log")
        self.assertEqual(build_for_testing["stdout_relpath"], "logs/build_for_testing.log")
        self.assertEqual(build_for_testing["stderr_relpath"], "logs/build_for_testing.log")

    def test_renderer_writes_shared_base_paths_env_entries(self) -> None:
        root = self.make_root()
        self.write_status_csv(root)

        render = self.run_renderer(root, "xctest-evidence")
        self.assertEqual(render.returncode, 0, render.stderr)

        paths_env = (root / "paths.env").read_text(encoding="utf-8")
        self.assertIn("EVIDENCE_ROOT=", paths_env)
        self.assertIn("ARTIFACT_ROOT=", paths_env)
        self.assertIn("STATUS_TXT=", paths_env)
        self.assertIn("SUMMARY_CSV=", paths_env)
        self.assertIn("SUMMARY_JSON=", paths_env)
        self.assertIn("MANIFEST=", paths_env)

    def test_renderer_supports_custom_output_relpaths(self) -> None:
        root = self.make_root()
        self.write_status_csv(root)

        render = self.run_renderer(
            root,
            "xctest-evidence",
            "--paths-env-relpath",
            "contracts/xctest/paths.env",
            "--status-txt-relpath",
            "contracts/xctest/status.txt",
            "--summary-csv-relpath",
            "contracts/xctest/summary.csv",
            "--summary-json-relpath",
            "contracts/xctest/summary.json",
            "--manifest-relpath",
            "contracts/xctest/evidence_contract.json",
        )
        self.assertEqual(render.returncode, 0, render.stderr)
        self.assertTrue((root / "contracts" / "xctest" / "evidence_contract.json").is_file())
        self.assertTrue((root / "contracts" / "xctest" / "summary.json").is_file())


if __name__ == "__main__":
    unittest.main()
