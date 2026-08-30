# Completed History: Meeting Library And Chat Controls

Date: 2026-08-29

# Archive status

This file preserves the complete pre-reconciliation implementation and
acceptance ledger as historical evidence. Its frontier records are not current
authority; use the retained active plan and product/decision documents for
current work.

## Status

Archived evidence; implementation history preserved.

## Outcome

The meeting library scrolls without a visible browser scrollbar, the Ask area
provides one compact working provider/model selector, and meeting deletion is
implemented only after its destructive-data policy is accepted. The exact DMG
handed to the owner installs at `/Applications/Meetless.app`, opens through
LaunchServices, and accepts later Developer-ID updates without weakening the
stable production identity boundary.

## Context

- `docs/product/experience.md` defines the meeting workspace and compact chat
  selection behavior.
- `docs/product/knowledge-and-citations.md` defines meeting-scoped provider and
  model selection.
- The current implementation is in the meeting contracts, store, plugin,
  client, app, and surface packages.

## Scope

In scope:

- Hidden scrollbar with retained wheel, trackpad, touch, and keyboard scrolling.
- Meeting deletion after product authority defines its destructive effects and
  recovery behavior.
- Repair and focused UX update of provider/model selection.
- Focused contract, integration, app-state, and surface tests.
- One automatic migration from a persisted legacy ad-hoc/CDHash identity to
  the trusted Developer ID identity for team `63M98WD275`.
- Developer-ID package production, real DMG install/LaunchServices launch, and
  an upgrade across two differently hashed signed builds.

Out of scope:

- New meeting retention policy or bulk deletion.
- New chat providers, models, summaries, or cross-meeting chat.
- Unrelated design changes.
- General CDHash rotation, ad-hoc update trust, another installation path,
  another bundle identifier, or another signing team.

## Approach

1. Trace UI and lifecycle ownership without changing files.
2. Resolve any product-authority or shared-contract gap.
3. Give one writer the scrollbar and provider/model frontier.
4. Inspect and accept that stable candidate with focused proof.
5. Implement deletion as a later vertical frontier after product authority is
   available.

## Risks And Recovery

- Deletion can remove audio and durable chat. Preserve the existing confirmed
  product action and test the exact durable effects before acceptance.
- Provider inventory can refresh while a saved selection is stale. Repair the
  choice only against the current inventory and keep one state owner.
- Revert this bounded change if focused integration or composition proof fails.
- Identity migration is security-sensitive. Permit it only when the previous
  identity is the exact legacy ad-hoc `cdhash` form and the current bundle is
  `/Applications/Meetless.app`, has bundle ID `com.meetless.app`, passes
  packaged-resource attestation, and passes Developer ID verification for team
  `63M98WD275`. Persist the stable Developer ID requirement after migration;
  all later updates must match it exactly.

## Progress

- [x] Read repository workflow, product authority, and engineering references.
- [x] Complete independent UI and lifecycle discovery.
- [x] Implement one coherent vertical change for scrollbar and provider/model repair.
- [x] Run focused proof and attempt composition proof for this frontier.
- [x] Record the accepted destructive-data policy and implement meeting deletion.
- [x] Record the final result and move this plan to completed.
- [x] Reproduce and fix the owner-reported delete and model-picker failures.
- [x] Run direct component interaction proof and produce a fresh owner-test build.
- [ ] Encode and test the approved one-time legacy identity migration.
- [ ] Build two successive Developer-ID-signed packages with different CDHash.
- [ ] Install each from its exact DMG and prove LaunchServices opens a visible,
      persistent app with no identity cleanup or prompt between upgrades.
- [ ] Prove wrong path, bundle ID, signer/team, and invalid packaged resources
      remain rejected.
- [ ] Publish the second DMG path, SHA-256, signing/notarization status, and
      remaining external limitations.

## Decisions

- 2026-08-29: Use one vertical writer after read-only discovery because delete
  and provider selection cross UI, app state, RPC, and persistence boundaries.
- 2026-08-29: Keep the provider/model inventory secondary to the Ask task, as
  required by `docs/product/experience.md`.
- 2026-08-29: Accept the scrollbar and provider/model frontier after 54 focused
  tests, the surface build, app typecheck, and diff validation passed.
- 2026-08-29: Pause deletion because no accepted source defines confirmation,
  recovery, active-work behavior, or which persisted files must be destroyed.
- 2026-08-29: Accept the MEETING-DELETE brief as product authority. Use an
  explicit deleted/not-found/refused result and a durable same-filesystem
  quarantine manifest. Restore staged files before commit; finish cleanup on
  restart after commit.
- 2026-08-29: Accept correction findings MD-REV-001 through MD-REV-007 as
  binding. Restrict deletion to exact owner-tagged paths under configured
  store/export roots; publish integrity-checked manifests atomically; separate
  pre-replacement rollback from post-replacement convergence; fsync every
  affected directory; serialize meeting work with one shared lifecycle lease;
  lock selection while delete is pending; and let the finalizer enumerate only
  exact recording-owned stage names.
- 2026-08-29: PLAN_RECONCILIATION v1 after correction close-out. MD-REV-001,
  MD-REV-002, and MD-REV-005 are verified. MD-REV-003/004 remain open only for
  rollback after a post-rename directory-sync failure; MD-REV-006 remains open
  only for connection replacement during deletion; MD-REV-007 remains open
  only when deletion runs before recording-runtime bootstrap. Keep the current
  contract and architecture. Route one bounded convergence delta for these
  three exact cases, then use deterministic proof rather than another broad
  review loop.
- 2026-08-29: MEETING-DELETE-CONVERGENCE-R2 closes the remaining exact cases.
  MD-REV-003/004 now register each quarantine rename for rollback before the
  affected parent fsync. MD-REV-006 resets confirmation, pending, and safe
  error state at every connection epoch change and rejects stale delete
  responses. MD-REV-007 uses the finalizer's exact recording-owned stage-name
  enumerator before recording-runtime bootstrap. No contract, product policy,
  or architecture changed.
- 2026-08-29: Reopen after owner build test. Keep the accepted scrollbar. A
  failed recording whose meeting row still says Recording must remain
  deletable, and every refused delete must produce visible feedback. The model
  picker must accept pointer selection, render above transcript/audio, and
  close on outside interaction without blocking that interaction.
- 2026-08-29: Reopen as a release blocker after the exact ad-hoc DMG mounted but
  the installed app exited immediately. The persisted legacy designated
  requirement is a CDHash, and each ad-hoc rebuild changes that CDHash. Owner
  approved one narrow migration: exact legacy ad-hoc identity to a verified
  Developer ID app at `/Applications/Meetless.app`, bundle ID
  `com.meetless.app`, team `63M98WD275`, with packaged resources attested.
  After migration, exact stable Developer ID requirement equality remains the
  update rule. No ad-hoc-to-ad-hoc refresh is permitted.
- 2026-08-29: Installed launch exposed two additional bounded legacy/startup
  blockers. The exact legacy development media cache contains only private
  `media-tools/{ffmpeg,ffprobe}` and lacks the packaged owner/manifest files;
  migrate only that exact two-file cache transactionally. Startup and deletion
  also enumerated `~/Documents/meetings` for failed recordings with no session
  directory, although such recordings cannot own finalizer stages. Skip only
  that impossible scan; keep stage enumeration for active/recoverable/finalizing
  recordings and failed recordings that still have a session directory.
- 2026-08-29: Freeze implementation after these three observed causes:
  legacy CDHash identity, exact legacy media cache, and impossible export-root
  scan. If another independent launch blocker appears, stop for a new decision;
  do not expand this correction batch.

## Release-blocking Execution Handoff

Current diagnosis:

- Installed ad-hoc build CDHash: `e5ad657c2e46b09e654202511d3ff9823647008a`.
- Persisted legacy CDHash: `9d977a0d543b9bdd73879112673f52583fab5d9c`.
- The host exits before child startup because `publishIdentity` requires exact
  designated-requirement equality. This is correct for stable signatures but
  makes successive ad-hoc builds unusable.
- A Developer ID Application certificate for team `63M98WD275` is available.
- The first signed build migrated identity but did not launch and is excluded
  from acceptance. It exposed the legacy media-cache layout.
- The next instrumented launch migrated media but readiness timed out because
  Node `readdir` blocked on `~/Documents/meetings`; every persisted recording
  was `failed` without a session or `saved`, so no finalizer stage scan was
  required.

Implementation boundary:

1. Verify the installed packaged bundle using the exact path, bundle ID,
   Developer ID certificate OIDs, and team before identity migration.
2. Accept only a previous requirement in exact ad-hoc `cdhash H\"…\"` form.
3. Persist the current stable Developer ID designated requirement once.
4. Continue to require exact designated-requirement equality thereafter.
5. Mirror the policy in the TypeScript runtime and repository decision, with
   positive and negative mechanical tests.
6. Extend packaging only as needed to produce reproducible release-signed DMGs
   and two build identities for upgrade proof.

Acceptance boundary:

- Build A and Build B are Developer-ID signed and have different CDHash.
- Each exact DMG is mounted and installed to `/Applications/Meetless.app`.
- Each installed app is opened with LaunchServices, has a visible window, and
  remains running. Build B is installed over A without deleting or editing
  Application Support state and without a prompt or terminal intervention.
- Executable negative proof rejects wrong path, bundle ID, signer/team, and
  invalid resources.
- Final handback is Build B only, with absolute path, SHA-256, codesign result,
  notarization/stapling status, and any external limitation.
- Controlled pre-A start must have the preserved legacy identity
  `cdhash H\"9d977a…\"` and the exact two development tools whose SHA-256 values
  are `00d011…` and `daba6e…`. Build A must migrate both during one normal
  LaunchServices launch. Failed earlier builds do not count.

Repository state at handoff:

- Base HEAD: `9c23436`.
- The worktree contains the accepted UI/delete corrections listed by
  `git status`; preserve all of them.
- `vendor/paseo` is intentionally dirty at the runtime-required checkout;
  do not reset it.
- The prior broad ad-hoc identity-rotation experiment was reverted. No launch
  migration implementation is present yet.
- Use this plan only. Do not create another proof lane or active plan.

## Validation

- Focused proof: surface tests cover hidden meeting-list indicators with
  scrolling retained, compact provider/model expansion, invalid saved choices,
  and selection of another provider/model. App tests cover stale provider and
  model repair in `openTranscript` and `loadCompanionRestoration`.
- Repository-required checks: affected surface and app typechecks/builds and
  focused tests were run; meeting deletion remains outside this frontier.
- Composition proof: `npm run test:composition` was attempted. The chat path
  could not bind its localhost MCP server, and M6 could not bind `127.0.0.1`;
  both failed with `EPERM` in this environment.
- Meeting-delete focused proof: 76 tests passed across contract, store
  restart/rollback/idempotency, plugin safety gate, client RPC, app state,
  surface confirmation, and thin composition tests.
- Affected package proof: 229 of 233 tests passed in the restricted sandbox.
  Four existing socket tests failed with `EPERM`; the same 11 tests passed
  outside the socket sandbox. `npm run build:meetless`, app typecheck, app web
  export, and `git diff --check` passed.
- Final deletion/recovery rerun after the post-commit retry and active-scan
  guards: 37 of 37 plugin, store, and composition tests passed. The repository
  TypeScript build, app typecheck, app web export, and diff check also passed.
- Correction R1 focused proof: 103 tests passed. This includes negative
  path/root/symlink/shared/directory and tampered-recovery cases, manifest
  write/sync/rename faults, post-replacement sync convergence, parent-directory
  fsync assertions, four deterministic lifecycle races, recovery-state UI,
  pending selection lock, exact stage deletion, startup stage sweep, and the
  thin delete composition path.
- Correction R1 package proof: 249 of 253 affected-package tests passed in the
  restricted sandbox. The four local-socket cases failed with `EPERM`; all 11
  tests in those two files passed outside the socket sandbox.
- Composition proof: the delete path and three other composition tests passed.
  The remaining M6 case cannot launch because the workspace has Paseo
  `94b30b5e6d9af3c25bc50835d04edc53952a7772`, while runtime authority pins
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. The diagnostic harness change was
  removed after confirming this pre-existing dependency mismatch.
- Final candidate proof: 53 of 53 store, lifecycle, app, and delete-composition
  tests passed. `npm run build:meetless`, app typecheck, app web export, and
  `git diff --check` passed.
- Lead rerun after Correction R1: 253 of 253 affected-package tests and the
  delete composition test passed; build, app typecheck, web export, and diff
  validation passed. Close-out still reproduced the narrower rollback case and
  identified the reconnect and pre-bootstrap stage-cleanup gaps above.
- Convergence R2 proof: the three exact regression tests passed; store passed
  40 of 40, app passed 48 of 48, plugin socket rerun passed 11 of 11, and delete
  composition passed. Lead final acceptance rerun passed 256 of 256 affected
  package tests plus the delete composition test. Build, app typecheck, web
  export, and diff validation passed.
- Convergence R2 focused proof: 3 of 3 targeted tests passed. The store fault
  test injects failure in the first post-rename parent fsync and proves the
  original graph/files return with no manifest or quarantine. The app test
  replaces the connection during deletion and proves reset delete state plus
  stale-response isolation. The plugin test deletes an exact owned MP3 stage
  before runtime bootstrap while preserving unrelated and deceptive
  stage-like files.
- Convergence R2 package proof: meeting-store passed 40 of 40 tests and app
  passed 48 of 48 tests. Plugin passed 75 of 79 tests in the restricted
  sandbox; the four socket-bind cases failed with `EPERM`, and both affected
  files then passed 11 of 11 tests with local socket permission.
- Convergence R2 composition and build proof: the delete composition test
  passed 1 of 1; `npm run build:meetless`, app typecheck, app web export, and
  `git diff --check` passed.
- Owner retest correction: a Meeting row in `recording` is deletable only when
  the matching runtime recording is explicitly `failed`. A matching active,
  interrupted, recoverable, or finalizing recording remains protected. Store
  restart proof also covers a failed recording with no session directory.
- Owner retest interaction proof: direct component events select a provider and
  model, close the options, and close the options on an outside pointer without
  consuming the outside action. The picker header/options now have an explicit
  stacking order above transcript and audio content.
- Owner retest checks: 260 of 260 affected package and delete-composition tests
  passed. Repository TypeScript build, app typecheck, web export, and
  `git diff --check` passed.
- Owner retest artifact: local ad-hoc DMG
  `/private/tmp/meetless-dmg-proof.KXEcmp/release/macos/Meetless.dmg`, SHA-256
  `738a2cc46aa6eaf7269365ca8b3cb94d1da99f81626ad47e399f01bef4043979`.

## Result

The owner-reported delete and picker corrections are ready for owner testing.
The scrollbar remains accepted and unchanged. Keep this plan active until the
owner accepts the new local build.

The existing M5 Electron harness did not reach the renderer. Its envelope call
does not supply the export lease now required by runtime authority and failed
with `Cannot read properties of undefined (reading 'expiresAt')`. The focused
interaction proof passed, but this build does not claim a fresh full Electron
M5 composition result.

## Developer ID launch acceptance (2026-08-29)

- Implementation is frozen after the three bounded startup corrections:
  one-time legacy ad-hoc identity migration, exact legacy media-cache
  migration, and removal of the unnecessary failed-recording export scan.
- Controlled Build A start restored the preserved legacy identity
  `cdhash H"9d977a0d543b9bdd73879112673f52583fab5d9c"` and the exact legacy
  `ffmpeg`/`ffprobe` files with SHA-256 `00d011…` and `daba6e…`.
- Signed Build A (`CFBundleVersion=1004`) launched through LaunchServices from
  `/Applications/Meetless.app`. It showed an on-screen Electron window and the
  host, desktop runtime, daemon, Electron, and renderer processes remained
  running. Both legacy migrations completed in that one launch.
- Build A main executable CDHash was
  `3bf4b36b278a385f958a460f6c664d8c209af4db`.
- Signed Build B (`CFBundleVersion=1005`) main executable CDHash is
  `1e2f93a40219487bfa95be4a637c6078fb62eb0a`. Both builds have the same exact
  Developer ID designated requirement for team `63M98WD275`.
- No identity or media state was reset between A and B. Build B was installed
  from its DMG through the normal `/Applications/Meetless.app` path.
- Build B did not launch. The host evidence is:
  `packaged media source changed ...; refusing a wrong-source snapshot`.
  The installed media closure was produced from Build A, while Developer ID
  re-signing gives Build B's packaged media source a different fingerprint.
  This blocks every normal signed update even though the stable designated
  requirement is unchanged.
- Per the convergence boundary, do not add another implementation change in
  this acceptance session. The next bounded decision is how the media-closure
  authority identifies compatible packaged media across signed updates. Do
  not publish Build B or claim upgrade acceptance until that policy is fixed
  and the same A-to-B LaunchServices proof passes without state cleanup.

## Owner-approved transactional packaged media adoption (2026-08-29)

The owner-approved Option 1 correction supersedes the prior M7-F23 pending
decision and the temporary implementation freeze above. This frontier is
limited to these four files:

- `docs/decisions/0002-direct-notarized-macos-dmg.md`
- `docs/plans/active/meeting-library-chat-controls.md`
- `packages/runtime/src/config.ts`
- `packages/runtime/test/media-closure.test.ts`

The existing packaged startup composition already verifies the native host
before `prepareRuntime`; it is unchanged in this frontier. Runtime adoption
now derives the package root from the packaged plugin, requires the packaged
manifest and installation contract markers, and rejects media sources outside
that verified package root. It keeps one owned private `media-tools` closure.
An intact same-fingerprint closure is reused idempotently. A complete changed
closure is copied and validated in staging, the old closure is renamed to an
owned recoverable `previous` directory, and the staged closure is atomically
published. Restart recovery restores the previous closure when publication
stops after the old rename and removes the owned previous closure when the new
closure is already visible. Pre-publication failures preserve the old
closure. Tampered, partial, unowned, incomplete, escaping, non-packaged,
system, and Homebrew media fail closed; no user-data paths are involved.

Focused evidence from the candidate:

- `npx vitest run --config vitest.config.ts packages/runtime/test/media-closure.test.ts` — 1 file, 21 tests passed.
- `npx tsc -p packages/runtime/tsconfig.json --noEmit --pretty false` — passed with exit code 0.
- `git diff --check -- docs/decisions/0002-direct-notarized-macos-dmg.md docs/plans/active/meeting-library-chat-controls.md packages/runtime/src/config.ts packages/runtime/test/media-closure.test.ts` — clean.
- No package, signing, installation, launch, `/Applications`, or Application Support mutation was performed.

The real signed A-to-B LaunchServices acceptance proof remains deliberately
unrun at this frontier because packaging/signing/install/launch are outside
the acceptance boundary. The native host identity and signer trust policy are
unchanged. Candidate snapshot/diff identity is reported in the peer handoff.

## Correction batch SMTM-001–003 (2026-08-29)

This correction batch is limited to the six declared files for this frontier:

- `docs/decisions/0002-direct-notarized-macos-dmg.md`
- `docs/plans/active/meeting-library-chat-controls.md`
- `packages/runtime/src/config.ts`
- `packages/runtime/src/cli.ts`
- `packages/runtime/test/media-closure.test.ts`
- `packages/runtime/test/host.test.ts`

SMTM-001 is corrected by making packaged CLI `daemon` assert
`assertSupervisorOwnedByHost(config, process.pid)` before
`activateUiTestRun` and `prepareRuntime`. Development mode bypasses this
packaged-only gate. SMTM-002 is corrected with a durable owner-bound
transaction manifest. It records exact staging/previous paths, the expected
new fingerprint, phase, and previous directory identity. Recovery validates a
matching published target before retrying cleanup of that exact previous path,
even if recursive cleanup left it partial. Without valid authorization,
previous state is not removed; a previous path is restored only as an active
rollback candidate when the target is absent.

Focused proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/media-closure.test.ts packages/runtime/test/host.test.ts` — 2 files, 29 tests passed.
- `npx tsc -p packages/runtime/tsconfig.json --noEmit --pretty false` — passed with exit code 0.
- `git diff --check` over the six scoped files — clean; the active plan also has no trailing whitespace.
- No packaging, signing, installation, launch, `/Applications`, Application Support, or user-data mutation was performed.

The signed A-to-B LaunchServices proof remains an owner-level follow-up and is
not claimed here. No files outside the six correction scopes were edited.

## Transactional-adoption installed acceptance attempt (2026-08-29)

The six-file correction passed independent FAST close-out for SMTM-001,
SMTM-002, and the bounded SMTM-003 proof. Lead verification passed 49 of 49
direct-DMG, media-closure, and host tests, runtime TypeScript compilation, and
the scoped diff check. A further 38 of 38 signing-policy tests passed, including
rejection of an ad-hoc signer, wrong Team ID, signer/Team mismatch, a different
certificate with the same leaf and Team ID, missing per-image certificate
evidence, unsigned or modified Mach-O content, and post-signature mutation.

The real installed update used the preserved signed Build A
(`CFBundleVersion=1004`, main CDHash
`3bf4b36b278a385f958a460f6c664d8c209af4db`) and a fresh signed Build B
(`CFBundleVersion=1006`, main CDHash
`c34ee576bf709a9ef57e55a1d0a69e8c69b5700e`). Both satisfy the exact same
Developer ID designated requirement for team `63M98WD275`. Build A launched
through LaunchServices with an on-screen Electron window and stable host,
desktop, daemon, Electron, and renderer processes. Build B was then installed
over A from its exact DMG without deleting or resetting identity, media, or
user state.

The owner-approved media update policy worked in the real Build A-to-B update.
Build B changed the private snapshot manifest from SHA-256
`1161791daf74900199901898084f4937d53e57d85d6d60e4fce43c2d98c49a06`
to `08bf9f50bfb261be23f6ba6dcb1af508b00be452b9d1f479ded5ae39e120ecc4`.
Its packaged source and installed snapshot fingerprints both equal
`4af369408c7f785813c3e50cc073debeec8bad3ffbd91f0488aa6405f0288e3c`,
and no staging, previous, or transaction residue remains. Canonical
fingerprints for `meeting-store` and `~/Documents/meetings` remain exactly the
pre-update values `1df9f0382a679d9d93472cf56f7300f8bf2b7115dd699081eb398dc4157c73b4`
and `95b4cb099ec6bf30d4419c2edfc7689bc7fe051efb348a4f1bb538bfa806b8ad`.

Installed Build B does not satisfy the full handback boundary. LaunchServices
starts the native host, desktop supervisor, packaged daemon, and plugin, but
the recording-readiness handoff cannot reach
`recording-control.sock`; the log reports `connect ENOENT` for that socket.
The renderer on port 18082, Electron process, and visible window therefore do
not appear. Repeated untouched LaunchServices observations reproduce the same
fail-closed exit. Shutdown also reports a pre-existing PID-lock start-time
mismatch while refusing unsafe cleanup. No lock, socket, Application Support,
or user-data cleanup was performed. This is a separate recording-capability /
lifecycle boundary and is not authorized as a fourth subsystem correction in
this frontier.

The candidate DMG is retained only as blocked evidence at
`/private/tmp/meetless-dev-id-option1-b.1yN5Sm/release/macos/Meetless.dmg`,
SHA-256 `042749f59e62cfb162fa9df35db173883f9ed1ce2bebf73f59e86a64e5fed88f`.
Its app is Developer-ID signed with a secure timestamp, passes strict deep
codesign verification and its designated requirement, and the DMG checksum is
valid. Notarization was not run, there is no stapled ticket, and Gatekeeper
reports `Unnotarized Developer ID`. Do not hand this candidate back as the
owner UI-retest artifact or claim A-to-B launch acceptance. The active plan
remains open at the real installed Build B renderer/window blocker.

## Recording-capability startup frontier (2026-08-29)

Owner authority permits one separate correction limited to recording
capability/socket startup lifecycle and its direct composition proof. Startup
must still prove the exact host-owned supervisor, daemon, plugin, recording
socket, and native transcription capability before exposing the desktop. It
must not use stale-socket removal, manual cleanup, state reset, retry ceremony,
or weaker host/signing/media trust, and it must not mutate user data or change
active-recording and failed-recording deletion policy.

The prior paragraph's `recording-control.sock` diagnosis is superseded by a
correlated normal LaunchServices observation. Both
`paseo-home/recording-control.sock` and `transcription.sock` were Unix sockets
from four seconds through at least 32 seconds after launch, while the host,
desktop, daemon, and plugin remained live. A direct invocation of the same
packaged readiness composition then reported the actual failure:

`Refusing to stop PID 79280: lock start 2026-08-29T08:55:05.259Z does not
match live process start 2026-08-29T08:55:02.000Z`.

The Paseo PID lock records lock-acquisition wall time after the supervisor has
started, while Meetless compares it with second-resolution `ps lstart` as if
both represented the same instant. The observed normal 3.259-second bootstrap
interval exceeds the current symmetric two-second allowance, so authoritative
recording readiness fails during owned-process verification even though both
capabilities are live. The later shutdown PID-lock diagnostic is the same
comparison defect, not evidence that either socket failed to publish.

Baseline focused proof before correction is 41 of 41 passing lifecycle,
readiness, and host tests. The correction decision and positive/negative
composition evidence remain pending the independent foundation check; no
runtime source has been edited in this frontier yet.

The independent narrow foundation check accepted a directional bounded
comparison: `0 <= lock.startedAt - live.startedAt <= 5,000ms`. Five seconds is
the smallest round bound that accepts the observed 3.259-second packaged
bootstrap with limited variance. A lock timestamp before the live process still
proves stale PID reuse and fails closed; an acquisition after five seconds,
invalid timestamps, wrong command/UID/host/endpoint/marker, and an unrelated
listener tree also remain rejected. No Paseo/vendor change is needed because
its PID lock continues to truthfully record lock-acquisition time.

The correction is limited to `packages/runtime/src/lifecycle.ts` and its direct
`packages/runtime/test/lifecycle.test.ts` proof. Positive cases cover the exact
observed delay and the 5,000ms boundary. Negative cases cover one millisecond
before process birth, 5,001ms after birth, invalid timestamps, later-process
PID reuse, and all retained ownership mismatches.

## Owner UI retest — stale Recording delete reopened (2026-08-29)

The owner tested installed, visibly running Build 1007. Provider/model
selection is accepted and must not be reopened or reworked. The owner reports
that a stale Meeting displayed as `Recording` still cannot be deleted: for the
selected Meeting “Popkle” (2026-08-28 16:23), the top-right Delete control is
visible but clicking it produces no reaction. Multiple older sidebar entries
remain labeled `Recording`, while a later Meeting is `Ready`. The screenshot
artifact is
`/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/paseo-attachments-BPkBt3/60c8e8dca2d4b56c07969d74d17b7124c48f5e38a82d71917a7353514c974fae.png`.

This reopens only the click-to-delete eligibility path. Persisted `Recording`
presentation is not sufficient evidence that a recording is genuinely active:
a stale or failed Meeting must be deletable, while a genuinely active recording
must remain protected. Diagnosis and automated proof must not delete or mutate
the owner's real Meeting; final deletion acceptance remains owner-operated.
Provider/model behavior, dropdown dismissal, scrollbar behavior, signed media
updates, and recording startup are preserved boundaries outside this frontier.

Read-only foundation diagnosis traced the no-reaction behavior to the App
eligibility gate, before confirmation or RPC. `App.tsx` disables Delete when
the selected Meeting's persisted presentation status is `recording`, unless
the single runtime recording state is an exact matching `failed` state.
`MeetingDetail` still renders the normal-looking control and its pressable
swallows clicks while disabled, so stale entries with idle or differently
associated runtime state produce no confirmation, request, refusal, or error.

The store/lifecycle boundary is already authoritative: it rejects genuinely
active, interrupted, recoverable, finalizing, pending/transcribing, or running
Ask work and permits failed stale work even when the parent Meeting still has
persisted status `recording`. The smallest correction therefore removes only
the persisted-status veto in `packages/meetless-app/src/App.tsx`, retains all
matching runtime and durable backend protection, and adds focused App proof in
`packages/meetless-app/test/transcript-selection.test.tsx` for stale/ambiguous
runtime state plus the existing genuinely-active negative case. No client,
plugin, contract, store, surface, provider/model, media, signing, or startup
change is authorized by this frontier.

The bounded two-file correction is frozen at owned-diff SHA-256
`3f02bb84bdcf99e46ff82c6240665a6fb18fc7308794888d5eb1aa050355406f`.
Focused App proof passed 18 of 18 tests, including persisted `Recording` with
idle runtime, persisted `Recording` with runtime belonging to another Meeting,
and a matching genuinely active recording that remains disabled. The App
TypeScript check and scoped diff check also passed. No owner data, packaging,
installation, or launch operation was performed by the implementation owner.

Lead installed-acceptance used a fresh Developer-ID release package with
`CFBundleVersion=1008` over the owner's installed Build 1007 through the
transactional package replacement path. Build 1007's main CDHash was
`faa4bc0463b8738e2f10f7e5cf4627022d5cf12e`; Build 1008's is
`3545cd41f7e4b8435fc006a4fc1729afd19550c3`. Both retain bundle identifier
`com.meetless.app`, team `63M98WD275`, and the same stable Developer ID
designated requirement. Build 1007 exited through its normal application quit;
no lock, socket, identity, media, Meeting, recording, export, or other user
state was manually removed or reset.

Build 1008 launched through LaunchServices and remained stable with the native
host, desktop runtime, daemon, plugin, recording socket, transcription socket,
Electron, and renderer live. Renderer HTTP returned 200 and CoreGraphics
reported an on-screen 1881 by 998 Electron window. The pre-install and
post-launch canonical Meeting-store fingerprint is unchanged at
`04443d7a43b18ad75e261dc10f484f442e6c110d7705ccc3638493ccc1f2be1a`;
the recording-export fingerprint is unchanged at
`95b4cb099ec6bf30d4419c2edfc7689bc7fe051efb348a4f1bb538bfa806b8ad`.
Packaged-media source and private snapshot fingerprints converged at
`f6130ac23b33a53a318a83cc4b3b8a86fadc1b3b245d8c81b5304401faed8cfa`,
with the source rooted under `/Applications/Meetless.app` and no transaction
residue.

The fresh owner-retest DMG is
`/private/tmp/meetless-dev-id-stale-delete-b.1O6o1O/release/macos/Meetless.dmg`,
SHA-256 `0140e268643625765877565d3af5a601daf4c130f9d63eecde39fd9a7efefbb1`.
The app passes strict deep codesign verification with a secure timestamp and
Developer ID Application identity for team `63M98WD275`; the DMG checksum is
valid. Notarization was not run, neither app nor DMG has a stapled ticket, and
Gatekeeper reports `Unnotarized Developer ID`. Stale-Meeting deletion remains
pending owner acceptance and is not claimed by this automated handback.

## Recording-start TCC correction candidate (2026-08-29)

`TCC-V1-CORRECTION-R2` preserves the accepted transactional zero-media
recording-start rollback and media-recovery dirty diff. Permission readiness
now fails before Meeting creation and helper startup through the signed host's
typed public-API boundary; the existing second pre-helper authorization and
rollback path remain intact. Focused plugin proof, including permission denial,
rollback cleanup failure, retained-media recovery, and retry behavior, passed
as part of the 217-test correction run. No Meeting or recording data was
deleted or mutated by validation.

### TCC correction R3 progress (2026-08-29)

R3 retains both accepted recording authorization gates and clarifies that the
pre-authorization prohibition starts at Meeting creation (`store.create`) and
helper spawn, not MeetingStore bootstrap. This preserves in-context denied and
not-determined recovery while keeping transactional rollback and media recovery
unchanged. Implementation is limited to renderer-route intent binding and
app/surface permission-state recovery.

Correction implemented: permission mutations now require exact packaged
renderer Origin/Host plus a fresh five-second one-use token obtained immediately
before the user action. Negative proof rejects missing, invalid, replayed,
foreign-origin, foreign-Host, and malformed-source requests before native
invocation. Status transport/decode and settings failures clear checking, remain
visible, and always leave an actionable Recheck path; `settingsOpened=false` is
a failure. Absent runtime state is again Proposed and typed `notDetermined` is
Will ask. Direct proof passed 59 of 59 tests; the serialized focused regression
passed 604 of 604. Native and TypeScript builds, app typecheck/export, and diff
checks passed without launch, real permission action, signing, installation,
data deletion, or commit.
