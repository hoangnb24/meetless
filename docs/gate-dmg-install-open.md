# Gate: DMG Install Surface Verification

`gate_dmg_install_open.sh` implements the `bd-3co8` install-surface lane:

- mount a Recordit DMG in read-only mode
- verify root layout (`Recordit.app` + `Applications` symlink)
- copy/install the app into a deterministic destination
- attempt launch of the installed app
- retain machine-readable evidence using the shared e2e contract

## Command

```bash
make gate-dmg-install-open
```

Direct script usage:

```bash
scripts/gate_dmg_install_open.sh [options]
```

## Default Evidence Root

```text
artifacts/ops/gate_dmg_install_open/<timestamp>/
```

Contract files:

- `evidence_contract.json`
- `summary.csv`
- `summary.json`
- `status.txt`
- `paths.env`
- `validation.json`

Phase logs:

- `logs/build_app.*`
- `logs/build_dmg.*`
- `logs/attach_dmg.*`
- `logs/verify_layout.*`
- `logs/copy_install.*`
- `logs/open_installed_app.*`
- `logs/detach_dmg.*`

Primary retained artifacts:

- `artifacts/dmg_attach.plist`
- `artifacts/dmg_layout_report.txt`
- `artifacts/install_copy_report.txt`
- `artifacts/open_launch_report.txt`
- `artifacts/dmg_detach_report.txt`

## Key Options

- `--out-dir <path>`
- `--recordit-app-bundle <path>`
- `--recordit-dmg <path>`
- `--dmg-volname <name>`
- `--install-destination <path>`
- `--skip-build`
- `--skip-dmg-build`
- `--open-wait-sec <n>`
- `--keep-installed-app`

## Status Semantics

- Lane fails (`exit 1`) only when `status.txt` reports `status=fail`.
- Optional pre-steps (`--skip-build`, `--skip-dmg-build`) are retained as non-failing phase records.
- Required contract checks are enforced in the attach/layout/copy/open path.

## Example

```bash
scripts/gate_dmg_install_open.sh \
  --skip-build \
  --out-dir artifacts/ops/gate_dmg_install_open/local-smoke
```
