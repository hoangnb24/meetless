# bd-39jy — Mock/Fake/Fixture Census and Allowed-Use Policy
Date: 2026-03-06
Related bead: `bd-39jy`  
Prerequisite inventory: `docs/bd-5cz8-test-surface-inventory.csv`  
Downstream consumer: `bd-eq01`
## Purpose
Turn the raw test-surface inventory into two things downstream work can actually use:
1. a **seam census** showing where mocks, fixtures, fake capture, UI-test-mode, preview DI, temp filesystems, and packaged-only checks currently appear
2. an **allowed-use policy** that says what those seams can legitimately support, and what they cannot be used to justify in coverage claims
## Census Snapshot
- inventoried surfaces with at least one explicit seam marker: **63**
- total seam annotations across those surfaces: **106**
- `mock` rows: **7** across **7** surfaces
- `stub` rows: **13** across **13** surfaces
- `fixture` rows: **48** across **48** surfaces
- `fake_capture` rows: **8** across **8** surfaces
- `ui_test_mode` rows: **2** across **2** surfaces
- `scripted_runtime` rows: **1** across **1** surfaces
- `preview_di` rows: **2** across **2** surfaces
- `temp_filesystem` rows: **17** across **17** surfaces
- `runtime_override` rows: **3** across **3** surfaces
- `packaged_checks` rows: **5** across **5** surfaces
## Allowed-Use Policy
| seam family | acceptable use | not enough for |
|---|---|---|
| `mock` | unit logic coverage; narrow view-model/controller behavior; deterministic failure-branch checks | integration realism, app-journey proof, release claims, or any “full coverage” statement |
| `stub` | unit and smoke tests where the seam is explicit and the claim stays logic-local | runtime authority, end-to-end app behavior, or packaged-app confidence claims |
| `fixture` | schema/contract compatibility, deterministic regressions, bounded scripted-e2e checks | live-real device/TCC behavior or certification-style product-journey claims |
| `fake_capture` | repeatable streaming/load verification and deterministic runtime regressions | claims about true capture devices, live permissions, or user-real audio paths |
| `ui_test_mode` | UI flow automation and deterministic onboarding/runtime affordance coverage | proof that the production app environment can satisfy runtime/preflight requirements |
| `scripted_runtime` | branch coverage for UX states and controlled failure/recovery paths | proof of real runtime ownership, real binary execution, or production event sequencing |
| `preview_di` | SwiftUI rendering and state-presentation checks | startup/readiness correctness, session persistence claims, or support-bundle truthfulness |
| `temp_filesystem` | service/process boundary checks and retained-artifact logic in isolated local runs | installed app behavior, DMG install/open proof, or production filesystem assumptions |
| `runtime_override` | automation bootstrapping where the override is explicit and separately audited | claims that bundled runtime/model lookup works in the shipped app posture |
| `packaged_checks` | signing, payload inventory, release-context parity, and packaged-artifact shape claims | live capture success, first-run onboarding, or installed-app journey claims by itself |
## Layer-Level Claim Policy
| layer | seam use that is acceptable | claim ceiling with seams still present | requires real-environment evidence for |
|---|---|---|---|
| `unit` | mocks, stubs, fixtures, temp filesystems | logic correctness inside the bounded module | any product-journey or packaged-runtime claim |
| `integration` | fixtures, fake capture, temp filesystems when the seam is explicit | service/boundary confidence and contract stability | true device/TCC behavior, installed-app behavior, or “full integration coverage” language |
| `scripted-e2e` | deterministic fixtures and fake capture if retained evidence is explicit | bounded end-to-end regression proof with seams named | live-real app journey, real capture hardware paths, or install/open truth claims |
| `smoke` | mocks/stubs/fixtures for fast local branch validation | smoke confidence only; never certification-level proof | readiness authority, release readiness, or final coverage claims |
| `xctest` | injected services and preview DI for deterministic SwiftUI behavior | app-logic and state-presentation confidence | production app/runtime parity or retained real-session evidence claims |
| `xcuitest` | UI-test-mode and scripted runtime only when called out explicitly | deterministic UI flow coverage | production environment readiness/live-run proof |
| `release-script` | packaged checks plus fixture-driven runtime probes | signing, entitlements, payload shape, and packaged parity proof | installed-user journey, live capture success, or DMG-open truth by itself |
| `contract-test` / `contract-harness` | fixtures and frozen artifacts | schema/format compatibility and parser stability | user-real product behavior or critical-path completeness claims |

## Interpretation Rules
1. **Any seam-bearing lane must be named as such in docs and reviews.** If a row depends on mocks, fixtures, preview DI, fake capture, or UI-test-mode, the claim must carry that seam explicitly.
2. **Layer names do not override seam reality.** A file living under `integration`, `xcuitest`, or a packaged script is still simulation-bound if its primary proof depends on fixtures, overrides, or scripted runtime behavior.
3. **Packaged verification is necessary but not sufficient.** Signing/payload/install-shape proof is valuable, but it cannot by itself justify “the user journey works” or “live capture is verified.”
4. **Fixture-backed evidence is still useful.** The policy is not anti-fixture; it is anti-overclaim. Deterministic seams are good for regression detection, contract stability, and bounded behavior checks.
## Critical-Path Flows That Still Require Real-Environment Evidence
- `production-app-journey`: onboarding -> readiness -> live run -> session review in the production app environment
- `live-tcc-capture`: true microphone/screen/display/TCC-backed live capture path
- `dmg-install-open`: mount/install/open verification for the shipped DMG artifact
- `playback-functional`: functional playback behavior against retained session artifacts in app context
- `packaged-runtime-lookup`: bundled runtime/model resolution in the shipped Recordit.app posture
## Immediate Downstream Use
- `bd-eq01` should use this policy when deciding whether a row is `real-environment verified`, `covered-with-seams`, `partial`, or `uncovered`.
- `bd-2mbp` can harden this into the stricter no-mock critical-path exception register without redoing the census.
- `bd-1jc9` can treat this file as the vocabulary source for scanner categories.
## Output
Machine-readable companion: `docs/bd-39jy-mock-fixture-census.csv`
