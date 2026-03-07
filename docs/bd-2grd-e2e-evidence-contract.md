# bd-2grd — Shared e2e evidence contract

This document defines the **shared retained-evidence contract** for new Recordit end-to-end verification lanes.

It is intentionally seeded from the strongest existing patterns already present in:

- `scripts/verify_recordit_release_context.sh`
- `scripts/ci_recordit_xctest_evidence.sh`
- `scripts/gate_packaged_live_smoke.sh`
- `scripts/gate_v1_acceptance.sh`

The goal is not to rewrite those scripts immediately. The goal is to make future default-app, packaged-app, failure-path, XCTest, and XCUITest lanes emit one **stable machine-readable evidence root** that downstream beads can validate and consume.

## Required root layout

Every new conforming lane should produce one evidence root with the following minimum shape:

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
    ... lane-specific retained files ...
```

Additional optional directories are allowed, including:

- `xcresult/` for XCTest / XCUITest result bundles
- `screenshots/` for UI evidence
- `attachments/` for copied diagnostics or extracted reports

## Root-file requirements

### `evidence_contract.json`

This is the canonical manifest for the root. It must include:

- `contract_name` — must be `recordit-e2e-evidence`
- `contract_version` — currently `1`
- `scenario_id` — stable lowercase identifier, for example `packaged_live_smoke` or `default_user_journey`
- `lane_type` — one of:
  - `shell-e2e`
  - `packaged-e2e`
  - `xctest-evidence`
  - `xcuitest-evidence`
  - `hybrid-e2e`
- `generated_at_utc` — valid UTC timestamp in RFC 3339 / ISO 8601 `...Z` form
- `artifact_root_relpath` — usually `artifacts` or `.`, and it must resolve inside the evidence root
- `overall_status` — one of `pass`, `warn`, `fail`, `skipped`
- `paths_env_relpath` — relative path to `paths.env`
- `status_txt_relpath` — relative path to `status.txt`
- `summary_csv_relpath` — relative path to `summary.csv`
- `summary_json_relpath` — relative path to `summary.json`
- `phases` — non-empty ordered array of retained phase records

### `summary.csv`

`summary.csv` is the concise machine-readable per-phase table. It must have exactly these columns:

- `scenario_id`
- `lane_type`
- `phase_id`
- `required`
- `status`
- `exit_classification`
- `started_at_utc`
- `ended_at_utc`
- `log_path`
- `primary_artifact`

`ended_at_utc` must not be earlier than `started_at_utc`. Timestamps must be real UTC calendar/time values; shape-only strings such as `2026-99-99T99:99:99Z` are invalid.

Each phase in `evidence_contract.json.phases[]` must have exactly one corresponding row in `summary.csv`, `phase_id` values must remain unique in both places, and the CSV row order must match the manifest phase order exactly.

### `summary.json`

`summary.json` is the concise aggregate view for policy/CI consumers. It must include:

- `scenario_id`
- `lane_type`
- `contract_version`
- `overall_status`
- `phase_count`
- `required_phase_count`
- `failed_phase_count`
- `warn_phase_count`
- `skipped_phase_count`
- `generated_at_utc`
- `manifest_relpath`

`summary.json` counts must agree with the retained phase set in `evidence_contract.json`.
`summary.json.generated_at_utc` must also match `evidence_contract.json.generated_at_utc`.

### `status.txt`

`status.txt` is the human-quick-read file. It must contain shell-style `key=value` lines for at least. Duplicate keys and malformed non-comment lines are invalid:

- `status`
- `scenario_id`
- `lane_type`
- `generated_at_utc`
- `summary_csv`
- `summary_json`
- `manifest`

`status.txt.generated_at_utc` must match `evidence_contract.json.generated_at_utc`.

### `paths.env`

`paths.env` records resolved paths that matter for triage. It must be a shell-style `KEY=VALUE` file using shell-safe uppercase keys (`[A-Z][A-Z0-9_]*`). Duplicate keys and malformed non-comment lines are invalid. Every lane must include these shared base entries:

- `EVIDENCE_ROOT`
- `ARTIFACT_ROOT`
- `STATUS_TXT`
- `SUMMARY_CSV`
- `SUMMARY_JSON`
- `MANIFEST`

Those values may be absolute resolved paths or safe relative paths, but they must resolve to the retained evidence root and the exact contract files named by the manifest. Lane-specific keys may add more context, but they must preserve the same shell-safe key format.

## Phase record requirements

Each `phases[]` entry in `evidence_contract.json` must include:

- `phase_id` — stable lowercase identifier such as `build_for_testing` or `packaged_preflight`
- `title` — short human-readable name
- `required` — boolean; whether failure should fail the lane
- `status` — `pass`, `warn`, `fail`, or `skipped`
- `exit_classification` — one of:
  - `success`
  - `product_failure`
  - `infra_failure`
  - `contract_failure`
  - `flake_retried`
  - `skip_requested`
- `started_at_utc`
- `ended_at_utc`
- `command_display` — exact echoed command surface or human-equivalent command string
- `command_argv` — argv array when applicable
- `log_relpath` — retained combined log path, usually under `logs/`
- `stdout_relpath` — retained stdout log if split
- `stderr_relpath` — retained stderr log if split
- `primary_artifact_relpath` — the main resulting file artifact for the phase when applicable
- `extra_artifact_relpaths` — optional extra retained files / bundles
- `result_bundle_relpath` — optional retained directory-style bundle, such as an `.xcresult`
- `notes` — optional explanatory note for warns/skips, and required when `exit_classification=flake_retried`

`ended_at_utc` must not be earlier than `started_at_utc`.

## Interpretation rules

- `status=pass` requires `exit_classification=success`.
- `status=warn` means the phase produced usable evidence but did not fully satisfy the target expectation, and it currently requires `exit_classification=flake_retried`.
- `status=fail` requires an explicit failure classification: `product_failure`, `infra_failure`, or `contract_failure`.
- `status=skipped` requires `exit_classification=skip_requested` and a non-blank `notes` field.
- `exit_classification=skip_requested` is valid only when `status=skipped`.
- `required=true` with `status=fail` means the lane-level `overall_status` must be `fail`.
- `flake_retried` is allowed only when a retained log explains the retry, `notes` summarize the retry context with non-blank text, and the final `status` is `warn`.
- All retained relative paths must resolve inside the evidence root; symlink escapes outside the root are invalid.
- `primary_artifact_relpath` may be empty only for pure gating/check phases with no output artifact beyond logs. Directory-style bundles belong in `result_bundle_relpath`, which must resolve to a directory when present.

## Minimal status model

- `pass` — every retained phase has `status=pass`
- `warn` — no required phase failed, and at least one retained phase is non-pass (`warn` or non-required `fail`)
- The tracked `recordit-e2e-evidence-hybrid-multiphase-warn` fixture demonstrates that a non-required failed phase still aggregates to lane-level `warn` when every required phase passes.
- The tracked `recordit-e2e-evidence-xctest-multiphase-warn` fixture demonstrates that an `xctest-evidence` lane can also aggregate to `warn` when a required phase completes with retained `flake_retried` evidence instead of a hard failure.
- The tracked `recordit-e2e-evidence-xcuitest-multiphase-warn` fixture demonstrates the same `warn` aggregation pattern for an `xcuitest-evidence` lane.
- `fail` — at least one required phase failed, or manifest/summary/log contract itself is invalid
- The tracked `recordit-e2e-evidence-hybrid-multiphase-fail` fixture demonstrates a retained multi-phase lane where a required verification phase fails and forces lane-level `overall_status=fail`.
- The tracked `recordit-e2e-evidence-xctest-multiphase-fail` fixture demonstrates required-failure aggregation for an `xctest-evidence` lane.
- The tracked `recordit-e2e-evidence-xcuitest-multiphase-fail` fixture demonstrates the same required-failure aggregation for an `xcuitest-evidence` lane.
- `skipped` — every retained phase is `status=skipped` because the lane was intentionally skipped before execution

## Why both CSV and JSON exist

- `summary.csv` is convenient for grep, spreadsheet diffing, and shell tools.
- `summary.json` is convenient for CI and downstream policy/scanner beads.
- `evidence_contract.json` is the full-fidelity retained manifest that ties the root together.

## Validator

Validator script:

- `scripts/validate_e2e_evidence_contract.py`

Primary usage:

```bash
python3 scripts/validate_e2e_evidence_contract.py --root <evidence-root>
```

Optional lane assertion:

```bash
python3 scripts/validate_e2e_evidence_contract.py --root <evidence-root> --expect-lane-type packaged-e2e
```

Canonical example fixtures:

```bash
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-minimal-pass --expect-lane-type packaged-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-minimal-warn --expect-lane-type packaged-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-minimal-fail --expect-lane-type packaged-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-minimal-skipped --expect-lane-type shell-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xctest-multiphase-pass --expect-lane-type xctest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xctest-multiphase-warn --expect-lane-type xctest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xctest-multiphase-fail --expect-lane-type xctest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xcuitest-multiphase-pass --expect-lane-type xcuitest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xcuitest-multiphase-warn --expect-lane-type xcuitest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-xcuitest-multiphase-fail --expect-lane-type xcuitest-evidence
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-hybrid-multiphase-pass --expect-lane-type hybrid-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-hybrid-multiphase-warn --expect-lane-type hybrid-e2e
python3 scripts/validate_e2e_evidence_contract.py --root tests/e2e_evidence_contract/fixtures/recordit-e2e-evidence-hybrid-multiphase-fail --expect-lane-type hybrid-e2e
```

The validator enforces:

- manifest presence and required fields
- root-file presence and shape
- per-phase unique IDs and timestamp formatting
- `summary.csv` row coverage for all phases
- existence of referenced logs / artifacts / result bundles
- status consistency between phase rows and lane-level aggregate files

Regression suite for the validator itself:

```bash
python3 -m unittest discover -s tests/e2e_evidence_contract -p 'test_*.py'
```

## Immediate downstream consumers

This contract is designed so downstream beads can consume one stable surface without inventing bespoke parsers:

- `bd-3co8` — DMG install/mount/open verification
- `bd-78qy` — default-user-journey app e2e lane
- `bd-v502` — failure-path packaged e2e lanes
- `bd-13tm` — contract validator enforcement lane
- `bd-3p9b` — CI gate on evidence completeness
