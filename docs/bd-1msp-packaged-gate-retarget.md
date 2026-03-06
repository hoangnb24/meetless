# bd-1msp: Retarget Packaged Live Gate to Recordit.app Launch Semantics

Date: 2026-03-05
Related bead: `bd-1msp`
Policy context: `docs/adr-005-recordit-default-entrypoint.md`

## Delivered

1. Updated `scripts/gate_packaged_live_smoke.sh` to enforce default packaged launch semantics before compatibility runtime checks:
   - signs `Recordit.app` (`make sign-recordit-app`)
   - captures deterministic `run-recordit-app` command plan output into `recordit_run_plan.log`
   - passes Recordit launch-semantic inputs into the packaged gate summary tool
2. Updated `scripts/gate_packaged_live_smoke_summary.py` to publish and gate on Recordit-default checks:
   - `recordit_plan_exit_ok`
   - `recordit_app_bundle_exists`
   - `recordit_launch_command_ok`
   - `recordit_sign_command_ok`
   - `recordit_launch_semantics_ok` (included in `gate_pass`)
3. Updated packaged gate docs and checklists to reflect new semantics:
   - `docs/gate-packaged-live-smoke.md`
   - `README.md`
   - `docs/post-implementation-verification-checklist.md`

## Acceptance Mapping

- "Packaged smoke/gates validate GUI-default launch semantics":
  - `recordit_launch_semantics_ok=true` now required for `gate_pass=true`.
- "plus required runtime artifact/trust/timing checks":
  - existing runtime checks remain intact (`runtime_first_stable_emit_ok`, `runtime_transcript_surface_ok`, trust/degradation and artifact-root checks).

## Notes

- This retarget keeps `SequoiaTranscribe.app` runtime assertions as compatibility/fallback evidence while requiring `Recordit.app` default launch semantics in the same gate outcome.

## Session Validation Evidence

Executed:

```bash
bash -n scripts/gate_packaged_live_smoke.sh
python3 scripts/gate_packaged_live_smoke_summary.py --help
make -n gate-packaged-live-smoke
DURATION_SEC=1 make gate-packaged-live-smoke
UBS_MAX_DIR_SIZE_MB=5000 ubs \
  scripts/gate_packaged_live_smoke.sh \
  scripts/gate_packaged_live_smoke_summary.py \
  docs/gate-packaged-live-smoke.md \
  docs/post-implementation-verification-checklist.md \
  README.md \
  docs/bd-1msp-packaged-gate-retarget.md
```

Observed packaged gate evidence:

- `status=pass` and `detail=packaged_live_smoke_thresholds_satisfied`
- gate artifact root:
  - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/20260305T051450Z/`
- key summary rows:
  - `recordit_launch_semantics_ok,true`
  - `runtime_first_stable_emit_ok,true`
  - `runtime_transcript_surface_ok,true`
  - `runtime_terminal_live_mode_ok,true`
  - `gate_pass,true`

UBS result:
- `Critical: 0, Warning: 0`
