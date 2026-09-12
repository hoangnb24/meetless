# Issue #18: Preserve protected receipts during MAS updates

Validated: 2026-09-12. Independent review and Lead **ACCEPTS** the corrected
ordinary preserving updater, source `afeca3c42d635af35d68270ab15e53befcad89be`.
The exact four-file task patch is
`060fa2b276b51304a932549556ebce4462c9dfe68a7ef91d28e56f3f363ea0e4`.

## Failure and correction

The earlier full update produced and validated a signed candidate, then failed
with EACCES when recursive removal encountered the installed nested Apple
receipt. The receipt directory belonged to root with mode 0755; its receipt
was mode 0644. Most of the app had already been removed. Rollback repeated
the same removal and also failed. Runtime data remained intact. That full
update remains FAILED; the separately reviewed emergency recovery remains
PASSED and does not substitute for this ordinary-updater proof.

The updater now copies and validates a staged candidate before touching the
canonical app. Under the existing native stable lock, no-replace renames keep
the whole old app at a unique sibling path and move the staged candidate into
place. Installed validation uses the actual staged/canonical path. A known
replacement or validation failure restores the old whole app when identity
checks prove that safe; ambiguous state, foreign destinations or lost lock stop
without overwriting the remaining copies. It does not recursively remove the
installed receipt, change permissions, elevate privileges or reset runtime.

## Local proof

Twenty focused tests passed against the isolated minimal HEAD candidate,
along with library/CLI syntax checks. Real temporary filesystem/native-lease
proof reproduced old recursive removal failing with EACCES on a nested 0500
directory, then demonstrated successful whole-app swap while preserving its
receipt inode/mode and runtime data. Other cases cover staging validation,
second-move failure and restoration, installed-signature failure with a retained
failed app, collision and ambiguous destination handling. The temporary
directory uses the current user rather than root; it is a permission simulation,
not signed app or real Apple receipt acceptance.

Evidence: `.artifacts/issue18/source-integration/` retains the exact candidate,
patch, manifest, test log and dependency/claim limits. Existing unrelated dirty
runbook content was excluded from the committed candidate and preserved in the
working tree.

## Actual production path

The documented command `npm run dev:mas:update -- --reuse-current` ran under
source `afeca3c` and exited 0. It used the already produced and signed exact MAS
development manifest
`a3cca1f00f863ee652befbd69760d7c33fd74cef02e8f247170b0265adfc7d27`.
The app was not rebuilt: this gate exercises the corrected replacement and
readiness route against the real retained producer artifact. Its provenance is
recorded in the [#6 validation](issue-6-premium-validation-2026-09-12.md).

Metadata-only preflight established that the canonical app really contained a
new root-owned Apple receipt after the owner's Monthly purchase. The ordinary
updater retained the old whole app at
`/Applications/.Meetless-previous-c9b4193b-ec14-49f9-a2a8-846dfad39156.app`.
Old app inode `52256221`, receipt directory inode `52306397` and receipt inode
`52306398` were preserved. Receipt contents were not inspected or hashed.
Backup `backup-EtZMD7` and the earlier emergency-recovery copies remain intact.

Canonical strict signature validation passed. The fresh installed-client
readiness process returned seven meetings; host `23434` was absent and new host
`27841` was running. The UI finished loading and reported Host online. All 29
store/audio files and seven saved recordings were unchanged; runtime inode
`51230577` and stable-lock inode `51230576` remained. Live evidence is retained
in `.artifacts/issue18/live/`, including the preflight, actual command log,
post-update proof and handback.

Premium currently shows purchase availability rather than active. No cause is
inferred and no purchase/Restore/status action was taken in this update gate.
This acceptance concerns protected receipt/data preservation and the ordinary
update route; it does not change the separately recorded #6 result or establish
additional billing, release, CI or branch-protection acceptance.

The ordinary preserving updater is available for #10's next exact-candidate
installation. Retained app copies and backups must not be deleted implicitly.
