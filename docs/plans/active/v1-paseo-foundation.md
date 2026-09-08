# Execution Plan: Meetless V1 Remaining Release Work

## Status

- `plan_revision`: `v202` — fresh sandbox purchase and managed enrollment accepted
- `state`: `PREMIUM_SANDBOX_PURCHASE_ACCEPTED`
- `historical_record`: [full superseded execution history](../completed/v1-paseo-foundation-mas-ui-history.md)
- `authority_contract_sha256`: `7db7cd6d94781a1367d3f66aaf5a9febdd8abedc703117741a994ea64da8a1a0`

This is the active navigation plan. It does not claim that all V1 release work
is complete. The owner opened only the bounded monthly sandbox purchase and
explicit restore scope below on 2026-09-06; every other runtime or external
operation remains closed.

## Accepted MAS development UI gate

The owner accepted the base desktop UI handoff: the private-temp MAS
development run `29c3a42e-475a-4d19-b843-ee830df5b756` from accepted artifact
`DTcivV` (source `55fe85f6d66445a80ecb805b1b77648c142f4670`) produced a visible,
interactable window and passed the requested basic UI test. This closes the
no-window startup blocker for owner exploration.

The latest read-only status reports an active transaction record but no live
processes, listeners, sockets, or open handles. The successful installation is
stopped and intentionally retained; its transaction and prior app/runtime backups remain
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

## Current opened scope: monthly sandbox purchase presentation correction

### Outcome

From an exact corrected MAS development artifact, the owner can press the
monthly package in the visible Meetless desktop UI, receive immediate progress
feedback, see the Apple sandbox purchase confirmation UI, cancel without being
granted Premium, complete one sandbox purchase, and explicitly restore that
purchase. The retained evidence must distinguish UI dispatch, plugin RPC,
trusted-native invocation, StoreKit completion, and normalized outcome without
recording a receipt, signed transaction, credential, secret, or raw native
error.

### Authority and stable contract

- ADR0005 and `docs/product/monetization.md` are the product and architecture
  authority. The trusted native host continues to own RevenueCat/StoreKit; the
  renderer receives only typed package, entitlement, purchase, restore, and
  normalized error results.
- Only the monthly product is opened for a real sandbox transaction. Annual
  purchase, production purchase, provider spend, managed-production admission,
  and publication remain closed.
- Purchase and restore remain explicit user actions. Cancellation never grants
  Premium, and unavailable purchase services never disable recording, meeting
  evidence, Ask, or user-supplied transcription.
- The correction may provide an AppKit presentation anchor and use the
  RevenueCat/StoreKit macOS window-confirmation API. It must not move transaction
  material into Electron or weaken the authenticated native boundary.

### Dependencies and write ownership

- The accepted MAS development profile, signer, bundle identity, public
  RevenueCat SDK key, catalog, Apple credential association, and hosted
  development configuration are dependencies to revalidate, not foundations to
  rebuild.
- The preserved MAS session `29c3a42e-475a-4d19-b843-ee830df5b756` remains
  coordinator-owned. Repository work may proceed, but package, install, launch,
  restore, archive, or cleanup must use its status/recovery contract and must not
  overwrite the retained artifact or runtime state.
- This scope has one moving writer. Its bounded write surface is the native
  RevenueCat/AppKit adapter and tests, the Premium interaction feedback and
  tests, any narrowly required MAS purchase-proof harness, and this active plan.
  Unrelated runtime, recording, TCC, managed-production, and release files are
  not part of the write surface.
- A present owner using the configured Apple sandbox account is required for
  the confirmation, cancellation, purchase, and restore interactions. Automation
  must not confirm a purchase on the owner's behalf.

### Approach and progress

- [ ] Preserve a failing diagnostic that proves the current package receives the
  purchase request but does not present a usable confirmation flow, without
  initiating another transaction merely for discovery.
- [x] Add redacted stage/outcome observability and immediate in-app progress
  feedback.
- [x] Correct the trusted host's macOS purchase and entitlement-convergence path and add focused
  positive and failure/cancellation tests.
- [x] Run focused native, contract, client, plugin, surface, and MAS validation;
  then inspect and accept or reject the exact candidate.
- [ ] Through the coordinator, build and launch one exact corrected development
  artifact and conduct the owner-driven monthly sandbox cancellation, purchase,
  and explicit restore checks.
- [ ] Record the exact artifact/evidence binding and close only this scope after
  all acceptance evidence passes.

### Source acceptance checkpoint (2026-09-06)

Lead accepts source candidate `c172a6e1d8f9bb0f3ac4f34d3026885f337c5ba46143d6f91ad2eddfe57f5fcf`,
the SHA-256 of the exact eight-file diff over base
`e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`. The trusted host now owns a
visible AppKit confirmation anchor that cannot be closed, minimized, or moved
while in use; macOS 15.2+ routes that exact window through RevenueCat
`PurchaseParams.with(confirmInWindow:)`. Purchase and restore serialization and
the presentation anchor remain owned until the RevenueCat callback completes;
there is no arbitrary interactive timeout pretending to cancel StoreKit.
Direct main-thread invocation fails closed. UI, plugin RPC, native RPC,
trusted-native presentation, StoreKit callback, and normalized completion use
distinct categorical diagnostics without transaction material or raw errors.

Lead independently observed `npm run build:native` pass with debug and release
native tests, `npm run typecheck` pass, seven relevant Vitest files with 116
tests pass, and `git diff --check` pass. Positive and negative native proof
covers visible acquire/release/reacquire, hidden or unavailable presentation,
the exact acquired-window identity at the window-bound parameter builder,
main-thread rejection, callback outcome normalization, and no overlapping
mutation while a callback is pending. UI proof covers immediate pending feedback
and repeat-action suppression; plugin proof separates mutation diagnostics from
ordinary status refresh. Local repository commands own this proof. No root hook
or checked-in GitHub workflow invokes these focused checks; branch-protection
enforcement remains unverified.

A fresh read-only Peer recommended rejection because the unit seam does not
capture private RevenueCat parameter internals from a real configured
`Purchases` instance, duplicate SDK callbacks could emit extra diagnostics, a
missing SDK callback would keep the operation pending, and ordered diagnostics
are not yet end-to-end. Lead does not treat those as source blockers: the pinned
RevenueCat 5.87.1 implementation and successful native compilation establish
the window API route, RevenueCat exposes no safe cancellation primitive for an
arbitrary timeout, state is first-callback-wins, and the packaged sandbox gate
below is the required integration and end-to-end evidence. These points reopen
source acceptance if the live flow shows a lost callback, duplicate completion,
an unusable anchor, or diagnostics that cannot distinguish the required stages.
No package, signing, installation, launch, or transaction is accepted by this
checkpoint.

### Artifact acceptance checkpoint (2026-09-06)

Lead accepts the exact signed development artifact at
`/private/tmp/meetless-mas-development-proof.sKxjIP/release/macos/Meetless.app`
and its adjacent `app-store-development-manifest.json`. The repository's
production install preflight independently returned `passed` against ADR0005
with manifest SHA-256
`fb3735cffd0bc6063bba655b032f1dbb53169902638c9566a88eefdf857c15c5`,
bundle fingerprint
`fb509091bba30b5e3f11ddf232e5f374f899c5ed5051bc9a32a2f736278f766a`,
and signed artifact digest
`a4c1098ee7b2dd626e6589d10127dcb89ed389ce7e89a79097dc649c20f734d0`.
The retained direct composition binds HEAD `e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`
plus the current package-source snapshot digest
`30ac589877111b807028cdc9c23e519c57bba460ed57ff4f75d093e66cd0d1ce`;
an immediate repository snapshot reproduced that digest, while the accepted
eight-file correction remained `c172a6e1d8f9bb0f3ac4f34d3026885f337c5ba46143d6f91ad2eddfe57f5fcf`.

The artifact is a thin arm64 MAS development bundle for `com.meetless.app`,
signed by the accepted Apple Development identity and team, with the exact R5
profile (expires 2027-09-01), App Sandbox entitlement closure, 43 inventoried
Mach-O entries, 42 verified nested signatures, Electron MAS 41.2.0, the
container-safe installation contract, and the expected public RevenueCat key
hash. Package creation and the independent preflight both passed. Launch and
purchase remain explicitly `not-run`, and distribution remains `not-claimed`.

### Current live checkpoint (2026-09-06)

The coordinator restored and archived preserved session
`29c3a42e-475a-4d19-b843-ee830df5b756` before any replacement. It then
installed only the accepted artifact above with the explicit 1 GiB free-space
preflight and opened new recoverable session
`527e2e47-75e7-4bd1-af88-7270a03eb5c9`. The installed bundle identity and
candidate binding matched; the app claimed the coordinator handoff at
2026-09-06T11:33:13Z. No purchase or restore has been automated or claimed.
The next action is the present owner's monthly cancellation check in the
visible UI; annual purchase remains closed.

The owner then pressed Monthly once. The visible Meetless UI immediately
changed both package actions to `Opening Apple confirmation...`, displayed
`Working...`, and presented Apple's account confirmation sheet over Meetless.
The owner selected Cancel. The UI returned to enabled Monthly, Annual, and
Restore actions without displaying active Premium. Correlated redacted runtime
diagnostics recorded exactly one ordered UI dispatch, plugin RPC dispatch,
native RPC dispatch, plugin completion `cancelled`, and UI completion
`cancelled`; the request completed in 14,245 ms. This accepts presentation and
cancellation without claiming a purchase or restore. The next owner action is
one real monthly sandbox purchase on this same running artifact.

The owner reported that no known Sandbox Apple Account is available. This is
an external account dependency, not an application correction. The installed
artifact and recoverable session remain live and unchanged; no purchase or
restore was attempted after the accepted cancellation. Resume only after an
authorized App Store Connect team member creates or identifies a dedicated
Sandbox Apple Account and the owner signs into the macOS App Store sandbox
surface. Do not substitute an existing personal Apple Account.

The owner subsequently created or obtained the required sandbox account and
completed one Monthly transaction. Apple's system UI visibly reported a
successful purchase in the Sandbox environment, so the external transaction
presentation and confirmation path passed. Meetless did not converge: the UI
returned to enabled package actions, retained no visible active Premium state,
and displayed `Purchase could not complete. Try again.` Correlated redacted
diagnostics show UI dispatch at 19:52:31.804 local, plugin and native dispatch
at 12:52:31.806Z, UI completion `failed` at the 30-second boundary, and plugin
completion `failed` at 12:54:02.707Z, roughly 90.9 seconds after dispatch.

Lead therefore rejects the Meetless purchase-completion and entitlement-refresh
gate while accepting only Apple's sandbox transaction success. This reopens the
source/integration decision under the previously recorded lost-callback and
indistinguishable-completion conditions. No receipt, signed transaction,
account identifier, credential, raw native error, or screenshot containing the
sandbox account is retained. Explicit restore remains unattempted; annual and
production purchase remain closed. Two separate backlog issues were created
for the app-owned purchase presentation UX and this correctness defect.

Lead accepts the resulting GitHub backlog after inspecting the exact remote
issues: [#5](https://github.com/hoangnb24/meetless/issues/5) owns only the
app-controlled purchase presentation, feedback, focus, accessibility, and
Meetless design work while keeping Apple's StoreKit sheet explicitly
system-owned; [#6](https://github.com/hoangnb24/meetless/issues/6) owns the
successful-Apple/failed-Meetless completion and entitlement-convergence defect,
including deadline, delayed callback, duplicate suppression, explicit Restore,
and relaunch/status proof. The existing `enhancement` and `bug` labels were
used respectively, no milestones were added, and no screenshot, sandbox
account, secret, or transaction material was published. These issues preserve
the reopened work; creating them does not close the live gate.

The owner then invoked explicit Restore once on the same running artifact.
Meetless showed loading and returned `No active Premium purchase was found.`
Correlated categorical diagnostics contain exactly one UI, plugin, and native
dispatch followed by plugin and UI `failed` completion after 5,774 ms. This
rejects the explicit Restore and relaunch/status-convergence subset of the live
gate and proves that the defect is not limited to the earlier 30-second client
deadline. No additional purchase was attempted and no private transaction or
account data was retained. The next frontier is a bounded source correction for
#6, followed by a new exact artifact; issue #5 remains non-blocking backlog.

Before replacing that artifact, a read-only coordinator status check failed
closed because the committed installed package no longer matched its original
fingerprint. A checksum comparison against the retained accepted artifact found
one content-only difference: the standard App Store receipt leaf now exists
inside the running nested Electron app, while every ordinary package file
remains byte-identical. No receipt bytes, digest, account data, or transaction
detail was read or retained. This appearance after the sandbox transaction is
expected App Store state, but the current outer bundle places the signed nested
Electron app under `Contents/Resources`; consequently the added receipt also
makes top-level `codesign --verify --deep --strict` fail solely as an added
nested resource even though the nested Electron app itself still verifies.

Package recovery and future artifact composition are therefore reopened before
any stop, rollback, package, install, or launch. A receipt-aware recovery rule
may be accepted only if it preserves byte-sensitive proof everywhere outside
the exact Apple-owned receipt leaf, rejects malformed or colliding receipt
structures without recording private material, and does not mask an invalid
future package layout. If the safe route requires moving nested Electron code
to a standard signed-code location or another broader package-contract change,
that dependency must be resolved before building the corrected artifact. The
current coordinator-owned session and receipt-bearing bundle remain running and
untouched while this decision is open.

Lead accepts package-recovery candidate
`8d56ccdcd9ece519cfe7b05741a2720c32459c274973230e033af3549e3eeb30`,
the SHA-256 of the exact two-file diff in the native package-transaction owner
and its focused test over base `e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`.
Only the observed nested Electron `_MASReceipt/receipt` leaf is
fingerprint-neutral; its containing structure must be one non-symlink directory
with exactly one regular, non-symlink, single-link leaf. Receipt bytes are not
read or hashed. Receipt-shaped content under any other app, malformed receipt
structure, and every ordinary package mutation continue to fail with an
ADR0005/actionable diagnostic. The whole receipt-bearing candidate remains
transaction-owned during displacement; no private material is copied or
deleted separately.

Lead independently observed syntax and diff checks pass, the focused
package-transaction owner suite pass 45/45, the retained source and installed
receipt-bearing artifact normalize to the same fingerprint, and the real
coordinator status return `active`, runtime phase `ready`, and package status
`committed` for run `527e2e47-75e7-4bd1-af88-7270a03eb5c9`. This acceptance
authorizes recovery of that exact session only. It does not accept the current
future package layout: the nested Electron app remains under outer
`Contents/Resources`, and top-level strict code-signature verification fails
after Apple adds the receipt. That composition/signature blocker must be
corrected before another artifact is built or installed.

The owner explicitly authorized the coordinator's stop, package rollback,
runtime-root restoration, and session archive after being told their exact
effects and reversibility. The coordinator stopped the owned app and restored
the prior canonical `/Applications/Meetless.app`, then failed closed before
runtime restoration when recursive disposal of the displaced candidate reached
the protected StoreKit receipt and returned `EACCES`. The package journal now
reports `target-restored` with an in-flight cleanup path whose fingerprint
changed as cleanup progressed. The receipt was not deleted or modified; runtime
restoration and session archive did not run, and retained recovery evidence
remains present.

The owner then authorized a narrower recovery correction: preserve the entire
remaining receipt-bearing disposable tree with durable provenance, never touch
the receipt as an individual file, complete package rollback proof, and only
then resume the existing package-before-runtime restore/archive order. A sole
writable Peer owns only the package-transaction implementation/tests and, if
strictly required, the coordinator integration/tests. It must reject arbitrary
partial deletion or ownership drift, prove the exact receipt-stopped residue in
positive and negative fixtures, and must not execute live recovery. No further
application, package, runtime-root, receipt, or user-data mutation is permitted
until Lead accepts that exact source candidate.

Lead accepts the fresh read-only package-layout finding against HEAD
`e29e33a44f3a0b4b84ab936f5dc7c34ba927e609` and the reported focused worktree
snapshot `6bae649a1def67f86777c182628ada681f6859b5302698894bf24ac9fdc52a53`.
Apple's documented nested-code locations designate `Contents/Helpers` for
helper apps and tools, while `Contents/Frameworks` is for frameworks and
dylibs; code left under `Contents/Resources` is sealed as outer resource data.
The selected future location is therefore exactly
`Contents/Helpers/Electron.app`, not `Frameworks` and not another custom
subdirectory. The Electron main bundle ID, internal helpers, entitlements,
host topology, cwd/argv, user data, and ADR0006 private-temp behavior remain
unchanged.

This technical route requires an ADR0006 amendment and a versioned,
bundle-relative Electron executable descriptor rather than `..` traversal in
the current package-root-relative resource field. Lead owns that architecture
choice; it is not a new product, cost, or external-effect decision. The shared
direct composition must not be broadened merely for convenience: implementation
must first determine the smallest MAS-specific contract overlay that leaves the
historical direct route unchanged. Acceptance requires strict/deep outer and
nested signature proof both before and after an opaque receipt-shape fixture,
plus exact contract/manifest/input/license/topology positives and negatives.
No future artifact may be built until this change is accepted.

Lead rejects interrupted-recovery candidate
`72fc08420e27f00ee645cfe35dfd96d8acf4da9320c40bd1180ecbc82f1b4bb1`
after inspecting its exact two-file diff over HEAD
`e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`. Although its focused 47-test
suite, syntax check, coordinator-ordering test, and diff check passed, its
fixture does not match the real interrupted tree. The real disposable still
contains 4,843 ordinary files, four symlinks, and 1,354 directories, while the
candidate accepts only a pruned receipt-only ancestor chain. It also requires
the Apple receipt to share the package root's owner, but the observed regular,
single-link receipt is Apple/root-owned while the package root is user-owned.
Finally, the candidate deliberately deletes every non-receipt subtree from a
full receipt-bearing package; this contradicts the owner's explicit decision
to retain the complete remaining tree without further deletion.

The reopened correction must leave the whole current disposable at its exact
journaled path, prove that every remaining non-receipt entry is an unchanged
subset of the artifact-bound candidate without reading or hashing receipt
bytes, allow the exact Apple-owned receipt identity, and durably attest the
whole retained residue. A future full receipt-bearing rollback must likewise
retain the whole bundle untouched. Positive proof must preserve unrelated
ordinary siblings across first recovery and rerun; additions, modifications,
foreign/malformed/hardlinked receipts, changed root identity, or missing source
proof must fail before mutation. No live recovery is authorized from the
rejected candidate.

The original writer's correction handback repeated the exact rejected hash
`72fc08420e27f00ee645cfe35dfd96d8acf4da9320c40bd1180ecbc82f1b4bb1`;
the code therefore did not change and Lead rejects the repeated handback. A new
sole writable Peer now owns the same two files and must replace the rejected
behavior. No lifecycle status or passing-test claim overrides the exact
candidate mismatch recorded above.

Lead rejects the replacement recovery candidate
`ff22ef472742b6587c691893afffe0e7f745ef0de6a201ab40a23de9a001db14`
after its 49-test package-transaction suite, syntax check, runtime typecheck,
and diff check passed but a read-only status run against the exact interrupted
state failed closed before mutation. The candidate compares source-artifact
ownership metadata to the installed copy: the source `Contents` directory is
`uid 501/gid 0`, while the retained installed directory is `uid 501/gid 80`.
That installation-time group normalization is not evidence of changed package
content. Its next receipt-chain check would also reject the exact observed
Apple/root-owned `_MASReceipt` directory and regular, single-link receipt
because the retained package root is user-owned. No receipt bytes were read and
no live path was changed.

The reopened two-file correction must use the artifact source to prove ordinary
path/type/content and only copy-stable metadata, while keeping the journaled
local disposable-root identity as the ownership/collision anchor. It must
accept the exact Apple/root-owned receipt chain without relaxing exact path,
shape, regular-file, single-link, whole-tree retention, source-subset, or later
drift checks. Positive proof must model the real source/destination group
difference and Apple-owned receipt chain; negative proof must show that metadata
normalization cannot authorize added or changed content. A fresh read-only Peer
is challenging the exact rejected snapshot while the sole writer corrects it.

The fresh read-only Peer returned `REOPEN_REQUEST`, which Lead accepts. It
independently confirmed the source/installed GID and Apple-owned receipt-chain
blockers in the frozen `ff22ef…` snapshot, and found three additional gaps:
retained inventory was unbounded, journal publication lacked file and parent
directory `fsync`, and check-then-delete races could still reach recursive
`rm`. Finalization receipt preflight also covered only `committed`, rather than
every non-rollback cleanup state. The Peer correctly declined to treat the
writer's moving replacement diff as the reviewed snapshot. The reopened writer
contract now includes bounded durable attestation, sticky receipt observation,
and all-state finalization refusal; no live mutation may precede a frozen
candidate and Lead acceptance.

Lead also rejects the subsequent frozen candidate
`82287f686f5f2acb3008b03f8140541a4ffdce1f4972465cd7d95671b16e01ad`
after independent syntax, typecheck, diff, and 51-test proof passed and the
exact live read-only MAS status finally returned `active/ready` with package
`recovery-required/target-restored`. The candidate correctly fixes copy-stable
metadata, Apple-owned receipt-chain handling, compact digest/count provenance,
journal file and parent-directory `fsync`, old-journal normalization, sticky
receipt observation, and all finalization states. However, a fresh independent
challenge proved that its final receipt inspections are still followed by a
path-based recursive `rm`; an Apple/root writer can create the receipt in that
last interval, and the test injects only during an earlier inspection. The gate
lock does not serialize that external writer.

The reopened correction must either close that final check-to-delete race with
deterministic post-check insertion proof or report that the only safe route is
conservative package retention. It must not silently select recurring retained
package disk cost or a future-install blocker; those consequences require the
owner's decision if they are material. The exact live status proof was
read-only, no recovery ran, and every preserved path remains unchanged.

The replacement writer has frozen two-file candidate
`70ce6971aa64eb91d0c77dbbb09e868d3aa079fdcff3bfc728ef8ee3ba41016a`
over the same HEAD. Package trees now use only snapshot-listed `unlink` and
nonrecursive `rmdir`; recursive removal remains limited to journal/temporary
files. Lead independently confirmed the exact diff hash, syntax, runtime
typecheck, diff check, and the complete transaction test file at 51/51. The
real coordinator status is still read-only `active/ready` with package
`recovery-required/target-restored`; no live recovery or receipt read occurred.

Acceptance remains pending a fresh exact-snapshot challenge. In particular,
the challenge must decide whether the deterministic seam really covers receipt
creation after the final inventory observation and before or during the first
snapshot-listed unlink. If any reachable insertion can delete an ordinary path
before receipt detection, the candidate remains rejected despite passing proof.
The known current residue already contains its receipt and must be retained in
full, but generic cleanup may not claim a stronger race invariant than it
actually enforces.

The fresh exact-snapshot Peer returned `REOPEN_REQUEST`, which Lead accepts,
and Lead rejects `70ce6971…`. Both cleanup callers invoke the deterministic
insertion seam before the removal routine takes its final inventory. A receipt
can therefore appear after that inventory or during its unlink loop; earlier
ordinary entries can be removed before a later nonempty directory exposes the
receipt. The 51/51 proof establishes the pre-existing-receipt case but does not
establish the accepted arbitrary Apple/root-writer race invariant.

There is no atomic recursive package deletion primitive that can both remove
the tree and preserve every ordinary inode if an uncoordinated root writer adds
a receipt during that deletion. The smallest technically safe route is to
retain every rollback package disposable and journal its provenance rather
than delete package trees. That changes recurring storage behavior and requires
the owner's decision before implementation. Read-only allocation evidence for
the current machine is approximately 334 MiB for the already partial retained
candidate and 925 MiB for the restored application; no path or receipt content
was changed or read to obtain that evidence.

The owner accepts the recommended conservative route: during rollback/recovery,
retain every displaced application package intact with durable provenance and
leave deletion to a separate explicitly authorized cleanup operation. This
does not authorize retaining ordinary package backups after a successful
installation, does not authorize any cleanup now, and does not broaden the
current gate beyond its existing package-before-runtime recovery order. The
implementation must support every rollback disposable without overwriting an
earlier retained record, must be idempotent, and must prove no package entry is
unlinked or recursively removed in rollback even when no receipt is initially
present or one appears at any later seam.

Writer candidate
`7323a7e5e6f0dd357d59baa069585d35065736df25d15db9feb2961801a22ac8`
over the same HEAD is not accepted. Lead independently observed syntax,
runtime typecheck, diff check, and its complete transaction file pass 55/55,
while the existing MAS development-gate integration file fails 1/24 only
because it still expects the rollback package journal to be deleted. That
integration expectation must be changed to assert the accepted durable
retention evidence, but it is not the current source-level blocker.

The candidate's generic retained-package record still requires every retained
fingerprint to equal `transaction.candidateFingerprint`. The reachable
`prior package backup` rollback branch passes
`transaction.previous.targetFingerprint`, so a duplicate prior backup cannot
be attested and retained even though the owner explicitly included backup in
the transaction-owned package set. Existing multi-record proof covers only the
candidate displaced/staging pair. A fresh read-only Peer is challenging this
exact snapshot. Unless that premise is disproved, the candidate must be
corrected with an honest per-record package fingerprint/source proof and a
prior-backup positive plus drift/collision negative before acceptance.

The fresh exact-snapshot Peer returned `REOPEN_REQUEST`, which Lead accepts,
and Lead rejects `7323a7e5…`. The Peer independently confirms that four slots
cover target/displaced/backup/staging and that no recognized rollback package
reaches the deletion routine, but the prior-backup path is blocked by the
candidate-only fingerprint field and lacks positive and drift/collision proof.
It also confirms the MAS development-gate failure is a stale integration
expectation rather than a lifecycle conflict. The correction owner may update
that one integration test in addition to the transaction owner/tests, must use
an honest versioned per-record package fingerprint bound to its transaction
role, and must preserve legacy receipt-v3 and generic candidate-record reading
without weakening exact live-journal recovery.

The correction owner has frozen three-file candidate
`cf0d6da2ab57b0afac716fdc626af4cd98d21512f899551321558ec60044c2e6`
over the same HEAD. Versioned v2 records now bind a `candidate|prior` package
role to its role-derived fingerprint; legacy candidate-only v1 and receipt-v3
records cannot attest a prior package. Positive prior-backup/idempotence and
bytes, identity, fingerprint, and legacy-schema negatives are present, and the
MAS integration now asserts durable retained evidence after package-before-
runtime restore/archive.

Lead independently confirmed the exact hash and diff check, syntax, runtime
typecheck, the full package-transaction file at 61/61, the full MAS development
gate file at 24/24, and a read-only real status of `active/ready` with package
`recovery-required/target-restored`. The candidate remains pending one fresh
exact-snapshot challenge; no live recovery, package mutation, receipt read, or
runtime mutation has occurred.

The fresh exact-snapshot Peer returned `REOPEN_REQUEST`, which Lead accepts,
and Lead rejects `cf0d6da2…`. After a candidate package is durably retained,
`restoreIdentity` can crash after renaming its transaction-owned identity file
to a disposable but before deletion/intent clear. The recovery-proof validator
currently requires every pending intent beside retained package records to
match one of those package records, so it rejects this valid identity cleanup
before reconciliation and permanently blocks runtime restoration/archive.

The correction must share the exact pending-intent validation path whether or
not retained package records already exist: a matching retained package intent
is replayed as retained; an unmatched exact transaction-owned package slot may
be attested/appended; an unmatched canonical identity or identity-temporary
intent may use the existing generic cleanup recovery; every foreign or changed
path still fails closed. Deterministic proof must interrupt after identity
rename, show read-only recovery proof remains recoverable, resume through the
coordinator-style path, preserve every retained package, and complete identity
and runtime/session restoration in package-before-runtime order.

The correction owner has frozen three-file candidate
`b56ca2b7da0c44882f2d800f181eb6bd94fb7d1d4152065cbee842754dfd04fd`
over the same HEAD. Cleanup intent structure is now validated independently of
whether retained package records already exist; a matching retained package is
verified directly, while unmatched transaction-owned package or identity
intents continue through their role-specific ownership checks. Focused package
and coordinator proofs interrupt once after identity rename and resume through
read-only proof, package recovery, runtime restoration, and archive.

Lead independently confirmed the exact hash and diff check, syntax, runtime
typecheck, and both complete focused files at 86/86. The real read-only status
remains `active/ready` and package `recovery-required/target-restored`. A fresh
exact-snapshot Peer is performing the final bounded challenge; no live state or
receipt has been mutated or read.

The fresh exact-snapshot Peer returned `REOPEN_REQUEST`, which Lead accepts,
and Lead rejects `5aea4ae9…`. A receipt can appear after the initial retained-
upgrade scan but before matching pending-record inspection. That later
inspection returns a valid monotonic upgrade, yet the pending branch currently
ignores it and clears the intent with the old no-receipt record. It can then
continue through identity/runtime restoration and archive without durable
receipt-bearing provenance.

Every operational call site that observes an upgrade must route through one
shared apply-and-fsync owner before clearing intent or continuing recovery.
Read-only proof continues to describe the upgrade without writing. Pending
retained package root checks must use the directory-binding comparator, not
full directory `nlink`/`size` equality, while stable ordinary attestation still
protects every non-bookkeeping field. Required proof inserts the receipt between
the initial scan and pending inspection, interrupts after the upgrade write,
replays idempotently, and proves coordinator archive occurs only after the v3

receipt-bearing record is durable; negative mode/owner/device/inode drift remains
rejected before mutation.
That fresh Peer returned `REOPEN_REQUEST`, which Lead accepts, and Lead rejects
`b56ca2b7…` despite the independent 86/86 focused proof. After the current
partial receipt residue is attested and the first durable record write succeeds,
a crash before cleanup-intent clear leaves a matching record whose partial-tree
fingerprint cannot equal the original full-candidate fingerprint. Both proof
and reconciliation incorrectly require that equality and cannot resume. The
validated retained inventory, receipt chain, root binding, role/fingerprint,
absent source, and exact intent binding must govern this matching-record state.

The Peer also found that a retained-record no-intent path returns before scanning
other deterministic cleanup siblings; an unrelated collision is likewise
missed beside a pending identity intent. Every proof branch must scan every
transaction-derived cleanup slot and reject any existing path unless it is the
exact validated retained path or the one exact validated pending intent.
Required proof now includes the partial-residue first-write crash and rerun,
retained plus an extra collision, and retained plus pending identity plus an
extra collision, all before mutation. The mixed identity resume, role binding,
bounded set, journal ordering, package retention, receipt privacy, and
coordinator ordering remain unchanged.

The writer returned `REOPEN_REQUEST` on frozen three-file candidate
`1bf45a53b0ee7fba929cd6ad754b67390434d639242c9ce263e947daa98b7ee0`.
Its partial-record first-write replay and global collision scans are retained as
the technical direction, but a valid receipt added after a no-receipt retained
record currently fails closed forever because no provenance-transition rule was
authorized. Lead resolves this as a technical route within the owner's existing
all-receipt-timings retention decision; no additional product, cost, or external
effect is introduced.

Newly written retained-package records must carry a compact stable ordinary-tree
attestation in addition to their exact attestation. The stable digest includes
every ordinary relative path, type, content/symlink digest, mode, owner, device,
inode, and file/symlink link-count and size, while excluding only directory
`nlink` and `size` bookkeeping that an exact Apple receipt insertion naturally
changes. A no-receipt record may upgrade monotonically to the exact valid
receipt-bearing record only when role/fingerprint/root binding, entry count,
and this stable digest are unchanged. Recovery writes and fsyncs the upgraded
compact receipt metadata before continuing; receipt bytes remain unread and
unhashed. Existing record schemas without the stable attestation remain readable
for exact replay but fail closed on a late receipt and cannot be upgraded.

Acceptance requires positive proof for the late-receipt upgrade across read-only
proof, durable reconcile, crash/rerun, and coordinator archive, plus negatives
for ordinary bytes/path/mode/owner/inode/link drift and malformed/wrong-path/
hardlinked receipt. The partial first-write crash, all-slot collision negatives,
mixed identity cleanup, legacy compatibility, and no-package-deletion proof must
remain green.

The correction owner has frozen three-file candidate
`5aea4ae9a118224522503a806b8102a2f1b5441c6c5b563c1e97c769a7a9a204`
over the same HEAD. Newly written v3 records carry the stable compact ordinary
attestation; read-only proof describes but does not persist a valid monotonic
late-receipt upgrade, while operational rollback reconciles and fsyncs that
upgrade before pending cleanup and later identity/runtime/archive work. Legacy
records remain exact-replay-only. The partial first-write crash and all-slot
collision checks remain present.

Lead independently confirmed the exact hash and diff check, syntax, runtime
typecheck, both complete focused files at 102/102, and unchanged read-only real
status `active/ready` with package `recovery-required/target-restored`. A fresh
exact-snapshot Peer is challenging the stable digest, transition boundary,
durability, privacy, and coordinator ordering. No live mutation occurred.

Lead ACCEPTS the superseding exact three-file candidate
`107aae0a1827979eb1b7891da82bda98ff4c43ac5137ea3ead036f1afa4c8f51`
over HEAD `e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`. Independent Lead validation
passed syntax, runtime typecheck, `git diff --check`, and both complete focused
files at 109/109. A fresh read-only Peer independently returned `ACCEPT` after
verifying the exact hash and challenging pending-upgrade fsync-before-clear,
pure proof behavior, stable directory binding, partial first-write replay,
all-slot collisions, legacy journal compatibility, package-first coordinator
ordering, package retention, and receipt-byte privacy. The repository-native
enforcement level is the package transaction plus focused behavioral tests;
no separate hook or CI policy is asserted. Immediately before acceptance the
real session remained `active/ready`, package
`recovery-required/target-restored`, run
`527e2e47-75e7-4bd1-af88-7270a03eb5c9`; the retained package root and nested
receipt inode metadata were unchanged and receipt bytes were not read or
hashed. This candidate is authorized for the one already owner-approved
coordinator restore under the conservative retain-every-package policy.

The one authorized live coordinator restore then completed successfully for
run `527e2e47-75e7-4bd1-af88-7270a03eb5c9`. Stop proof observed no live host;
package rollback durably reached `identity-restored` before runtime recovery;
the prior runtime root returned at its recorded inode and aggregate shape; the
active slot disappeared; and the session journal reached `archived` with exact
recorded-device assurance. The existing partial package became one compact v3
retained-package record with no pending cleanup intent. Its package-root inode
remained `46506411` and its nested receipt inode remained `46546102`, size
`9840`; receipt bytes were never read or hashed. Read-only status now reports
`archived` and package `not-applicable`. No retained application package was
deleted; any later disposal remains a separate owner decision.

Lead REJECTS the frozen 19-file MAS Helpers layout snapshot
`0ab4b8ae40bda2e1b8e9daeb4f35287b37e5fe5642a48a5d2f23ce281b456637`
over HEAD `e29e33a44f3a0b4b84ab936f5dc7c34ba927e609`. Its descriptor,
runtime/native consumers, package relocation, receipt boundaries, installed
signature ordering, and focused tests are directionally correct; Lead also
observed runtime TypeScript, six focused Vitest files at 185/185, Swift debug
build, the complete Node-parent native test executable, and `git diff --check`
pass. Those results do not establish the production evidence route.

The production MAS packager still retains the direct composition manifest and
license inventory before relocating Electron from `Contents/Resources` to
`Contents/Helpers`, then the MAS gate validates those retained direct package
inputs, entries, Mach-O paths, and license mappings. The focused MAS fixture
passes only because it manually remaps and recomputes those structures; the new
MAS package-input and entitlement-layout selectors are not invoked by the
production route. A fresh read-only Peer independently returned
`REOPEN_REQUEST` with the same static call-graph counterexample. Consequently a
Helpers-only final artifact can be accepted while its retained evidence still
asserts the old Resources topology, which is false proof.

The reopened correction must generate and validate final MAS-scoped package
input, artifact-entry, Mach-O/signature, and license evidence after relocation,
while retaining the original direct composition as a separately named,
immutable source/composition binding. Production and fixture paths must call
the same evidence owner; a stale direct inventory or old Electron prefix must
fail. Direct packaging remains unchanged, no real package/sign/install/launch
is authorized, and the already accepted package-recovery implementation must
not be modified. Acceptance requires positive final-Helpers coverage, negative
stale/legacy/duplicate evidence, direct-route non-regression, syntax/typecheck,
focused MAS tests, and a fresh exact-snapshot challenge.

Lead REJECTS the first shared-evidence handback (Peer-reported scope digest
`281cfee43baa257d96e65f18293cac3981a352c3d3d758bbbb2dc845326935a2`;
Lead ten-path content-list digest
`d66e1eeb7131bf54fcc637074da100191e4615ad0921985d8c3d7a98c4bcd5d1`).
The new shared evidence owner and its focused proof are directionally correct,
but the real production call graph passes fields that cannot exist:
`retainDirectCompositionManifest()` returns only `path`, `sha256`, and
`artifactDigest`, while both preparation and finalization read
`directComposition.candidateSnapshot` and preparation also reads
`directComposition.packageInputs`. Those values are therefore `undefined` in
the production packager even though the fixture passes. The same sole writer
is reopened to carry the parsed direct manifest's snapshot and package inputs
privately while preserving the serialized direct-composition binding's small
immutable shape, and to add executable regression proof for that exact
handoff. No package, signing, install, launch, source-entitlement, native, or
package-transaction scope is opened.

The reopened Peer then reported `DONE` without changing the workspace: the
ten-path digest remained
`d66e1eeb7131bf54fcc637074da100191e4615ad0921985d8c3d7a98c4bcd5d1`,
and the production function still returned only the three-field binding while
its callers read the two absent private fields. Lead therefore REJECTS that
handback as an artifact/report mismatch and took ownership after the Peer
finished. The bounded correction now uses one tested helper to return a private
source object containing the exact parsed `candidateSnapshot` and
`packageInputs` plus a separately frozen three-field public binding; only that
binding is serialized as `directComposition`.

Lead observed Node syntax, runtime TypeScript, `git diff --check`, four focused
files at 172/172, and the two runtime/layout files at 15/15. The final ten-path
evidence-correction digest is
`ed5b2925e7e866ba8bf5fcf0cbff673ae3d83a40ddafc0d84d4f5caa79a9fad5`;
the complete twenty-path MAS Helpers candidate digest is
`7f4c8a290b4b42e922597383ca80ae22b28cb911099ca20d8a629b5adfad6b47`.
A fresh read-only Peer is challenging that exact complete snapshot, including
production wiring, final license evidence, signing-policy ownership, strict
installed verification ordering, receipt privacy, and fixture bypasses. No
live or external operation is authorized by this review.

Lead REJECTS that complete twenty-path MAS Helpers candidate after the fresh
read-only Peer returned `REOPEN_REQUEST` against exact digest
`7f4c8a290b4b42e922597383ca80ae22b28cb911099ca20d8a629b5adfad6b47`.
Four production blockers remain. First, the final Helpers Electron comes from
the downloaded MAS archive while package-input evidence still hashes the
direct `node_modules/electron` source and final verification repeats that
wrong source; production must bind the exact MAS archive descriptor and its
pinned SHA-256 (`e153b855ba023f1edfcad4a07b22c30b4d48af57530c04808cffc6c75e17bc7d`
for `electron-v41.2.0-mas-arm64.zip`) and reject missing or mutated bytes.
Second, the final license inventory still names the removed generic
`composition-manifest.json`; the MAS route must name and validate the actual
App Store development manifest and its Helpers layout. Third, the generic MAS
entitlement-map selector is test-only while production signing remains owned
by `electron-osx-sign`; those dead changes also alter direct-route bytes and
must be removed rather than accepted as signing proof. Fourth, the producer
requires an exact three-key direct-composition binding while the gate accepts
extra keys; producer and consumer must share the same strict validator with
negative proof.

The reopened write scope is limited to the MAS contract/evidence owner,
production MAS packager and gate, package-input and license-inventory helpers,
the removal of the dead generic signing/entitlement-map changes, and focused
tests for those routes. The already accepted package transaction, native host,
runtime descriptor consumers, source entitlement/UI work, and active plan are
not writer-owned. Production and fixtures must use the same final-MAS evidence
path; direct package-input and entitlement-map behavior must remain byte-for-
byte unchanged. No real package, sign, install, launch, purchase, Restore, or
external operation is authorized. Acceptance requires positive pinned-archive
and final-Helpers evidence, negative mutated/missing archive, stale direct
inventory, old/duplicate layout, and extra-binding-key proof, plus syntax,
typecheck, focused tests, diff hygiene, Lead inspection, and a fresh exact-
snapshot challenge.

Lead REJECTS the next Peer handback, reported as fifteen-path digest
`2d087679d5acc9d786515c54ae56c52544d65f0cf5c3a6ac261c6184cfce04eb`.
That digest was not reproduced by the established sorted per-file SHA-256
method (Lead observed
`4563b4fb8658f853440cd40cfbda38bd9a243b5b693605241d54ac3616c8389c`),
but the decisive blocker is behavioral rather than digest framing. The shared
archive descriptor validator verifies only that its SHA-256 is well formed and
matches the bytes at its path; the accepted contract pin is optional in the
creator and absent from shared evidence verification and the install gate.
The MAS fixture therefore creates arbitrary deterministic bytes without a pin
override, and an executable Lead counterexample showed arbitrary non-Electron
bytes named `electron-v41.2.0-mas-arm64.zip` pass both creation and verification
with SHA-256
`3d42c83cf9504ce9835588316140befc067954300cf9ac0e0ef694b49e603b13`.
The focused test proves mutation relative to a self-declared digest, not the
accepted archive pin.

The same bounded route is reopened only to make the accepted contract SHA-256
the mandatory production and install-gate default at every shared archive
validation boundary. Deterministic fixture bytes may use an explicit test-only
expected-digest dependency supplied outside the manifest and threaded through
the same owner; no manifest, archive descriptor, or package evidence field may
select its own expected digest. Positive proof must distinguish the accepted
production pin from the explicit fixture override, and negative proof must
show a self-consistent alternate descriptor plus matching alternate bytes is
still rejected by the default production/gate route before mutation. The
correct route-aware inventory, strict direct-composition binding, restored
direct signing/map bytes, and all previous scope exclusions remain unchanged.

The reopened Peer then returned `DONE` and again reported digest
`2d087679d5acc9d786515c54ae56c52544d65f0cf5c3a6ac261c6184cfce04eb`.
Lead reproduced that digest using the supplied filename-plus-per-file-hash
command, but exact inspection shows no correction delta: the creator still
defaults `expectedSha256` to `null`, shared verification still accepts a
self-declared digest, and both focused fixtures still create arbitrary archive
bytes without an explicit out-of-band expected digest. The executable
counterexample therefore remains valid. Lead REJECTS this second handback as an
artifact/report mismatch. The technical route remains the v172 route, but it
must be assigned to a different sole writer after the Human-directed production
evidence documentation task has completed; no package or live operation is
authorized from this rejected snapshot.

A different sole writer produced a real seven-path correction delta with digest
`92da7f53268f8fc84b44dbd1cc9be639f6b54aa4aa2e17d6ffd107b2a5db6ac0`;
the complete fifteen-path MAS source candidate digest is
`fcb74fc1300c656058c05487622dca21075894786a4b7b466d9008ba8c2916ab`
using filename-plus-per-file SHA-256 records in sorted order. Every exported
archive/source/evidence/license boundary now defaults to the accepted contract
pin, while deterministic fixtures pass one explicit expected digest outside
manifest and evidence data. The production packager and CLI install path supply
no override. Lead observed an alternate same-name archive rejected by both
default creation and verification while an explicit fixture digest passed;
TypeScript, changed-module syntax, diff hygiene, and seven focused suites at
153 passed/1 skipped also passed.

This evidence supports only review of the source candidate. It does not satisfy
the production-evidence pattern for an actual package: no production packager,
signed artifact, install consumer, launch, or purchase operation has run. A
fresh read-only Peer is challenging the exact `fcb74fc1…` source snapshot for
default/manifest-derived bypasses, fixture-authority leakage, prior false-proof
blockers, and direct-route regression before Lead explicitly accepts or rejects
the source candidate.

The fresh Peer returned `DONE` for source-level archive-pin behavior but called
out that the install gate resolves and reads
`masPackageEvidence.licenseInventory.path` before the later shared validator
rejects any path other than the fixed packaged license inventory. Lead rejects
`fcb74fc1…`: this ordering is a containment and receipt-privacy violation, not
mere hygiene. A modified external manifest can point that self-attested field at
an absolute owned file or the nested `_MASReceipt/receipt`; the gate reads those
bytes before it proves the field equals
`Contents/Resources/meetless/notices/license-inventory.json`, even though final
acceptance later fails. This contradicts the accepted fail-closed consumer and
receipt-byte boundary.

The reopened correction is limited to exporting/reusing the existing strict
license-inventory binding validator, invoking it during MAS manifest validation
before any artifact-selected path read, resolving only the fixed validated
inventory path, and adding negative proof that receipt/external-path mutations
are rejected without reading the target or beginning runtime/package mutation.
The accepted archive-pin correction and all prior direct/MAS contracts remain
unchanged. This remains source-level work; no package or live operation is
authorized.

The bounded containment writer returned a three-path correction. Lead exact
inspection confirms the install consumer now invokes the shared strict
license-inventory binding validator while validating the MAS manifest, before
any artifact-selected path read; after validation it resolves and reads only
the fixed `Contents/Resources/meetless/notices/license-inventory.json` path.
Negative proof mutates the manifest to both the nested opaque receipt path and
an absolute external path and observes only the manifest read, no forbidden
target read, no owner command, and no runtime/package mutation. Lead observed
changed-module syntax, diff hygiene, repository typecheck, and five focused
suites at 100/100 passing.

The complete fifteen-path source snapshot is frozen at
`72a96965e0e42647107102f2ce40d78dd3b4be87e2c40d603df85d16f1c26b74`,
computed from sorted filename-plus-per-file SHA-256 records. A fresh read-only
Peer is challenging this exact snapshot across the production producer and
consumer call paths, archive-pin authority, final Helpers evidence, direct-route
preservation, strict pre-read validation, installed-signature ordering, and
receipt opacity. Lead has not yet accepted or rejected this source snapshot.
Even acceptance would remain source-only: actual production package, signing,
install consumer, launch, purchase, and Restore evidence are still closed and
must satisfy the production-evidence pattern separately.

The fresh Peer reproduced the canonical `72a96965…` digest and then found a
source blocker. Lead exact inspection confirms it. ADR0006 requires the nested
Electron plist to carry both the exact `com.meetless.app` bundle identifier and
accepted build-scoped `ElectronTeamID`, and final validation to require the
signed main Electron identifier. The production packager enforces all three,
but the install/launch consumer calls the plist validator with both requirements
disabled and validates every nested signature with no expected bundle
identifier. A self-consistent artifact with missing or wrong nested Electron
identity can therefore pass that consumer boundary. Lead REJECTS source
snapshot `72a96965e0e42647107102f2ce40d78dd3b4be87e2c40d603df85d16f1c26b74`.

The correction is reopened only at the production MAS consumer and its focused
test: require both nested Electron plist identity fields and require
`com.meetless.app` for the exact main Electron executable signature while
leaving other helper signature identifiers unchanged. Positive proof must keep
the accepted fixture passing; negative proof must reject missing/wrong plist
bundle or team identity and a wrong signed main Electron identifier for the
intended ADR0006 diagnostic. All archive-pin, Helpers evidence, direct-route,
receipt-opacity, recovery, and no-live-operation boundaries remain unchanged.

The first identity correction enforces those checks in install preflight and
passes Lead syntax, typecheck, diff hygiene, and five focused suites at 105/105.
Lead nevertheless REJECTS full snapshot
`9a7d68a9aa86df76d028b19a2b0e92d9a958a5703693f18e6f8dfb146aafa7dc`
after fresh exact-snapshot challenge. The launch path does not rerun install
preflight: its separate installed-signature validator verifies immutable
manifest/path evidence and strict/deep signatures, but neither reads the fixed
nested Electron plist nor parses the signed main Electron identifier. Thus a
post-install, validly signed replacement with wrong identity can reach launch.

The same two-file owner is reopened to apply the exact ADR0006 plist and main
signature identity checks inside the installed launch validator before handoff
read and `open`. It must use only immutable manifest Mach-O paths and the fixed
Electron Info.plist path, must not enumerate the package or receipt, and must
preserve strict/deep plus individual signature verification. Launch-specific
negative proof must reject missing/wrong plist bundle/team identity and wrong
actual main Electron signed identifier while observing no handoff read, no
`open`, and no receipt-byte read. A valid artifact must continue to pass before
and after insertion of an opaque Helpers receipt.

The reopened two-file owner implemented all three launch boundaries: immutable
manifest main-Electron identifier, the fixed nested Electron plist bundle/team
identity, and parsed actual codesign identity after strict/deep plus individual
verification. The validator still uses only immutable Mach-O paths and the
fixed plist path; it neither enumerates the installed package nor reads the
receipt. Lead exact inspection and independent local execution observed syntax,
typecheck, diff hygiene, and five focused suites at 111/111 passing. Six
launch-specific negatives cover missing/wrong plist fields, wrong immutable
manifest identity, and wrong actual codesign identity; the valid path passes
both before and after adding opaque receipt bytes.

The exact fifteen-file identity is frozen by its per-file SHA-256 vector. Its
sorted `filename<TAB>sha256` manifest digest is
`24b7307846e43451c6d8202e85aaf09f1a109eca212a864ec12ec8ce8e3be72b`;
the alternate standard `shasum` record framing over the same sorted filenames
is `537b74de4b62a28ab2e78239d528260725d288c296f02bf76c285a9e8d56a659`.
A fresh read-only Peer must match the vector and challenge install plus launch
consumer behavior before Lead accepts or rejects this source candidate. Actual
production-artifact acceptance remains closed.

The fresh Peer confirmed the identity checks themselves, then challenged the
durable provenance trust anchor: launch obtains the original artifact binding
from the fixed mode-0600, same-UID package journal. A process deliberately
acting as the current macOS user can rewrite that journal, its referenced
manifest and identity, and the installed package into a new self-consistent
set. Existing strict schemas, fingerprints, inode/path checks, and codesign
validation detect accidental or partial change, but cannot authenticate one
same-UID file against another after all local evidence has been deliberately
replaced.

ADR0005 explicitly says this repository boundary does not prevent arbitrary
same-UID shell deletion, which strongly indicates the current-user account is
the trust boundary, but it does not explicitly classify deliberate same-UID
journal/manifest rewrite. Extending the threat model would require an external
trust anchor such as a Keychain-held authentication key or another privileged
owner; copying the binding into another same-UID journal would not solve the
reviewer's counterexample. This is a material security/architecture choice.
Lead therefore holds source candidate acceptance and all production/live work
until Human chooses whether deliberate same-UID evidence rewrite remains out of
scope or becomes a new authenticated-state requirement.

Human chose the existing trusted-current-user boundary on 2026-09-07.
ADR0005 now states explicitly that deliberate same-UID deletion or coordinated
journal/manifest/package rewrite is outside this threat model; adding a
Keychain-backed MAC, privileged owner, or other external trust anchor requires
a separate Human security decision. The fresh Peer's rewrite counterexample is
valid only outside the accepted boundary, so Lead rejects it as a blocker.

Lead ACCEPTS the exact fifteen-file MAS Helpers source candidate identified by
the per-file vector above (sorted `filename<TAB>sha256` digest
`24b7307846e43451c6d8202e85aaf09f1a109eca212a864ec12ec8ce8e3be72b`).
Within the accepted threat model it binds the production producer and install
consumer to the pinned MAS archive and final Helpers evidence, keeps direct
packaging unchanged, validates fixed inventory paths before reads, preserves
receipt opacity/recovery, and enforces nested Electron plist and signed identity
at install and immediately before launch. Do not reopen this source decision
for deliberate same-UID tampering; reopen it only for a failing production
producer/artifact/consumer path or a violated in-scope invariant.

This is source acceptance, not production-artifact acceptance. The next source
frontier is the already accepted bounded entitlement/callback lifecycle route:
strict backend authorization snapshots, one native pending operation, bounded
UI waiting, and explicit refresh for late completion. After that source is
accepted, create one actual production-path development artifact and run its
consumer evidence before any owner-driven monthly purchase or Restore.

Lead subsequently rejects source candidate
`b071b1724db2d8a1cfd7d205e38f93072364c055afd09a9d6f255c6a7ae79eed`
after exact inspection, independent build/typecheck/focused-test success, and a
fresh read-only challenge. A failed StoreKit JWS lookup can currently preserve
stale RevenueCat `active` access in a public `failed` result, which the renderer
applies before backend enrollment. The plugin also consumes its newly verified
active override once before returning to potentially stale RevenueCat status,
and a missing native callback/socket terminal event leaves the UI polling and
all Premium mutations disabled without a bounded recovery state. Passing unit
proof does not outweigh those source-level violations. The next source
candidate must normalize every non-active mutation result to non-active access,
define the lifetime and refresh owner for backend-verified entitlement, and
provide a bounded terminal route that releases purchase/Restore retry without
misclassifying a late StoreKit callback as cancellation or active. No new
artifact may be built from `b071…`.

Lead accepts the fresh read-only architecture challenge for the reopened source
route. Enrollment and device-key refresh must return a strict versioned backend
snapshot containing credential expiry, `active|grace|expired|refunded|revoked`,
and natural expiry; only `active|grace` maps to public Premium active. The JWT
does not carry entitlement, and backend authorization remains current on every
managed operation. Native RevenueCat status supplies catalog/package display
only and may never replace or prolong the backend authorization snapshot.

The native bridge will expose one private versioned operation slot and ID. A
purchase or Restore start returns `pending` without waiting past the existing
30-second renderer RPC boundary; the one in-flight callback remains native-owned
and first-callback-wins. Its terminal result is retained in that single bounded
slot until the trusted plugin consumes it or the host exits; no timeout is
reported as StoreKit cancellation, and a late verified transaction is still
enrolled exactly once. A retry while native is busy returns a retryable typed
pending/busy result rather than starting another StoreKit mutation. On host
restart, explicit refresh/Restore recovers through the persistent device key
and StoreKit current entitlement rather than a durable raw transaction record.

The UI may poll the private operation through the existing status path for at
most the existing 30-second client boundary, then ends its local pending state
and re-enables refresh/purchase/Restore with a retryable pending message. A late
native/backend completion can become visible on explicit refresh, but cannot
silently rewrite an unrelated newer operation. This is a bounded technical
lifecycle choice, not purchase cancellation or a new entitlement policy. The
public Premium wire remains v1 unless implementation proves that a new public
field is unavoidable; catalog and backend authorization stay internally
separate.

### Issue #6 implementation ownership

Lead opened one bounded source correction for the observed successful monthly
sandbox purchase that later became failed/inactive. One sole writable Peer owns
the backend credential snapshot, native one-slot purchase/Restore lifecycle,
plugin convergence, renderer's bounded wait, and their focused tests. Existing
unaccepted edits in that scope are inputs to correct, not accepted behavior and
must not be discarded wholesale. The accepted MAS packaging, signing,
installation, launch, recovery, and receipt-privacy source is outside this
writer's scope.

The stable contract is the architecture immediately above: strict backend
snapshot and expiries; only backend `active|grace` maps to public active;
RevenueCat remains catalog-only after a mutation; one native private operation
with an opaque ID, typed busy/pending, first callback wins, and a retained
terminal result; one enrollment per signed transaction; UI wait no longer than
30 seconds followed by an enabled retry/refresh path; and late completion only
through explicit refresh without overwriting a newer operation. Public Premium
wire v1, free features, transaction secrecy, and user-owned purchase/Restore
actions remain unchanged. Reopen if this requires renderer-visible secrets,
automatic Restore, a second concurrent mutation, durable raw transactions, a
public wire-version change, or policy beyond ADR0005.

Lead REJECTS the first issue #6 candidate at exact fifteen-path digest
`b2ffabea56396ed589754c6b6411202828bbdda6c2f9a7c2a2f7aeeae8b59505`.
Typecheck, 80 focused tests, and native build/test passed, but exact inspection
and a fresh read-only challenge found three lifecycle violations. The plugin
retains every raw signed transaction in an unbounded map; a host-retained
purchase terminal can no longer be consumed by status or explicit Restore when
the plugin restarts and loses the original operation kind; and explicit Premium
refresh returns an unexpired cached credential instead of forcing a current
backend snapshot, so refund/revocation can remain visibly active.

The correction scope is limited to the native private recovery operation,
plugin lifecycle/auth refresh, and focused tests. It must retain at most one
in-flight raw transaction and only bounded non-raw dedupe evidence afterward;
allow trusted status and explicit Restore to consume any retained terminal
exactly once without exposing the JWS on the public wire; reject late old
leases; and force the explicit Premium authorization path to replace its cache
from backend device-key refresh. Existing 30-second UI behavior and backend
snapshot shape remain unchanged. Reopen if this requires a public wire change,
raw transaction persistence, automatic Restore, or policy outside ADR0005.

The correction Peer returned `DEPENDENCY_REQUEST` without changing files:
`native/macos-host/TranscriptionCapability.swift` is the actual owner of the
private socket operation allowlist and response dispatch. Lead authorizes that
single additional path solely for `premiumRecover`; public contracts, renderer,
backend schema, and all package/live operations remain excluded.

Lead verified the seven-path correction at reproducible sorted
`filename<TAB>sha256` digest
`3b5b223c5e04e97dfa99e2a9fd0d376623fbd061c73cbfdaaab9c2e9aee5017b`.
The full sixteen-path issue candidate is
`fb730a716b57bde12134cc4ce8bcca6f06629fdaf84a18019915aa92f98a7c07`.
The native retained-terminal and plugin forced-refresh corrections are sound,
but Lead REJECTS the full candidate because the renderer still retains a local
`premiumVerifiedAccess` override. After a successful enrollment, an explicit
refresh that returns backend `refunded`, `revoked`, or otherwise non-active is
discarded in favor of the old active value; an RPC failure also preserves that
old active value. This can visibly prolong Premium after the accepted backend
authority has withdrawn it.

The renderer correction is limited to `packages/meetless-app/src/App.tsx` and
`packages/meetless-app/test/transcript-selection.test.tsx`. Explicit refresh
must trust the current plugin/backend result, never a renderer-retained active
override, while the existing connection and operation token guards must still
prevent an older asynchronous result from overwriting a newer operation. Add
proof that active followed by refunded/revoked-equivalent inactive refresh is
rendered inactive and that refresh failure does not preserve active access.
Do not change the public wire, native/plugin/backend code, visual design,
packaging, or live state.

The two-file renderer correction removed the stale active override and its
dead post-mutation request. Lead reproduced its aggregate as
`a0186a177ebb4f68ac015d67c0468a7b856139c47921222288508a39056a9ade`;
the resulting full sixteen-file aggregate was
`192f681108432a8081b0aef702f12fcc3f0033d0e36ed7f860dd3a5b7e4538ea`.
Typecheck, 88 focused tests, native debug/release proof, and scoped diff hygiene
passed. A fresh read-only Peer matched that exact snapshot but found one final
implicit convergence route: `askQuestion` calls `refreshPremium()` when Ask
returns a Premium error. That can consume and expose a late terminal purchase
without the explicit Refresh action required by the accepted lifecycle.

Lead therefore REJECTS `192f6811…` and reopens only the same renderer and test
paths. Remove the Ask-error Premium refresh and dependency, preserve the Ask
error itself, and prove an Ask Premium failure does not invoke
`getPremiumAccess` or mutate Premium state. All other issue #6 behavior remains
frozen.

That correction produced full sixteen-file aggregate
`d9167cb48634c0148cc47d66c2fe73ddcbab54f807862d437ed613ec126f5da7`;
typecheck, 89 focused tests, native proof, and diff hygiene passed. A second
fresh read-only Peer matched the digest and confirmed the Ask correction plus
backend/native/plugin contracts. Lead rejects one of its two proposed blockers:
Premium rehydration on a new companion connection is the same trusted status
boundary as initial connection or relaunch, is required for relaunch/reconnect
convergence, and is protected by the connection epoch. It is not an automatic
StoreKit Restore or an unrelated in-connection state rewrite. Reopen this only
if evidence shows an old connection can overwrite a newer one or reconnect
starts a StoreKit mutation.

Lead accepts the Peer's second blocker. The visible explicit Refresh control is
currently absent for backend-active access and for `null` access after an
initial status timeout. Active users therefore cannot request a current
refund/revocation projection, and a timed-out initial load has no Premium retry
action. Reopen only `packages/meeting-surface/src/index.tsx` and
`packages/meeting-surface/test/surface.test.tsx`: show the existing bounded
Refresh action for active, inactive, unavailable, and null access whenever its
callback exists; keep it disabled while pending and preserve all current copy,
layout, public wire, and issue #5 design deferral. Positive component proof
must cover active and null as well as existing inactive/unavailable behavior.

The control correction changed only the two authorized meeting-surface paths.
Lead reproduced its sorted raw-file aggregate as
`49af4c4058b71f956b8531c9e37a27ae6db53aded0d8e97188cc1dd1c4d05012`
and ACCEPTS the complete sixteen-file issue #6 source candidate at sorted
`filename<TAB>raw-file-sha256` aggregate
`06a65d16a34acb0c0ad36504a673e957b02546f32cdc58aa728e30f93d3471bf`.
The final repository evidence is 93/93 focused tests, full TypeScript
typecheck, native production/debug/release builds plus boundary tests, and
scoped diff hygiene. Exact inspection confirms one backend-authoritative
entitlement snapshot, bounded native terminal/JWS ownership, once-only private
recovery, bounded plugin dedupe, a 30-second renderer wait followed by enabled
retry, explicit in-connection late convergence, and current status
rehydration on initial connection, reconnect, and relaunch.

This ACCEPT is source-only. It does not claim the production packager output,
installed consumer, or real monthly sandbox purchase/Restore. Human explicitly
deferred issue #5 design work until after issue #6 is fixed and retested; do not
change the presentation design while producing or testing this artifact.

The first actual production-route package attempt after source acceptance used
a fresh private proof root, the accepted MAS Electron archive pin, the exact
development profile snapshot, and the accepted Apple Development signer. It
failed closed before manifest write, install, or launch with `final MAS
package-input artifact digest differs from the signed bundle`. Lead REJECTS that
artifact; it was never accepted or consumed.

Exact inspection of the retained failed stage proves the signing transform is
the mismatch owner. The signer embedded `Contents/embedded.provisionprofile`
with byte-for-byte SHA-256
`b7a06dab827c3624b9a5bf50408ed537d11cc3f506d2f1c3b2d1413beedbb921`,
identical to the immutable profile snapshot, and rewrote the seven nested
`**/_CodeSignature/CodeResources` files plus the expected Mach-O signature
bytes. The pre-sign package-input owner currently excludes Mach-O, the
self-referential inventory, and only the outer CodeResources prefix, so it
incorrectly treats nested signing metadata and the later embedded profile as
ordinary immutable payload.

Reopen only the MAS production evidence lifecycle. The correction must put the
exact immutable profile bytes into the artifact before pre-sign evidence (or
return `REOPEN_REQUEST` with proof for a stricter phase split), ensure the signer
cannot silently substitute them, and classify only the exact MAS
signing-mutated CodeResources paths outside the ordinary payload digest. The
final manifest and installed consumer must still bind and validate every exact
final entry, all CodeResources, all Mach-O signatures, and the embedded profile;
no broad path exclusion or artifact self-attestation is allowed. Direct package
input/inventory bytes and behavior remain unchanged. Positive and negative
proof must cover the real producer call order, profile absence/mutation, and a
changed or unexpected signing-bound path. Reopen if the route requires weaker
final coverage, changes source snapshot meaning, writes evidence after the final
outer signature without a valid re-sign phase, or needs any install, launch,
purchase, Restore, upload, or issue #5 design action.

Lead reproduced the eight-file candidate at aggregate `83553394d05303916fbdfbffabe314681c8274a3eb313dc830e58dcd9e57e860`
and its 60/60 focused tests, 82-pass/1-skip direct regressions, typecheck,
syntax, and diff hygiene. A fresh read-only Peer nevertheless supplied a valid
counterexample: `digestArtifactEntries` still unconditionally drops the broad
`Contents/_CodeSignature/` prefix. Adding and mutating
`Contents/_CodeSignature/Unexpected` therefore leaves the MAS ordinary-payload
digest unchanged even though the exact descriptor does not authorize that
path. Lead REJECTS `83553394…` because final artifact self-binding cannot replace
the missing pre-sign provenance binding.

Reopen the same evidence owner only. For MAS, digest and entry-count logic must
use exact excluded paths with no broad prefix: inventory, inspected Mach-O, and
all eight exact signer-mutated CodeResources paths (the seven nested paths plus
the outer `Contents/_CodeSignature/CodeResources`). Any other file under any
`_CodeSignature` directory is ordinary payload and must affect the pre-sign
digest; missing or extra CodeResources remains a hard failure. Preserve the
existing broad-prefix semantics and bytes for the direct route. Add a negative
counterexample for an arbitrary outer `_CodeSignature` file whose hash changes,
and prove the MAS digest/count changes while the direct regression remains
unchanged. All profile, final full-artifact, signature, and no-live-operation
invariants above remain frozen.

The exact-scope correction and Lead's one-line fixture clarification produced
the reproducible eight-file aggregate
`39ed84482c718f9795382d2b7ceb255211559c83d3aaf1529ce40f3046a690ce`.
Lead inspection confirms MAS digest/count/component paths now use only the
descriptor's exact inventory, inspected Mach-O, and eight CodeResources paths;
an arbitrary `Contents/_CodeSignature/Unexpected` entry changes MAS identity,
while direct compatibility still uses its historical prefix exclusion. The
embedded profile is staged before evidence and final artifact identity retains
every entry and hash. Lead reproduced 61/61 focused MAS tests, 82 pass/1 skip
direct regressions, typecheck, syntax, and diff hygiene. A fresh read-only Peer
matched the exact aggregate and independently ACCEPTED the production call path
with no bypass. Lead therefore ACCEPTS this source correction for one fresh
production package/sign/validate attempt. This is not acceptance of any
artifact not yet produced and does not open install, launch, or purchase.

The fresh production-route retry at private proof root
`/private/tmp/meetless-mas-issue6-r2.2fQFiT` failed closed before signing,
manifest write, install, or launch. The real pinned Electron MAS archive has no
nested CodeResources before signing; only the retained outer app
`Contents/_CodeSignature/CodeResources` exists. The descriptor incorrectly
required all seven future nested CodeResources during pre-sign collection, so
the fixture's pre-seeded nested signing metadata was not production-faithful.
Lead REJECTS `39ed8448…` as production-ready despite its local proof and review.

Reopen the signing-boundary owner with an explicit phase contract. One shared
descriptor must declare the exact expected final eight CodeResources and exact
ordinary exclusions, while actual-entry validation distinguishes: pre-sign has
exactly the retained outer CodeResources and none of the seven nested paths;
post-sign/final has exactly all eight. The seven nested paths remain excluded
from pre-sign ordinary identity as deterministic signer-created outputs, even
though absent at collection. Unexpected `_CodeSignature` entries are ordinary
payload or a hard path-set failure according to their exact class; no broad
prefix returns. The final manifest/install consumer must freshly observe all
eight exact files and hashes. Replace the fixture assumption with executable
production-faithful pre-sign-to-final proof and negatives for a nested
CodeResources present too early, missing after signing, extra paths, and ordinary
outer `_CodeSignature` payload mutation. Direct route, embedded-profile
contract, entitlement/source/UI files, and no-live-operation boundary remain
unchanged.

The phase correction is frozen for independent inspection as the exact sorted
eight-file `filename<TAB>raw-file-SHA256` aggregate
`655e72d14bb3cd0528c2f8e04b111a54e366ed683586be9efce1c633fb33f64f`.
Lead inspection confirms the production producer explicitly prepares evidence
in `pre-sign`, the finalizer and install consumer default to `final`, and the
shared descriptor always retains the exact final eight-path exclusion set while
phase validation observes only the outer CodeResources before signing and all
eight after signing. The production-faithful fixture removes the seven nested
paths before prepare and creates them only during its simulated signing phase.
Lead reproduced syntax and runtime typecheck, 63/63 focused MAS tests, 129/129
signature and package-transaction regressions, and scoped diff hygiene. A fresh
read-only Peer is challenging this exact snapshot and production call path; no
new production packaging attempt is accepted until Lead resolves that handback.

The fresh Peer reproduced the exact aggregate, production phase wiring,
retained pre-sign bytes, and 63/63 tests, then returned `REOPEN_REQUEST` with a
valid provenance counterexample. `validateMasPackageEvidenceInputs` validates
the inventory package-input binding only internally; it does not compare that
binding's digest, source snapshot, artifact-input digest/signing boundary,
package/workspace member digests and counts, input count, or lock-gap count to
the separately source-verified `evidence.packageInputs`. An inventory can
therefore retain valid final entry/profile/CodeResources/Mach-O hashes while
asserting a self-consistent but stale package-input provenance record. Lead
REJECTS `655e72d1…` for production retry.

Reopen only the shared package-input/inventory evidence boundary. Derive one
exact binding from `evidence.packageInputs` through the existing inventory owner
and require byte-structural equality with `inventory.artifact.packageInputBinding`
at prepare, finalize, and install validation. Candidate-snapshot equality must
remain source-owned and explicit. Add negative proof for independently stale
digest, source snapshot, artifact-input/signing-boundary, package/workspace
member digest/count, input count, and lock-gap fields; a self-consistent rewrite
must not pass. Preserve the accepted pre-sign/final phase model, direct-route
bytes and behavior, profile/archive contracts, and no-live-operation boundary.
Reopen if this requires changing package-input schema or source snapshot meaning,
weakening final artifact coverage, or widening beyond the shared evidence owner
and focused MAS tests.

The Electron provenance correction is frozen as exact two-file aggregate
`c4fcfe2395869a0d099a22cadae83f5039bf8237e9d83f461c34fa56398f6275`;
the resulting full eight-file candidate aggregate is
`3d0cd98d84b1fa074c7f5a2e25c857dfd1f60dd6ca691aed5e8a225491ee85f6`.
Lead inspection confirms `buildComponent` now supplies the same route context
to both source-type and source-path derivation. The positive fixture asserts the
exact pinned-MAS type and absolute archive source, plus the unchanged direct
type and direct Electron notice/package paths. Lead reproduced syntax, runtime
typecheck, 79/79 focused MAS tests, 129/129 signature/transaction regressions,
and diff hygiene. Freeze this snapshot for a fresh read-only challenge before
production retry.

The fresh source reviewer reproduced exact aggregate `3d0cd98d…` and returned
`ACCEPT`: the MAS archive type/path, full source and package-input provenance,
phase boundary, profile, final entry/signature evidence, and installed consumer
are cross-bound; direct behavior remains unchanged. Lead ACCEPTS the source
candidate.

The next production producer/signing run succeeded at private proof root
`/private/tmp/meetless-mas-issue6-r3.T9dETF`. It wrote the real development
manifest and reported the accepted bundle/team/profile, pinned Electron archive
`e153b855…`, verified signature, 42 nested Mach-O objects, and no launch,
purchase, or distribution claim. The production install consumer then read the
exact manifest and bundle and returned `passed`, with immutable identities:
manifest SHA-256 `eee1f31904565639452bc055ceda1fb4c90f7548ed12e14e953360b2dff99729`,
bundle fingerprint `f157a3a828bcf2eabda7671645fafb9276aad702edf493300d73d9290f187874`,
artifact digest `807d03a455c6a298eb7616b1d70effa4045bbfefbd12cae19e27b08e5373583d`,
package-input digest `dd607260dc2959bb2e6f6280f7a0f000f0c965844d676684c8ed8e37add58937`,
and license digest `8a41fafdfe570857d866dde7b1e6a6b95d5bc6ee0442c56d8e36d9ac57e376e2`.
No install or launch has occurred. Freeze these exact bytes for fresh read-only
artifact review before mutating `/Applications`.

The exact-artifact Peer initially returned `REOPEN_REQUEST` because its
read-only check observed transient keychain trust failure
`CSSMERR_TP_NOT_TRUSTED`, `Authority=(unavailable)`, and zero valid signing
identities, even though all deterministic artifact/provenance identities
matched. Lead correctly withheld install. A subsequent read-only dependency
check observed three valid signing identities, the accepted Apple Development
certificate and full Apple trust chain (valid through 2027-07-28), and
standalone `codesign --verify --deep --strict` success on the unchanged exact
bundle. The full production install consumer then passed again with the same
manifest SHA, bundle fingerprint, artifact/package-input/license/signature
digests. The artifact bytes did not change. Reopen the same read-only reviewer
against this restored external trust state; install remains withheld until that
handback is resolved.

The same read-only Peer still observed zero valid identities and trust failure
inside its isolated security session while confirming every deterministic
artifact identity remained unchanged. Lead REJECTS that environment-local
observation as an artifact/install blocker: the actual coordinator consumer
context has three valid identities, the accepted certificate and Apple chain,
standalone strict/deep verification, and two complete consumer passes over the
same bytes. This does not waive trust validation; install invokes that same
consumer again before mutation and must fail closed if the Lead security context
changes. Lead ACCEPTS the exact artifact for coordinator install.

Read-only coordinator status is `archived` with no active package transaction;
the exact bundle occupies 1,035,824 KiB, `/Applications` has 90,930,496 KiB
available, and the manifest hash remains `eee1f319…`. Use the prior explicit
1-GiB advisory free-space threshold. Install may proceed transactionally;
launch remains a separate user-present step.

Coordinator install reran the full consumer and committed exact artifact
`eee1f319…` transactionally to `/Applications/Meetless.app` as run
`09f3038d-ca26-49b7-b82d-fe506e6176d0`. The published installed host identity
is binary SHA-256 `23cda44805df1c8b38f540d75459a0cd60217dc3c5a7822f4146422ace109a6c`,
CDHash `01a8e9ece868dde5966ecc15ac8474390b9f0823`, with the accepted bundle,
team, signer, and container runtime paths. The previous package and runtime root
remain transactionally recoverable. Launch then repeated installed-signature
validation, opened the app, and received a valid claimed handoff from PID 22819
for the same run. Issue #6 now awaits Human's sandbox purchase/refresh retest;
no purchase or Restore result is inferred from launch.

A fresh read-only Peer reproduced exact aggregate `3d0cd98d…`, traced the real
producer, inventory, signer transition, finalizer, and installed consumer, and
returned `ACCEPT` with no remaining provenance, phase, bypass, cyclic-evidence,
stale-inventory, broad-exclusion, fixture-only, or direct-route blocker. Lead
inspected the exact candidate and ACCEPTS it for one fresh production
package/sign/validate attempt. This accepts source bytes only; the resulting
artifact must independently pass the production consumer before install or
launch is considered.

The provenance correction is frozen as the exact full eight-file
`filename<TAB>raw-file-SHA256` aggregate
`14dc7edc4418e42341a2b1964c710b3ee2636c7146ad2d6c1c1f80c6ca45b83e`;
the four-file correction subset is
`2485e7f51c492d864e9a9e438115b2db01fdc9d7461147d4552068ab8917bbee`.
Lead inspection confirms one exported projection owner supplies inventory
generation and exact equality validation in both the MAS evidence validator and
the installed-consumer source verifier. The complete package-input document is
validated before projection. Lead reproduced syntax, runtime typecheck, 75/75
focused MAS tests (including ten field mutations, a self-consistent summary
rewrite, and installed-consumer proof), 129/129 signature/transaction
regressions, and scoped diff hygiene. A fresh read-only Peer must challenge the
exact full snapshot before any production retry.

That fresh Peer reproduced `14dc7edc…`, confirmed the complete package-input
projection and phase model, and returned `REOPEN_REQUEST` for one remaining
source-snapshot gap. MAS inventory validation requires the candidate digest to
match the package-input projection but checks `head` and `paseoCommit` only as
valid 40-hex strings. Replacing either with another valid value therefore
preserves all package-input, artifact, profile, Mach-O, and CodeResources checks
while asserting contradictory source provenance. The generic direct composition
validator already performs the missing full snapshot equality. Lead confirms
the counterexample and REJECTS `14dc7edc…`.

Reopen only `scripts/validate-macos-package.mjs` and the focused MAS gate test.
The existing shared MAS package-input/inventory validator must compare the full
inventory `candidateSnapshot` object byte-structurally with the validated
`evidence.packageInputs.sourceSnapshot`; the same owner is already reached by
prepare/finalize and installed-consumer source verification. Add negative proof
for independently stale `head` and `paseoCommit`, including installed-consumer
coverage, without changing schemas, generation, the accepted package-input
projection, phase behavior, direct route, or any live operation boundary.

The exact two-file correction aggregate is
`e22c6105e61d884a163a90ace48fe00e32abbd2ea0ef14bc638a3da6775a2c4b`;
the resulting full eight-file candidate aggregate is
`7e77c600a6e1f6da1554ed3b092d638457e7d56f142baee1e43df385e290c10c`.
Lead inspection confirms the shared validator now compares the complete
inventory candidate-snapshot object with the already validated package-input
source snapshot before comparing the full package-input projection. Lead
reproduced syntax, runtime typecheck, 79/79 focused MAS tests (including stale
`head` and `paseoCommit` at both evidence and installed-consumer paths), 129/129
signature/transaction regressions, and diff hygiene. Freeze this snapshot for a
fresh read-only challenge before production retry.

The fresh challenge reproduced `7e77c600…` and confirmed the phase, snapshot,
projection, and consumer bindings, then returned `REOPEN_REQUEST` for a distinct
license-provenance mismatch. `buildComponent` passes MAS context to
`sourcePaths` but calls `sourceType(id)` without that context. The Electron
component therefore names the pinned MAS archive path while serializing the
generic direct Electron distribution source type; validation only requires a
non-empty string. Lead confirms the exact call mismatch and REJECTS
`7e77c600…` as false production provenance.

Reopen only `scripts/lib/macos-license-inventory.mjs` and the focused MAS gate
test. Pass the existing route context to the existing `sourceType` owner and
prove the MAS Electron component records
`pinned-MAS-Electron-archive-and-Chromium-runtime` while the direct route retains
`Electron-distribution-and-Chromium-runtime` and its existing source paths.
Do not change schemas, other component provenance, package-input/snapshot/phase
bindings, direct serialized behavior beyond proving its existing value, or any
live-operation boundary.

### Acceptance evidence

- Repository proof covers monthly dispatch, immediate pending feedback, a
  window-bound native purchase request, cancellation, failed/unavailable service,
  active purchase, explicit restore, and preservation of free paths.
- MAS validation proves the exact profile, signer, bundle ID, App Sandbox
  closure, embedded public SDK key, container-safe runtime, and corrected native
  code in the tested artifact.
- Live evidence comes from one real Apple sandbox monthly flow on the exact
  artifact: visible confirmation UI, cancellation without Premium, successful
  purchase with active `premium`, and explicit restore. Catalog display or a
  fixture transaction is not acceptance evidence.
- Cleanup/status evidence proves that only gate-owned processes and state were
  affected and that coordinator-preserved state remains recoverable.

### Reopen conditions

Reopen the route before further mutation if StoreKit cannot present from a
trusted-host-owned AppKit window without moving transaction authority into
Electron; the current sandbox account, Apple/RevenueCat association, profile,
signer, or public key no longer matches authority; the corrected path requires
annual or production activity; raw transaction/error material would cross the
native boundary; validation weakens; or preserved MAS state cannot be reconciled
by the coordinator contract.

### Live sandbox purchase reopen (2026-09-08)

The exact installed development artifact completed the owner-driven monthly
Apple sandbox purchase, but the subsequent explicit Refresh did not converge
to managed Premium. The production RPC currently returns exactly
`{entitlement: "premium", status: "unavailable", packages: [],
reason: "store_unavailable"}`. Correlated runtime evidence records the
purchase as pending and then failed, followed by the actionable failure
`MEETLESS_CONVEX_URL must be configured for the explicit managed Convex
command`. The installed host therefore has the RevenueCat public key and StoreKit
catalog but does not project a build-bound managed-backend URL into its packaged
runtime. This is a real producer/consumer failure, not fixture evidence.

Lead REJECTS the live gate as incomplete. The smallest correction is to require
one build-scoped public HTTPS Convex URL, embed it in the signed outer
`Info.plist`, have the trusted host validate and pass only that value to its
runtime child, and bind it through the MAS manifest and installed consumer just
like the existing public RevenueCat key. The actual sandbox retry may use only
the already locked hosted-development target
`https://frugal-mandrill-646.convex.cloud`; selecting a production deployment or
region remains closed. Missing, malformed, changed, or unbound URL evidence must
fail package/host/consumer validation before launch.

The renderer must also retain the last known StoreKit catalog when an explicit
refresh returns or throws a transient unavailable result. It must keep the
authoritative unavailable status and visible retry error, must not infer active
Premium, and must not let retained catalog state overwrite a later active,
refund, or revoke result. This encodes ADR0005's rule that an unreachable
purchase service never grants Premium while preserving a retryable purchase
surface. Positive proof covers active convergence and unavailable-with-prior-
catalog; negative proof covers missing/wrong backend binding and stale catalog
overwriting an authoritative terminal state.

The first nine-file candidate is frozen at exact sorted
`filename<TAB>sha256` aggregate
`6eaf2d7e4f0d5d55ffb2a0dd2a11e172e4113eafeb241870575fb7b17df039cc`.
Lead REJECTS it despite 18/18, 30/30, 64/64, typecheck, syntax, native build,
and diff hygiene passing. `retainPremiumCatalog` correctly retains package
objects while preserving authoritative `unavailable`, but the actual
`PremiumPanel` still renders package cards only for `inactive`. The exact live
failure would therefore continue to hide both packages. Reopen the same writer
with the meeting-surface component and its native test as necessary
dependencies; require observable cards plus unavailable/retry state, and keep
active terminal behavior authoritative. The first candidate is not accepted
for packaging.

The corrected eleven-file candidate matched its complete per-file SHA vector
and passed Lead syntax/typecheck/diff checks, 87/87 focused UI/App/URL tests,
the native production/debug boundary, and the isolated 64/64 MAS gate. A fresh
read-only Peer nevertheless returned `REOPEN_REQUEST`, which Lead accepts and
therefore REJECTS this candidate for production packaging. The exact Node
counterexample `https:foo` is normalized by `new URL` to `https://foo/` and
passes the JavaScript validator, while Swift `URLComponents` does not expose
the same host; a package could thus sign successfully and then fail before the
runtime child starts. The package producer and installed consumer also accept
arbitrary valid HTTPS roots even though this sandbox gate is explicitly
limited above to the repository-locked `HOSTED_DEV_TARGET.cloudUrl`. Finally,
the native proof calls only the environment helper and does not observe the
environment assigned at the production `Process.run()` boundary.

Reopen the same writer on the smallest dependency set. Use the existing
hosted-development target owner as the single sandbox URL authority (or move
that unchanged constant to a shared side-effect-free owner consumed by the
existing proof, producer, and consumer); production defaults must reject any
different environment/manifest/Info.plist value while fixtures may supply an
explicit out-of-band override through the same validators. Make JavaScript and
Swift reject non-canonical authority spellings including `https:foo`,
`https:/foo`, and `https:///foo`. Add executable proof that the production
runtime-launch construction assigns the signed plist URL to the child
environment, overriding ambient MAS input immediately before the actual launch
boundary; direct behavior remains unchanged. Preserve the accepted unavailable
catalog UI behavior and all prior package/signature/receipt invariants. Reopen
again if the shared target owner introduces top-level effects, a package can
self-select its backend, JS/Swift acceptance differs, or proof still bypasses
the production child-launch route.

The corrected exact eleven-file snapshot has sorted filename/SHA-vector
aggregate `bf978a499b4d1a4d715eb4cd3e5b5f8bf0b38d9e5ed892d241f2d6a6c5783d02`.
Lead independently passed 88/88 focused UI/App/URL tests, 65/65 isolated MAS
gate tests, native production/debug builds and real-child environment proof,
typecheck, syntax, and diff hygiene. A fresh read-only Peer matched every file
hash and returned `ACCEPT`: parser counterexamples are rejected, the producer
and installed consumer require the unchanged hosted target outside the
manifest, the signed plist and manifest remain cross-bound, and the actual
`Process.run()` seam replaces ambient MAS input while preserving direct-route
behavior. Lead therefore ACCEPTS this source snapshot. The next and only
frontier is one fresh production package with the exact locked URL, followed by
the existing artifact consumer; fixture evidence alone is not production
acceptance.

The fresh production package at
`/private/tmp/meetless-mas-issue6-r4.VaTGbJ` completed successfully with the
locked backend URL. Its manifest SHA-256 is
`56acba088fe4b71a6edf00a8437d8de66f2a3407343e75c7ca958ddc659d03f3`,
bundle fingerprint is
`a91be669bcf91547238396861ca8c68d7adcaaa6f857b622420a4f1900aa8fdc`,
and artifact digest is
`aefbd1f9d613990627833c8dbd12d1024463714c4f28372d1b3141336b24266e`.
The actual artifact consumer passed. The coordinator restored and archived the
prior run, then transactionally installed this exact artifact as run
`8975e3b9-920d-45af-b552-b4d9293ebdbf` at `/Applications/Meetless.app`.

The launch command reported a handoff-claim timeout, but the observable final
state is claimed and ready: the installed host, desktop runtime, daemon worker,
plugin, and renderer are live, and the daemon accepts the real client RPC. A
read-only `getPremiumAccess()` call against that running app returned
`inactive`, both Monthly and Annual localized packages, and no failure reason.
This proves that the packaged backend binding reaches the production runtime
and that the earlier missing-URL/catalog-disappearance failure is absent before
the retry. Lead ACCEPTS the production artifact and installed consumer for this
correction. Human then invoked Restore and Refresh. The real UI returned to the
two-package inactive catalog, and an independent read-only RPC confirmed
exactly `status: "inactive"`, both Monthly and Annual packages, and
`reason: null`. Correlated diagnostics show Restore dispatched and became
pending, with no active completion; subsequent reconciliation returned the
inactive catalog.

The original monthly sandbox purchase was nearly three hours earlier. Under
Apple's default accelerated sandbox schedule a one-month subscription renews
every five minutes and automatically stops renewing after the thirteenth
attempt, so that original entitlement is no longer expected to be active. This
observation does not reopen the correction: catalog/backend transport is
healthy, and Restore correctly grants nothing when StoreKit exposes no current
entitlement. Human then completed a fresh Monthly purchase and Refresh. This is
not accepted: the real RPC is now `status: "unavailable"`, and the UI retained
only the Monthly package while dropping Annual. Runtime and hosted-development
logs prove the Apple purchase reached pending enrollment; an enrollment-purpose
challenge was created successfully, but no `enrollDevice` action followed and
the plugin completed failed. The next Refresh then failed because the same
device key was not enrolled.

The native Keychain implementation queries an EC key by application tag without
requiring `kSecAttrKeyClassPrivate`; the actual Keychain contains both public
and private records under that tag, so the query can return the public key and
`SecKeyCreateSignature` fails. The implementation also exports identity bytes
directly from the selected key instead of deriving the public key from an
explicitly private key. Reopen the smallest correction: select only the private
EC key, derive its public key for identity, and prove a production-shaped
identity/sign round trip plus rejection of the public-key selector regression
without persisting test keys.

During pending or unavailable enrollment, merge the previously observed
Monthly and Annual catalog by package ID so a one-package mutation response
cannot drop the other offering; authoritative active state must remain
authoritative and must not resurrect stale plans. No entitlement, price,
backend, receipt, transaction, packaging, signing, install, launch, or external
deployment policy changes are authorized. Reopen if the fix requires deleting
or rotating the existing device key, exposing raw challenges/transactions, or
granting Premium before backend enrollment succeeds.

The exact four-file correction has sorted `filename<TAB>SHA-256` aggregate
`1278a135eec4dc6be7b1eb5b053aec556ba57529913715af19621dc967ad3275`.
Lead inspection confirms the production Keychain create and lookup paths require
an EC private key, public identity is derived with `SecKeyCopyPublicKey`, and
signing rejects a public or otherwise unusable key. Pending/unavailable catalog
merging is latest-wins by package ID, deduplicated in Monthly/Annual order,
while active and ordinary authoritative inactive results are unchanged.
Lead passed typecheck, 32/32 focused App tests, native build and Node-parent
boundary tests, diff hygiene, and an independent ephemeral invocation of
`SecKeyCreateRandomKey` using the production key-class attributes. A fresh
read-only Peer matched every file hash and returned `ACCEPT`, finding no private
key leak, persistence in tests, authority downgrade, or catalog-state bypass.
Lead therefore ACCEPTS this exact source snapshot. The next frontier is one
fresh production package and existing exact-artifact consumer before any
transactional replacement of the installed app.

That production frontier is complete for the exact accepted four-file source
snapshot. The fresh package root is
`/private/tmp/meetless-mas-premium-r5.qNxaAN`; its production manifest SHA-256
is `dfc680685d2777ca0ded1de1643d6392049c56be6f9d59f5da3491be68085814`,
bundle fingerprint is
`aec848dd2f25eafc5213c4951f96d0707c502bf54d967aa0df3d767f69763ebb`, and
artifact digest is
`e0be3ba575a1fa3173c547563e143578a9c4e1efb5db0286ddb5e2699ca566d4`.
The production package completed with 42 signed nested Mach-O entries, the
contract-pinned MAS Electron archive, the locked hosted-development Convex URL,
and the existing public SDK-key binding. The actual standalone artifact
consumer passed against these exact bytes.

The coordinator then restored and archived prior run
`8975e3b9-920d-45af-b552-b4d9293ebdbf` and transactionally installed the exact
fresh artifact as run `8e5658bd-724e-45ef-8adb-c274c35b2354`. The installed
host SHA-256 is
`121393db17bcb20ce9c131175ad548b16b20fbb6028774ff495de882e2ba8567`
with CDHash `856df289933b8a05eab78b45396a56a419acf034`. Lead ACCEPTS the
production package, exact-artifact consumer, and transactional install. The
installed app has not yet been launched; the next frontier is one coordinator
launch, readiness check, and read-only Premium RPC before returning control to
Human for any explicit StoreKit action.

The coordinator launched this exact installation successfully as
`launch-claimed`; host PID `11065` claimed the expected run, binary SHA-256,
CDHash, bundle path, and fresh runtime root. The daemon is listening on the
expected private development endpoint. A real read-only client RPC against the
running app returned authoritative `inactive` with both localized Monthly and
Annual packages and `reason: null`. This proves the corrected app is live, the
plugin is reachable, and the complete catalog survives before a new mutation.
The next action belongs to Human: explicitly Restore (or make a new monthly
sandbox purchase if Apple no longer exposes the earlier accelerated sandbox
subscription), then press Refresh. No StoreKit action has been automated.

Human completed a fresh Monthly sandbox purchase, observed the bounded UI
timeout, explicitly refreshed, explicitly restored, and refreshed again. The
result is REJECTED: Annual disappeared and the real RPC returned `unavailable`,
no packages, with `store_unavailable`.

Correlated runtime evidence identifies the production-path failure. Apple
completion reached pending enrollment, but the hosted-development action
returned the older credential shape: strict parsing reports missing/invalid
`version`, `state`, and `naturalExpiryAt`. The checked-in
`convex/managedAuthActions.ts` already emits the accepted strict v1 shape, so
the exact locked hosted-development deployment is stale rather than the app
using an incorrect endpoint. Separately, `retainPremiumCatalog` refuses to
merge a later unavailable response when the previous catalog-bearing response
is itself unavailable; that makes a second failure able to drop Annual.

The bounded correction is to deploy the current checked-in Convex functions to
the already selected `frugal-mandrill-646` development target without changing
environment values, and to let a catalog-bearing unavailable UI state preserve
Monthly and Annual across another unavailable/partial response. Active status
remains authoritative and no client state may grant Premium. Production,
provider, environment rotation, annual purchase, and automated StoreKit action
remain closed. Reopen if the exact target cannot be proven, deployment asks to
change configuration, or the current backend source does not produce the
strict v1 credential shape.

The UI correction removes the erroneous requirement that a prior
catalog-bearing state be non-`unavailable` before it can preserve plans. Its
focused positive and recurrence proofs passed as part of 61/61 Premium app,
managed-auth, and Premium service tests; app and plugin TypeScript checks and
diff hygiene also passed. The exact locked `.env.local` target was checked
without exposing the public SDK key, then `convex dev --once` updated only
`frugal-mandrill-646` and reported `Convex functions ready!`; no environment
value was changed.

Because the failed enrollment was cached in the old app process, Lead stopped
it through the coordinator. Relaunch of that already-used package was correctly
refused by the immutable package proof after the host had atomically rewritten
its identity file. Lead did not bypass the gate. One fresh corrected artifact
was built at `/private/tmp/meetless-mas-premium-r6.KnXjS3`; its manifest
SHA-256 is `337f526c3ddc4fc39f9635b62649283e650b4cb5c8e4c69056f12894fdc3aaa8`,
bundle fingerprint is
`d9fcf01590e20f0f1d93c50edab01491fdf189cc32c71d722555f6c170c1f8af`,
and artifact digest is
`7c164d58a8d95f140d0efeeba1356819c08bc9232cae51e383cdf4fa414acfb1`.
The production packager and standalone exact-artifact consumer passed with 42
signed nested Mach-O entries and the locked Convex URL.

Run `8e5658bd-724e-45ef-8adb-c274c35b2354` was restored and archived before
the new artifact was transactionally installed as run
`a6c34243-8954-44a2-bf14-55e13b20f86c`. The new installed host SHA-256 is
`b341fd38c6454b7108f50eec56f963ee843eca4ee6c3f1f2690dbdd235b2059a`
with CDHash `3e2507c8b1290ef9f9a715cc149351372500c002`. Coordinator launch completed as
`launch-claimed`, and a real read-only RPC returned inactive with both Monthly
and Annual localized packages and no failure reason. Lead ACCEPTS the local
source guard, exact artifact, install, and pre-mutation live state. Final
acceptance still requires Human's explicit Restore against the updated backend;
no StoreKit action has been automated.

Human instead selected Monthly again and then Refresh. The visible app retained
both Monthly and Annual, and a real read-only RPC independently returned
`inactive`, both packages, and no failure reason. Lead ACCEPTS the catalog
retention correction on the live production-shaped path.

This attempt did not create an active subscription. Native StoreKit unified
diagnostics record the purchase request at 21:10:32 and RevenueCat's categorical
terminal at 21:10:53 as `Purchase was cancelled`; the UI had reported pending
and reached its bounded timeout. The updated backend successfully served strict
`refreshDevice` actions for the already-enrolled device, but it received no new
enrollment and no RevenueCat purchase event for this attempt. Therefore the
inactive result is consistent with the trusted store evidence and must not be
promoted to active. The remaining question is whether Human intentionally
cancelled/closed the Apple sheet or Apple displayed an apparent success despite
returning cancellation; that distinction controls whether another ordinary
sandbox retry is sufficient or the native presentation/callback route must be
reopened.

Human then completed another Monthly sandbox purchase and explicitly observed
Apple's `Purchase success`. The first Refresh still showed an intermediate
Monthly-only catalog, but the next explicit Refresh converged to `Managed
transcription is active`; the active surface intentionally hides purchase
choices. A real read-only client RPC against the same running installation now
returns authoritative `status: "active"`, `reason: null`, and the Monthly
product associated with the transaction.

Correlated hosted-development evidence records a successful enrollment chain
for this exact interaction: `managedAuth:createDeviceChallenge`,
`managedAuth:consumeEnrollment`, and `managedAuthActions:enrollDevice` all
completed without error. Later `consumeRefresh` and `refreshDevice` calls also
completed without error. This is the production-path proof that the private-key
selection correction signs successfully, the deployed strict credential shape
is accepted, and the app converges from the Apple purchase to backend-managed
Premium. Lead ACCEPTS the sandbox Monthly purchase and managed-enrollment
correction. The intermediate one-product catalog remains observable during
convergence, but it does not grant or revoke access and is no longer a blocker
for this accepted purchase path; reopen if it persists while access remains
inactive/unavailable or if an authoritative Refresh stops returning active.

## Remaining work boundaries

These are open obligations carried forward from the history. Only the bounded
monthly sandbox purchase presentation and explicit restore subset of item 3 is
authorized above; all other work below still requires its own owner/Lead scope
and evidence.

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
3. **Store and billing operations.** Preserve the accepted development package's
   profile-backed sandbox and container-safe runtime layout; those are completed
   foundations, not work to restart. Validate the exact store-distribution and
   In-App Purchase configuration when that separately scoped gate opens.
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

No new recording, TCC, annual purchase, production purchase, managed-production,
publication, legal, or App Store upload action is opened by this document.
Package, sign, install, launch, purchase, restore, recovery, and cleanup are
opened only as bounded steps of the current scope and remain subject to its
dependencies, user-presence rule, and coordinator contract. The coordinator
remains the sole owner of preserved runtime state. The Paseo runtime supervisor
is legitimate process-manager code, not a Codex Room Supervisor role. Neither
the Paseo fork nor Meetless artifacts may contain Codex Room Supervisor/Lead/Peer
role configuration; that belongs only to `codex-room-setup`.

## Prior documentation closeout note

The full prior plan body remains in the completed history. The current ordered
four-file authority manifest changed only because Human explicitly clarified
the same-UID threat boundary in ADR0005; its sorted
`filename<TAB>sha256` aggregate is
`7db7cd6d94781a1367d3f66aaf5a9febdd8abedc703117741a994ea64da8a1a0`.
Historical authority digests remain preserved in the completed record.
