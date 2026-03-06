# bd-55np — Release Rehearsal Report (Recordit.app DMG Lane)

Date: 2026-03-05
Rehearsal stamp: `20260305T070038Z`

## Objective
Run an end-to-end rehearsal of the Recordit.app-default DMG lane and produce operator-ready evidence with measured outcomes and explicit go/no-go determination.

## Rehearsal Procedure

```bash
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-bd55np-20260305T070038Z.dmg RECORDIT_DMG_VOLNAME='Recordit Rehearsal'
hdiutil attach dist/Recordit-bd55np-20260305T070038Z.dmg -nobrowse -readonly -mountpoint /tmp/recordit-dmg-XXXX
open -n /tmp/recordit-dmg-XXXX/Recordit.app
hdiutil detach /tmp/recordit-dmg-XXXX
```

## Measured Outcomes

Source: `artifacts/releases/rehearsal/20260305T070038Z/evidence/rehearsal_metrics.csv`

- `dmg_create_elapsed_seconds=34`
- `dmg_attach_elapsed_seconds=3`
- `dmg_launch_check_elapsed_seconds=3`
- `mount_has_recordit_app=1`
- `mount_has_applications_symlink=1`
- `launch_from_mounted_dmg_ok=1`
- `recordit_pid_observed=9747`
- `dmg_sha256=8629207cbba16688820f7e0deecdf451f23eeb0e8f5ca5bb6546b91c36260926`

## Evidence Paths

Rehearsal run artifacts:
- `artifacts/releases/rehearsal/20260305T070038Z/logs/create_recordit_dmg.log`
- `artifacts/releases/rehearsal/20260305T070038Z/logs/hdiutil_attach.log`
- `artifacts/releases/rehearsal/20260305T070038Z/logs/open_recordit_from_dmg.log`
- `artifacts/releases/rehearsal/20260305T070038Z/logs/hdiutil_detach.log`
- `artifacts/releases/rehearsal/20260305T070038Z/evidence/dmg_mount_listing.txt`
- `artifacts/releases/rehearsal/20260305T070038Z/evidence/dmg_applications_symlink.txt`
- `artifacts/releases/rehearsal/20260305T070038Z/evidence/Recordit-bd55np-20260305T070038Z.dmg.sha256`
- `artifacts/releases/rehearsal/20260305T070038Z/evidence/rehearsal_metrics.csv`

Supporting gate evidence consumed in this rehearsal report:
- `artifacts/ci/xctest_evidence/local-bd3jdm-r3/summary.csv`
- `artifacts/ci/xctest_evidence/local-bd3jdm-r3/responsiveness_budget_summary.csv`
- `artifacts/releases/rehearsal/20260305T070038Z/evidence/packaged_live_smoke.summary.csv`

## Pass/Fail Criteria and Result

1. DMG build succeeds and outputs a Recordit-named artifact.
- Result: PASS (`dist/Recordit-bd55np-20260305T070038Z.dmg` created).

2. Mounted DMG surface contains `Recordit.app` and `Applications -> /Applications`.
- Result: PASS (`mount_has_recordit_app=1`, `mount_has_applications_symlink=1`).

3. Mounted app launches successfully (process observed).
- Result: PASS (`launch_from_mounted_dmg_ok=1`, `recordit_pid_observed=9747`).

4. Latest packaged smoke gate remains green.
- Result: PASS (`latest_packaged_gate_pass=true` from `.../gate_packaged_live_smoke/20260305T051450Z/summary.csv`).

5. App-level responsiveness gate summary remains green.
- Result: PASS (`threshold_first_stable_transcript_budget_ok=true`, `threshold_stop_to_summary_budget_ok=true`, `responsiveness_gate_pass=true`).

## Go/No-Go Decision

Decision: **GO** for continuing the Recordit.app-default release lane based on this rehearsal.

Rationale:
- install surface and launch path behaved as expected
- packaging artifacts are deterministic and hash-recorded
- packaged smoke and app-level responsiveness gate signals are green in referenced evidence

## Support Handoff Notes

If field reports indicate install/launch issues:
1. verify mounted DMG contents against `dmg_mount_listing.txt`
2. verify launchability via mounted-app `open` + process observation
3. inspect latest packaged smoke status/summary for contract drift before rollback decisions
