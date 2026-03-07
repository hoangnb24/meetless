#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RENDERER = PROJECT_ROOT / "scripts" / "render_shell_e2e_evidence_contract.py"
VALIDATOR = PROJECT_ROOT / "scripts" / "validate_e2e_evidence_contract.py"


class RenderShellE2EEvidenceContractTests(unittest.TestCase):
    maxDiff = None

    def make_phase_root(self) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        (root / "logs").mkdir(parents=True)
        (root / "artifacts").mkdir(parents=True)
        (root / "bundles" / "smoke.xcresult").mkdir(parents=True)
        for relpath, content in {
            "logs/build.log": "build combined\n",
            "logs/build.stdout": "build out\n",
            "logs/build.stderr": "\n",
            "logs/run.log": "run combined\n",
            "logs/run.stdout": "run out\n",
            "logs/run.stderr": "\n",
            "artifacts/build.txt": "built\n",
            "artifacts/run.txt": "ran\n",
            "artifacts/extra.json": "{}\n",
        }.items():
            path = root / relpath
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return root

    def write_phase_manifest(self, root: Path, phases: list[dict]) -> Path:
        manifest = root / "phases.json"
        manifest.write_text(json.dumps({"phases": phases}, indent=2) + "\n", encoding="utf-8")
        return manifest

    def run_renderer(self, root: Path, phase_manifest: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(RENDERER),
                "--root",
                str(root),
                "--scenario-id",
                "packaged_live_smoke",
                "--lane-type",
                "packaged-e2e",
                "--phase-manifest",
                str(phase_manifest),
                "--generated-at-utc",
                "2026-03-06T15:30:00Z",
                "--paths-env-entry",
                "MODEL_PATH=/tmp/model.bin",
                "--paths-env-entry",
                "SIGNED_APP=dist/Recordit.app",
                "--json",
                *extra_args,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def run_validator(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                "--root",
                str(root),
                "--expect-lane-type",
                "packaged-e2e",
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_renderer_outputs_validator_compatible_contract(self) -> None:
        root = self.make_phase_root()
        phase_manifest = self.write_phase_manifest(
            root,
            [
                {
                    "phase_id": "build_for_testing",
                    "title": "Build packaged app",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T15:00:00Z",
                    "ended_at_utc": "2026-03-06T15:05:00Z",
                    "command_display": "make sign-recordit-app",
                    "command_argv": ["make", "sign-recordit-app"],
                    "log_relpath": "logs/build.log",
                    "stdout_relpath": "logs/build.stdout",
                    "stderr_relpath": "logs/build.stderr",
                    "primary_artifact_relpath": "artifacts/build.txt",
                },
                {
                    "phase_id": "run_packaged_smoke",
                    "title": "Run packaged live smoke",
                    "required": False,
                    "status": "warn",
                    "exit_classification": "flake_retried",
                    "started_at_utc": "2026-03-06T15:06:00Z",
                    "ended_at_utc": "2026-03-06T15:08:00Z",
                    "command_display": "scripts/gate_packaged_live_smoke.sh",
                    "command_argv": ["scripts/gate_packaged_live_smoke.sh"],
                    "log_relpath": "logs/run.log",
                    "stdout_relpath": "logs/run.stdout",
                    "stderr_relpath": "logs/run.stderr",
                    "primary_artifact_relpath": "artifacts/run.txt",
                    "extra_artifact_relpaths": ["artifacts/extra.json"],
                    "result_bundle_relpath": "bundles/smoke.xcresult",
                    "notes": "first attempt flaked; retry succeeded with retained logs",
                },
            ],
        )

        render = self.run_renderer(root, phase_manifest)
        self.assertEqual(render.returncode, 0, render.stderr)
        payload = json.loads(render.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["overall_status"], "warn")
        self.assertEqual(payload["phase_count"], 2)

        validate = self.run_validator(root)
        self.assertEqual(validate.returncode, 0, validate.stderr)
        validator_payload = json.loads(validate.stdout)
        self.assertTrue(validator_payload["ok"])
        self.assertEqual(validator_payload["overall_status"], "warn")

        paths_env = (root / "paths.env").read_text(encoding="utf-8")
        self.assertIn("MODEL_PATH=/tmp/model.bin", paths_env)
        self.assertIn("SIGNED_APP=dist/Recordit.app", paths_env)
        self.assertIn("EVIDENCE_ROOT=", paths_env)
        self.assertIn("ARTIFACT_ROOT=", paths_env)
        self.assertIn("STATUS_TXT=", paths_env)
        self.assertIn("SUMMARY_CSV=", paths_env)
        self.assertIn("SUMMARY_JSON=", paths_env)
        self.assertIn("MANIFEST=", paths_env)

    def test_renderer_rejects_non_shell_safe_paths_env_entry_key(self) -> None:
        root = self.make_phase_root()
        phase_manifest = self.write_phase_manifest(
            root,
            [
                {
                    "phase_id": "build_for_testing",
                    "title": "Build packaged app",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T15:00:00Z",
                    "ended_at_utc": "2026-03-06T15:05:00Z",
                    "command_display": "make sign-recordit-app",
                    "command_argv": ["make", "sign-recordit-app"],
                    "log_relpath": "logs/build.log",
                    "stdout_relpath": "logs/build.stdout",
                    "stderr_relpath": "logs/build.stderr",
                    "primary_artifact_relpath": "artifacts/build.txt",
                }
            ],
        )

        render = self.run_renderer(root, phase_manifest, "--paths-env-entry", "bad-key=value")
        self.assertEqual(render.returncode, 1)
        payload = json.loads(render.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("paths.env entry key must be shell-safe", payload["error"])

    def test_renderer_marks_required_failure_as_fail(self) -> None:
        root = self.make_phase_root()
        phase_manifest = self.write_phase_manifest(
            root,
            [
                {
                    "phase_id": "run_packaged_smoke",
                    "title": "Run packaged live smoke",
                    "required": True,
                    "status": "fail",
                    "exit_classification": "product_failure",
                    "started_at_utc": "2026-03-06T15:06:00Z",
                    "ended_at_utc": "2026-03-06T15:08:00Z",
                    "command_display": "scripts/gate_packaged_live_smoke.sh",
                    "command_argv": ["scripts/gate_packaged_live_smoke.sh"],
                    "log_relpath": "logs/run.log",
                    "stdout_relpath": "logs/run.stdout",
                    "stderr_relpath": "logs/run.stderr",
                    "primary_artifact_relpath": "artifacts/run.txt",
                }
            ],
        )

        render = self.run_renderer(root, phase_manifest)
        self.assertEqual(render.returncode, 0, render.stderr)
        payload = json.loads(render.stdout)
        self.assertEqual(payload["overall_status"], "fail")

        summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["overall_status"], "fail")
        self.assertEqual(summary["failed_phase_count"], 1)

    def test_renderer_rejects_duplicate_phase_ids(self) -> None:
        root = self.make_phase_root()
        phase_manifest = self.write_phase_manifest(
            root,
            [
                {
                    "phase_id": "duplicate_phase",
                    "title": "First",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T15:00:00Z",
                    "ended_at_utc": "2026-03-06T15:01:00Z",
                    "command_display": "first",
                    "command_argv": ["first"],
                    "log_relpath": "logs/build.log",
                    "stdout_relpath": "logs/build.stdout",
                    "stderr_relpath": "logs/build.stderr",
                    "primary_artifact_relpath": "artifacts/build.txt",
                },
                {
                    "phase_id": "duplicate_phase",
                    "title": "Second",
                    "required": True,
                    "status": "pass",
                    "exit_classification": "success",
                    "started_at_utc": "2026-03-06T15:02:00Z",
                    "ended_at_utc": "2026-03-06T15:03:00Z",
                    "command_display": "second",
                    "command_argv": ["second"],
                    "log_relpath": "logs/run.log",
                    "stdout_relpath": "logs/run.stdout",
                    "stderr_relpath": "logs/run.stderr",
                    "primary_artifact_relpath": "artifacts/run.txt",
                },
            ],
        )

        render = self.run_renderer(root, phase_manifest)
        self.assertEqual(render.returncode, 1)
        payload = json.loads(render.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("duplicate phase_id", payload["error"])


if __name__ == "__main__":
    unittest.main()
