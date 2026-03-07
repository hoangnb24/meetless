# bd-8ydu — Common Shell E2E / Smoke / Gate Evidence Contract

Date: 2026-03-06
Related bead: `bd-8ydu`
Related shared contract: `docs/bd-2grd-e2e-evidence-contract.md`
Reusable helpers:
- `scripts/e2e_evidence_lib.sh`
- `scripts/render_shell_e2e_evidence_contract.py`

## Purpose

Define the shell-specific way to emit the shared Recordit retained-evidence contract for shell-based end-to-end lanes, smoke scripts, and gate scripts.

This artifact does not replace the shared contract from `bd-2grd`. It narrows that general contract into one concrete shell workflow so scripts can produce the same root shape without hand-building JSON, CSV, and status files one by one.

## Contract Shape

Shell lanes should emit the same root files already required by the shared validator:

```text
<evidence-root>/
  evidence_contract.json
  summary.csv
  summary.json
  status.txt
  paths.env
  logs/
    <phase>.log
    <phase>.stdout
    <phase>.stderr
  artifacts/
    ... retained shell outputs ...
```

Shell lanes may additionally keep:

- copied manifests or status snapshots under `artifacts/`
- extracted reports or phase-specific attachments under `artifacts/`
- retained directories such as copied `.xcresult` bundles when a shell lane wraps XCTest / XCUITest or packaged app helpers

## Builder Workflow

Shell scripts should prefer the common builder rather than hand-writing each root file.

### Phase manifest input

The builder consumes one JSON file containing an array of phase records or an object with `phases: [...]`.

Each phase record must already point at retained files/directories under the evidence root:

- `phase_id`
- `title`
- `required`
- `status`
- `exit_classification`
- `started_at_utc`
- `ended_at_utc`
- `command_display`
- `command_argv`
- `log_relpath`
- `stdout_relpath`
- `stderr_relpath`
- `primary_artifact_relpath`
- optional `extra_artifact_relpaths`
- optional `result_bundle_relpath`
- optional `notes`

The builder validates the same shell-relevant rules the shared validator expects:

- unique `phase_id`
- safe relative paths that stay inside the evidence root
- existing retained files/directories
- skip/retry note requirements
- lane-level status derived from per-phase outcomes

### Shell helper

Reusable wrapper from `scripts/e2e_evidence_lib.sh`:

```bash
evidence_render_contract \
  "$OUT_DIR" \
  "packaged_live_smoke" \
  "packaged-e2e" \
  "$PHASE_MANIFEST_JSON" \
  --generated-at-utc "$(evidence_timestamp)" \
  --paths-env-entry "MODEL_PATH=$MODEL" \
  --paths-env-entry "SIGNED_APP=$SIGNED_APP"
```

This wrapper calls `scripts/render_shell_e2e_evidence_contract.py` and writes:

- `paths.env`
- `status.txt`
- `summary.csv`
- `summary.json`
- `evidence_contract.json`

## Shell Conventions

### `lane_type`

Shell lanes should use:

- `shell-e2e` for generic shell-driven journeys
- `packaged-e2e` for packaged app / release-script journeys
- `hybrid-e2e` when a shell orchestration lane wraps multiple execution families but still owns the retained root

### `paths.env`

The builder always writes:

- `EVIDENCE_ROOT=<absolute path>`
- `ARTIFACT_ROOT=<absolute path>`

Shell lanes should add the resolved inputs/outputs that matter for triage, such as:

- selected model path
- bundled app path
- runtime input dir
- DMG path
- install destination
- copied manifest path
- helper binary path

### `overall_status`

The builder computes lane-level status from retained phases:

- `skipped` if every phase is `skipped`
- `fail` if any required phase failed
- `pass` if every phase passed
- `warn` otherwise

This keeps shell lanes aligned with the same lane semantics already expected by `bd-2grd` and downstream validator/gate work.

## Validation

Primary renderer test suite:

```bash
python3 -m unittest tests.test_render_shell_e2e_evidence_contract
```

Shared contract validation example:

```bash
python3 scripts/validate_e2e_evidence_contract.py --root <evidence-root> --expect-lane-type packaged-e2e
```

## Immediate Downstream Use

This shell-specific contract is intended to unblock:

- `bd-13tm` by giving shell lanes one canonical root-builder shape
- `bd-2t10` by making orchestrated shell suites emit the same retained envelope
- `bd-1ngy` by making cross-lane evidence indexing depend on one shell contract surface instead of ad hoc per-script metadata

## Practical Rule

If a shell lane is important enough to be cited in a runbook, release summary, or coverage claim, it should be important enough to emit the shared retained-evidence contract through the common builder.
