# bd-1uik: GA Hardening Plan for Signing and Notarization

Date: 2026-03-05  
Status: active GA plan (mandatory for public GA release)

## 1. Purpose

Define the mandatory GA release gates for:
1. Developer ID signing
2. Apple notarization
3. post-notarization verification and evidence retention

This plan is the GA follow-on to `docs/bd-b2qv-release-checklist.md` (beta lane).

## 2. GA Policy

GA publication is blocked unless all of the following are true:
1. signed app bundle passes `codesign --verify --deep --strict`
2. distributable DMG is signed
3. DMG notarization is accepted by Apple
4. DMG is stapled and stapler validation passes
5. Gatekeeper assessment passes on stapled DMG
6. required runtime/reliability gates pass

No waiver path exists for GA signing/notarization failures.

## 3. Roles and Accountability

| Role | Responsibility |
|---|---|
| Release Owner | Executes packaging/signing/notarization pipeline |
| Security Owner | Verifies signing identity, entitlements, notarization acceptance |
| QA Owner | Confirms runtime gate evidence and artifact integrity |
| Support Owner | Confirms rollback packet and support triage inputs |

All four roles must sign off before moving a GA release from draft to public.

## 4. Prerequisites

1. macOS host with Xcode command-line tools
2. Apple Developer team access (Developer ID certificate installed)
3. Notary credentials stored in keychain profile (one-time setup):

```bash
xcrun notarytool store-credentials "recordit-notary" \
  --apple-id "<apple-id>" \
  --team-id "<team-id>" \
  --password "<app-specific-password>"
```

4. Required environment variables:

```bash
export RELEASE_TAG="v1.0.0"
export SIGN_IDENTITY="Developer ID Application: <Organization> (<TEAMID>)"
export NOTARY_PROFILE="recordit-notary"
export EVIDENCE_ROOT="artifacts/releases/ga/${RELEASE_TAG}"
mkdir -p "${EVIDENCE_ROOT}"/{logs,packaging,notary,gates,release}
```

## 5. Mandatory GA Gates

## Gate A - Build and Sign App Bundle

```bash
make sign-recordit-app SIGN_IDENTITY="${SIGN_IDENTITY}" | tee "${EVIDENCE_ROOT}/logs/sign-recordit-app.log"
codesign --verify --deep --strict --verbose=2 dist/Recordit.app | tee "${EVIDENCE_ROOT}/logs/codesign-verify-app.log"
codesign -d --entitlements :- --verbose=2 dist/Recordit.app > "${EVIDENCE_ROOT}/logs/codesign-entitlements-app.plist" 2>&1
```

Pass criteria:
1. signing command exits `0`
2. verify command reports valid signature
3. entitlements snapshot is archived

## Gate B - Build and Sign DMG

```bash
DMG_NAME="Recordit-${RELEASE_TAG}.dmg"
hdiutil create \
  -volname "Recordit" \
  -srcfolder dist/Recordit.app \
  -ov -format UDZO \
  "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/hdiutil-create.log"

codesign --force --sign "${SIGN_IDENTITY}" "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/codesign-dmg.log"
codesign --verify --verbose=2 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/codesign-verify-dmg.log"
shasum -a 256 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/${DMG_NAME}.sha256"
```

Pass criteria:
1. DMG exists and is signed
2. DMG verify command exits `0`
3. SHA-256 is recorded

## Gate C - Submit for Notarization and Capture Result

```bash
xcrun notarytool submit "dist/${DMG_NAME}" \
  --keychain-profile "${NOTARY_PROFILE}" \
  --wait \
  --output-format json | tee "${EVIDENCE_ROOT}/notary/notary-submit.json"

SUBMISSION_ID="$(jq -r '.id' "${EVIDENCE_ROOT}/notary/notary-submit.json")"
xcrun notarytool log "${SUBMISSION_ID}" \
  --keychain-profile "${NOTARY_PROFILE}" > "${EVIDENCE_ROOT}/notary/notary-log.json"
```

Pass criteria:
1. submit result has `status=Accepted`
2. notarization log is archived

## Gate D - Staple and Validate

```bash
xcrun stapler staple "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/stapler-staple.log"
xcrun stapler validate "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/stapler-validate.log"
spctl --assess --type open --context context:primary-signature --verbose=4 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/spctl-assess.log"
```

Pass criteria:
1. stapler operations exit `0`
2. Gatekeeper assessment passes

## Gate E - Runtime and Reliability Evidence

```bash
make gate-packaged-live-smoke | tee "${EVIDENCE_ROOT}/gates/gate-packaged-live-smoke.log"
make gate-v1-acceptance | tee "${EVIDENCE_ROOT}/gates/gate-v1-acceptance.log"
make gate-backlog-pressure | tee "${EVIDENCE_ROOT}/gates/gate-backlog-pressure.log"
make gate-transcript-completeness | tee "${EVIDENCE_ROOT}/gates/gate-transcript-completeness.log"
br show bd-2n4m --json | tee "${EVIDENCE_ROOT}/gates/bd-2n4m-status.json"
```

Pass criteria:
1. all gate runs report pass envelopes
2. reliability bead `bd-2n4m` is `closed`

## 6. Failure Rollback and No-Go Criteria

Any single failure below is an immediate no-go for GA publication:
1. signing failure or signature verification failure for app/DMG
2. notarization status not `Accepted`
3. stapler or Gatekeeper assessment failure
4. required runtime/reliability gate failure
5. missing evidence artifacts for executed steps

Rollback actions on no-go:
1. keep release as draft/unpublished
2. post incident summary with failing step and log paths
3. open/track fix bead(s) before reattempt
4. rerun full Gate A-E sequence after fix (no partial rerun for GA sign-off)

## 7. Evidence Retention Requirements

Required retained files under `${EVIDENCE_ROOT}`:
1. all command logs from Gates A-E
2. DMG hash file
3. notarization submit/log JSON
4. final GA sign-off checklist with role approvals

Retention rule:
1. keep GA release evidence for minimum 12 months
2. keep links to evidence from GitHub Release notes

## 8. GA Sign-Off Checklist

| Gate | Release Owner | Security Owner | QA Owner | Support Owner | Evidence Path |
|---|---|---|---|---|---|
| A. App signing verified | [ ] | [ ] | [ ] | n/a | `logs/codesign-verify-app.log` |
| B. DMG signed + hashed | [ ] | [ ] | [ ] | n/a | `packaging/codesign-verify-dmg.log` |
| C. Notarization accepted | [ ] | [ ] | n/a | n/a | `notary/notary-submit.json` |
| D. Staple + Gatekeeper pass | [ ] | [ ] | [ ] | n/a | `notary/stapler-validate.log`, `notary/spctl-assess.log` |
| E. Runtime/reliability gates pass | [ ] | n/a | [ ] | [ ] | `gates/*.log`, `gates/bd-2n4m-status.json` |
| Release notes + rollback path | [ ] | [ ] | [ ] | [ ] | `release/release-summary.md` |

GA publication cannot proceed until all non-`n/a` cells are checked.
