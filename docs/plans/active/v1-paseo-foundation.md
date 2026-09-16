# Meetless V1 — stopped pending product direction

Updated: 2026-09-16

## Current decision

The owner stopped the current V1/App Store development direction after the
installed-provider assumption failed on the actual TestFlight path, then asked
to close related issues and update product/ADR authority. See
[ADR0007](../../decisions/0007-stop-v1-pending-product-direction.md).
Permanent shutdown versus pivot is undecided. There is no active implementation,
provider experiment, next TestFlight build or App Review submission authorized
by this plan. Prior continuation instructions are historical, not current work.

This record stays at its existing path to preserve incoming evidence links.
It is stopped, not a completed/accepted V1 plan.

## Evidence retained

- TestFlight builds through 1.0 (6) were delivered internally. Build 6 source:
  `de5ea797ace59601f9eebfb109dc9f59f9992135`; package SHA-256:
  `4617bc0884dba83175f8acc9e4f933f3a5e682779b2cddf38042784697f662e7`.
- Build 6 passed its producer/signing/delivery checks, but the actual Apple
  runtime rejected selection of the existing Codex executable. No successful
  Ask answer was established. Lead rejection of Ask acceptance remains.
- The owner confirmed recording/permission recovery, a Monthly sandbox purchase
  and transcription on TestFlight build 4. These bounded successes remain valid;
  they do not prove full production billing, complete permission coverage,
  branding acceptance or the complete product journey.
- File chooser/bookmark access does not itself grant execution. Symlinks do not
  add target permissions. Static allowed locations or narrow exceptions are
  research possibilities, not verified fixes or App Review approval. No new
  experiment was performed after that research.
- Historical source, failed attempts, exact artifacts, backups and private
  runtime evidence are retained. No application data or deployed service is
  removed by this decision.

## Tracker disposition

Close as **not planned**, not completed: #5 (purchase presentation), #14
(launch/reboot), #15 (billing acceptance), #16 (managed production acceptance),
#17 (App Store readiness), #20 (hosted quota/recovery), #21 (production epic),
#30 (remaining permission acceptance), and #31 (branding acceptance).
Preserve their existing checklists, dependencies and evidence as history; no
unchecked acceptance item becomes passed. Archive their Project cards so they
are not presented as executable work. Already completed issues retain their
existing acceptance scope.

## Closeout work and validation

Root owns issue/Project disposition, documentation navigation and this record;
a separate author updates product/ADRs, with an independent reviewer for the
combined result. Validate local document links and whitespace, then read back
GitHub issue state/reason and Project archive state. This validates administrative
closeout only, not the stopped product or any new runtime behavior.

Closeout verification on 2026-09-16:

- GitHub GraphQL readback confirmed all nine issues `CLOSED / NOT_PLANNED`,
  each with its current disposition before the retained historical body.
- Direct Project item readback confirmed `isArchived: true` for all nine cards.
- Both pre-stop active plans were preserved byte-for-byte against Git HEAD in
  the historical snapshots linked below.
- All 104 local Markdown links across the 18 changed/new documents resolved;
  `git diff --check` passed. No runtime tests or builds were run for this
  documentation-only change.
- Independent reviewer `review_stop_closeout` ACCEPTS documentation/admin
  closeout after correcting historical runbook and release-packet wording.
  Lead ACCEPTS this closeout only; V1 and actual Ask remain unaccepted.
  This does not reopen development or any closed acceptance work.

## Retained execution history

- [V1 source and release history through 2026-09-15](../history/v1-paseo-foundation-through-2026-09-15.md)
- [Permission recovery disposition](issue-30-capture-permission-recovery.md)
- [Historical snapshots](../history/README.md)

Infrastructure, RevenueCat/Apple configuration, TestFlight access, Cloudflare
website, Convex deployments, keys and backups are unchanged. Decommissioning
or a pivot needs a separate owner decision; issue closure does not perform it.
