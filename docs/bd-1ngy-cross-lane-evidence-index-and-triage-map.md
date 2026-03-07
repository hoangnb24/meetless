# bd-1ngy — Cross-lane evidence index and failure-triage map

Date: 2026-03-06
Related bead: `bd-1ngy`
Shared retained-evidence standard: `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`
Shell/scripted retained-evidence contract: `docs/bd-8ydu-shell-e2e-evidence-contract.md`
XCTest/XCUITest/app-launched retained-evidence contract: `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md`

## Purpose

Give future sessions one practical answer to the question: **"A lane failed or warned — where exactly should I look next?"**

This document is intentionally operational. It does not redefine the contracts. It indexes the current summary surfaces, deep evidence entrypoints, and common failure classes across shell/scripted, packaged, XCTest, XCUITest, and current app-launched verification lanes.

## Fast start

When triaging any retained verification failure, follow this order:

1. identify the lane family
2. open the first-hop summary surface for that lane family
3. find the failing or warning `phase_id` / summary row
4. follow the linked deep evidence files or bundles
5. inspect `paths.env` or equivalent path context before concluding the bug is in product code

## First-hop evidence index

| Lane family / run type | First file to open | Second file to open | Deep evidence to inspect next | Notes |
| --- | --- | --- | --- | --- |
| shell/scripted single-lane e2e | `summary.json` | `evidence_contract.json` | `logs/`, `artifacts/`, `paths.env` | Applies to conforming shell roots from the shared contract |
| packaged smoke / packaged failure-path shell lanes | `summary.csv` or `summary.json` under the retained packaged gate root | `status.txt` | parity logs, copied artifacts, retained app/runtime/model paths | README points at packaged smoke roots under `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/...` |
| release-context verification shell lane | lane `summary.csv` / `status.txt` | any retained verification report under the same root | signing logs, entitlements reports, bundle inventory evidence, `paths.env` | Best used for release-posture/signing questions |
| multi-lane app-level xctest/xcuitest root | `contracts/lane_matrix.json` | `contracts/<lane>/summary.json` | `contracts/<lane>/evidence_contract.json`, `logs/`, `.xcresult/`, lane `paths.env` | Current producer: `scripts/ci_recordit_xctest_evidence.sh` |
| single scoped app-level lane | `contracts/xctest/summary.json` or `contracts/xcuitest/summary.json` | matching `evidence_contract.json` | step logs, split `stdout`/`stderr` when present, `.xcresult/`, lane `paths.env` | App-launched verification currently lives under `xcuitest-evidence` |

## Current canonical app-level evidence root

For the current app-level CI lane, start here:

- root: `artifacts/ci/xctest_evidence/<stamp>/`
- lane index: `artifacts/ci/xctest_evidence/<stamp>/contracts/lane_matrix.json`
- xctest manifest: `artifacts/ci/xctest_evidence/<stamp>/contracts/xctest/evidence_contract.json`
- xcuitest manifest: `artifacts/ci/xctest_evidence/<stamp>/contracts/xcuitest/evidence_contract.json`
- responsiveness evidence: `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv`

Triage rule:
- if the question is about app responsiveness or app-target XCTest, start with `xctest`
- if the question is about onboarding, visible UI flow, warning acknowledgement, remediation, or current app-launched behavior, start with `xcuitest`

## Current canonical packaged evidence root

For the strongest packaged runtime lane currently documented in the repo, start here:

- packaged smoke root family: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/`
- first-hop files called out in `README.md`:
  - `summary.csv`
  - `status.txt`
  - `recordit_run_plan.log`

Triage rule:
- if the question is about shipped-app posture, signed payload contents, packaged runtime/model parity, or non-Xcode launch behavior, prefer the packaged root before the xctest root

## Failure-class triage map

### Contract / evidence-shape failure

Examples:
- malformed `status.txt` / `paths.env`
- missing summary files
- invalid timestamp fields
- contradictory retained metadata
- `contract_failure` classifications

Start here:
- shell roots: `evidence_contract.json`, `summary.json`, `status.txt`, `paths.env`
- app-level roots: `contracts/lane_matrix.json`, then lane `evidence_contract.json`

Inspect next:
- `phase_id` rows in `summary.csv` / `summary.json`
- validator-facing files under the retained root
- any `discover_xctestrun` phase failure for app-level lanes

Likely interpretation:
- the evidence contract itself is broken or incomplete
- do not jump directly to product-code conclusions until the retained root is proven valid

### Retry / flake warning

Examples:
- `status=warn`
- `exit_classification=flake_retried`
- bootstrap retry markers in app-level logs

Start here:
- app-level lane `contracts/<lane>/summary.json`
- matching phase in `contracts/<lane>/evidence_contract.json`

Inspect next:
- retained combined step log under `logs/`
- split `stdout_relpath` / `stderr_relpath` when present
- `.xcresult` bundle for the affected UI phase

Likely interpretation:
- final outcome may be usable, but the run was not clean
- treat as infrastructure or harness instability first, not immediate product failure

### Responsiveness gate failure

Examples:
- `threshold_first_stable_transcript_budget_ok=false`
- `threshold_stop_to_summary_budget_ok=false`
- `responsiveness_gate_pass=false`

Start here:
- `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv`
- `contracts/xctest/summary.json`

Inspect next:
- `contracts/xctest/evidence_contract.json`
- `logs/responsiveness_budget_gate.log`
- `xcresult/responsiveness_budget_gate.xcresult/`

Likely interpretation:
- the app-level responsiveness budget was missed
- compare with the runtime posture and readiness/path context before attributing the miss to UI code alone

### UI readiness / remediation mismatch

Examples:
- onboarding blocker vs warning disagreement
- fallback affordance missing or incorrectly shown
- warning acknowledgement path not working
- visible live-run summary flow regression

Start here:
- `contracts/xcuitest/summary.json`
- `contracts/xcuitest/evidence_contract.json`

Inspect next:
- the affected `uitest_*` phase log
- matching `.xcresult` bundle under `xcresult/`
- lane `paths.env` for destination/runtime-input context

Likely interpretation:
- current app-launched / visible UI behavior diverged from the readiness contract or test scenario expectations
- cross-check against the current policy docs and recent `bd-tr8z` lane notes before changing fallback semantics

### Packaged runtime/model parity failure

Examples:
- bundled runtime missing
- model path or artifact manifest mismatch
- packaged smoke parity checks failing
- release-context payload disagreement

Start here:
- packaged smoke `summary.csv`
- packaged smoke `status.txt`
- release-context verifier outputs when the question is about signing/posture instead of runtime execution

Inspect next:
- `recordit_run_plan.log`
- parity logs and copied retained artifacts under the packaged gate root
- retained path/context files describing app/runtime/model locations

Likely interpretation:
- the shipped artifact posture differs from the expected embedded runtime/model contract
- prefer packaged evidence over debug/Xcode evidence for this class of issue

### Release signing / entitlements / validation posture failure

Examples:
- codesign verification mismatch
- entitlements disagreement
- notarization-input or validation-context confusion
- bundle inventory not matching the intended shipped artifact

Start here:
- release-context shell verification root for the relevant run
- retained summary / status files for that root

Inspect next:
- signing logs
- entitlements reports
- bundle inventory outputs
- path context showing which app artifact was actually validated

Likely interpretation:
- validation may be running against the wrong app posture, or the release artifact is misassembled
- avoid using app-level xctest evidence as the primary truth for release-posture questions

### Stop / finalization evidence gap

Examples:
- stop request acknowledged but summary never finalizes
- stop path classification mismatch
- expected final artifacts missing after stop

Start here:
- the lane summary for whichever lane exposed the issue
- any runtime/session artifact paths referenced from that lane

Inspect next:
- retained stop/finalization logs for the phase in question
- session manifest / pending or finalized artifacts referenced in the root
- the strongest currently relevant stop-handshake lane notes if the lane is still actively evolving

Likely interpretation:
- may be a runtime lifecycle bug, a finalization timeout, or an evidence-retention gap depending on whether the artifacts exist but classification is wrong

## Summary-row to next-hop map

| If you see this | Start here | Then inspect |
| --- | --- | --- |
| `overall_status=fail` on a shell lane | lane `summary.json` | `evidence_contract.json`, failing phase logs, `artifacts/`, `paths.env` |
| `overall_status=warn` on an app-level lane | `contracts/lane_matrix.json` | lane `summary.json`, `evidence_contract.json`, affected phase logs, `.xcresult/` |
| `exit_classification=contract_failure` | phase entry in `evidence_contract.json` | `status.txt`, `paths.env`, discovery/setup logs, validator assumptions |
| `exit_classification=flake_retried` | lane `summary.json` | combined step log, split stream logs, `.xcresult/` |
| responsiveness threshold row false | `responsiveness_budget_summary.csv` | xctest manifest, responsiveness gate log, responsiveness `.xcresult` |
| packaged `handoff_failure_stage` / parity problem | packaged `summary.csv` / `status.txt` | parity logs, copied bundle/runtime/model artifacts, path context |

## Lane-specific reminders

- for app-level xctest/xcuitest roots, prefer the lane-local manifest and summary over the root-level legacy CSVs when you need exact per-lane truth
- for packaged/release questions, prefer packaged smoke or release-context roots over debug/xctest evidence
- for shell lanes that wrap app helpers indirectly, copied bundles may live under `artifacts/` rather than at top-level canonical app paths
- retained evidence quality is not the same thing as realism; a lane can retain excellent logs and still only prove a simulated path

## Suggested future usage

Future docs, validators, and triage bots should reference this file when they need to tell a human or agent:

- where to start for a given lane family
- which retained file is the summary entrypoint
- which deep evidence is authoritative for a specific failure class
- when to prefer packaged evidence over app-level xctest evidence, and vice versa
