# bd-2elo — Canonical test inventory and realism matrix

Date: 2026-03-07
Related bead: `bd-2elo`
Parent epic: `bd-204a`
Supporting inventory and policy sources:
- `docs/bd-5cz8-test-surface-inventory.md`
- `docs/bd-5cz8-test-surface-inventory.csv`
- `docs/bd-39i6-critical-path-test-realism-inventory.md`
- `docs/bd-39i6-critical-surface-coverage-matrix.md`
- `docs/bd-39i6-critical-surface-coverage-matrix.csv`
- `docs/bd-k993-coverage-claim-policy.md`
- `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`
- `docs/bd-2gw4-release-posture-and-build-context-parity.md`

## Purpose

This document is the canonical top-level answer to the question:

> What test and verification surfaces does Recordit actually have, how real are they, and what kinds of product or release claims are those lanes allowed to support?

It does **not** replace the detailed inventories and matrices listed above. Instead, it defines which existing artifacts are authoritative for each question, normalizes the vocabulary, and gives one consolidated realism matrix that future docs, runbooks, and release discussions can cite.

## Canonical source stack

Use the following source hierarchy instead of inventing one-off interpretations.

| Question | Canonical source | Why it is authoritative |
| --- | --- | --- |
| What test and verification files exist at all? | `docs/bd-5cz8-test-surface-inventory.md` and `docs/bd-5cz8-test-surface-inventory.csv` | exhaustive file-level inventory across Rust, Swift smoke, XCTest, XCUITest, shell, and Python surfaces |
| What is the strongest current lane for each critical journey or product surface? | `docs/bd-39i6-critical-surface-coverage-matrix.md` and `docs/bd-39i6-critical-surface-coverage-matrix.csv` | critical-path matrix with strongest-lane, realism, gap, and follow-on-bead fields |
| How should realism seams and overclaim risk be interpreted? | `docs/bd-39i6-critical-path-test-realism-inventory.md` and `docs/bd-k993-coverage-claim-policy.md` | defines conservative realism classes and the allowed terminology for truthful summaries |
| How should retained evidence be interpreted across shell, XCTest, and XCUITest lanes? | `docs/bd-2j49-cross-lane-e2e-evidence-standard.md` | unifies retained-evidence entrypoints without overstating realism |
| Which build or release context is authoritative for which type of claim? | `docs/bd-2gw4-release-posture-and-build-context-parity.md` | separates developer, packaged-local, and release-candidate proof |

Interpretation rule:
- if this document conflicts with a lower-level source on a concrete row or lane, the lower-level source wins
- if a future doc wants to summarize project coverage, it should cite this file and then drill into the lower-level source for the exact row or evidence root

## Canonical vocabulary

### Realism classes

Use these realism classes when describing the dominant seam in a lane:

- `mock`
- `fixture`
- `temp-filesystem`
- `packaged-app`
- `manual-user-journey`
- `live-real`
- `uncovered`

These are realism labels, not pass/fail labels.

### Claim levels

Use the claim vocabulary from `docs/bd-k993-coverage-claim-policy.md`:

- `logic-covered`
- `fixture-covered`
- `simulation-covered`
- `temp-filesystem integration-covered`
- `packaged-path verified`
- `real-environment verified`
- `partial`
- `uncovered`

Interpretation rule:
- realism says **how the lane works**
- claim level says **how strongly the result may be summarized**
- retained evidence richness says **how diagnosable the lane is**

Those three axes must not be collapsed into one marketing sentence.

## Snapshot of the current inventory baseline

The current canonical exhaustive inventory baseline comes from `docs/bd-5cz8-test-surface-inventory.md`.

### Current file-level counts

- total inventoried surfaces: **86**
- primary surfaces: **85**
- supporting harnesses: **1**
- category counts: rust inline **15**, rust external **26**, Swift smokes **29**, XCTest **1**, XCUITest **1**, Python tests **3**, shell harnesses **10**, Python harnesses **1**
- layer counts: unit **15**, integration **23**, scripted-e2e **8**, smoke **29**, XCTest **1**, XCUITest **1**, contract-test/harness **4**, release-script **5**
- realism counts: mock **18**, fixture **40**, temp-filesystem **9**, packaged-app **5**, live-real **14**

### What this baseline means

- the repo has broad verification breadth
- the Swift app layer still contains many preview-DI, scripted-runtime, or stub-backed seams
- the strongest packaged and retained-evidence lanes currently live in shell and app-level evidence drivers
- broad test counts must **not** be translated into blanket real-environment confidence

## Canonical lane-family matrix

This is the project’s canonical lane-family summary. It intentionally groups the inventory into stable families that humans can reason about quickly.

| Lane family | Representative surfaces | Dominant realism today | Strongest truthful claim today | Canonical retained evidence or source of truth | Main caution |
| --- | --- | --- | --- | --- | --- |
| Rust inline unit tests | `src/**/*.rs` test modules such as `src/live_capture.rs`, `src/bin/transcribe_live/preflight.rs`, `src/live_stream_runtime.rs` | mixed: `live-real`, `fixture`, `mock` | usually `logic-covered` or `fixture-covered` depending on row | source code plus file-level inventory in `docs/bd-5cz8-test-surface-inventory.csv` | broad logic signal, but not app-journey proof |
| Rust external integration and contract tests | `tests/*.rs` such as live-stream, CLI-contract, compatibility, and fault lanes | mostly `fixture` or `temp-filesystem` | `fixture-covered` or `temp-filesystem integration-covered` | `tests/*.rs` plus critical-path rows in `docs/bd-39i6-critical-surface-coverage-matrix.csv` | real binaries may run, but many lanes still rely on fake capture or frozen inputs |
| Swift smoke executables | `app/**/*_smoke.swift` across Preflight, AppShell, Services, ViewModels, Exports, Navigation, Accessibility, Integration | mostly `mock`, `fixture`, or `temp-filesystem` | usually `logic-covered`, `simulation-covered`, or `temp-filesystem integration-covered` | file-level inventory in `docs/bd-5cz8-test-surface-inventory.csv`; surface rows in `docs/bd-39i6-critical-surface-coverage-matrix.csv` | valuable subsystem proof, but generally not production app-shell proof |
| App-level XCTest | `app/RecorditAppTests/RecorditAppTests.swift` and `scripts/ci_recordit_xctest_evidence.sh` | mixed `mock`, `fixture`, with some stronger production-backed slices emerging | at best mixed: some rows are `logic-covered`, some are approaching `temp-filesystem integration-covered` | `artifacts/ci/xctest_evidence/<stamp>/contracts/xctest/summary.json` and `evidence_contract.json` | retained-rich evidence does not automatically mean production-real runtime behavior |
| App-level XCUITest and app-launched verification | `app/RecorditAppUITests/RecorditAppUITests.swift` and `scripts/ci_recordit_xctest_evidence.sh` | mainly `fixture` / scripted seams | `simulation-covered` | `artifacts/ci/xctest_evidence/<stamp>/contracts/xcuitest/summary.json`, `.xcresult`, and `lane_matrix.json` | `RECORDIT_UI_TEST_MODE`, scripted runtime/preflight, and runtime binary overrides still cap realism |
| Shell packaged-local verification | `scripts/verify_recordit_release_context.sh`, `scripts/gate_packaged_live_smoke.sh`, `scripts/gate_v1_acceptance.sh` | `packaged-app` with fixture-backed runtime behavior in some lanes | `packaged-path verified` | retained roots described by `docs/bd-2j49-cross-lane-e2e-evidence-standard.md` and `docs/bd-2gw4-release-posture-and-build-context-parity.md` | validates packaged payload/signing posture, but not full DMG install/open or true live device capture |
| Shell/XCTest/XCUITest evidence validators and renderers | `scripts/validate_e2e_evidence_contract.py`, `scripts/render_shell_e2e_evidence_contract.py`, `scripts/render_xctest_evidence_contract.py` and their tests | contract-focused, not user-flow realism | evidence-contract correctness, not product-journey proof | `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`, `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md`, `docs/bd-2grd-e2e-evidence-contract.md` | a perfect validator does not upgrade a simulated lane into a real-environment lane |
| Release runbooks and DMG instructions | `README.md`, `docs/bd-3p8a-release-context-matrix.md`, `scripts/create_recordit_dmg.sh` | `manual-user-journey` | `partial` unless backed by retained release evidence | `docs/bd-2gw4-release-posture-and-build-context-parity.md` | docs and build scripts define posture, but they are not execution evidence by themselves |

## Canonical critical-journey realism matrix

For product-level questions, treat the following rows as the project’s canonical summary baseline. The detailed strongest-lane data lives in `docs/bd-39i6-critical-surface-coverage-matrix.csv`.

| Surface | Current strongest lane family | Current realism ceiling | Strongest truthful summary today | Primary remaining gap |
| --- | --- | --- | --- | --- |
| first-run onboarding progression | Swift smoke + XCUITest + app tests | `fixture` / scripted seams | `simulation-covered` | no production-backed first-run path with actual packaged runtime/model resolution |
| permission remediation journey | Swift smoke + XCUITest | `fixture` | `simulation-covered` | no retained proof of a real TCC deny/regrant cycle in the app context |
| live readiness and gating semantics | Rust preflight + Swift preflight smokes | `fixture` | `fixture-covered` for mapping semantics | no end-to-end proof that the shipped app surfaces only Rust-authoritative readiness in a real runtime context |
| runtime binary and model readiness | smoke + XCTest + packaged release-context verification | `packaged-app` for payload posture; weaker inside app tests | mixed: `temp-filesystem integration-covered` for local logic and `packaged-path verified` for bundled payload posture | no single lane proves packaged app launch, runtime resolution, and first live start together |
| app-shell runtime lifecycle | integration smokes + view-model stop/finalization + UI automation | `temp-filesystem` | `temp-filesystem integration-covered` | no production-backed app-shell to actual runtime-process lane |
| visible live-run UI flow | XCUITest + app-level evidence driver | `fixture` | `simulation-covered` | current UI lane still depends on `RECORDIT_UI_TEST_MODE`, scripted runtime, and override seams |
| packaged local app path | shell packaged-local verification | `packaged-app` | `packaged-path verified` | no automated drag-install to first-launch to first-live-stop proof on an installed DMG artifact |
| release signing / notarization / Gatekeeper | docs and release runbooks | `manual-user-journey` until retained RC evidence exists | `partial` | requires retained release-candidate execution evidence |
| DMG install / mount / drag / open | build script + README instructions | `manual-user-journey` | `partial` | install-surface proof remains open until a retained verifier exists |

## Canonical interpretation rules

### 1. Inventory breadth does not equal realism depth

A high number of tests or smoke executables means the repo has verification surfaces, not that the whole product is real-environment verified.

### 2. Retained evidence quality does not upgrade realism

A lane can be extremely diagnosable and still remain `simulation-covered` or `fixture-covered`.

Examples:
- app-level XCUITest evidence is retained-rich today
- packaged shell evidence is also retained-rich today
- neither fact alone proves a complete unsimulated user journey

For app-level retained evidence specifically:
- `summary.json` phase counts are raw per-phase aggregates, not a second encoding of lane severity
- a lane may still aggregate to `warn` when an optional phase failed while all required phases passed, or when retry/flake metadata elevates a successful run into `warn`
- severity questions should therefore be answered from the lane contract rules and `overall_status`, not from phase-count fields alone

### 3. Developer, packaged-local, and release-candidate contexts must stay separate

Use the context separation from `docs/bd-2gw4-release-posture-and-build-context-parity.md`:

- developer context answers build, XCTest, XCUITest, and local debugging questions
- packaged-local context answers bundled payload, signing, and packaged launch-plan questions
- release-candidate context answers ship-readiness and Gatekeeper/notarization questions

No single lower context may be used to overclaim a higher context result.

### 4. XCUITest is currently app-launched, but not production-real

Current XCUITest lanes launch the app and retain `.xcresult` bundles, which is important. They still remain `simulation-covered` until the known bypasses are removed from the lane.

### 5. DMG and release claims remain incomplete until retained execution evidence exists

Build scripts, README instructions, and release runbooks are necessary posture documents. They do not count as equivalent proof that the full install or release journey has been executed and archived.

## How to use this matrix in future work

When someone asks “do we cover this?”, answer in this order:

1. identify the exact journey, subsystem, or release claim
2. consult `docs/bd-39i6-critical-surface-coverage-matrix.csv` for the strongest current lane
3. use `docs/bd-k993-coverage-claim-policy.md` to choose the strongest allowed wording
4. if the question is evidence-shape-specific, use `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`
5. if the question is build or release-context-specific, use `docs/bd-2gw4-release-posture-and-build-context-parity.md`
6. if a surface has no row or only broad file-level coverage, fall back to `docs/bd-5cz8-test-surface-inventory.csv` and classify it conservatively

## Immediate downstream implications

This canonical matrix keeps the next coverage and enforcement beads grounded:

- `bd-11vg` should use this source stack when publishing the broader gap report
- `bd-34yb` should treat the “critical-journey realism matrix” above as the baseline truth set for defining the comprehensive non-mock suite
- `bd-2ptr` should keep treating UI-test-mode-backed lanes as simulated until anti-bypass coverage exists
- `bd-13tm` and related evidence work should keep retained-evidence quality separate from realism elevation
- `bd-3co8` remains the main install-surface gap owner for DMG mount/install/open proof

## Decision

The canonical project answer is now:

- use `bd-5cz8` for exhaustive inventory
- use `bd-39i6` for strongest critical-surface coverage rows
- use `bd-k993` for claim wording
- use `bd-2j49` for retained-evidence interpretation
- use `bd-2gw4` for build and release-context authority

Any future statement about “coverage”, “verification”, or “readiness” should be traceable through that stack rather than improvised from a single test pass or one retained artifact root.
