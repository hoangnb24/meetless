from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class GatePackagedStopFinalizationSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo_root = Path(__file__).resolve().parents[1]
        self.script = self.repo_root / "scripts" / "gate_packaged_stop_finalization_summary.py"

    def _write_json(self, path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _make_manifest(self, runtime_mode: str, session_status: str, degraded: bool = False) -> dict:
        return {
            "runtime_mode": runtime_mode,
            "session_summary": {
                "session_status": session_status,
            },
            "trust": {
                "degraded_mode_active": degraded,
            },
        }

    def _make_scenario(
        self,
        scenarios_root: Path,
        scenario_id: str,
        *,
        mode: str,
        expected_outcome_code: str,
        expected_runtime_mode: str,
        expected_manifest_exists: bool,
        exit_code: int,
        signal_requested: str = "none",
        signal_sent: bool = False,
        manifest: dict | None = None,
        with_jsonl: bool = True,
        with_wav: bool = True,
        with_input_wav: bool = True,
    ) -> None:
        scenario_dir = scenarios_root / scenario_id
        session_root = scenario_dir / "session"
        session_root.mkdir(parents=True, exist_ok=True)

        self._write_json(
            scenario_dir / "scenario_meta.json",
            {
                "scenario_id": scenario_id,
                "mode": mode,
                "expected_outcome_code": expected_outcome_code,
                "expected_runtime_mode": expected_runtime_mode,
                "expected_manifest_exists": expected_manifest_exists,
                "session_root": str(session_root),
                "stdout_log": str(scenario_dir / "stdout.log"),
                "stderr_log": str(scenario_dir / "stderr.log"),
            },
        )

        self._write_json(
            scenario_dir / "execution.json",
            {
                "mode": mode,
                "exit_code": exit_code,
                "signal_requested": signal_requested,
                "signal_sent": signal_sent,
                "session_root": str(session_root),
                "stdout_log": str(scenario_dir / "stdout.log"),
                "stderr_log": str(scenario_dir / "stderr.log"),
                "runner_error": "",
            },
        )

        (scenario_dir / "stdout.log").write_text("ok\n", encoding="utf-8")
        (scenario_dir / "stderr.log").write_text("", encoding="utf-8")

        if with_jsonl:
            (session_root / "session.jsonl").write_text("{}\n", encoding="utf-8")
        if with_wav:
            (session_root / "session.wav").write_bytes(b"RIFF")
        if with_input_wav:
            (session_root / "session.input.wav").write_bytes(b"RIFF")
        if manifest is not None:
            self._write_json(session_root / "session.manifest.json", manifest)

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
            "summary_csv": summary_csv,
            "summary_json": json.loads(summary_json.read_text(encoding="utf-8")),
            "status_txt": status_txt.read_text(encoding="utf-8"),
        }

    def test_summary_passes_for_expected_packaged_matrix(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bd-2kia-summary-") as tmp:
            tmp_root = Path(tmp)
            scenarios_root = tmp_root / "scenarios"

            self._make_scenario(
                scenarios_root,
                "graceful_stop_live",
                mode="live",
                expected_outcome_code="finalized_success",
                expected_runtime_mode="live-stream",
                expected_manifest_exists=True,
                exit_code=0,
                manifest=self._make_manifest("live-stream", "ok"),
            )
            self._make_scenario(
                scenarios_root,
                "fallback_record_only_offline",
                mode="offline",
                expected_outcome_code="finalized_success",
                expected_runtime_mode="representative-offline",
                expected_manifest_exists=True,
                exit_code=0,
                manifest=self._make_manifest("representative-offline", "ok"),
            )
            self._make_scenario(
                scenarios_root,
                "early_stop_live_interrupt",
                mode="live",
                expected_outcome_code="finalized_success",
                expected_runtime_mode="live-stream",
                expected_manifest_exists=True,
                exit_code=0,
                signal_requested="SIGINT",
                signal_sent=True,
                manifest=self._make_manifest("live-stream", "ok"),
            )
            self._make_scenario(
                scenarios_root,
                "partial_artifact_forced_kill",
                mode="live",
                expected_outcome_code="partial_artifact_session",
                expected_runtime_mode="live-stream",
                expected_manifest_exists=False,
                exit_code=-9,
                signal_requested="SIGKILL",
                signal_sent=True,
                manifest=None,
            )

            result = self._run_summary(scenarios_root, tmp_root)
            self.assertIn("status=pass", result["status_txt"])
            self.assertEqual(result["summary_json"]["failure_count"], 0)
            self.assertTrue(result["summary_json"]["gate_pass"])

    def test_degraded_manifest_maps_to_finalized_degraded_success(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bd-2kia-degraded-") as tmp:
            tmp_root = Path(tmp)
            scenarios_root = tmp_root / "scenarios"

            self._make_scenario(
                scenarios_root,
                "degraded_live",
                mode="live",
                expected_outcome_code="finalized_degraded_success",
                expected_runtime_mode="live-stream",
                expected_manifest_exists=True,
                exit_code=0,
                manifest=self._make_manifest("live-stream", "ok", degraded=True),
            )

            result = self._run_summary(scenarios_root, tmp_root)
            self.assertIn("status=pass", result["status_txt"])
            rows = result["summary_json"]["scenarios"]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["outcome_code"], "finalized_degraded_success")


if __name__ == "__main__":
    unittest.main()
