# `bd-mcva` Compatibility Gate Report

## Scope

- bead: `bd-mcva`
- objective: run compatibility gates and verify output compatibility against the frozen baseline
- lane owner: `MaroonCreek`

## Root Cause Fixed

`make gate-transcript-completeness` was failing in valid `pressure_profile=buffered-no-drop` runs.

Why:

- `scripts/gate_backlog_pressure_summary.py` is already profile-aware and can pass with either:
  - `drop-path`, or
  - `buffered-no-drop`
- `scripts/gate_transcript_completeness_summary.py` still hard-required drop/reconciliation signals (`reconciled_final`, trust/degradation reconciliation codes), which is incompatible with valid buffered-no-drop behavior.

Fix:

1. `scripts/gate_transcript_completeness.sh`
   - pass backlog summary CSV path into transcript-completeness summarizer.
2. `scripts/gate_transcript_completeness_summary.py`
   - add `--backlog-summary-csv`
   - derive/validate `pressure_profile`
   - run profile-aware threshold logic:
     - `drop-path`: preserve strict reconciliation-gain assertions
     - `buffered-no-drop`: require no false-positive reconciliation signals and stable high pre/post completeness
   - emit profile metadata (`pressure_profile`, `canonical_source`) and `threshold_pressure_profile_known_ok`.

## Validation Evidence

### Full sweep command

```bash
make contracts-ci && make gate-backlog-pressure && make gate-v1-acceptance && make gate-transcript-completeness
```

### Results

1. `make contracts-ci`
   - result: pass

2. `make gate-backlog-pressure`
   - output root: `artifacts/bench/gate_backlog_pressure/20260302T074649Z`
   - status: `pass`
   - key rows:
     - `pressure_profile=buffered-no-drop`
     - `gate_pass=true`

3. `make gate-v1-acceptance`
   - output root: `artifacts/bench/gate_v1_acceptance/20260302T074722Z`
   - status: `pass`
   - key rows:
     - `backlog_pressure_profile=buffered-no-drop`
     - `backlog_pressure_profile_known_ok=true`
     - `gate_pass=true`

4. `make gate-transcript-completeness`
   - output root: `artifacts/bench/gate_transcript_completeness/20260302T074823Z`
   - status: `pass`
   - key rows:
     - `pressure_profile=buffered-no-drop`
     - `canonical_source=stable_final`
     - `pre_completeness=1.000000`
     - `post_completeness=1.000000`
     - `threshold_pressure_profile_known_ok=true`
     - `gate_pass=true`

## Compatibility Conclusion

`bd-mcva` compatibility gates are green with profile-aware semantics aligned across backlog and transcript-completeness harnesses. No runtime contract change was required; this was a gate interpretation mismatch fix.
