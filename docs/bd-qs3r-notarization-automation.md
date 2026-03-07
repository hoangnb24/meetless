# bd-qs3r: Automated DMG Notarization + Stapling + Gatekeeper Evidence

`bd-qs3r` adds a single scripted release-finalization path for distributable DMGs:

- submit to Apple notarization and wait for verdict
- staple the ticket onto the DMG and validate it
- run Gatekeeper assessment against the stapled artifact
- retain machine-readable evidence for CI/release review

## Canonical Command

```bash
make notarize-recordit-dmg \
  RECORDIT_DMG_NAME=Recordit.dmg \
  RECORDIT_DMG_VOLNAME=Recordit \
  SIGN_IDENTITY="Developer ID Application: <Team Name> (<TeamID>)" \
  NOTARY_PROFILE="recordit-notary"
```

Direct script invocation is also supported:

```bash
scripts/notarize_recordit_release_dmg.sh \
  --recordit-dmg dist/Recordit.dmg \
  --sign-identity "Developer ID Application: <Team Name> (<TeamID>)" \
  --notary-profile recordit-notary
```

## Output Contract

Default evidence root:

- `artifacts/releases/notary/<utc-stamp>/`

Retained artifacts:

- `summary.csv` / `summary.json` / `checks.json`
- `status.txt`
- `paths.env`
- `logs/*.log`
- `packaging/dmg.sha256`
- `notary/notary-submit.json`
- `notary/notary-outcome.json`
- `notary/notary-log.json`
- `notary/failure-signatures.json`

## Useful Flags

- `SKIP_DMG_BUILD=1` or `--skip-dmg-build`: reuse an existing DMG
- `ALLOW_SPCTL_FAILURE=1` or `--allow-spctl-failure`: record Gatekeeper failure as `warn` instead of `fail`

## Acceptance-Criteria Mapping

1. Scripted notarization path with `notarytool submit --wait`: `notary_submit` + `notary_status` checks.
2. Automatic stapling + validation: `stapler_staple` + `stapler_validate` checks.
3. Gatekeeper assessment on the distributable DMG: `spctl_assess` check.
4. Retained release evidence including submission ID/status and failure signatures: `notary-outcome.json`, `summary.csv`, `failure-signatures.json`.
