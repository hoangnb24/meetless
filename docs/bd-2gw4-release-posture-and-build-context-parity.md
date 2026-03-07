# bd-2gw4 — Release posture and build-context parity

Date: 2026-03-06
Related bead: `bd-2gw4`
Primary release-posture decision: `docs/bd-1mep-v1-release-posture.md`
Primary build-system decision: `docs/bd-1nqb-build-system-strategy.md`
Supporting packaged/runtime docs:
- `docs/bd-1gx5-recordit-makefile-packaging.md`
- `docs/bd-1msp-packaged-gate-retarget.md`
- `docs/bd-8ic9-release-context-e2e-verifier.md`
- `docs/bd-yu7n-recordit-signing-notary-paths.md`

## Purpose

Lock one explicit answer to these questions for v1:

- what app posture are we shipping?
- which validation contexts are authoritative for which claims?
- which retained artifacts should future sessions trust first when build, packaging, signing, runtime, or release-posture questions arise?

This document is the parity layer between the accepted release-posture decision and the actual build/validation surfaces already present in the repo.

## Canonical v1 posture

For v1, the product posture is:

- user-facing artifact: `Recordit.app`
- distribution posture: DMG-distributed
- signing posture: Developer ID signed
- security posture: hardened runtime
- release expectation: notarized and Gatekeeper-validatable
- sandbox posture: **unsandboxed** for v1

Interpretation rule:
- Xcode is the canonical app build/test toolchain
- Xcode is **not** by itself the canonical release proof
- release claims must be anchored to packaged or release-candidate evidence, not only local Xcode success

## The three validation contexts

The repo currently needs three explicitly separate contexts.

### 1. Developer validation context

Primary use:
- iteration
- targeted UI/runtime debugging
- smoke checks
- XCTest/XCUITest development

Typical commands:
- `make build-recordit-app`
- `make run-recordit-app`
- `scripts/ci_recordit_xctest_evidence.sh`

Typical artifact posture:
- Xcode-derived build outputs
- app-level retained xctest/xcuitest roots under `artifacts/ci/xctest_evidence/<stamp>/...`

What this context is authoritative for:
- app-target compilation/build health
- app-level XCTest/XCUITest behavior
- onboarding/remediation/live-run UI flow evidence
- app responsiveness budget evidence
- targeted local debugging of runtime/model/startup issues

What this context is **not** authoritative for:
- final shipped signing posture
- final entitlements interpretation for the distributable artifact
- DMG packaging behavior
- notarization/Gatekeeper shipping claims
- packaged-runtime parity by itself

### 2. Packaged local validation context

Primary use:
- validating the built `dist/Recordit.app` posture on the machine that assembled it
- checking bundled runtime/model payloads, signing state, and packaged launch semantics

Typical commands:
- `make bundle-recordit-app`
- `make sign-recordit-app`
- `make verify-recordit-app`
- `scripts/verify_recordit_release_context.sh ...`
- `make gate-packaged-live-smoke`
- `make create-recordit-dmg ...`

Typical artifact posture:
- `dist/Recordit.app`
- packaged smoke roots under `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/...`
- release-context verifier roots under `artifacts/ops/release-context/...`

What this context is authoritative for:
- the shape and contents of `dist/Recordit.app`
- bundled runtime/model payload presence
- local codesign / entitlements capture / bundle inventory evidence
- packaged launch-plan semantics for `Recordit.app`
- embedded runtime preflight in packaged context

What this context is **not** authoritative for:
- final notarized Gatekeeper behavior of the shipped DMG
- drag-install → first launch → onboarding → first live stop as an installed-user journey unless a lane explicitly proves that path

### 3. Release-candidate validation context

Primary use:
- final shipping claims
- notarization, stapling, Gatekeeper, and RC-quality release inspection

Typical commands / lanes:
- release automation around DMG creation and notarization
- Gatekeeper-oriented verification and retained release evidence
- downstream RC/reporting lanes such as the notarization/signing plan and release-context inspection work

Typical artifact posture:
- notarized DMG and its retained release evidence
- retained codesign, notarization, and Gatekeeper logs

What this context is authoritative for:
- “ready to ship” claims
- notarized/distributable artifact posture
- Gatekeeper-facing acceptance evidence

What this context is **not** authoritative for:
- day-to-day product debugging when a local Xcode or packaged-local run already isolates the issue earlier in the funnel

## Authoritative evidence map

When a future session asks “what evidence should I trust first?”, use this table.

| Question | Trust this context first | Start here |
| --- | --- | --- |
| Did the app target build and do app-level tests behave? | developer validation | `artifacts/ci/xctest_evidence/<stamp>/contracts/lane_matrix.json` or the relevant xctest/xcuitest manifest |
| Did onboarding/remediation/live-run UI behavior regress? | developer validation | `artifacts/ci/xctest_evidence/<stamp>/contracts/xcuitest/summary.json` |
| Did responsiveness budgets regress? | developer validation | `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv` |
| Does `dist/Recordit.app` contain the expected runtime/model payload and signing posture? | packaged local validation | `scripts/verify_recordit_release_context.sh` retained root (`summary.csv`, `status.txt`, `paths.env`) |
| Does the packaged app lane preserve Recordit-default launch semantics and packaged smoke evidence? | packaged local validation | packaged smoke `summary.csv` / `status.txt` / `recordit_run_plan.log` |
| Are we validating the artifact we actually intend to ship? | packaged local validation, then release-candidate validation | release-context verifier root first, then RC/notarization evidence |
| Can we claim the shipped artifact is release-ready? | release-candidate validation | notarized DMG / Gatekeeper / stapling evidence |

## Build-context parity rules

To avoid reintroducing drift, future work must obey these rules.

### Rule 1: Do not equate Xcode success with release success

- `xcodebuild` success proves the app target can build/test in developer context
- it does not prove that `dist/Recordit.app` or the DMG artifact has the correct signed payload, entitlements, or release behavior

### Rule 2: Do not equate packaged-local proof with notarized release proof

- a local signed `dist/Recordit.app` is necessary and useful
- it is still earlier evidence than notarized DMG and Gatekeeper proof

### Rule 3: Use the right retained root for the question

- UI/app-behavior questions -> app-level xctest/xcuitest retained roots
- runtime/model/signing/payload questions -> packaged smoke or release-context verifier roots
- final shipping questions -> release-candidate/notarization evidence

### Rule 4: Keep compatibility lanes explicitly non-default

- `SequoiaTranscribe.app` and direct CLI lanes remain compatibility/support workflows
- they can provide useful diagnostics, but they are not the authoritative default-user release posture

## Canonical command chains

### Developer context

```bash
make build-recordit-app
scripts/ci_recordit_xctest_evidence.sh
```

Use when you need:
- app build/test confidence
- xctest/xcuitest retained evidence
- local iteration feedback

### Packaged local context

```bash
make build-recordit-app bundle-recordit-app sign-recordit-app verify-recordit-app
scripts/verify_recordit_release_context.sh --out-dir artifacts/ops/release-context/manual-$(date -u +%Y%m%dT%H%M%SZ)
make gate-packaged-live-smoke
```

Use when you need:
- `dist/Recordit.app` payload/signing verification
- packaged runtime/model parity evidence
- one retained packaged gate root that embeds release-context verification output
- Recordit-default packaged launch semantics

### Release-candidate context

```bash
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-local.dmg RECORDIT_DMG_VOLNAME='Recordit'
```

Then continue with the retained notarization / stapling / Gatekeeper flow owned by downstream release beads.

Use when you need:
- shipping-grade artifact validation
- DMG-oriented release evidence

## Current authoritative retained artifacts

### Developer context entrypoints

- `artifacts/ci/xctest_evidence/<stamp>/contracts/lane_matrix.json`
- `artifacts/ci/xctest_evidence/<stamp>/contracts/xctest/evidence_contract.json`
- `artifacts/ci/xctest_evidence/<stamp>/contracts/xcuitest/evidence_contract.json`
- `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv`

### Packaged local context entrypoints

- `artifacts/ops/release-context/<run>/summary.csv`
- `artifacts/ops/release-context/<run>/status.txt`
- `artifacts/ops/release-context/<run>/paths.env`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/recordit_run_plan.log`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/release_context_verification/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/release_context_verification/status.txt`

## What future agents should say plainly

Future docs, scripts, and reviews should be explicit about these distinctions:

- “passes in Xcode” is not the same claim as “packaged app posture is correct”
- “local signed bundle looks correct” is not the same claim as “notarized release artifact is ready”
- “compatibility CLI/app lane works” is not the same claim as “default Recordit.app user journey is validated”

If a future change blurs those boundaries, it should be treated as parity drift.
