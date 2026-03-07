# bd-2j49 — Cross-lane retained-evidence standard

Date: 2026-03-06
Related bead: `bd-2j49`
Shared root contract: `docs/bd-2grd-e2e-evidence-contract.md`
Shell/scripted specialization: `docs/bd-8ydu-shell-e2e-evidence-contract.md`
XCTest/XCUITest specialization: `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md`
Current app-level matrix slice: `docs/bd-13pv-xctest-xcuitest-app-launched-matrix.md`

## Purpose

Define one truthful cross-lane standard for retained end-to-end verification evidence so shell-based gates, packaged-app checks, XCTest, XCUITest, and current app-launched verification all produce diagnosable outputs that can be consumed consistently by validators, CI, runbooks, and future triage tools.

This document does **not** replace the shared root contract from `bd-2grd` or the lane-family specializations from `bd-8ydu` and `bd-1ff5`. It specifies how those pieces fit together into one project-wide standard.

## Standard stack

The retained-evidence standard is intentionally layered:

1. **Shared root contract** — every conforming lane must satisfy `docs/bd-2grd-e2e-evidence-contract.md`
2. **Lane-family specialization** — shell/scripted lanes follow `docs/bd-8ydu-shell-e2e-evidence-contract.md`; XCTest/XCUITest/app-launched lanes follow `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md`
3. **Lane-specific implementation docs** — individual beads may document a producer surface, but they must not contradict the two layers above

Interpretation rule:
- if a lane-specific producer doc disagrees with the shared root contract, the shared contract wins
- if a producer doc adds lane-family details without contradicting the root contract, that specialization is the authoritative detail for that lane family

## Supported lane families

The current standard recognizes these retained lane families:

| Lane family | `lane_type` values | Typical producers | Primary retained deep evidence |
| --- | --- | --- | --- |
| shell/scripted e2e | `shell-e2e`, `packaged-e2e`, `hybrid-e2e` | `scripts/gate_*`, `scripts/verify_*`, future default-user-journey scripts | `logs/`, `artifacts/`, optional copied bundles |
| app-level `xcodebuild` verification | `xctest-evidence`, `xcuitest-evidence` | `scripts/ci_recordit_xctest_evidence.sh` | lane manifests under `contracts/`, `.xcresult/`, retained step logs |

Truthful current note:
- app-launched verification is currently represented through `xcuitest-evidence`, not a third standalone lane type

## Required traceability chain

Every retained failure or warning must be traceable through the same chain, regardless of lane family:

1. **run root** — the retained evidence root directory for one execution
2. **summary surface** — the first file a human or machine opens to understand lane-level status
3. **phase row / manifest entry** — the exact phase that failed, warned, skipped, or retried
4. **deep evidence** — logs, artifacts, result bundles, screenshots, manifests, or copied diagnostics
5. **path context** — `paths.env` entries explaining which concrete paths and inputs produced the retained result

If a lane cannot support that chain, it is not yet compliant with the standard.

## Summary-surface standard

The project should expose a small, predictable set of summary surfaces.

### Single-lane roots

Every single-lane root must retain:

- `status.txt` for quick human inspection
- `summary.csv` for compact per-phase tabular scanning
- `summary.json` for machine-readable aggregate consumption
- `evidence_contract.json` for full-fidelity retained manifest data

### Multi-lane roots

When one producer run emits multiple lane manifests from a single retained root, it must additionally expose a lane index.

Current truthful example:
- `scripts/ci_recordit_xctest_evidence.sh` emits `contracts/lane_matrix.json`
- `contracts/lane_matrix.json` is the first cross-lane summary surface for that retained root
- each row in that index points to a lane-local `summary.json` and `evidence_contract.json`

Standard rule:
- multi-lane roots must provide one machine-readable lane index that points to every retained lane manifest under that root
- consumers should treat the lane index as the root entrypoint and the lane-local summary/manifest pair as the next hop

## Trace-to-artifact rules

To make failures diagnosable without ad-hoc reruns, every lane family must support the following trace pattern.

### Shell/scripted lanes

Minimum trace path:

- start at `summary.json` or `summary.csv`
- identify `phase_id`
- open `log_relpath` / `stdout_relpath` / `stderr_relpath`
- follow `primary_artifact_relpath`, `extra_artifact_relpaths`, or copied files under `artifacts/`
- inspect `paths.env` for concrete app/runtime/model/input/output paths

### XCTest/XCUITest/app-launched lanes

Minimum trace path:

- start at `contracts/lane_matrix.json` for multi-lane runs, or lane-local `summary.json` if already scoped
- identify the failing/warning phase in `contracts/<lane>/summary.json` or `contracts/<lane>/evidence_contract.json`
- open the retained combined step log under `logs/`
- when present, also open the split `stdout_relpath` and `stderr_relpath` stream artifacts for exact stream-level context
- open `result_bundle_relpath` for `.xcresult` attachments, screenshots, and XCTest/XCUITest diagnostics when present
- inspect lane-local `paths.env` for `DERIVED_DATA_PATH`, destination, runtime-input root, and related path context

## Status and realism interpretation

The standard intentionally separates **lane result quality** from **behavior realism**.

- `pass` / `warn` / `fail` / `skipped` describe the retained execution outcome
- realism labels such as `mock`, `fixture`, `temp-filesystem`, `packaged-app`, and `manual-user-journey` describe how close the lane is to real user execution

Standard rule:
- retained evidence quality must never be used to over-claim realism
- a lane may be `retained-rich` and still only prove a simulated path
- consumers and docs must keep those dimensions separate

## Required producer responsibilities

Every new or updated e2e-style producer must do all of the following:

- emit a valid retained root that satisfies `bd-2grd`
- choose the truthful `lane_type` instead of inventing a one-off label
- retain stable `scenario_id` and `phase_id` values suitable for CI and runbook references
- keep all referenced paths inside the evidence root
- preserve the first-hop summary surfaces even when the run fails
- record enough `paths.env` context to explain which concrete app/runtime/model/log paths were used
- classify skips, retries, contract failures, and product failures honestly rather than collapsing them into generic pass/fail

## Required consumer responsibilities

Validators, CI gates, and future evidence indexes must all follow these rules:

- prefer `summary.json` / `evidence_contract.json` over bespoke grep of producer-specific logs
- use the lane index when a root exposes multiple manifests
- tolerate truthful compatibility fallbacks documented by the lane family, such as log/stream aliasing on legacy roots
- reject malformed or contradictory retained metadata rather than silently guessing
- avoid claiming that a lane proves a real user journey unless the realism classification independently supports that claim

## Current truthful compatibility rules

The standard already includes a few explicit compatibility allowances.

- upgraded XCTest/XCUITest roots may retain all three log pointers truthfully: combined compatibility log plus split `stdout_relpath` and `stderr_relpath`
- older XCTest roots may still alias `stdout_relpath` and `stderr_relpath` to the combined `log_relpath`
- current app-launched verification lives inside `xcuitest-evidence` rather than a dedicated third lane
- shell lanes may retain copied `.xcresult` bundles or other directories under `artifacts/` when they wrap app-level helpers indirectly

These allowances are acceptable only when they are explicitly documented and still preserve the traceability chain above.

## Recommended root entrypoints by lane family

| Use case | Start here | Then inspect |
| --- | --- | --- |
| one shell/scripted retained run | `summary.json` | `evidence_contract.json`, `logs/`, `artifacts/`, `paths.env` |
| one packaged smoke / failure-path run | `summary.json` | `evidence_contract.json`, parity logs, copied artifacts, `paths.env` |
| one app-level xctest/xcuitest run root | `contracts/lane_matrix.json` | `contracts/<lane>/summary.json`, `contracts/<lane>/evidence_contract.json`, `logs/`, `.xcresult/`, lane `paths.env` |
| a single known app-level lane | `contracts/<lane>/summary.json` | `contracts/<lane>/evidence_contract.json`, phase logs, `.xcresult/`, lane `paths.env` |

## Downstream implications

This standard is intended to make downstream work straightforward.

- `bd-1ngy` should build one cross-lane index on top of these shared entrypoints instead of parsing each producer separately
- `bd-13tm` should validate cross-lane roots by checking the shared root contract plus the lane-family specialization
- `bd-2t10` should orchestrate runs by collecting lane indexes and lane-local summaries, not by scraping raw logs first
- future e2e beads should link back to this document and choose one existing lane family unless they truly require a new one

## Focused follow-on opportunities

The current standard is truthful but still leaves room for future tightening:

- expand multi-lane indexing beyond the current app-level xctest/xcuitest producer
- expose richer first-class screenshot/attachment manifests when `.xcresult`-only retention becomes insufficient
- add stronger CI gates that prove every required lane both exists and emits a valid retained root
- standardize per-attempt retry artifacts where retry-heavy producers need more than merged step-level evidence
