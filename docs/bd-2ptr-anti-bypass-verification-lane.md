# bd-2ptr Anti-Bypass Verification Lane

This lane enforces one rule: seam-bearing lanes may be useful, but they cannot
be reported as `real-environment-verified`.

## Scope

The lane compares:

- `docs/bd-39i6-canonical-downstream-matrix.csv`
- `docs/bd-2mbp-critical-path-exception-register.csv`

It blocks certifying claims when active seam-bearing rows still include known
bypass families:

- `ui_test_mode`
- `preview_di`
- `mock` / `stub`
- `scripted_runtime`
- `runtime_override`

## Commands

Run the gate directly:

```bash
python3 scripts/gate_anti_bypass_claims.py \
  --claim-level real-environment-verified \
  --summary-csv artifacts/ci/gate_anti_bypass_claims/manual/summary.csv \
  --status-json artifacts/ci/gate_anti_bypass_claims/manual/status.json
```

Or run the wrapper:

```bash
scripts/gate_anti_bypass_claims.sh --claim-level real-environment-verified
```

## Output Contract

- `summary.csv` contains key/value gate counters and seam totals.
- `status.json` contains machine-readable violations, including:
  - `surface_key`
  - `seam_families`
  - `seam_sources`
  - `exception_ids`

## Claim Interpretation

- If `gate_pass=false`, claims must be downgraded to `simulation-covered`.
- If `gate_pass=true` for a certifying claim, the checked matrix/register slice
  has no active bypass families captured by this lane.
