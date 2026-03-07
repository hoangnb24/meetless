#!/usr/bin/env python3
"""Regression tests for scripts/notarize_recordit_release_dmg.sh."""

from __future__ import annotations

import csv
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "notarize_recordit_release_dmg.sh"


class NotarizeRecorditReleaseDmgTests(unittest.TestCase):
    def _write_executable(self, path: Path, body: str) -> None:
        path.write_text(body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def _make_shims(self, bin_dir: Path, trace_path: Path, reject_submit: bool) -> None:
        self._write_executable(
            bin_dir / "codesign",
            """#!/usr/bin/env bash
set -euo pipefail
echo "codesign $*" >> "$TRACE_FILE"
exit 0
""",
        )
        self._write_executable(
            bin_dir / "spctl",
            """#!/usr/bin/env bash
set -euo pipefail
echo "spctl $*" >> "$TRACE_FILE"
exit 0
""",
        )

        submit_payload = (
            '{"id":"SUBMISSION-123","status":"Invalid","message":"The binary is not signed."}'
            if reject_submit
            else '{"id":"SUBMISSION-123","status":"Accepted","message":"ready"}'
        )
        self._write_executable(
            bin_dir / "xcrun",
            f"""#!/usr/bin/env bash
set -euo pipefail
echo "xcrun $*" >> "$TRACE_FILE"
if [[ "$1" == "notarytool" && "$2" == "submit" ]]; then
  printf '%s\n' '{submit_payload}'
  exit 0
fi
if [[ "$1" == "notarytool" && "$2" == "log" ]]; then
  printf '%s\n' '{{"id":"SUBMISSION-123","issues":[]}}'
  exit 0
fi
if [[ "$1" == "stapler" && "$2" == "staple" ]]; then
  echo "The staple and validate action worked!"
  exit 0
fi
if [[ "$1" == "stapler" && "$2" == "validate" ]]; then
  echo "The validate action worked!"
  exit 0
fi
echo "unsupported xcrun invocation: $*" >&2
exit 2
""",
        )

        os.environ["TRACE_FILE"] = str(trace_path)

    def _run_script(self, reject_submit: bool) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
        temp_root = Path(tempfile.mkdtemp(prefix="recordit-notary-test-"))
        dmg_path = temp_root / "Recordit-test.dmg"
        dmg_path.write_bytes(b"fake-dmg")
        out_dir = temp_root / "out"
        fake_bin = temp_root / "bin"
        fake_bin.mkdir(parents=True, exist_ok=True)
        trace_path = temp_root / "trace.log"
        self._make_shims(fake_bin, trace_path, reject_submit=reject_submit)

        env = os.environ.copy()
        env["TRACE_FILE"] = str(trace_path)
        env["PATH"] = f"{fake_bin}:{env['PATH']}"
        env["ROOT"] = str(PROJECT_ROOT)
        env["RECORDIT_DMG"] = str(dmg_path)
        env["OUT_DIR"] = str(out_dir)
        env["NOTARY_PROFILE"] = "recordit-test-profile"
        env["SIGN_IDENTITY"] = "Developer ID Application: Example"
        env["SKIP_DMG_BUILD"] = "1"

        proc = subprocess.run(
            ["bash", str(SCRIPT_PATH)],
            cwd=PROJECT_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        return proc, out_dir, trace_path

    def test_happy_path_runs_submit_staple_and_gatekeeper_with_retained_evidence(self) -> None:
        proc, out_dir, trace_path = self._run_script(reject_submit=False)
        self.assertEqual(proc.returncode, 0, msg=f"stdout={proc.stdout}\nstderr={proc.stderr}")

        status = (out_dir / "status.txt").read_text(encoding="utf-8").strip()
        self.assertEqual(status, "pass")

        summary_rows = list(csv.DictReader((out_dir / "summary.csv").open(encoding="utf-8")))
        by_check = {row["check"]: row for row in summary_rows}
        self.assertEqual(by_check["notary_submit"]["status"], "pass")
        self.assertEqual(by_check["notary_status"]["status"], "pass")
        self.assertEqual(by_check["stapler_staple"]["status"], "pass")
        self.assertEqual(by_check["stapler_validate"]["status"], "pass")
        self.assertEqual(by_check["spctl_assess"]["status"], "pass")

        outcome = json.loads((out_dir / "notary" / "notary-outcome.json").read_text(encoding="utf-8"))
        self.assertEqual(outcome["submission_id"], "SUBMISSION-123")
        self.assertEqual(outcome["status"], "Accepted")

        trace_lines = trace_path.read_text(encoding="utf-8").splitlines()
        joined = "\n".join(trace_lines)
        self.assertIn("xcrun notarytool submit", joined)
        self.assertIn("xcrun notarytool log", joined)
        self.assertIn("xcrun stapler staple", joined)
        self.assertIn("xcrun stapler validate", joined)
        self.assertIn("spctl --assess --type open", joined)

    def test_invalid_notary_status_fails_and_records_failure_signatures(self) -> None:
        proc, out_dir, _trace_path = self._run_script(reject_submit=True)
        self.assertNotEqual(proc.returncode, 0, msg="invalid notary status should fail")

        status = (out_dir / "status.txt").read_text(encoding="utf-8").strip()
        self.assertEqual(status, "fail")

        summary_rows = list(csv.DictReader((out_dir / "summary.csv").open(encoding="utf-8")))
        by_check = {row["check"]: row for row in summary_rows}
        self.assertEqual(by_check["notary_status"]["status"], "fail")
        self.assertEqual(by_check["stapler_staple"]["status"], "skipped")
        self.assertEqual(by_check["stapler_validate"]["status"], "skipped")

        signatures = json.loads((out_dir / "notary" / "failure-signatures.json").read_text(encoding="utf-8"))
        codes = {entry["code"] for entry in signatures.get("signatures", [])}
        self.assertIn("notary_status_invalid", codes)
        self.assertIn("missing_signature", codes)


if __name__ == "__main__":
    unittest.main()
