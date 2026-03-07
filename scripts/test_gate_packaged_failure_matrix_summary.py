from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class GatePackagedFailureMatrixSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo_root = Path(__file__).resolve().parents[1]
        self.script = self.repo_root / "scripts" / "gate_packaged_failure_matrix_summary.py"

    def _write_json(self, path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _write_scenario(
        self,
        scenarios_root: Path,
        scenario_id: str,
        *,
        expected_failure_class: str,
        expected_outcome_code: str,
        exit_code: int,
        preflight_failing_ids: list[str] | None = None,
        missing_runtime_binary: bool = False,
        stop_timeout: bool = False,
        partial_artifact: bool = False,
    ) -> None:
        scenario_dir = scenarios_root / scenario_id
        session_root = scenario_dir / "session"
        session_root.mkdir(parents=True, exist_ok=True)

        stdout_log = scenario_dir / "stdout.log"
        stderr_log = scenario_dir / "stderr.log"
        stdout_log.write_text("\n", encoding="utf-8")
        stderr_log.write_text("\n", encoding="utf-8")

        preflight_manifest_path = scenario_dir / "preflight.manifest.json"
        if preflight_failing_ids is not None:
            checks = []
            for check_id in [
                "model_path",
                "out_wav",
                "out_jsonl",
                "out_manifest",
                "sample_rate",
                "screen_capture_access",
                "display_availability",
                "microphone_access",
                "backend_runtime",
            ]:
                checks.append(
                    {
                        "id": check_id,
                        "status": "FAIL" if check_id in set(preflight_failing_ids) else "PASS",
                        "detail": "fixture",
                    }
                )
            self._write_json(
                preflight_manifest_path,
                {
                    "schema_version": "1",
                    "kind": "transcribe-live-preflight",
                    "overall_status": "FAIL",
                    "checks": checks,
                },
            )

        if stop_timeout:
            (session_root / "session.pending.json").write_text("{}\n", encoding="utf-8")
            (session_root / "session.pending.retry.json").write_text("{}\n", encoding="utf-8")

        if partial_artifact:
            (session_root / "session.jsonl").write_text('{"event_type":"partial"}\n', encoding="utf-8")

        self._write_json(
            scenario_dir / "scenario_meta.json",
            {
                "scenario_id": scenario_id,
                "expected_failure_class": expected_failure_class,
                "expected_outcome_code": expected_outcome_code,
                "expected_nonzero_exit": True,
                "session_root": str(session_root),
                "stdout_log": str(stdout_log),
                "stderr_log": str(stderr_log),
                "preflight_manifest_path": str(preflight_manifest_path),
            },
        )

        self._write_json(
            scenario_dir / "execution.json",
            {
                "scenario_id": scenario_id,
                "exit_code": exit_code,
                "session_root": str(session_root),
                "stdout_log": str(stdout_log),
                "stderr_log": str(stderr_log),
                "started_at_utc": "2026-03-07T00:00:00Z",
                "ended_at_utc": "2026-03-07T00:00:01Z",
                "runner_error": "",
                "preflight_manifest_path": str(preflight_manifest_path),
                "missing_runtime_binary": missing_runtime_binary,
            },
        )

    def _run_summary(self, scenarios_root: Path, out_root: Path) -> dict:
        summary_csv = out_root / "summary.csv"
        summary_json = out_root / "summary.json"
        status_txt = out_root / "status.txt"

        subprocess.run(
            [
                "python3",
                str(self.script),
                "--scenarios-root",
                str(scenarios_root),
                "--summary-csv",
                str(summary_csv),
                "--summary-json",
                str(summary_json),
                "--status-path",
                str(status_txt),
            ],
            check=True,
            cwd=self.repo_root,
        )

        return {
            "summary_json": json.loads(summary_json.read_text(encoding="utf-8")),
            "status_txt": status_txt.read_text(encoding="utf-8"),
        }

    def test_summary_passes_for_required_failure_matrix(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bd-v502-summary-") as tmp:
            tmp_root = Path(tmp)
            scenarios_root = tmp_root / "scenarios"

            self._write_scenario(
                scenarios_root,
                "permission-denial-preflight",
                expected_failure_class="permission_denial",
                expected_outcome_code="permission_denied",
                exit_code=1,
                preflight_failing_ids=["screen_capture_access", "display_availability", "microphone_access"],
            )
            self._write_scenario(
                scenarios_root,
                "missing-invalid-model",
                expected_failure_class="missing_or_invalid_model",
                expected_outcome_code="missing_or_invalid_model",
                exit_code=1,
                preflight_failing_ids=["model_path"],
            )
            self._write_scenario(
                scenarios_root,
                "missing-runtime-binary",
                expected_failure_class="missing_runtime_binary",
                expected_outcome_code="missing_runtime_binary",
                exit_code=127,
                missing_runtime_binary=True,
            )
            self._write_scenario(
                scenarios_root,
                "runtime-preflight-failure",
                expected_failure_class="runtime_preflight_failure",
                expected_outcome_code="runtime_preflight_failure",
                exit_code=1,
                preflight_failing_ids=["out_wav", "out_jsonl", "out_manifest"],
            )
            self._write_scenario(
                scenarios_root,
                "stop-timeout-class",
                expected_failure_class="stop_timeout",
                expected_outcome_code="stop_timeout",
                exit_code=124,
                stop_timeout=True,
            )
            self._write_scenario(
                scenarios_root,
                "partial-artifact-forced-kill",
                expected_failure_class="partial_artifact",
                expected_outcome_code="partial_artifact_session",
                exit_code=137,
                partial_artifact=True,
            )

            result = self._run_summary(scenarios_root, tmp_root)
            self.assertIn("status=pass", result["status_txt"])
            self.assertTrue(result["summary_json"]["gate_pass"])
            self.assertEqual(result["summary_json"]["failure_count"], 0)
            self.assertEqual(result["summary_json"]["missing_required_scenarios"], [])

    def test_summary_fails_when_required_scenario_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bd-v502-missing-") as tmp:
            tmp_root = Path(tmp)
            scenarios_root = tmp_root / "scenarios"

            self._write_scenario(
                scenarios_root,
                "missing-invalid-model",
                expected_failure_class="missing_or_invalid_model",
                expected_outcome_code="missing_or_invalid_model",
                exit_code=1,
                preflight_failing_ids=["model_path"],
            )

            result = self._run_summary(scenarios_root, tmp_root)
            self.assertIn("status=fail", result["status_txt"])
            self.assertFalse(result["summary_json"]["gate_pass"])
            self.assertIn("permission-denial-preflight", result["summary_json"]["missing_required_scenarios"])


if __name__ == "__main__":
    unittest.main()
