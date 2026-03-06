# bd-d987: Packaging Cutover Closeout (Recordit.app-First DMG)

## Feature Goal

Make `Recordit.app` the packaged default for DMG users while retaining `SequoiaTranscribe` strictly as compatibility/fallback runtime tooling.

## Parent-Child Completion Rollup

Verified closed child lanes:

- `bd-1gx5` (Recordit-first Makefile packaging targets)
- `bd-1msp` (packaged gate retarget to Recordit launch semantics)
- `bd-yu7n` (signing/notary/gatekeeper path retarget)
- `bd-slew` (DMG mount UX includes `Recordit.app` + `Applications`)
- `bd-vsix` (explicit no-arg SequoiaTranscribe guidance)
- `bd-13kc` (legacy path compatibility resolver shim)
- `bd-14y4` (non-default fallback policy)

## Verification Pass (Closeout Session)

```bash
make sign-recordit-app SIGN_IDENTITY=-
make verify-recordit-app
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-bd-d987.dmg RECORDIT_DMG_VOLNAME='Recordit Cutover'
```

Mounted DMG inspection:

```text
Applications -> /Applications
Recordit.app/
MOUNT_HAS_RECORDIT_APP=1
MOUNT_HAS_APPLICATIONS_SYMLINK=1
```

Packaged gate command path check:

```bash
make -n gate-packaged-live-smoke
```

Confirms gate invocation remains wired through `scripts/gate_packaged_live_smoke.sh` (which now resolves compatibility runtime path via `scripts/resolve_sequoiatranscribe_compat.sh`) while preserving `Recordit.app` launch-plan checks.

## Acceptance Assessment

`bd-d987` acceptance criteria are satisfied:

1. build/sign/verify flow is Recordit-first and operational
2. DMG surface is Recordit-first with explicit drag-to-Applications UX
3. SequoiaTranscribe remains compatibility-only (non-default), with explicit guidance and policy guardrails
4. packaged smoke lane still validates compatibility runtime contracts while proving Recordit-default launch semantics
