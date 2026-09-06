# Execution Plan: Meetless V1 Remaining Release Work

## Status

- `plan_revision`: `v139` — documentation closeout consolidation
- `state`: `MAS_DEV_UI_GATE_CLOSED_REMAINING_RELEASE_GATES`
- `historical_record`: [full superseded execution history](../completed/v1-paseo-foundation-mas-ui-history.md)
- `authority_contract_sha256`: `ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`

This is the active navigation plan. It does not claim that all V1 release work
is complete and it does not authorize a new runtime or external operation.

## Accepted MAS development UI gate

The owner accepted the base desktop UI handoff: the private-temp MAS
development run `29c3a42e-475a-4d19-b843-ee830df5b756` from accepted artifact
`DTcivV` (source `55fe85f6d66445a80ecb805b1b77648c142f4670`) produced a visible,
interactable window and passed the requested basic UI test. This closes the
no-window startup blocker for owner exploration.

The latest read-only status reports an active transaction record but no live
processes, listeners, sockets, or open handles. The successful installation is
intentionally stopped; its transaction and prior app/runtime backups remain
coordinator-preserved. It is not claimed restored or archived, and no inference
is made about who stopped it. No automatic relaunch, retry, recording, or
monitoring is active.

This gate proves desktop UI availability for the accepted development path. It
does not prove real recording or TCC attribution, Electron second-instance
routing, purchase/restore, managed production, store publication, or legal
release acceptance.

## Completed authority and evidence

- The full source, package, and live UI convergence ledger is preserved in the
  [completed history](../completed/v1-paseo-foundation-mas-ui-history.md).
- The accepted MAS development integration is recorded in
  [ADR0006](../../decisions/0006-mas-development-desktop-integration.md).
  ADR0003 remains the runtime/host boundary; ADR0004 remains the recording and
  TCC boundary; ADR0005 and [Premium](../../product/monetization.md) remain the
  managed-transcription, billing, and store authorities.
- Managed-transcription policy, fake-backed foundation proof, and the
  region-neutral local Convex boundary are already promoted into ADR0005 and
  product authority. This plan links to them instead of duplicating their
  contract.
- The direct-DMG route in ADR0002 is superseded history, not an active
  prerequisite for the selected Mac App Store path.

## Remaining work boundaries

These are open obligations carried forward from the history; this plan does
not authorize them. Each requires its own owner/Lead scope and evidence.

1. **Real recording and TCC.** The historical `TCC-V1-CORRECTION-R3` candidate
   still needs its clean-main rebind and Lead acceptance before a live gate.
   Then prove packaged host/helper permission attribution, clean-install and
   persistence behavior, microphone and system audio capture, recoverable
   finalization/export, and supported-target limits on an authorized macOS run.
   Preserve the ADR0004 rule that the host owns TCC and the helper owns capture;
   repository fixtures are not live proof.
2. **Packaged second-instance behavior.** Prove the MAS Electron singleton and
   second-instance handoff with the accepted shared `userData` and private temp
   lifecycle. The visible first window does not establish this routing.
3. **Store and billing operations.** Apply and validate the profile-backed App
   Sandbox/In-App Purchase configuration, replace unrestricted writable paths
   with container/export-safe behavior, and produce a validated sandbox build.
   Prove sandbox purchase, cancellation, restore, offline/free behavior, device
   enrollment, and RevenueCat webhook handling. Complete App Store Connect
   agreements, availability/eligibility, and release metadata under the
   ADR0005/monetization contracts; credentials remain external and must not be
   recorded here.
4. **Managed production.** Configure an explicit production subscriber
   allowance, select and deploy the owner-authorized hosted region, bind the
   verified Apple lineage and provider access, and measure the production
   lifecycle/latency/cleanup behavior. Local Convex and fake-provider proof
   does not establish these gates.
5. **Release and legal acceptance.** Capture the required icon, screenshots,
   demo, privacy, review, and launch evidence; validate the exact release
   artifact and clean-install/update path; complete the license/NOTICE/AGPL
   review; upload and process the selected Mac App Store build; pass App
   Review; and record the public listing only after it exists. The paused
   `M7-F29` direct-DMG notarization/stapling route remains historical and is not
   an active prerequisite. These are external/release gates, not implied by
   the local UI result.

## Scope guard

No new recording, TCC, purchase, restore, production, publication, legal,
package, sign, install, launch, recovery, or cleanup action is opened by this
document. The coordinator remains the sole owner of preserved runtime state;
future work must use its recovery/status contract. The Paseo runtime supervisor
is legitimate process-manager code, not a Codex Room Supervisor role. Neither
the Paseo fork nor Meetless artifacts may contain Codex Room Supervisor/Lead/Peer
role configuration; that belongs only to `codex-room-setup`.

## Documentation closeout note

This consolidation changed navigation and documentation only. The full prior
plan body is retained above in the completed history, with only the superseded
header and three sibling-history link relocations normalized. The frozen four
authority files and their aggregate digest remain unchanged.
