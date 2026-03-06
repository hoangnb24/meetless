# bd-8ic9: Release-Context E2E Verifier

Date: 2026-03-06
Status: Implemented
Related bead: `bd-8ic9`
Release posture context: `docs/bd-1mep-v1-release-posture.md`

## Goal

Provide one script that captures the key release-context evidence downstream RC and
inspection work needs from the `Recordit.app` lane:

- signing verification
- signed entitlements capture
- bundled runtime/model payload inventory
- packaged-app preflight from the embedded `recordit` binary
- timestamped logs plus a machine-readable summary file

## Script

`scripts/verify_recordit_release_context.sh`

## Usage

```bash
scripts/verify_recordit_release_context.sh \
  --out-dir artifacts/ops/release-context/manual-$(date -u +%Y%m%dT%H%M%SZ)
```

Useful options:

- `--recordit-app-bundle <path>`: inspect a non-default app bundle path
- `--sign-identity <value>`: pass a signing identity through to `make sign-recordit-app`
- `--skip-build`: inspect an already-built bundle without rebuilding/signing it
- `--allow-preflight-failure`: keep collecting evidence even if packaged preflight exits non-zero

## Output Contract

The script writes one evidence root containing:

- `summary.csv`: `check,status,detail,artifact`
- `status.txt`: overall `pass` or `fail`
- `paths.env`: resolved app/runtime/model/preflight paths
- `logs/build_and_sign.log`: `make sign-recordit-app` output unless `--skip-build`
- `logs/codesign_verify.log`: deep/strict codesign verification
- `logs/entitlements_dump.log`: entitlements emitted from the signed app
- `logs/spctl_assess.log`: Gatekeeper-oriented assessment when `spctl` is available
- `logs/bundle_inventory.log`: app bundle inventory snapshot (including embedded runtime/model paths when present)
- `logs/payload_checksums.log`: checksums for app/runtime/model payloads
- `logs/packaged_preflight.log`: embedded `recordit preflight --mode live --json` output using `RECORDIT_ASR_MODEL` pointed at the bundled model
- `artifacts/preflight-live/`: packaged preflight output root

## Verification Scope

The verifier is intentionally release-context-oriented, not a full UI smoke suite.
It proves that the packaged app lane contains the expected payload, exposes the
signed posture we are about to ship, and can execute runtime preflight from the
embedded binary context.

This complements, rather than replaces:

- `scripts/gate_packaged_live_smoke.sh`
- XCTest/XCUITest evidence lanes
- downstream release-inspection/reporting work such as `bd-1huk`

## Expected Interpretation

- `codesign_verify=pass` means the app bundle is signed consistently enough for
  deep/strict verification on the local machine.
- `entitlements_dump=pass` means the script captured the effective signed
  entitlements for audit; downstream work decides whether those entitlements match
  the intended release posture.
- `runtime_payload=pass` means the embedded `recordit`, `sequoia_capture`, and
  default whispercpp model are present.
- `packaged_preflight=pass` means the packaged runtime context could run live
  preflight successfully on the current machine.
- `packaged_preflight=warn|fail` still preserves the exact logs needed for RC or
  local-debug triage.

## Validation Evidence

Executed during implementation:

```bash
bash -n scripts/verify_recordit_release_context.sh
scripts/verify_recordit_release_context.sh --help
scripts/verify_recordit_release_context.sh \
  --skip-build \
  --allow-preflight-failure \
  --out-dir artifacts/ops/release-context/selftest-fresh-20260306T071523Z
```

Observed on the current local `dist/Recordit.app` snapshot:

- help path returned successfully without triggering side effects
- self-test produced `summary.csv`, `status.txt`, and per-step logs under
  `artifacts/ops/release-context/selftest-fresh-20260306T071523Z`
- overall status was `fail`, which is useful evidence rather than a script bug:
  - `codesign_verify=fail` because the inspected app was not fully signed
  - `runtime_payload=fail` because the inspected bundle did not contain embedded
    runtime binaries or the default whispercpp model
  - checksum and packaged-preflight steps were correctly marked `skipped` once the
    payload gap was detected
  - the verifier writes `paths.env` with shell-escaped values so spaces in bundle paths remain recoverable
