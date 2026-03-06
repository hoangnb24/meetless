# bd-1b1k — Support Troubleshooting Matrix Publication

Date: 2026-03-05

## Objective
Publish a support-facing troubleshooting matrix for post-cutover `Recordit.app` users, covering top failure classes with deterministic remediation and escalation rules.

## Delivered

1. New matrix doc:
- `docs/support-troubleshooting-matrix.md`

Includes deterministic failure-mode handling for:
- permissions
- model resolution
- runtime start/finalization
- packaging/DMG install/launch
- packaged smoke gate regressions
- app-level XCTest/XCUITest gate regressions

Each row includes:
- deterministic signal/check
- user-safe remediation sequence
- escalation trigger
- escalation target owner

2. Runbook linkage:
- `docs/transcribe-operator-runbook.md`
- added explicit link to `docs/support-troubleshooting-matrix.md` as support escalation companion.

## Acceptance Outcome

- support troubleshooting matrix is published
- matrix is linked from runbook
- major failure modes include deterministic remediation and escalation rules
