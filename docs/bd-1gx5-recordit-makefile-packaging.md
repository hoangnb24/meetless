# bd-1gx5: Recordit.app-First Makefile Packaging Targets

Date: 2026-03-05
Related bead: `bd-1gx5`
Policy context: `docs/adr-005-recordit-default-entrypoint.md`

## Delivered

1. Added Recordit-first packaging targets in `Makefile`:
   - `build-recordit-app`
   - `bundle-recordit-app`
   - `sign-recordit-app`
   - `verify-recordit-app`
   - `run-recordit-app`
2. Added deterministic Recordit build variables:
   - `RECORDIT_XCODE_PROJECT`
   - `RECORDIT_XCODE_SCHEME`
   - `RECORDIT_XCODE_CONFIGURATION`
   - `RECORDIT_DERIVED_DATA`
   - `RECORDIT_XCODE_DESTINATION`
3. Updated target help text so `Recordit.app` is the recommended packaged default path.
4. Kept `run-transcribe-app` and related selectors explicitly labeled as legacy compatibility/fallback lanes.

## Deterministic Command Chain

```bash
make build-recordit-app bundle-recordit-app sign-recordit-app verify-recordit-app
```

What this chain does:
1. Builds `RecorditApp` via `xcodebuild` into deterministic DerivedData.
2. Bundles `Recordit.app` into `dist/Recordit.app`.
3. Signs bundle with existing packaging entitlements.
4. Verifies signature and dumps effective entitlements.

## Session Validation Evidence

Executed in this session:

```bash
make build-recordit-app bundle-recordit-app sign-recordit-app verify-recordit-app
```

Observed result:
- `xcodebuild` completed successfully for `RecorditApp` (Release config)
- `dist/Recordit.app` was produced
- `codesign --verify --deep --strict --verbose=2 dist/Recordit.app` succeeded

## Notes

- This bead updates the packaging control plane only.
- Downstream beads still own DMG composition, notarization flow updates, and end-to-end release gate retargeting.
