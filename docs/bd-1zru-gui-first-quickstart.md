# bd-1zru — GUI-First README and Operator Quickstart Update

Date: 2026-03-05

## Objective
Document an unambiguous Recordit.app-first user path for install/launch/first-run validation while preserving fallback diagnostics as explicitly non-default.

## Updated Files

- `docs/operator-quickstart.md`
- `README.md`

## What Changed

1. `docs/operator-quickstart.md`
- converted quickstart from CLI-first to GUI-first
- added explicit default flow:
  - build DMG
  - install via drag-to-Applications
  - launch `Recordit.app`
  - complete onboarding gates (permissions/model)
  - validate first live session start/stop + summary
  - verify session artifacts
- added explicit fallback diagnostics section marked non-default

2. `README.md`
- updated canonical operator quickstart summary to point to GUI-first flow
- replaced CLI-first quick path block with minimal GUI-first install sequence
- retained compatibility/CLI diagnostics guidance as non-default

## Acceptance Check

- README and operator quickstart now describe the GUI-first `Recordit.app` path as canonical.
- fallback diagnostics (`run-transcribe-app`, direct CLI usage) remain documented but explicitly labeled compatibility/support workflows.
