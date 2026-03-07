#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "gate_coverage_matrix_evidence.py"

REQUIRED_DOWNSTREAM = [
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

REQUIRED_CRITICAL = [
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

REQUIRED_FAILURE_SCENARIOS = [
    "permission-denial-preflight",
    "missing-invalid-model",
    "missing-runtime-binary",
    "runtime-preflight-failure",
    "stop-timeout-class",
    "partial-artifact-forced-kill",
]


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


class GateCoverageMatrixEvidenceTests(unittest.TestCase):
    def _make_downstream_rows(self) -> list[list[str]]:
        rows: list[list[str]] = []
        for key in REQUIRED_DOWNSTREAM:
            rows.append(
                [
                    key,
                    "journey",
                    "mods",
                    "lane",
                    "packaged-app",
                    "retained-rich",
                    "high",
                    "covered",
                    "none",
                    "none",
                    "bd-next",
                ]
            )
        return rows

    def _make_critical_rows(self) -> list[list[str]]:
        rows: list[list[str]] = []
        for surface in REQUIRED_CRITICAL:
            rows.append(
                [
                    surface,
                    "lane",
                    "files",
                    "shell",
                    "packaged-app",
                    "claim",
                    "none",
                    "none",
                    "bd-next",
                ]
            )
        return rows

    def _create_default_journey_root(self, root: Path, journey_claim_ready: str = "true") -> Path:
        journey = root / "journey"
        (journey / "artifacts").mkdir(parents=True, exist_ok=True)
        (journey / "summary.csv").write_text("k,v\n", encoding="utf-8")
        (journey / "summary.json").write_text("{}\n", encoding="utf-8")
        (journey / "status.txt").write_text("status=pass\n", encoding="utf-8")
        (journey / "evidence_contract.json").write_text("{}\n", encoding="utf-8")
        write_csv(
            journey / "artifacts" / "default_user_journey_checks.csv",
            ["key", "value"],
            [["journey_claim_ready", journey_claim_ready]],
        )
        return journey

    def _create_failure_root(self, root: Path, missing: str | None = None) -> Path:
        failure = root / "failure"
        (failure / "artifacts").mkdir(parents=True, exist_ok=True)
        (failure / "summary.csv").write_text("k,v\n", encoding="utf-8")
        (failure / "summary.json").write_text("{}\n", encoding="utf-8")
        (failure / "status.txt").write_text("status=pass\n", encoding="utf-8")
        (failure / "evidence_contract.json").write_text("{}\n", encoding="utf-8")
        rows = []
        for scenario in REQUIRED_FAILURE_SCENARIOS:
            if missing and scenario == missing:
                continue
            rows.append([scenario, "pass"])
        write_csv(
            failure / "artifacts" / "failure_matrix.csv",
            ["scenario_id", "status"],
            rows,
        )
        (failure / "artifacts" / "failure_matrix_status.txt").write_text("status=pass\n", encoding="utf-8")
        return failure

    def _run_gate(
        self,
        temp_root: Path,
        claim_text: str,
        missing_scenario: str | None = None,
        journey_claim_ready: str = "true",
        repo_root_override: Path | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        downstream_csv = temp_root / "downstream.csv"
        critical_csv = temp_root / "critical.csv"
        out_dir = temp_root / "out"
        claim_file = temp_root / "claims.txt"
        claim_file.write_text(claim_text, encoding="utf-8")

        write_csv(
            downstream_csv,
            [
                "surface_key",
                "journey",
                "owning_modules",
                "lane_id",
                "realism_class",
                "evidence_quality",
                "confidence_level",
                "gap_status",
                "main_bypass_or_limit",
                "remaining_gap",
                "follow_on_beads",
            ],
            self._make_downstream_rows(),
        )
        write_csv(
            critical_csv,
            [
                "surface",
                "strongest_lane",
                "files",
                "layer",
                "realism",
                "primary_claim",
                "simulation_or_bypass",
                "remaining_gap",
                "follow_on_beads",
            ],
            self._make_critical_rows(),
        )

        journey = self._create_default_journey_root(temp_root, journey_claim_ready=journey_claim_ready)
        failure = self._create_failure_root(temp_root, missing=missing_scenario)

        repo_root = repo_root_override or ROOT
        proc = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--root",
                str(repo_root),
                "--out-dir",
                str(out_dir),
                "--downstream-matrix-csv",
                str(downstream_csv),
                "--critical-matrix-csv",
                str(critical_csv),
                "--default-journey-root",
                str(journey),
                "--failure-matrix-root",
                str(failure),
                "--claim-scan-files",
                str(claim_file),
                "--skip-contract-validation",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        payload = json.loads((out_dir / "status.json").read_text(encoding="utf-8"))
        return proc, payload

    def _create_fake_repo_with_cert_gate(
        self,
        temp_root: Path,
        cert_status_body: str,
        cert_exit_code: int = 0,
    ) -> Path:
        fake_repo = temp_root / "fake_repo"
        scripts_dir = fake_repo / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        gate_script = scripts_dir / "gate_coverage_certification.sh"
        gate_script.write_text(
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    'OUT_DIR=""',
                    'while [[ $# -gt 0 ]]; do',
                    '  case "$1" in',
                    "    --out-dir)",
                    '      OUT_DIR="$2"',
                    "      shift 2",
                    "      ;;",
                    "    *)",
                    "      shift",
                    "      ;;",
                    "  esac",
                    "done",
                    'mkdir -p "$OUT_DIR"',
                    'cat > "$OUT_DIR/status.json" <<\'JSON\'',
                    cert_status_body,
                    "JSON",
                    f"exit {cert_exit_code}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        gate_script.chmod(0o755)
        return fake_repo

    def test_pass_with_complete_rows_and_evidence_without_claim_text(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_pass_") as tmp:
            proc, payload = self._run_gate(Path(tmp), claim_text="release notes\n")
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            self.assertTrue(payload["gate_pass"])

    def test_fail_when_required_failure_scenario_is_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_missing_") as tmp:
            proc, payload = self._run_gate(Path(tmp), claim_text="release notes\n", missing_scenario="stop-timeout-class")
            self.assertNotEqual(proc.returncode, 0)
            codes = {item["code"] for item in payload["failures"]}
            self.assertIn("failure_matrix_missing_required_scenario", codes)

    def test_fail_when_certifying_claim_text_exists_without_true_certification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_claim_") as tmp:
            proc, payload = self._run_gate(Path(tmp), claim_text="This release has full coverage.\n")
            self.assertNotEqual(proc.returncode, 0)
            codes = {item["code"] for item in payload["failures"]}
            self.assertIn("unsupported_certifying_claim_text", codes)

    def test_fail_when_default_journey_claim_ready_is_false(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_claim_ready_") as tmp:
            proc, payload = self._run_gate(
                Path(tmp),
                claim_text="release notes\n",
                journey_claim_ready="false",
            )
            self.assertNotEqual(proc.returncode, 0)
            codes = {item["code"] for item in payload["failures"]}
            self.assertIn("default_journey_claim_not_ready", codes)

    def test_fail_when_certification_status_json_is_malformed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_cert_malformed_") as tmp:
            temp_root = Path(tmp)
            fake_repo = self._create_fake_repo_with_cert_gate(temp_root, cert_status_body="{not-json")
            proc, payload = self._run_gate(
                temp_root,
                claim_text="release notes\n",
                repo_root_override=fake_repo,
            )
            self.assertNotEqual(proc.returncode, 0)
            codes = {item["code"] for item in payload["failures"]}
            self.assertIn("certification_status_malformed", codes)
            self.assertIn("certification_verdict_invalid", codes)

    def test_fail_when_certification_verdict_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gate_cov_matrix_cert_invalid_") as tmp:
            temp_root = Path(tmp)
            fake_repo = self._create_fake_repo_with_cert_gate(
                temp_root,
                cert_status_body='{"verdict":"maybe"}',
            )
            proc, payload = self._run_gate(
                temp_root,
                claim_text="release notes\n",
                repo_root_override=fake_repo,
            )
            self.assertNotEqual(proc.returncode, 0)
            codes = {item["code"] for item in payload["failures"]}
            self.assertIn("certification_verdict_invalid", codes)


if __name__ == "__main__":
    unittest.main()
