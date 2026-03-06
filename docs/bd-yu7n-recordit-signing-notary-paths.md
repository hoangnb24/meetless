# bd-yu7n: Retarget Signing/Notarization/Gatekeeper Paths to Recordit.app

Date: 2026-03-05
Related bead: `bd-yu7n`
Policy context: `docs/adr-005-recordit-default-entrypoint.md`

## Delivered

1. Retargeted beta release checklist signing/packaging commands to `Recordit.app`:
   - `docs/bd-b2qv-release-checklist.md`
   - Step B now uses `make sign-recordit-app` and `codesign ... dist/Recordit.app`
   - Step F DMG source folder now uses `dist/Recordit.app`
   - packaged gate pass criteria now explicitly includes `recordit_launch_semantics_ok=true`
2. Retargeted GA signing/notarization hardening plan app-path commands:
   - `docs/bd-1uik-ga-signing-notarization-plan.md`
   - Gate A now signs/verifies `dist/Recordit.app`
   - Gate B DMG source folder now uses `dist/Recordit.app`
3. Added README traceability entry:
   - `docs/bd-yu7n-recordit-signing-notary-paths.md`

## Acceptance Mapping

- "Signing/notarization/gatekeeper commands target Recordit.app artifact path":
  - canonical checklist/plan command blocks now point to `dist/Recordit.app`.
- "checklist evidence updated and validated on new path":
  - command execution evidence below confirms `Recordit.app` signing/verification and DMG creation from the new app path.

## Session Validation Evidence

Executed:

```bash
make sign-recordit-app SIGN_IDENTITY=-
codesign --verify --deep --strict --verbose=2 dist/Recordit.app
codesign -d --entitlements :- --verbose=2 dist/Recordit.app
hdiutil create -volname "Recordit Beta" -srcfolder dist/Recordit.app -ov -format UDZO dist/Recordit-bd-yu7n.dmg
shasum -a 256 dist/Recordit-bd-yu7n.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 dist/Recordit-bd-yu7n.dmg
```

Observed:

1. `make sign-recordit-app` succeeded and produced signed `dist/Recordit.app`.
2. `codesign --verify` reported:
   - `dist/Recordit.app: valid on disk`
   - `dist/Recordit.app: satisfies its Designated Requirement`
3. DMG was built from `dist/Recordit.app`:
   - `dist/Recordit-bd-yu7n.dmg` created successfully
4. `spctl` output was captured on the new DMG path (`rejected: source=no usable signature` on unsigned ad-hoc artifact is expected in this local non-notarized validation context).
