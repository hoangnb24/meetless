# bd-1huk: Release Artifact Inspection and Evidence Bundle

Date: 2026-03-07
Related bead: `bd-1huk`
Parent feature: `bd-2gw4`
Upstream policy refs:
- `docs/bd-1mep-v1-release-posture.md`
- `docs/bd-3p8a-release-context-matrix.md`

## Goal

Provide one deterministic command that retains the release-artifact evidence needed
for the current v1 `Recordit.app` posture instead of relying on manually copied
codesign, DMG, and bundle-inspection logs.

## Canonical Command

```bash
make inspect-recordit-release-artifacts
```

Default evidence root:

```text
artifacts/ops/release-artifact-inspection/<timestamp>/
```

## What It Captures

1. `Xcode-built Recordit.app`
   - inventory for `.build/recordit-derived-data/Build/Products/<Configuration>/Recordit.app`
   - runtime payload presence and checksums
   - runtime payload parity against `dist/Recordit.app`

2. `dist/Recordit.app`
   - nested `scripts/verify_recordit_release_context.sh` evidence bundle
   - verbose signing / entitlements / `spctl` / runtime payload verification
   - packaged preflight using the embedded `recordit` binary

3. `Recordit.dmg`
   - `hdiutil imageinfo`
   - SHA-256 checksum log
   - `spctl --assess --type open` output when available
   - mounted root inventory
   - mounted `Recordit.app` inventory and runtime payload parity against `dist/Recordit.app`
   - explicit validation that the DMG root exposes the `Applications` alias

## Key Outputs

- `summary.csv`
- `summary.json`
- `checks.json`
- `status.txt`
- `paths.env`
- `dist_release_context/summary.csv`
- `artifacts/xcode_bundle_inventory.json`
- `artifacts/xcode_vs_dist_runtime_parity.json`
- `artifacts/dmg_root_inventory.json`
- `artifacts/dmg_vs_dist_runtime_parity.json`

## Why This Exists

Before `bd-1huk`, release inspection lived as a checklist made of separate shell
commands and manually copied logs. That was workable for one-off release runs, but
it was not a strong retained-evidence contract for future agents or CI-style
release validation.

This bead makes the release-artifact lane executable and repeatable without
changing the already-authoritative release-context verifier.
