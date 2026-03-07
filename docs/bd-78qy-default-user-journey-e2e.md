# bd-78qy: Default-user-journey Recordit.app e2e lane

## Scope

Added a canonical default-user-journey orchestration lane that verifies:

1. DMG install/open flow (`Recordit.app` + `Applications` layout, copy, launch attempt)
2. onboarding completion + first live-run UI flow evidence (XCTest/XCUITest lane)
3. packaged live start/stop + retained artifact verification
4. one retained hybrid evidence root with phase logs and machine-readable summaries

## Delivered

### New scripts

1. `scripts/gate_default_user_journey_e2e.sh`
   - orchestrates three existing lanes in sequence:
     - `scripts/gate_dmg_install_open.sh`
     - `scripts/ci_recordit_xctest_evidence.sh`
     - `scripts/gate_packaged_live_smoke.sh`
   - records per-phase logs/artifacts under one root
   - emits shared e2e evidence contract (`hybrid-e2e`) via `e2e_evidence_lib.sh`

2. `scripts/gate_default_user_journey_e2e_summary.py`
   - validates journey-level checks across child lanes
   - emits `artifacts/default_user_journey_checks.csv` and `.json`
   - supports `--require-pass` for strict CI/nightly failure behavior

## Output contract

Default root (unless `--out-dir` provided):

- `artifacts/ops/gate_default_user_journey_e2e/<timestamp>/`

Required retained files:

- `evidence_contract.json`
- `summary.csv`
- `summary.json`
- `status.txt`
- `paths.env`
- `status.json`
- `logs/<phase>.log|stdout|stderr`
- `artifacts/phases.json`
- `artifacts/default_user_journey_checks.csv`
- `artifacts/default_user_journey_checks.json`

Child-lane outputs are retained by path and referenced through phase logs + `paths.env` entries:

- `DMG_OUT_DIR`
- `XCTEST_OUT_DIR`
- `PACKAGED_LIVE_OUT_DIR`

## Usage

Strict/default mode (all phases required):

```bash
scripts/gate_default_user_journey_e2e.sh
```

Custom roots/model:

```bash
scripts/gate_default_user_journey_e2e.sh \
  --out-dir artifacts/ops/gate_default_user_journey_e2e/manual \
  --packaged-root "$HOME/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta" \
  --model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Capability-gated variant (documented skip mode):

```bash
scripts/gate_default_user_journey_e2e.sh \
  --allow-capability-gated \
  --skip-dmg-phase
```

Without `--allow-capability-gated`, any `--skip-*-phase` flag is rejected.

## Acceptance mapping

1. Canonical GUI-default flow coverage:
   - install/open: `dmg_install_open` phase
   - onboarding completion + first live-run UI: `onboarding_and_live_ui` phase
   - first live start/stop + artifact verification: `packaged_live_start_stop` phase
2. Standardized retained evidence:
   - one hybrid root with phase logs, summary/status files, and contract manifest
3. Failure diagnostics:
   - per-phase logs and deterministic `journey_summary_checks` output preserve failure location
4. CI/nightly suitability:
   - strict mode enforces full-pass claims
   - capability-gated mode explicitly marks partial/skip operation

## Validation

```bash
bash -n scripts/gate_default_user_journey_e2e.sh
python3 -m py_compile scripts/gate_default_user_journey_e2e_summary.py
```
