# bd-3p8a: Release-Context Matrix and Executable Validation Runbook

Date: 2026-03-06
Related bead: `bd-3p8a`
Parent feature: `bd-2gw4`
Policy context: `docs/adr-005-recordit-default-entrypoint.md`

## Goal

Define one executable validation matrix for the three release contexts that matter in this repository:

1. **Dev/Xcode validation** — prove the app target, embedded runtime inputs, and app-level test lanes are healthy during active development.
2. **Packaged local validation** — prove `dist/Recordit.app` is the default packaged app path and that local signed artifacts still satisfy current runtime acceptance checks.
3. **Release-candidate / notarized validation** — prove the distribution artifact is signed, notarized, stapled, Gatekeeper-assessed, and backed by retained runtime/reliability evidence.

This matrix exists to prevent context drift. A command that is appropriate in one context must not be mistaken for proof in a stronger context.

## Scope Rules

### Canonical default

- `Recordit.app` is the user-facing default app path.
- `run-recordit-app` / `dist/Recordit.app` are the canonical packaged launch semantics.

### Compatibility-only lane

- `run-transcribe-app` and related `SequoiaTranscribe.app` wrappers remain compatibility/fallback diagnostics.
- They can contribute supporting runtime evidence, but they do **not** replace `Recordit.app` as the packaged default.

### Evidence discipline

- Every validation context must write to deterministic artifact paths.
- Stronger contexts build on weaker-context expectations, but each context still has its own explicit command and evidence contract.
- RC/GA sign-off requires retained evidence, not just terminal success.

## Release-Context Matrix

| Context | Primary question answered | Canonical commands | Required pass signals | Evidence roots |
|---|---|---|---|---|
| Dev/Xcode validation | Does the app target build correctly, wire runtime inputs correctly, and pass app-level XCTest/XCUITest evidence lanes? | `make build-recordit-app`; `scripts/ci_recordit_xctest_evidence.sh` | `xcodebuild` succeeds; app-level summaries exist; responsiveness rows are present in summary artifacts | `.build/recordit-derived-data/`; `artifacts/ci/xctest_evidence/<stamp>/`; `artifacts/ci/xctest_evidence/<stamp>/derived_data/` |
| Packaged local validation | Does the local packaged app path produce a signed `dist/Recordit.app`, preserve default launch semantics, and satisfy packaged smoke/runtime checks? | `make bundle-recordit-app sign-recordit-app verify-recordit-app`; `make gate-packaged-live-smoke`; `make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-local.dmg RECORDIT_DMG_VOLNAME='Recordit'` | `codesign --verify` passes on `dist/Recordit.app`; packaged smoke summary reports `recordit_launch_semantics_ok=true` and `gate_pass=true`; DMG is created from `dist/Recordit.app` | `dist/Recordit.app`; `dist/Recordit-local.dmg`; `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<stamp>/` |
| Release-candidate / notarized validation | Is the distributable DMG signed, notarized, stapled, Gatekeeper-assessed, and backed by retained release evidence? | `make sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY"`; `scripts/create_recordit_dmg.sh --app ... --output ... --volname ...`; `codesign --force --sign "$SIGN_IDENTITY" ...dmg`; `xcrun notarytool submit ... --wait`; `xcrun stapler staple`; `spctl --assess ...`; plus required runtime gates | app signature valid; DMG signature valid; notarization `status=Accepted`; stapler validate passes; `spctl` passes; required gates/reliability evidence pass | `artifacts/releases/ga/<tag>/` with `logs/`, `packaging/`, `notary/`, `gates/`, `release/` |

## Context A — Dev/Xcode Validation

Use this context while actively developing the app target or Swift/Rust integration seams.

### Commands

```bash
make build-recordit-app
scripts/ci_recordit_xctest_evidence.sh
```

### What this context proves

1. `RecorditApp` builds through the Xcode project/scheme path.
2. Prebuilt runtime inputs are prepared before the app build.
3. App-level XCTest/XCUITest evidence lanes can emit deterministic summaries.

### Expected outputs

1. `make build-recordit-app` DerivedData under:
   - `.build/recordit-derived-data/`
2. `scripts/ci_recordit_xctest_evidence.sh` evidence under:
   - `artifacts/ci/xctest_evidence/<stamp>/status.csv`
   - `artifacts/ci/xctest_evidence/<stamp>/summary.csv`
   - `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv`
   - `artifacts/ci/xctest_evidence/<stamp>/derived_data/`

### Pass criteria

1. `make build-recordit-app` exits `0`.
2. `scripts/ci_recordit_xctest_evidence.sh` emits a deterministic evidence folder.
3. `summary.csv` includes responsiveness gate rows:
   - `threshold_first_stable_transcript_budget_ok`
   - `threshold_stop_to_summary_budget_ok`
   - `responsiveness_gate_pass`

### Not sufficient for

- DMG distribution proof
- notarization/Gatekeeper proof
- final release sign-off

## Context B — Packaged Local Validation

Use this context after app-target changes that affect packaging, signing, launch semantics, or packaged smoke behavior.

### Commands

```bash
make bundle-recordit-app sign-recordit-app verify-recordit-app
make gate-packaged-live-smoke
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-local.dmg RECORDIT_DMG_VOLNAME='Recordit'
```

### Supporting checks

```bash
codesign --verify --deep --strict --verbose=2 dist/Recordit.app
codesign -d --entitlements :- --verbose=2 dist/Recordit.app
```

### What this context proves

1. `dist/Recordit.app` is the packaged default artifact path.
2. Local signing/verification works on the packaged app.
3. The packaged smoke gate still enforces `Recordit.app` launch semantics while retaining compatibility runtime checks.
4. DMG assembly uses `dist/Recordit.app` as the source bundle.

### Expected outputs

1. Packaged app:
   - `dist/Recordit.app`
2. Local DMG:
   - `dist/Recordit-local.dmg`
3. Packaged smoke evidence:
   - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<stamp>/summary.csv`
   - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<stamp>/status.txt`
   - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<stamp>/recordit_run_plan.log`

### Required pass signals

From app verification:

1. `codesign --verify` reports a valid signature for `dist/Recordit.app`.
2. Effective entitlements can be dumped and retained.

From packaged smoke `summary.csv`:

1. `recordit_launch_semantics_ok=true`
2. `runtime_first_stable_emit_ok=true`
3. `runtime_transcript_surface_ok=true`
4. `runtime_terminal_live_mode_ok=true`
5. `gate_pass=true`

### Not sufficient for

- notarization acceptance
- stapled distribution proof
- GA publication approval

## Context C — Release-Candidate / Notarized Validation

Use this context only for release-candidate or GA-grade distribution proof.

### Environment setup

```bash
export RELEASE_TAG="v0.1.0-rc.1"
export EVIDENCE_ROOT="artifacts/releases/ga/${RELEASE_TAG}"
export SIGN_IDENTITY="Developer ID Application: <team>"
export NOTARY_PROFILE="<keychain-profile>"
mkdir -p "${EVIDENCE_ROOT}"/{logs,packaging,notary,gates,release}
```

### Commands

```bash
make sign-recordit-app SIGN_IDENTITY="$SIGN_IDENTITY" | tee "${EVIDENCE_ROOT}/logs/sign-recordit-app.log"
codesign --verify --deep --strict --verbose=2 dist/Recordit.app | tee "${EVIDENCE_ROOT}/logs/codesign-verify-app.log"
codesign -d --entitlements :- --verbose=2 dist/Recordit.app > "${EVIDENCE_ROOT}/logs/codesign-entitlements-app.plist" 2>&1

DMG_NAME="Recordit-${RELEASE_TAG}.dmg"
scripts/create_recordit_dmg.sh \
  --app "dist/Recordit.app" \
  --output "dist/${DMG_NAME}" \
  --volname "Recordit" | tee "${EVIDENCE_ROOT}/packaging/create-recordit-dmg.log"

codesign --force --sign "$SIGN_IDENTITY" "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/codesign-dmg.log"
codesign --verify --verbose=2 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/codesign-verify-dmg.log"
shasum -a 256 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/packaging/${DMG_NAME}.sha256"

xcrun notarytool submit "dist/${DMG_NAME}" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait \
  --output-format json | tee "${EVIDENCE_ROOT}/notary/notary-submit.json"

SUBMISSION_ID="$(jq -r '.id' "${EVIDENCE_ROOT}/notary/notary-submit.json")"
xcrun notarytool log "$SUBMISSION_ID" \
  --keychain-profile "$NOTARY_PROFILE" > "${EVIDENCE_ROOT}/notary/notary-log.json"

xcrun stapler staple "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/stapler-staple.log"
xcrun stapler validate "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/stapler-validate.log"
spctl --assess --type open --context context:primary-signature --verbose=4 "dist/${DMG_NAME}" | tee "${EVIDENCE_ROOT}/notary/spctl-assess.log"

make gate-packaged-live-smoke | tee "${EVIDENCE_ROOT}/gates/gate-packaged-live-smoke.log"
make gate-v1-acceptance | tee "${EVIDENCE_ROOT}/gates/gate-v1-acceptance.log"
make gate-backlog-pressure | tee "${EVIDENCE_ROOT}/gates/gate-backlog-pressure.log"
make gate-transcript-completeness | tee "${EVIDENCE_ROOT}/gates/gate-transcript-completeness.log"
br show bd-2n4m --json | tee "${EVIDENCE_ROOT}/gates/bd-2n4m-status.json"
```

### What this context proves

1. The release app and DMG are signed with the intended identity.
2. The distributable DMG preserves the repo's drag-to-Applications install surface before signing/notarization.
3. The DMG is notarized and stapled.
4. Gatekeeper accepts the distribution artifact.
5. Runtime/reliability gates still pass on the release candidate.
6. Evidence required for release sign-off is retained in one root.

### Required pass signals

1. `codesign --verify` succeeds for both `dist/Recordit.app` and the DMG.
2. `notary-submit.json` reports `status=Accepted`.
3. `stapler validate` exits `0`.
4. `spctl --assess` passes for the DMG.
5. Runtime/reliability gates emit pass envelopes.
6. `bd-2n4m` is `closed` before GA sign-off.

### Mandatory retained evidence

1. `${EVIDENCE_ROOT}/logs/`
2. `${EVIDENCE_ROOT}/packaging/`
3. `${EVIDENCE_ROOT}/notary/`
4. `${EVIDENCE_ROOT}/gates/`
5. `${EVIDENCE_ROOT}/release/`

## Decision Rules

### If you are validating active development work

Use **Context A** first.

### If you changed packaging/signing/default-launch behavior

Use **Context B** and do not treat Context A alone as sufficient proof.

### If you are preparing a distributable artifact or release sign-off

Use **Context C**. No weaker context can substitute for notarization + Gatekeeper evidence.

## Anti-Drift Rules

1. Do not cite `run-transcribe-app` as proof of the default packaged launch path.
2. Do not cite ad-hoc local signing as proof of notarized release readiness.
3. Do not cite Xcode build success alone as proof of packaged runtime behavior.
4. Do not publish a release candidate without retained evidence under one canonical release root.
5. When a stronger context fails, reopen the issue in that stronger context rather than downgrading the claim to a weaker lane.

## Downstream Unblock Mapping

This runbook provides the release-context vocabulary needed by:

1. `bd-1huk` — release artifact inspection and evidence capture
2. `bd-1vo3` — Gatekeeper/notarization expectation clarification

It also supports broader `bd-2gw4` work by making context-specific proof explicit instead of implicit.
