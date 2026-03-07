# bd-2owz: Coverage Certification Gate

Date: 2026-03-07  
Related bead: `bd-2owz`  
Parent epic: `bd-204a`

## Goal

Provide one explicit gate that answers whether a certifying claim such as
`full coverage` is currently:

- `true` (allowed)
- `false` (hard-blocked)
- `unproven` (no hard blocker, but required evidence is still incomplete)

This lane is the anti-hand-wave answer point for future sessions.

## Canonical Command

```bash
scripts/gate_coverage_certification.sh
```

Default output root:

```text
artifacts/ci/gate_coverage_certification/<timestamp>/
```

## Inputs Enforced

1. Canonical downstream matrix (`docs/bd-39i6-canonical-downstream-matrix.csv`)
2. Critical-surface matrix (`docs/bd-39i6-critical-surface-coverage-matrix.csv`)
3. Anti-bypass certifying-claim gate (`scripts/gate_anti_bypass_claims.sh`)
4. Required domain-bead closure set (default):
   - `bd-tr8z` (readiness parity)
   - `bd-diqp` (runtime/model parity)
   - `bd-p77p` (stop/finalization)
   - `bd-39i6` (matrix inventory)
   - `bd-11vg` (gap report)
   - `bd-2j49` (cross-lane evidence standard)

## Verdict Rules

1. `false` (hard-blocked):
   - anti-bypass gate fails for certifying claim, or
   - any required domain bead is not `closed`, or
   - any downstream matrix row is `uncovered`.
2. `unproven`:
   - no hard blockers, but matrix rows are still `partial` / `covered-with-seams`,
     or critical-surface rows still report explicit `remaining_gap` values.
3. `true`:
   - no hard blockers and no remaining soft blockers.

## Required Outputs

- `summary.csv` (key/value verdict + blocker counters)
- `status.json` (machine-readable blockers and missing-work breakdown)
- `status.txt` (flat key/value summary)
- `anti_bypass/` nested output from `gate_anti_bypass_claims.sh`

## Why This Satisfies Certification Acceptance

1. Depends on matrix inventory + evidence standards + domain-specific parity/stop
   features by explicit input checks.
2. Real-environment claim posture is enforced through anti-bypass certifying-claim
   failure handling and matrix gap interpretation.
3. Produces explicit `true`/`false`/`unproven` answer for future sessions.
4. Emits exact missing blockers in `status.json` so `not yet` is unambiguous.

## Example

```bash
OUT_DIR="artifacts/ci/gate_coverage_certification/manual" \
scripts/gate_coverage_certification.sh

cat artifacts/ci/gate_coverage_certification/manual/status.txt
jq '.verdict, .hard_blockers, .soft_blockers' \
  artifacts/ci/gate_coverage_certification/manual/status.json
```

If verdict is `false` or `unproven`, use `open_required_beads`,
`downstream_uncovered`, `downstream_partial_or_seam`, and
`critical_remaining_gaps` in `status.json` as the canonical follow-up list.
