# bd-b2qv: Release Checklist for GitHub DMG Beta Lane

Date: 2026-03-05  
Status: active checklist for beta release operations (`bd-twiz`)

## Superseded Entrypoint Context (2026-03-05)

Canonical user-facing default is now `Recordit.app` per
`docs/adr-005-recordit-default-entrypoint.md`.

This checklist uses `Recordit.app` artifact paths for canonical packaging/signing/
Gatekeeper checks. Compatibility `SequoiaTranscribe.app` runtime lanes remain
available for fallback diagnostics only.

## 1. Purpose

Define a deterministic, auditable beta release checklist for publishing Recordit via GitHub Releases as a DMG artifact.

This checklist is the required input for:
1. `bd-3b1j` (rollback/support runbook)
2. `bd-1uik` (GA signing/notarization hardening)

Contract mapping reference:
- `docs/bd-dk69-product-contract-matrix.md`

## 2. Policy Summary (Beta vs GA)

1. Beta minimum:
   - GitHub Release DMG is required.
   - Reliability gates and packaged smoke evidence are required.
   - Signing/notarization are strongly recommended.
2. GA target:
   - Developer ID signing + notarization are mandatory.

Reference: `plan/recordit-user-interfaces-journey.md` (Decision Log, distribution lane).

## 3. Evidence Root and Naming Contract

Set one canonical evidence root per release tag:

```bash
export RELEASE_TAG="v0.1.0-beta.1"
export EVIDENCE_ROOT="artifacts/releases/github-dmg-beta/${RELEASE_TAG}"
mkdir -p "${EVIDENCE_ROOT}"/{logs,gates,packaging,release,waivers}
```

Required artifact naming:
1. DMG filename: `Recordit-${RELEASE_TAG}.dmg`
2. SHA-256 file: `Recordit-${RELEASE_TAG}.dmg.sha256`
3. Release summary file: `${EVIDENCE_ROOT}/release/release-summary.md`

## 4. Pre-Release Gate Checklist

## Step A - Baseline Build/Model Readiness

```bash
make setup-whispercpp-model | tee "${EVIDENCE_ROOT}/logs/setup-whispercpp-model.log"
```

Pass criteria:
1. command exits `0`
2. model path/sha/size emitted

## Step B - Signed Recordit App Packaging and Verification

```bash
make sign-recordit-app SIGN_IDENTITY=- | tee "${EVIDENCE_ROOT}/logs/sign-recordit-app.log"
codesign --verify --deep --strict --verbose=2 dist/Recordit.app | tee "${EVIDENCE_ROOT}/logs/codesign-verify.log"
codesign -d --entitlements :- --verbose=2 dist/Recordit.app > "${EVIDENCE_ROOT}/logs/codesign-entitlements.plist" 2>&1
```

Pass criteria:
1. `codesign --verify` reports valid signature
2. entitlements file is captured

## Step C - Packaged Live Smoke Gate

```bash
make gate-packaged-live-smoke | tee "${EVIDENCE_ROOT}/logs/gate-packaged-live-smoke.log"
PACKAGED_GATE_DIR="$(ls -td ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/* | head -1)"
cp "${PACKAGED_GATE_DIR}/summary.csv" "${EVIDENCE_ROOT}/gates/packaged-live-smoke.summary.csv"
cp "${PACKAGED_GATE_DIR}/status.txt" "${EVIDENCE_ROOT}/gates/packaged-live-smoke.status.txt"
```

Pass criteria from `packaged-live-smoke.summary.csv`:
1. `recordit_launch_semantics_ok=true`
2. `runtime_first_stable_emit_ok=true`
3. `runtime_transcript_surface_ok=true`
4. `runtime_terminal_live_mode_ok=true`
5. `gate_pass=true`

## Step D - Contract/Reliability Gates

```bash
make gate-backlog-pressure | tee "${EVIDENCE_ROOT}/logs/gate-backlog-pressure.log"
make gate-v1-acceptance | tee "${EVIDENCE_ROOT}/logs/gate-v1-acceptance.log"
make gate-transcript-completeness | tee "${EVIDENCE_ROOT}/logs/gate-transcript-completeness.log"
```

Pass criteria:
1. each gate status file reports `status=pass`
2. each summary reports `gate_pass=true`

## Step E - Soak Gate Dependency Closure (`bd-2n4m`)

This beta lane cannot be marked release-ready until the 10-session no-restart soak dependency is closed.

```bash
br show bd-2n4m --json | tee "${EVIDENCE_ROOT}/gates/bd-2n4m-status.json"
```

Pass criteria:
1. `bd-2n4m` status is `closed`
2. associated soak report path is recorded in `${EVIDENCE_ROOT}/release/release-summary.md`

## 5. DMG Build, Verification, and Packaging Evidence

## Step F - Build DMG Artifact

```bash
DMG_NAME="Recordit-${RELEASE_TAG}.dmg"
hdiutil create \
  -volname "Recordit Beta" \
  -srcfolder dist/Recordit.app \
  -ov -format UDZO \
  "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/hdiutil-create.log"
```

Pass criteria:
1. DMG file exists at `dist/${DMG_NAME}`
2. `hdiutil create` exits `0`

## Step G - Hash and Gatekeeper Assessment

```bash
shasum -a 256 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/${DMG_NAME}.sha256"
spctl --assess --type open --context context:primary-signature --verbose=4 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/spctl-dmg.log"
```

Pass criteria:
1. SHA-256 is recorded
2. `spctl` output is captured (pass for signed artifacts, explicit waiver required otherwise)

## 6. GitHub Release Publication Checklist

## Step H - Draft GitHub Release with DMG

```bash
gh release create "${RELEASE_TAG}" "dist/${DMG_NAME}" \
  --title "Recordit ${RELEASE_TAG}" \
  --notes-file "${EVIDENCE_ROOT}/release/release-summary.md" \
  --draft | tee "${EVIDENCE_ROOT}/release/gh-release-create.log"
gh release view "${RELEASE_TAG}" --json url,assets | tee "${EVIDENCE_ROOT}/release/gh-release-view.json"
```

Pass criteria:
1. draft release URL is present
2. DMG asset appears in release assets

## Step I - Release Notes Minimum Contents

`release-summary.md` must include:
1. commit SHA
2. completed gate list + links to evidence files
3. known limitations for beta users
4. rollback contact and issue-report path

## 7. Owner Sign-Off Matrix

All rows must be completed before publishing from draft to public:

| Area | Owner | Required status | Evidence |
|---|---|---|---|
| Packaging/signing | Release owner | PASS | `logs/sign-recordit-app.log`, `logs/codesign-verify.log` |
| Runtime gate health | QA owner | PASS | `gates/*.summary.csv`, `gates/*.status.txt` |
| Soak dependency (`bd-2n4m`) | Reliability owner | PASS | `gates/bd-2n4m-status.json` + soak report link |
| GitHub release asset integrity | Release owner | PASS | `packaging/*.sha256`, `release/gh-release-view.json` |
| Support handoff readiness | Support owner | PASS | release notes include support path |

## 8. Beta Waiver Protocol (When Signing/Notarization Is Missing)

If signing/notarization is not available for this beta release, add `${EVIDENCE_ROOT}/waivers/signing-notarization-waiver.md` with:
1. reason
2. risk statement
3. compensating controls
4. approver name/date

No public release publication without an explicit waiver file when `spctl` fails.

## 9. Completion Criteria for `bd-b2qv`

`bd-b2qv` is complete when:
1. this checklist exists in-repo
2. commands and evidence paths are concrete and executable
3. owner sign-off criteria are explicit
4. soak dependency gate requirement (`bd-2n4m`) is encoded as a mandatory input
