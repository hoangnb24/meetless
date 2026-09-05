# Execution Plan: Meetless V1 Release Readiness

## Current State

- `plan_revision`: `v126`
- `current_frontier`: `R5-MAS-ATTEMPT19-NATIVE-DIAGNOSTIC-RUNTIME-PROOF`
- `state`: `ATTEMPT19_READINESS_FAILED_RECOVERED_CHILD_IDENTITY_MISMATCH`
- `depends_on`: accepted managed-transcription foundation candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88`; production integration must preserve its policy, lifecycle, and local-publication boundaries
- `candidate`: terminal-archive source candidate implemented from immutable base `f003c05`; local commit identity is handed off separately for Lead acceptance. No MAS artifact, package, install, launch, or external gate is accepted by this implementation.
- `authority_contract_sha256`: `ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297` (old correction-base digest was `8b2c3a70917c2c7e5b26cf9bcfe8c19bb5abeb9a54f0aeec6bf256e5440dca91`; ordered SHA-256 manifest of ADR0003, amended ADR0005, product monetization, and macOS artifact-validation authority files)
- `Convex target`: owner-selected/observed project `hoang-bang/meetless`, existing dev deployment `frugal-mandrill-646`, reference `dev/hoang-bang`, region `US East (N. Virginia)`; production deployment does not exist
- `failed_proof`: Attempt 12 artifact root `/private/tmp/meetless-mas-development-proof.pwHECm` has manifest SHA-256 `3c8fff584926cf0e1e0d082a65264b175d7e8a7c8b3eacf0cf007dba658b778a`, launch PID `18597`, and brief record `16777/no 18082`. It reached no accepted readiness; approximately 829 MB of attempt-created runtime state mixed with approximately 37 MB of pre-existing state, and the aggregate fell from approximately 37,632 KB to approximately 24 KB. The owner confirmed no external/manual backup; classify the loss as unrecoverable and claim no reconstruction. No external gate was opened and no retry is authorized.
- `pending_ruling`: the terminal-only archive assurance implementation is locally complete, but its source candidate remains pending Lead acceptance and read-only coordinator verification. Attempt 18 had one interrupted Phase-1 invocation, no accepted artifact and no Phase-2 admission. External retry/build/install/recovery operations remain held; existing excluded gates and push remain closed.
- `diagnostic_source_candidate`: Lead-accepted `8759ec6d494018e2bfd7a01682b6f5af0fb2f409`, packaged and exercised in Attempt 17; its retained timeout diagnostic narrowed the failing readiness subcheck.
- `blocked_by`: no in-scope implementation dependency remains; Lead acceptance and read-only status verification remain pending. Historical volume continuity is still unproven by design.
- `next_action`: review the local parent pin candidate, then assess the separately queued launch-failure enum work; no external retry admitted.

### A19 argv-drift ruling and fork correction boundary

Parent candidate b25d69aea6e5e309f5a46659fd9a8f2c94a5b859 is not yet accepted:
pin/marker delta is scoped, but verify:paseo-bundle cannot reconstruct the new
fork commit from the referenced historical bundle. Lead verified the dependency
record points at old 018c8114...bundle while expectedCommit is a2c8ff349....
This is missing immutable dependency material, not a reason to bypass validation.
Authorize one SERIAL completion of the same integration: generate one new
content-addressed self-contained Git bundle for the exact reviewed fork commit,
update bundle path/hash/size metadata, and prove fresh offline checkout/fsck.
Preserve both existing bundles and all existing fork refs; use an isolated
temporary Git repository for the bundle ref rather than overwriting the
pre-existing refs/meetless/bundle-candidate (currently points elsewhere).
No remote access/push, new fork revision, lockfile or application behavior change.
Generated bundle is source evidence, not a MAS package or role configuration.
Use the existing verifier unchanged unless a concrete defect is demonstrated.
Parent candidate acceptance remains held until the verification passes.

Lead local fork checkpoint: accept a2c8ff349ffdf6f500eb09270c7f44af4c018bfc
from 7618cda71e2836f9ba7e821286504841203cb745 for bounded parent integration,
not release/runtime acceptance. Exact fork delta: two guarded title assignments
and daemon-identity.test.ts. Lead inspected delta/marker propagation, clean fork
worktree and whitespace; reran four identity tests with parent-provided Vitest,
all passed. Initial invocation looked for absent fork-local Vitest and failed
before tests; corrected explicit executable passed. Writer server build passed;
oxfmt/oxlint/tsgo unavailable and not installed. Test imports real source modules
and observes a pre-set fixture title via ps; this proves assignments are skipped,
not full native argv attestation or an installed MAS lifecycle.

`NO_REVIEW`: independent causal/design judgment already obtained; this two-guard
implementation is deterministic and does not change native policy. No further
macro review would resolve missing live evidence. ADR0001 recording/desktop
acceptance remains unrun and must not be claimed by the local pin checkpoint.
One SERIAL writer may now integrate only the reviewed gitlink, pin constants,
direct marker fixtures and plan in parent history. No fork/lockfile changes,
push or external attempt. The separate bounded launch-failure enum work remains
queued after this integration; shared checkout/proof surfaces mean SERIAL,
not concurrent writers without isolated worktrees.

Role boundary: changed fork paths and generated server output contain no added
Room role configuration per writer audit; known test/example provider IDs are
not installed role profiles. Actual future MAS artifact still needs the role
configuration exclusion check; source scan is not artifact acceptance.

Explicit project-owner boundary: Codex Room Supervisor/Lead/Peer role
configuration belongs to codex-room-setup, not the maintained Paseo fork and
not any Meetless artifact. This applies to the current fork correction and
subsequent pin/package acceptance. Do not copy role prompts, provider profiles,
setup defaults or room configuration into runtime source, generated output or
package inputs. Generic provider support is not authorization to ship role
configuration. The Paseo daemon supervisor is a runtime process manager, not
the Codex Room Supervisor role; its legitimate runtime code is not prohibited.

Lead relayed this boundary to the active sole fork writer without expanding
the two-entrypoint correction. Initial tracked-content scan found role IDs in
four test files and public-docs/mcp.md examples; this is not yet proof of an
installed role profile or clean artifact. Classify those references and actual
configuration/package inputs before acceptance; do not equate a keyword match
with configuration or silently claim the entire artifact is clean. Any cleanup
of pre-existing role-specific examples/configuration is separately scoped after
the moving fork candidate is stable, never competing edits or broad deletion.

Lead accepts independent A19-DAEMON-IDENTITY-001: title-driven argv drift is a
sufficient supported cause of native supervisor pruning. Native exact equality
is correct and will not be weakened. Both supervisor and worker set title;
the existing packaged environment marker is available before these assignments.
Preserve launch argv in packaged mode while leaving direct-development titles
unchanged. This is runtime infrastructure in the maintained fork, not meeting
policy or an exception to native identity checks.

ADR0001 requires separate fork history and reviewed immutable pin integration.
Authorize one SERIAL local fork candidate from
7618cda71e2836f9ba7e821286504841203cb745 in the existing submodule, limited to
the two entrypoints and focused fork tests. No push, remote mutation, lockfile,
upstream merge or parent gitlink acceptance yet. The local submodule HEAD may
move to the candidate; this is unaccepted pending integration, not a new pin.
Meetless parent source remains unchanged during fork work. Lead will own the
later explicit pin/marker integration and necessary package-source proof.
Recording/capture remains excluded; an eventual local pin checkpoint must
report unrun recording proof rather than silently claim full ADR0001 release
acceptance. No distribution or publication is authorized.

### A19 parent pin integration checkpoint (2026-09-05)

The parent integration starts from exact base
`51951c040471b75131cf30313107dca68530b653`, which already contains only the
Lead plan routing from the fork handback. The checked-out `vendor/paseo`
gitlink is advanced locally to the Lead-accepted fork candidate
`a2c8ff349ffdf6f500eb09270c7f44af4c018bfc`, whose fork parent is the original
`7618cda71e2836f9ba7e821286504841203cb745`. This is a local parent candidate,
not Lead acceptance of release or runtime proof.

The current pin/marker contract is updated coherently at the existing owners:
`scripts/lib/paseo-dependency.mjs` and
`packages/runtime/src/config.ts` now name the candidate, and current package
marker/pin fixtures in the focused runtime tests plus the native marker fixture
use that same exact commit. Historical artifact baselines and historical plan
records remain unchanged. No fork file, lockfile, launch-diagnostic source,
package/sign/install/launch/recording/TCC/network state, or protected artifact
was changed. The fork audit found no added Codex Room role configuration; the
future packaged-artifact role exclusion remains an independent audit and is
not claimed by this checkpoint.

Observed local proof:

- The focused parent Vitest command passed five files with 96 tests passed and
  one existing skip.
- `npm run typecheck`, `npm run build:meetless`, and `npm run build:native`
  passed. The native command passed both debug and release
  `MeetlessHostTests` executables.
- The package-source snapshot passed with digest
  `03c7fdad96d595b1983bbc67ed8af444b99a1012d67f2b70dec3b51c1bb55560`, parent
  head `51951c040471b75131cf30313107dca68530b653`, gitlink and expected commit
  both `a2c8ff349ffdf6f500eb09270c7f44af4c018bfc`, and the existing bundle
  size/hash unchanged.
- The offline bundle validator remains intentionally unaccepted: the existing
  content-addressed bundle contains only the historical
  `7618cda71e2836f9ba7e821286504841203cb745` ref, so checkout of the new
  candidate fails closed. Updating or regenerating that bundle is outside this
  parent-pin scope and no package proof is claimed.
- Root format/lint scripts are absent; the maintained fork's `oxfmt`,
  `oxlint`, and `tsgo` are unavailable in this checkout. No tool installation
  was attempted. The frozen authority aggregate remains
  `ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The separate coordinator launch `exit1` remains unresolved and is not
attributed to this pin integration. ADR0001 recording/desktop proof remains
explicitly unrun and excluded.

The coordinator launch exit1 is separate: native handoff is claimed before
children start, whereas title mutation occurs afterward. Existing sanitized
evidence cannot identify its failing branch. Retain this independent issue;
do not claim the argv correction fixes launch acceptance or renderer delivery.
Avoid another external run until its available evidence/source is assessed.

### Attempt 19 close-out and runtime diagnosis

Run f76291eb-7f8b-44cf-8c73-46f85cafb2cc: install once exit0, launch once
exit1, readiness failed at plugin bootstrap, restore once exit0. No manual
stop/launch, rebuild or retry. Evidence is retained under
`/Users/tubakhuym/Library/Logs/Meetless-dev-proof/attempt19/phase2-J7K4mN`.
Lead read terminal/observation/restoration evidence and full operator handback;
fresh authoritative status confirms this run archived with exact-recorded-device
assurance and repository-owned live inspection returns absent.
Operator evidence proves app fingerprint/CDHash and runtime inode43589382,
dev16777232, digest9e870f5fd3f9e97af20d4434d0017decb53f8c026c87a05e245fef5f3d241e06
returned to their pre-attempt baseline. Accept recovered terminal disposition,
not user-test readiness. Operator moving scope is released.

Native evidence now retains `action=prune role=daemon stage=inspection
check=child-identity-mismatch os=none pid=86634 generation=1 revision=9`.
H86339 -> D86605 -> S86634 -> W86686 and plugin86721 were observed; capture
helper absent, renderer18082 absent, daemon16777 present before recovery.
Observed supervisor argv became ["Paseo Supervisor", "", ""]; worker argv
became ["Paseo Daemon", "", ""]. Source sets process.title in both roles;
native pruning compares full current identity to the registered snapshot.
This is a concrete causal hypothesis, not yet an isolated reproduction proving
which identity field changed at the prune instant. Launch exit1 had only the
safe coordinator-failed-closed category retained; do not conflate it with the
prune event without checking the actual launch acceptance path.

`FOUNDATION_CHECK v1`: one bounded read-only Peer will establish the changing
field/control flow and smallest safe correction boundary, including whether
the process-title behavior can be kept from changing attested argv rather than
weakening identity security. No implementation or external retry dispatched.
Avoid another generic diagnostics layer if an isolated existing seam can prove
the cause. Any fork/pinned-input change needs explicit Lead scope ruling.

### Attempt 19 authorization reconciliation and artifact acceptance

Owner specifically proposed "restore, chạy attempt 19"; after Lead explained
archive verification before that named attempt, owner replied "Ok thế bạn
quyết đi, mình giao toàn quyền rồi mà. Xử lý cho xong để mình có thể test thử".
Lead rules this authorizes the named bounded Attempt 19 workflow, satisfying
the earlier separate-owner retry gate for this episode, not all future retries.
The temporary supervisory reconciliation hold was resolved in the task-local
record `/Users/tubakhuym/Library/Logs/Meetless-dev-proof/attempt19/lead-authorization-reconciliation.md`
without changing the source during build. That decision is now absorbed here.
Supervisor did not act on the operator; Lead retains handback ownership.

Phase 1 completed exactly once at source `483c7a50f861f17237249473633a16dcd650154f`:
wrapper 6933/npm 6937, start 2026-09-05T15:15:31.728Z, exit 0/signal null at
15:27:49.290Z. No install/launch/recovery occurred. Evidence directory:
`/Users/tubakhuym/Library/Logs/Meetless-dev-proof/attempt19/run-D3S1jW`.
Lead read terminal, validator and source-parity records, independently hashed
the manifest and bundle and ran deep/strict codesign (exit 0):

- Artifact `/private/tmp/meetless-mas-development-proof.pGYeDE/release/macos/Meetless.app`
- Manifest SHA256 `b30a5fd9d8cc5dc7c4d0dc0e69122081bc24f076cfec0dc7a4cbfd1409bd0984`
- Fingerprint `f0c4eb2fbbd6a5fd31a22f12b571fd6f67fc316ecd316a4093be3a9e33cccd45`
- Artifact digest `f2a774a00091a861818674cb8b5c325b1007db2931f0ea01f1af1f5a99ec05db`
- Recorded CDHash `69ea6f1d9a67a74e9db10a7adaf7ce87a9e55e99`; Lead observed correct Apple Development signer, Team 63M98WD275 and thin arm64.

Lead accepts this artifact checkpoint. Phase 2 is now separately admitted for
the same named attempt: one coordinator install, one LaunchServices launch
with observer armed beforehand, bounded diagnostic observation, then coordinator
package-first restore regardless of readiness outcome. No rebuild, repeated
launch, standalone stop or manual cleanup. Any refusal ends progression and
retains evidence. Readiness remains unproven. Existing excluded gates remain
closed; owner-test installation left running is not promised by this proof.
The authoritative key hash is the full 64-character value in terminal/validator
records (the peer summary omitted its final character); no raw key is recorded.

### Lead source acceptance and Attempt 19 Phase 1 (2026-09-05)

Lead accepts `4ad3d532e4bbab8dd8110a2376b384fbf7e3f0ca`, original base
`f003c05cc86ddfc9a887179f5c30ad68d158164d`, correction base
`62f7505b290b63ae7170ddc8a3f96d7dd7efb98a`. Cumulative six-file scope matches
the declared transaction/coordinator tests, native host/tests and plan.
Independent same-Peer FAST closeout closed R5-MAS-TERMINAL-ARCHIVE-001.
Lead inspected the comparator and all call sites, preserved current-parent
device guard, ancestry, whitespace and frozen hashes; personally ran native
build with debug/release tests (exit 0) and the unchanged Node suites (133 pass).
Writer typecheck passed. No full HostDelegate/live readiness claim is implied.

Lead then ran the read-only authoritative session status: exit 0, archived,
package not-applicable, four terminal archives each explicitly classified
limited-non-device-equivalent, recorded non-device properties matched,
historical volume continuity unproven, retained content digest not recorded.
Repository-owned inspectMasLiveState returned absent with all four counts zero.
No archives or roots were modified and no lifecycle mutation was needed.

This supersedes the historical pending-acceptance/blocked fields above. Under
existing scoped owner authority, admit exactly one fresh package/build/sign
Phase-1 invocation for Attempt 19. Sole operator owns ignored build output and
fresh proof/evidence only; repository source and protected paths stay frozen.
Record invocation ownership/start/PID and evidence location before waiting,
retain terminal exit explicitly, and never infer success from intermediate
build output. Incomplete results are rejected, not automatically retried.
No general artifact-retention framework is required. Phase 2 needs a separate
Lead artifact acceptance brief; install/launch/restore counts remain zero now.
All billing, production, real capture/TCC/export, upload/publication, push and
manual evidence cleanup exclusions remain closed.

`PLAN_RECONCILIATION v1`: reboot archive foundation and native parity are
absorbed. Return directly to packaged native diagnostic/runtime proof; do not
add automatic cross-reboot recovery or unrelated hardening to this frontier.

### Terminal archive assurance decision and implementation authority (2026-09-05)

Lead acceptance checkpoint: candidate `62f7505b290b63ae7170ddc8a3f96d7dd7efb98a`
is reopened on exactly `{R5-MAS-TERMINAL-ARCHIVE-001}`. Independent ordinary
Peer found the unchanged Swift archived-artifact guard still compares retained
root device exactly before native handoff. Lead verified that call path and
accepts the finding: Node acceptance alone cannot deliver a launchable state.
The shared active/handoff comparator must stay strict; the bounded correction
belongs only to the terminal native archived-root guard and direct regressions.

Lead personally reran the two focused Node suites from repository root:
133 tests passed. An earlier workspace-cwd invocation failed four tests because
repository-relative script/fixture paths were resolved from packages/runtime;
the correct root invocation passed without source changes. Ancestry, four-file
manifest, diff whitespace and all four frozen authority hashes matched.

`PLAN_RECONCILIATION v1`: one accepted correction batch, one SERIAL writer;
expand ownership to native/macos-host/MeetlessHost.swift and its existing
TranscriptionCapabilityTests.swift plus this plan. No competing Node writer or
second independent feature. Require actual native test execution and retained
Node regression proof; reuse the same reviewer for FAST closeout of this
finding and correction delta. External attempt remains held. This is native
composition of the accepted terminal exception, not a new assurance policy.

### R5 native parity correction evidence (2026-09-05)

The correction started from exact HEAD `d97bc5e02490ab05e6bcd69d4a516417ecc5a17c`,
whose only prior change after correction base
`62f7505b290b63ae7170ddc8a3f96d7dd7efb98a` was the Lead's plan-only routing;
that routing and its authority text remain preserved. The native correction
keeps the shared `sameMasGateStableRootIdentity` comparator exact for active,
ready, and host-handoff paths. Only `assertArchivedMasTransactionArtifact`
uses the named terminal archived-retained-root comparator, which ignores the
historical numeric `dev` while retaining every existing stable non-device
comparison. The surrounding current-retained-root-to-current-parent device
check, archive ownership/mode/path/symlink checks, exact journal paths and
archived phase remain unchanged. Native records no retained content digest, so
this correction makes no content-equivalence claim.

The native test seam proves an archived retained root with a device-only
difference is accepted, the shared active/ready/handoff comparator rejects the
same device difference, and archived type, mode, owner, group, and inode
differences remain rejected. `npm run build:native` from repository root
passed the RevenueCat-linked host and MAS mutation builds, then both debug and
release native test builds and executables. The mandated focused Node
transaction/coordinator command passed 2 files and 133 tests from repository
root without Node changes. A preliminary standalone debug executable run used
`command -v node` instead of the build script's canonical `process.execPath`
and failed only its existing package-builder path precondition; the required
root build command supplied the canonical path and passed.

Cumulative changed-path manifest from original base `f003c05` is now:

- `scripts/lib/macos-mas-gate-session-transaction.mjs`
- `packages/runtime/test/macos-mas-gate-session-transaction.test.ts`
- `packages/runtime/test/macos-mas-development-gate.test.ts`
- `native/macos-host/MeetlessHost.swift`
- `native/macos-host/TranscriptionCapabilityTests.swift`
- `docs/plans/active/v1-paseo-foundation.md`

No protected state/build material was changed. No real archive, nested mounted
device, live launch/recovery, package/install/sign operation, credential,
network, or external gate was used. The frozen authority aggregate remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`; the
scoped plan-v118 owner decision and Lead v119 routing remain separately
identified and are not represented as part of that frozen digest. This
correction remains pending Lead acceptance and FAST closeout.

After the explicit limited-assurance recommendation and confirmation question,
the owner directed: "Ok thế bạn quyết đi, mình giao toàn quyền rồi mà. Xử lý
cho xong để mình có thể test thử". Lead exercises that specific delegated
decision now: accept a terminal-only non-device-equivalence assurance class,
not historical volume continuity. This resolves the confirmation hold below.

Accepted rule: only fully terminal `archived` evidence may use a derived
comparison projecting serialized device identifiers to their recorded values.
All other recorded properties must match; traversal must enforce current-device
uniformity and existing symlink/hardlink/ownership/path protections. Retained
fresh-root checks remain at their existing recorded evidence depth, with only
the same explicit device exception; do not imply a retained-content digest
where none was recorded. Journals and retained roots remain immutable.
Report the limited assurance explicitly through the authoritative coordinator;
never label it exact historical volume equivalence. Unknown or non-device
differences still refuse progression without mutation.

Active, construction, ready, archive-intent, restore and new pre-write checks
retain exact device identity. A new transaction independently records its
current baseline. This exception does not authorize active recovery across
reboot, a generic migration framework, or manual repair of old archives.

`FOUNDATION_CHECK v1`: independent design result accepted conditionally on the
above explicit assurance decision; no second discovery loop is needed.
One SERIAL writer owns the bounded transaction/coordinator/test change and
this plan after dispatch. Lead does not implement the moving scope. Acceptance
requires positive device-only proof, negative non-device/active-state proof,
coordinator propagation and new-transaction baseline composition proof. The
same ordinary foundation Peer may assess the stable candidate's residual
lifecycle risk; no OCR or broad unrelated review is prescribed.
External operations remain held until source acceptance and read-only status
verification; then Lead may brief Attempt 19 under existing scoped authority.

### R5 terminal archive device assurance implementation evidence (2026-09-05)

The bounded implementation is complete from base `f003c05`. It changes only the
transaction attestation owner, its native transaction tests, the native
coordinator composition test, and this plan. Terminal `archived` status derives
a digest by projecting only serialized `dev` fields to the recorded value while
the live traversal still requires the current parent device for the root and
every entry. Every other digest field, root identity field, file byte, metadata,
symlink target, and hardlink grouping remains exact. Active, construction,
ready, archive-intent, restore, and new-begin baseline paths remain exact.

The coordinator reports `terminal-archive-limited-non-device-equivalence`,
`recordedNonDeviceProperties: matched`,
`historicalVolumeContinuity: unproven`, and
`retainedFreshRootContent: not-recorded` when a terminal device projection was
needed. Same-device archives retain the exact-device classification. Journals,
retained roots, and old evidence are not rewritten by the implementation.

Changed-path manifest:

- `scripts/lib/macos-mas-gate-session-transaction.mjs`
- `packages/runtime/test/macos-mas-gate-session-transaction.test.ts`
- `packages/runtime/test/macos-mas-development-gate.test.ts`
- `docs/plans/active/v1-paseo-foundation.md`

Observed proof on isolated fixtures: the focused transaction/coordinator
command passed 2 files and 133 tests; `npm run typecheck` passed. The first
focused run exposed one test expectation that matched `device` but the
diagnostic used `dev`; the test expectation was corrected and the rerun passed.
The fixtures covered device-only terminal projection, non-device mutation
rejection, retained-root identity without a content digest, active and
archive-intent strictness, coordinator propagation, and a fresh current
baseline. No nested mounted-device fixture, real archive, live runtime probe,
package/sign/install/launch/recovery operation, network, or external gate was
used.

Enforcement remains repository-native: local focused Vitest and typecheck are
available and passed; no active hook was found beyond checked-in Git samples;
no checked-in CI workflow invoking these commands was found; branch protection
is unverified.

### Owner boundary question: post-reboot scope classification (2026-09-05)

Foundation result / Lead ruling: ordinary Peer `be99120b` returned
`DEPENDENCY_REQUEST` at `c0b9b335c3388bfaf055236599bd11d3591d7e25`.
Lead verified the digest construction, uniform-device traversal, hardlink
grouping and separate retained-root device checks. A terminal-only derived
digest with only serialized device fields projected to the historical value
could prove equality of the other recorded properties, but cannot prove
historical volume continuity. No historical volume binding is retained in the
journal. This is a conditional verification design, not observed equivalence
of the live roots and not an accepted correction.

Lead recommends explicitly accepting this limited historical assurance for
completed archives only, while preserving their bytes, requiring every other
recorded property to match, reporting volume continuity as unproven, and keeping
all active-transaction/device/pre-write/restore checks strict. A fresh run would
record its own current baseline. If any required comparison fails, stop without
mutation. This changes the assurance delivered, so broad technical delegation
is not treated as silent approval to relax it. Owner confirmation is required
before implementation; no further review loop or external attempt is opened.
The alternative is to keep the gate blocked pending historical volume evidence.

Owner subsequently accepted the narrow recommendation and delegated technical
execution: "Đồng ý, please act on my behalf, bạn toàn quyền quyết. Chúng ta cần
đẩy nhanh tiến độ hơn." Lead selects terminal-archive handling as the next
bounded outcome; automatic active-transaction recovery and full artifact
retention are deferred. Existing data protection and excluded external gates
remain unchanged. Routine implementation decisions do not require another
owner approval; reduced historical assurance is not silently authorized.

`FOUNDATION_CHECK v1`: the remaining decision is evidence sufficiency for old
terminal archives, not a general recovery design. One ordinary read-only Peer
will independently identify the smallest defensible behavior and focused proof,
including whether existing journal evidence can support it without rebaseline
or archive mutation. Lead owns the final ruling and subsequent writer brief.
No writer is active. SERIAL remains the routing default; no two writable
frontiers are ready. This foundation check is a bounded prerequisite, not a
new broad review loop. Build/install/launch remain held until acceptance.

Scope judgment only, requested by the owner. No implementation, review dispatch,
external attempt, identity-policy relaxation, or new artifact acceptance is
authorized by this record. The proposed frontier has no frozen implementation
candidate yet; its broad name must not implicitly bundle the outputs below.

**Causal boundary.** Attempt 18 never entered install. Its missing package exit
and artifact evidence require rejection, not runtime recovery. The separate
current status refusal follows `readMasGateSessionStatusBody` ->
`assertArchivedState` -> `assertRestoredRoots` -> `assertAttestation` ->
`attestRoot`: even terminal archived transactions compare the current root to
the historical numeric device. That field also participates in the aggregate
digest and retained-root identity checks. Removing one comparison is neither
a complete fix nor evidence of historical equivalence. This work can prevent
the observed post-reboot verification blockage; it cannot prevent the machine
crash or fix the independent native daemon-registration failure.

| Mechanism/output | Classification for single-operator dev MAS | Independent completion boundary |
| --- | --- | --- |
| Whole-root preservation, no overwrite/delete of prior state, artifact/target binding, shared lock, owned-process absence, active identity checks, package-first rollback, unknown-state refusal | Existing mandatory safety, not optional production hardening. A single operator still has host/helper concurrency and valuable pre-existing data. Preserve; do not reopen completed work without causal evidence. | Existing safety proof remains valid across the actual changed surface; no weakening of active-transaction checks. |
| Authoritative handling of terminal archives after reboot | Necessary next foundation scope for the observed blocker. Establish a defensible distinction between completed historical evidence and the identity needed for a new run. | An evidenced allowed post-reboot terminal state is classified correctly; changed or ambiguous state is rejected with all bytes preserved. Archive and retained-root checks are covered, not just the first device comparison. Current old archives require an explicit evidence disposition. |
| Build start/ownership/result handback and evidence surviving interruption | Separate operational reliability output. A bounded durable invocation record addresses coordination ambiguity; missing exit remains unknown and missing artifact remains rejected. Full artifact retention/resumption is not necessary for safe rejection or for the archive fix. | A new Lead can classify the interrupted invocation without inventing completion or reusing unaccepted outputs. Retaining signed artifacts across reboot is a further storage/output choice. |
| Recovery or resumption of an active install/restore across reboot; broad legacy migration, volume replacement, unattended multi-operator operation | Separate recovery/production-hardening scope, not causally required by this Phase-1-only crash. Safe detection, preservation and refusal of unresolved active state remain mandatory now. | Rehearsed recovery at the relevant mutation boundaries with its own identity and compatibility proof; not inferred from terminal-archive tests. |
| Native prune diagnosis, any resulting runtime correction, packaged renderer and owner-test readiness | Independent user-facing output; accepted diagnostics have not yet proven or fixed the native failure. | A fresh accepted artifact reaches the required runtime/renderer behavior and bounded shutdown/recovery. A green coordinator status is not this result. |

**Lead recommendation and owner tradeoff.** Narrow the next foundation to safe
terminal-archive handling for the current dev gate. Keep interruption behavior
explicit: stop and preserve ambiguous state; reject unverifiable packages;
rebuild only under a fresh brief. This minimizes new implementation, review and
reboot-test surface on the route to an owner-testable app. It accepts rebuild
time and Lead inspection after interruption rather than promising unattended
resume. It does not trade away protection of existing data.

Requiring automatic recovery at every mid-install crash point, historical
identity migration, or durable retention of every full artifact expands the
requested output and adds implementation/test time and storage cost. No honest
hour estimate exists before selecting and bounding that design; same-day app
readiness is not established. These guarantees must not become silent
prerequisites of the dev-runtime deliverable. Conversely, substituting a new
baseline for unproven historical equivalence changes the assurance delivered
to the owner: it is not approved here and cannot be disguised as a refactor.

The lifecycle coordinator owns any later archive classification change; the
build operator owns invocation/artifact evidence; runtime ownership remains
separate. These responsibilities vary independently. Runtime proof depends on
accepted gate state and artifact, not on a general-purpose recovery system.
This is a separation of acceptance outcomes, not a demand for new modules,
parallel writers, or artificially split implementation commits. Combine work
only if subsequent evidence establishes a real inseparable invariant.

`PLAN_RECONCILIATION v1`: scope classified; all existing holds remain. No
writer/reviewer dispatched. The next foundation judgment must bound the
terminal-archive DoD and evidence sufficiency before a correction brief; it
must not silently admit the other independent DoDs.

### Attempt 18 crash handback and Lead disposition (2026-09-05)

The owner reported a machine crash and asked to continue. Supervisor advisory
required explicit Phase-1 process/residue disposition and artifact ruling
before any retry or Phase 2. Lead resumed read-only inspection; no original
write authority was silently reused. Operator `87974102-5b8f-420e-8352-d221e044b474`
was idle with no active turn or pending permission, then completed a bounded
read-only crash handback: `INTERRUPTED_NO_ACCEPTABLE_ARTIFACT`.

Attempt 18 ledger at original source `9e1a05f2f857206adf24216941d3e44d2a2628dc`:

- Package/build/sign invocation: exactly one started, tool session `9001`.
  OS PID and exact start timestamp were not captured. No terminal child exit
  was recorded; overall build/sign completion is **unknown**, not a fabricated
  nonzero exit or a successful package claim.
- Last observed progress: native release products and native tests completed,
  Paseo/TypeScript builds completed, Expo reported `Exported: dist`; the same
  invocation remained live with no candidate/signature/validator handback.
- Coordinator install / launch / recovery: `0 / 0 / 0`. Phase 2 was never
  admitted. No Attempt-18 run ID or transaction was observed.
- After reboot, the original process is no longer live. Lead's bounded process
  metadata check found no surviving original npm/Swift/codesign/Meetless package
  process; this does not supply a missing terminal exit code.
- Exact Phase-1 proof root was never handed back. Current `/private/tmp`
  enumeration has no `meetless-attempt18-*` or `meetless-mas-development-proof.*`
  paths. No surviving manifest/fingerprint/CDHash/artifact digest/full validator
  result is available. Previously recorded temporary artifact/evidence paths
  must now be treated as unavailable, not silently reused.
- Ignored generated native/Paseo/TypeScript/Expo build outputs remain. They are
  unaccepted intermediate outputs, not a signed MAS artifact or new baseline.
  No residue was deleted, renamed, repaired, or promoted during this audit.

**Binding Lead ruling:** reject Attempt 18 Phase 1 for progression:
`INTERRUPTED_NO_ACCEPTABLE_ARTIFACT`. This closes the one-shot operator's moving
write scope and the unclassified result; it is not acceptance of an artifact,
not a claim that the package command exited nonzero, and not authorization to
retry it. Any new build needs a fresh Lead brief after the status blocker is
resolved. Phase 2 remains unadmitted.

Post-crash machine evidence personally observed by Lead:

- Source HEAD still `9e1a05f2f857206adf24216941d3e44d2a2628dc`, tracked worktree
  clean; protected untracked paths untouched; four authority hashes unchanged.
- `/Applications/Meetless.app` fingerprint remains
  `7039ded32b778fcda21fae6d961d80e72508630b2aaa0c8d2abedf08103e2a14`, CDHash
  `acfdb5223b4d492d86e13827babcea2c5df392dc`; deep/strict verification passed.
- Repository-owned `inspectMasLiveState` returned `absent`: process, listener,
  socket and open-handle counts all zero.
- MAS support parent still contains the same four terminal archive journals
  (Attempts 14–17) and retained roots. Filesystem inspection found no canonical
  active transaction directory/new run. This is descriptive inspection, not
  a replacement for the failing authoritative coordinator status.
- `node scripts/macos-mas-gate-session.mjs status` emitted
  `MAS-GATE-CLEANUP-001: runtime root device does not match the transaction
  device` while verifying archived restored roots. Current device `16777232`
  differs from journal device `16777234`; root inode remains `43589382`.
- Current full attestation digest is
  `9e870f5fd3f9e97af20d4434d0017decb53f8c026c87a05e245fef5f3d241e06`, with the
  same 13 entries, 6 files, 7 directories and 5413 file bytes. Historical digest
  was `130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de`.
  The device field is included in the attestation digest; equality of the
  other observed summaries does not prove it is the only differing field.
  Full runtime restoration/equivalence is therefore not re-accepted post-boot.

No post-crash package/sign/install/launch/restore/cleanup command was run.
All live resources are absent, so no process termination or manual filesystem
recovery is needed or authorized by this handback. Read-only diagnostics and
this durable record close the coordination gap without weakening verification.

`PLAN_RECONCILIATION v1`: native diagnostic source acceptance survives the crash;
temporary package proof does not. Route post-reboot archive identity foundation
before a fresh build or runtime attempt. The base-runtime goal remains unmet;
billing/production and all previously excluded gates remain out of scope.

### Native diagnostic acceptance and Attempt 18 routing (2026-09-05)

Lead accepts `90637005d82a30fce8b264a256026c5edab7701a`, correction base
`ceb101ad5e496a2419cc693ea852c04bbd9a7a50`, original base
`6688a6003628c5529096386b2cc7ea8fd7406186`. Complete change manifest is the three
native Swift source/test files plus this plan. The diagnosed validity checks
preserve the original inspection sequence/predicates. Lead verified the sink
attachment in `HostDelegate.launchRuntime` before `Process.run`, the real
attach/state fixture's retained output, and the bounded categorical format.
Live MAS retention is not yet proven.

Independent ordinary macro EXPLORATORY review identified exactly
`LIFECYCLE-001` (synchronous log before execution cancellation). Lead accepted
that set; one correction batch reordered both methods and added controlled
blocking-sink tests. The same reviewer completed FAST CLOSEOUT on that set and
delta, disposition FOUNDATION_READY / finding CLOSED. Review runtime metadata:
`codex-peer/gpt-5.6-luna`, max; no OCR. Lead personally reran
`npm run build:native` on the correction: release native builds and debug/release
native suites passed. Lead's three TypeScript diagnostic/readiness/packaged
composition suites passed 56 tests on the preceding diagnostic candidate;
correction changed no TypeScript. Ancestry, changed-path and whitespace checks
passed; all four material authority files remain unchanged.

Under delegated base-runtime authority, Lead routes exactly one new Attempt 18
with the existing two real checkpoints. Sole SERIAL operator owns generated
build/fresh proof output first; after Lead accepts the new artifact, owns one
coordinator install, one LaunchServices launch/observation, and one coordinator
recovery. No source edits or concurrent writer during execution. Build must
include native removal events, not reuse the Attempt 17 artifact. The same
already-accepted public SDK key may be loaded for build/validation/startup;
raw value never enters arguments/log evidence. Existing network behavior and
all purchase/restore/production/capture/publication exclusions stay unchanged.

Before launch, prepare and syntax-check the whole observation/recovery
orchestration, arm continuous passive topology/HTTP sampling and diagnostic
collection, then launch without a human/agent setup gap. Correlate observation
deadline to actual handoff/startup within a fixed outer bound; do not change
the app's 30-second startup deadline. Do not invoke desktop-attestation APIs
from an unrelated external observer. Readiness status probes may not activate
capture/TCC or billing. Always collect allowlisted native registration-removal
lines and desktop readiness summaries from the exact runtime log, preserving
empty sets and first/last timing. Stop observation and release its handles
before coordinator recovery; then prove exact old-app/runtime restoration and
terminal archived/owned-live-state absence. Any failure ends that operator's
attempt; recovery refusal stops further work and requires a Lead decision.

`PLAN_RECONCILIATION v1`: desktop diagnostic proof, Attempt 17 recovery and native
diagnostic acceptance are absorbed. Current path is new packaged observation,
then an evidence-backed correction only if needed, then owner-test readiness.
No billing/production work becomes a dependency of this base-runtime frontier.

### Delegated base-runtime technical authority (2026-09-05)

Owner instruction: `Đồng ý, từ giờ bạn take full control cho mình. Vì mình
không có domain knowledge về chỗ này.` This accepts the proposed native
diagnostic work and delegates technical choices toward a working MAS base
runtime the owner can test. Lead explicitly communicated that this includes
needed build–install–launch–recover proof rounds, one at a time, after local
candidate acceptance, with complete recovery before continuing. It does not
authorize relaxed validation, new product policy, billing/production/capture
or publication gates, push, or manual cleanup of protected state/evidence.

Lead owns reversible in-scope fixes, local proof, candidate acceptance and
bounded existing coordinator operations without routine technical approval
prompts. Every new external round gets an exact accepted source/artifact and a
one-shot operator brief; no operator self-retries after failure. Stop and
escalate new material risk/cost, ambiguous product choices, failed recovery or
any expansion outside this base-runtime scope. Previously consumed attempts
remain historical failures, not reusable authorizations.

`FOUNDATION_CHECK v1`: independent Attempt 17 source/log analysis narrows the
missing fact to native registration removal; existing predicates and contracts
remain valid authority. Native diagnostic work must retain why a committed
removal/reset occurred and prove that output reaches the retained startup
evidence, not merely construct an unused error. No functional cause is assumed.
One SERIAL writer owns native registration diagnostics and their direct tests;
Lead acceptance is separate. No second writable frontier is ready.

### Attempt 17 result and Lead ruling (2026-09-05)

The authorized attempt completed once and is recovered. Phase 1 package/sign,
Phase 2 install, LaunchServices launch, and coordinator restore each ran once
and exited 0. No retry or standalone/manual stop occurred. Runtime readiness
did not pass; successful launch-command exit is only handoff acceptance.

Accepted artifact: `/private/tmp/meetless-mas-development-proof.p8sBUu/release/macos/Meetless.app`.
Manifest SHA-256 `48f710433c26ab8456983d41e17f5d0dd7e9d24e808af7e2d2d9381f2eb29a5d`,
artifact digest `d0ae18b79566a64606327768213097ab7b96a3e4fb97f61f9ce31becf0b2d52f`,
outer CDHash `37c93255dcfb0063b5fdd6be3d60f766a783d952`. Complete MAS validator
passed for the exact signer/team/profile, 43 thin-arm64 Mach-O entries,
entitlement/load/symlink closure, source/package inputs and public-key hash.
Lead personally verified the fingerprint, manifest and packaged diagnostic
hashes, and deep/strict signature before admitting Phase 2 without another
owner prompt.

Run `a7f57a9b-8068-4c10-ad73-a58fa80adf9f` claimed native host PID `54189`
at `00:59:49Z`. Retained logs show supervisor PID `54195`, worker PID `54196`,
worker ready at `00:59:51.954Z`, and intentional SIGTERM at `01:00:20.932Z`.
The retained desktop timeout is conclusive at the readiness-subcheck level:

```text
last={pidLock=live-desktop-managed,registration=matching-registration-absent,pid=54195}
observedPidLock=[live-desktop-managed,missing]
observedRegistration=[matching-registration-absent,not-applicable]
observedErrors=[]
```

Source-constrained inference: initial child registration and daemon attestation
returned successfully because both precede the reached supervisor and timeout.
The PID lock belongs to the supervisor, not its worker. Native status prunes
registrations before reading them, and the native reaper does the same every
250 ms; invalid identity/parent/owner-chain checks remove registrations while
allowing status to succeed. Which check caused the disappearance is not
retained. A specific pruning trigger or unobserved reset is not proven.
Do not infer a functional fix from absent downstream renderer readiness.

Independent read-only Peer `be99120b-a7be-4886-ab54-dc20cfc56ad2` returned
DEPENDENCY_REQUEST / evidence insufficient for a functional correction against
frozen source `4ec0865d...`. Ordinary macro premise lane, EXPLORATORY; configured
runtime was `codex-peer/gpt-5.6-luna` with max reasoning (the response's literal
model field `report` is not a valid model identity). Lead inspected the decisive
pruning/status code and accepts that evidence limit. No OCR or code correction
was performed.

### Native registration-removal diagnostics (2026-09-05)

`FRONTIER_BRIEF v1` / `FOUNDATION_CHECK v1` is implemented against original
base `6688a6003628c5529096386b2cc7ea8fd7406186`, with no MAS, install,
LaunchServices, capture, TCC, network, product, or external attempt. The native
candidate changes only `native/macos-host/MeetlessHost.swift`,
`native/macos-host/TranscriptionCapability.swift`, and
`native/macos-host/TranscriptionCapabilityTests.swift`; this plan records the
evidence and remains the only other changed path.

`MeetlessProcessRegistrationRemovalEvent` retains fixed action, role, stage,
check, normalized OS code, PID, generation, and committed revision. Native
pruning classifies the observation that failed the existing identity, parent,
or owner-chain predicate; process disappearance is distinct from unavailable
inspection. The existing registration/descendant mutation and status/lease
semantics remain unchanged. Events are constructed under the authorization
lock but written only after unlocking, and stale snapshots emit no prune event.
Reset and explicit release paths have separate fixed action/check values so a
missing registration is not misreported as pruning.

The production `HostDelegate.launchRuntime` path opens the existing mode-0600
`runtimeRoot/logs/host-runtime.log`, attaches a duplicated descriptor to the
authorization state before `Process.run`, and continues using that same handle
for runtime stdout/stderr. The sink admits at most 64 diagnostic events per
host launch and rejects lines over 512 bytes; output is categorical only and
contains no paths, argv, tokens, raw errors, hashes, credentials, or hostile
caller text. An isolated process-chain fixture replaced the executable image,
denied executable reads, killed the daemon, and exercised reset/stale races.
It proved valid-chain survival, child identity drift, inspection unavailable,
parent mismatch, owner-chain invalidation, process-gone removal, recursive
descendant removal, stale-snapshot suppression, reset distinction, and actual
retention through the host-runtime log composition.

`npm run build:native` passed release capture/host/mutation builds and both
debug/release `MeetlessHostTests` runs with the accepted absolute
`MEETLESS_TEST_PACKAGE_NODE_SOURCE` precondition. The focused TypeScript host
readiness/diagnostic regression passed 2 files and 53 tests; no TypeScript was
changed, so the full typecheck was not required. Frozen authority hashes and
aggregate digest remain unchanged. Lead acceptance is separate; this section
does not claim MAS runtime readiness.

### `LIFECYCLE-001` correction closeout (2026-09-05)

Lead froze the sole accepted finding against correction base
`ceb101ad5e496a2419cc693ea852c04bbd9a7a50`: `publish()` and `clear()` called
`recordRemovalEvents` before the existing active-execution cancellations. The
correction retains each committed event snapshot, generation, and revision,
unlocks the authorization state, runs the original cancellation loop, and only
then invokes the diagnostic sink. No lifecycle/security/readiness/inspection
behavior or sink design changes are included.

The executable regression creates an active native request execution for each
method, installs a sink that blocks on its first record, invokes `publish()`
and `clear()` on isolated fixtures, and verifies cancellation is already true
when sink work begins before releasing the stall. Both reset event snapshots
are recorded. The reviewer-supplied evidence limit remains explicit:
`testRegistrationDiagnosticProductionWiring` exercises the real attach helper
and real authorization state in an isolated fixture, while source inspection
verifies production attachment before `Process.run`; real MAS retained-sink
proof remains the next external boundary.

No other finding is accepted. The correction remains native-only plus this
plan, with the frozen four authority-file hashes and aggregate digest
unchanged. Final native debug/release proof and the focused TypeScript
diagnostic/readiness/packaged-attestation regression are required before the
immutable closeout handoff; no external attempt is authorized.

Operational evidence limit: the operator's observation started at
`01:05:30.495Z`, over five minutes after launch and after cleanup. Its later
plugin-bootstrap failure and renderer connection refusal cannot diagnose
startup. Future authorized observation must be prepared before launch and
start immediately around handoff, then include sanitized retained-log evidence.
This is a task-local execution correction, not authority to redesign Harness
or lifecycle tooling.

Recovery accepted: package rollback preceded runtime restoration. Lead
personally recomputed restored `/Applications/Meetless.app` fingerprint
`7039ded32b778fcda21fae6d961d80e72508630b2aaa0c8d2abedf08103e2a14`, ran deep/strict
verification, and recomputed runtime full-attestation digest
`130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de` with original
inode `43589382`. Operator observed restored CDHash
`acfdb5223b4d492d86e13827babcea2c5df392dc` and no owned process/listener/socket/open
handle. Lead's additional read-only coordinator status returned `archived`,
including this run, package `not-applicable`.

Archive and fresh-retained evidence remain under the exact MAS support parent
as `.meetless-mas-gate-session.a7f57a9b-8068-4c10-ad73-a58fa80adf9f.archived`
and the matching `.fresh-retained`; neither is a cleanup target.
Final audit `/private/tmp/meetless-attempt17-phase2-final-audit-l0D7E7/final-audit.json`
SHA-256 `4b6bc3f0e14ee69409ab797d84e1e4cd5d6a842e8a350b12ebbae4a71144c7a0`.
Retained `logs/host-runtime.log` SHA-256
`67f0bd8439eea7228befe6b978198d082d07a5534fcf87a0dd643f1099b5c43b`;
`logs/daemon.log` SHA-256
`b3eb7bfc38e15ec1ea5aee0975c3b24c1027ec2128d41d94ccaff9ee2f77ee01`.
No raw credentials/log payloads are copied into this plan. Protected untracked
paths remain untouched; all excluded gates and push remain closed.

`PLAN_RECONCILIATION v1`: absorb completed desktop diagnostics and Attempt 17
proof/recovery. Route native removal-reason discovery before a functional fix
or new runtime attempt. Purchase/restore/production remain deferred. The base
runtime acceptance target is unchanged and remains unmet.

### Attempt 17 authorization (2026-09-05)

The owner answered `Đồng ý` to the explicit proposal for one
build–sign–validate–install–launch attempt using the existing public SDK key and
unchanged network behavior, followed by automatic restoration of the old app
and data after evidence collection. This is one serial two-checkpoint attempt:

- Phase 1: read-only coordinator-status preflight, one MAS development
  build/package/sign invocation in a fresh proof root, complete artifact
  validation. Stop at the immutable artifact for Lead acceptance.
- Phase 2: after Lead accepts that artifact, one coordinator install, one
  LaunchServices launch with bounded readiness observation, owned stop if
  needed, then one coordinator recovery. A new owner prompt between these
  phases is not required. Verify package-first rollback, exact old-app and
  old-runtime restoration, absence of owned live state, and terminal archive.

The sole external operator owns generated build/proof outputs and authorized
coordinator-mediated changes to `/Applications/Meetless.app` and the exact MAS
runtime transaction targets; no other writer operates concurrently. The
previous runtime diagnostic writer is finished. Repository code is frozen at
accepted diagnostic source `8759ec6d494018e2bfd7a01682b6f5af0fb2f409` plus
subsequent plan-only acceptance/authorization records. No source corrections,
manual cleanup, archive deletion, or unbounded retries are authorized.

Load only `MEETLESS_REVENUECAT_PUBLIC_SDK_KEY` from the already accepted owned
mode-0600 environment file for build/validator/startup where required; never
print or pass its raw value in arguments or copy it into evidence. Preserve
existing relay and local-model startup behavior. Purchase/restore, Premium
UI/status, RevenueCat dashboard/mutation/cache/secret inspection, Convex and
production, real capture/recording/TCC/export, upload/submission/publication,
and push remain closed. This proof ends with restoration, not a retained
interactive test installation. Read-only preflight failures before a side
effect do not consume an attempt; terminal package/install/launch failure
remains no-retry. Retain failed-attempt evidence safely.

## Today's Acceptance Boundary — Base MAS Runtime (2026-09-05)

Owner direction: `Mình muốn giảm bớt ma sát, bản Mas chạy được, mình có thể
test được. Việc mua bán/restore có thể để sang plan tiếp theo khi base runtime
ready`.

The immediate outcome is a MAS application the owner can launch and test, with
observed host-owned startup, daemon/plugin and recording-capability readiness,
renderer delivery, and safe shutdown/recovery. Packaging alone is not this
outcome. A diagnostic patch alone is not this outcome either.

Purchase/restore, Premium UI/status, managed-transcription production, billing
configuration, and store submission/publication are deferred to a subsequent
plan after base runtime acceptance. This sequencing does not remove V1 product
requirements or disable existing billing behavior. Real recording/TCC/export,
external attempts, and leaving an installed test session running still require
their explicit operational scope; no such gate is opened by this record.

`PLAN_RECONCILIATION v1`: runtime startup is the sole immediate critical path.
Keep prior accepted artifact/recovery evidence; defer monetization/release
frontiers rather than repeating their checks during runtime diagnosis. Keep
one active plan and preserve historical records. No Harness or transaction
framework redesign is authorized.

`FOUNDATION_CHECK v1`: existing ADR0003 owns readiness and safe shutdown. The
current daemon predicate drops PID-lock and native inspection errors; retained
Attempt 16 evidence cannot identify the failed component. Existing process,
registration, sandbox, network, and recovery contracts remain frozen. Route
diagnostic-only work before proposing a behavioral correction.

Execution is SERIAL with one writer in `packages/runtime/src/`,
`packages/runtime/test/`, and this plan, restricted to readiness diagnostics and
their proof. No second writable frontier is ready; parallel dispatch is not
applicable. Lead owns acceptance, not a competing implementation.

Next real acceptance boundaries:

1. A locally verified diagnostic candidate distinguishes read/parse failures,
   missing or non-managed/dead PID locks, native inspection failures, missing
   matching registration, and non-attested registration without leaking secrets
   or weakening readiness, timeout, abort, or cleanup behavior.
2. A separately authorized packaged attempt obtains conclusive startup evidence
   and completes coordinator-owned recovery. Any correction follows observed
   cause, not an inferred renderer/network failure.
3. After runtime proof, agree the bounded owner-test installation/session and
   recovery path. Do not claim an archived proof run leaves a usable test app.

## Ownership And Authority

Date: 2026-08-30; reconciled 2026-09-03

- Owner: `v1-paseo-foundation` owns the managed-transcription foundation contract,
  residual M7, paused `M7-F29-NOTARIZE-STAPLE-VERIFY`, and TCC R3.
- Owned scope: managed-transcription authority and entry criteria; residual M7
  release gates; paused M7-F29; TCC R3 candidate acceptance.
- Authority: ADR0001, ADR0003, ADR0004, ADR0005, product monetization policy, and the macOS artifact-validation specification where its non-DMG mechanics still apply.

## Outcome

Keep one compact execution record for the remaining Meetless V1 release work.
The accepted M0–M6, design, package, signing-preparation, and recording-start
history is completed evidence; this plan tracks only the live frontiers listed
in `Current State`.

The owner changed the release path on 2026-08-30 from direct DMG to the Mac App
Store for RevenueCat Shipaton 2026. On 2026-08-31 the owner also replaced the
initial Premium gate: Ask and user-supplied transcription remain free; Premium
funds Meetless-managed transcription. The owner clarified that the trial
remains seven days with a five-hour total allowance, while the subscriber
monthly allowance amount remains intentionally unfinalized. This plan owns
that foundation contract, the store sandbox, RevenueCat purchase integration,
App Store Connect submission, and launch-evidence frontier.

## Ownership And Boundaries

- Residual M7 owns the remaining release, legal, target, and distribution gates.
- `SHIPATON-MAS-REVENUECAT` supersedes the direct-DMG distribution frontier but
  does not erase its historical proof. It owns sandbox packaging, purchase
  mechanics, App Store Connect readiness, submission, and launch evidence.
- `MANAGED-TRANSCRIPTION-FAKE-BACKED-FOUNDATION` owns one bounded vertical proof
  of the accepted identity, device, quota, duration, job, cleanup, expiry, and
  local-publication contracts. It does not authorize production provider
  credentials, production backend rollout, external store mutation, or final UI.
- `M7-F29-NOTARIZE-STAPLE-VERIFY` remains paused under its separate owner hold;
  no notarization, stapling, upload, publication, or credential inspection is
  authorized by this reconciliation.
- `TCC-V1-CORRECTION-R3-ACCEPTANCE` owns only candidate rebind and Lead ruling.
  Its implementation candidate preserves the accepted permission and rollback
  behavior while adding renderer intent binding and recoverable app/surface
  failure handling.
- The accepted R1 correction changed host artifact ownership/linking,
  authorization-state lock lifetime, MAS entitlement validation, and the former
  Premium chat composition. Its build, sandbox, native purchase, and runtime
  boundary proof is reusable structural evidence. Its Ask gate is superseded
  product behavior and is not authority for the managed-transcription gate.

## Stable Authority

- [ADR0001 — maintained Paseo fork and pin](../../decisions/0001-maintained-paseo-fork.md)
  owns Paseo provenance and the exact dependency revision.
- [ADR0002 — direct notarized macOS DMG](../../decisions/0002-direct-notarized-macos-dmg.md)
  is superseded distribution history; its retained artifacts remain direct-DMG
  evidence only.
- [ADR0003 — runtime isolation and host ownership](../../decisions/0003-meetless-runtime-isolation-and-host-ownership.md)
  owns runtime topology, app boundary, companion transport, renderer endpoint,
  readiness, and shutdown.
- [ADR0004 — recording host and capture permission boundary](../../decisions/0004-recording-host-and-capture-permission-boundary.md)
  owns the recording host/helper and microphone/system-audio permission boundary.
- [ADR0005 — Mac App Store and RevenueCat](../../decisions/0005-mac-app-store-and-revenuecat.md)
  owns store distribution, sandbox, product identifiers, purchase mechanics,
  and managed-transcription account, quota, duration, lifecycle, and expiry
  contracts.
- [Premium product policy](../../product/monetization.md) owns user-visible free,
  paid, trial, quota, device, purchase, restore, expiry, and temporary-data
  behavior.
- [macOS artifact validation](../../specs/macos-artifact-validation.md) owns
  candidate, package, sign, re-sign, and validation stages.

## Live Frontier: TCC-V1-CORRECTION-R3-ACCEPTANCE

`TCC-V1-CORRECTION-R2` is superseded history and has no live owner. R3 is the
only active TCC frontier; its permission policy is now anchored by
[ADR0004](../../decisions/0004-recording-host-and-capture-permission-boundary.md).

The current candidate keeps MeetingStore bootstrap available so permission
recovery can render. It still forbids Meeting/session creation and native helper
spawn before both typed microphone and system-audio permissions are authorized.
Permission mutations require the exact packaged renderer Host/Origin and a
fresh one-use user-intent token. Invalid, replayed, foreign, or malformed
requests fail before native invocation. Status/decode/settings failures clear
checking, stay visible, and leave an actionable Recheck path; absent runtime
state is `Proposed`, while typed `notDetermined` is `Will ask`.

The candidate must be rebound to this clean-main snapshot before Lead acceptance.
No app launch, real permission request, TCC or Settings change, signing,
installation, package mutation, Keychain access, notarization, upload,
publication, or user-data deletion is part of this frontier.

## Residual M7 And Paused M7-F29

The accepted package and signing-preparation evidence remain pre-release only.
Residual M7 still includes the unresolved Human/legal inventory decisions,
supported-target limits, real clean-install permission attribution/persistence,
and release acceptance. M7-F29 retains the exact DMG and owner hold from the
archived ledger; it may resume only after the owner supplies a validated
`notarytool` profile name and explicit resume direction.

M7-F29 is no longer on the selected release path. Do not resume notarization or
stapling for Shipaton; retain it only as direct-DMG history.

## Accepted Foundation: MANAGED-TRANSCRIPTION-FOUNDATION-CONTRACT

### Outcome

Define the authority and smallest credible proof for Meetless-managed
transcription before implementation. The accepted direction keeps Ask,
existing transcripts, citations, provider/model controls, and user-supplied
transcription providers/API keys free. RevenueCat Premium gates only
Meetless-managed transcription, where the publisher's provider credential
remains backend-only.

Convex-first is the accepted V1 backend direction. The local-first Convex
implementation frontier below may define the owner of verified subscription
lineage, device credentials, atomic quota ledger, managed jobs, and temporary
uploads against a local deployment. It does not replace local `MeetingStore`
ownership of transcripts, citations, and meeting evidence.

The managed subscriber allowance is one backend-configured allowance in each
subscription-anchored monthly period, without rollover; its amount is not
finalized. Production must fail closed and remain undeployable without an
explicit configured subscriber allowance. A non-production hosted canary may
use an explicitly labeled test allowance, never product authority. The
seven-day trial receives five hours (18,000 seconds) total during the trial.
Each period snapshots its assigned configured limit, so a later reduction
cannot change an already-started period.

`TranscriptionProvider` remains the execution abstraction. Provider/engine
selection may change independently from payment mode; entitlement, admission,
quota reservation, and charging stay outside provider implementations.

### Progress

- [x] Select Mac App Store distribution and supersede direct DMG.
- [x] Accept the replacement product direction at Lead review boundary:
  `ACCEPT_WITH_REQUIRED_DECISIONS` on 2026-08-31.
  - Ask, existing transcripts, citations, provider/model controls, and BYOK are
    free.
  - Premium gates only Meetless-managed transcription.
  - Convex-first is the accepted V1 direction; the local-first implementation
    frontier is recorded below.
- [x] Preserve the former Ask Premium implementation as historical candidate
  evidence only. Its product gate is superseded and must not be treated as
  current policy or copied into the managed-transcription path.
- [x] Add the native RevenueCat/StoreKit adapter and authenticated renderer boundary.
  - RevenueCat 5.87.1 is pinned by SwiftPM and the real SDK target links.
  - `npm run build:native` now produces and checks the SwiftPM-owned
    `native/macos-host/.build/release/MeetlessHost` artifact; install and package
    workflows copy this artifact and refuse a missing or fallback binary.
  - Native focused tests build through the same SwiftPM core and prove Premium
    waits do not block authorization clear/shutdown or grant access after revoke.
  - The native socket normalizes status, purchase, cancellation, restore, and
    unavailable results without exposing receipts, keys, or raw SDK errors.
- [x] Establish the structural Mac App Store sandbox baseline.
  - A distinct contract pins Electron 41.2.0 `mas` arm64, Apple Distribution,
    an App Store provisioning profile, container-owned state, and
    security-scoped external export.
  - Parent application-group and inherited-child entitlement closures are exact
    and validated by `npm run validate:macos:app-store`; positive and negative
    contract proofs passed on 2026-08-31. The Team ID/application-group input is
    build-scoped and contains no credential.
- [x] Decide and promote the managed-transcription product contracts into
  durable product/ADR authority.
  - Owner accepted trial, device, restore, server duration, temporary data,
    job lease, expiry, refund/revocation, and free Ask/BYOK behavior on
    2026-08-31. Subscriber monthly allowance behavior is authoritative, but
    its amount remains intentionally unfinalized.
- [x] Close the bounded fake-backed foundation proof defined below. Lead accepted convergence candidate `cdc42fd44b8644b259a37876646cfd3f00aefa88` after independent artifact inspection, focused composition proof, typecheck, build, and frozen-authority verification.
- [x] Freeze the local-first Convex implementation contract in product and ADR
  authority on 2026-08-31: explicit user action gates upload; ordered
  ten-minute transport/provider chunks remain one logical billing timeline; the
  manifest and server-derived PCM duration are authoritative; V1 has no
  diarization or user-facing 60-minute cap.
- [x] Close the region-neutral local Convex boundary correction using generated
  upload URLs/storage IDs; production deployment, credentials, and provider
  access remain deferred gates.
- [x] Reconcile the executable Ask gate so Ask is free; Premium UI remains
  deferred because final UI work is outside this frontier.
- [ ] Apply the profile-backed App Sandbox entitlement and In-App Purchase configuration.
- [ ] Replace unrestricted writable paths with container/export-safe behavior.
- [ ] Produce and validate a sandbox development build.
- [x] Record the observed Apple catalog app, subscription group, products,
  prices, seven-day offers, quota-neutral descriptions, and Family Sharing-off
  state; availability and release evidence remain open.
- [x] Record the observed RevenueCat project, `app_store` app, products,
  `premium` entitlement, default offering, and monthly/annual packages.
- [ ] Configure Apple credentials and prove sandbox purchase and restore.
- [ ] Configure and verify the RevenueCat webhook and secret.
- [ ] Confirm Apple availability/eligibility and complete App Store Connect
  agreements and release metadata.
- [ ] Configure the production subscriber allowance; until an explicit value
  exists, production remains undeployable. Do not select that value in this
  frontier.
- [ ] Prove sandbox purchase, cancellation, restore, and offline/free behavior.
- [ ] Capture icon, screenshot, demo, privacy, review, and launch evidence.
- [ ] Upload the exact build, wait for processing, and submit it to App Review.
- [ ] Record the public Mac App Store URL after approval.

### Observed Apple And RevenueCat Catalog State (2026-08-31)

The catalog objects below are observed configuration state, not proof of
credentials, sandbox purchase or restore, webhook delivery, production
deployment, availability, review, or publication.

Apple:

- App ID `6807070739`, bundle ID `com.meetless.app`.
- Subscription group `22348334`.
- Monthly Apple ID `6807071303`, product
  `com.meetless.app.premium.monthly`, US price `$9.99`.
- Annual Apple ID `6807073268`, product
  `com.meetless.app.premium.annual`, US price `$79.99`.
- Both products have seven-day offers observed from 2026-08-31 through `No End
  Date`; Family Sharing is off.
- Apple descriptions are quota-number-neutral: monthly, `Monthly plan with
  managed transcription allowance`; annual, `Annual plan with monthly managed
  transcription quota`.

RevenueCat:

- Project `proj0d7b4465` (`Meetless`).
- App `appe0ef526253`, type `app_store`, bundle ID `com.meetless.app`.
- Products `prod18ec63f975` (monthly) and `prod381da0b787` (annual).
- Entitlement `entl69875a0345`, lookup `premium`, contains both products.
- Current/default offering `ofrng235b5d5086`, with packages
  `pkge846368fb40` (`$rc_monthly`) and `pkgeb835b3ed04` (`$rc_annual`).
- No Apple credentials, webhook, or RevenueCat secret was configured. The
  owner-selected `Productivity` category was not persisted because the
  available MCP/API surface exposes no category field; this is a non-runtime
  metadata gap, not completed configuration.
- `app_store` is the accepted RevenueCat type for a new post-2020 universal
  Apple macOS app; legacy `mac_app_store` is not required.

### Accepted Direction And Dependency Boundaries

- The backend derives the stable billing/quota account from server-verified App
  Store subscription lineage. RevenueCat App User ID, client entitlement state,
  and client-selected subscriber IDs are lookup data, not authorization proof.
- Each installation receives revocable device credentials. Enrollment, StoreKit
  transaction exchange, refresh credentials, and device private-key material
  remain trusted-native-host and Keychain scoped; the renderer sees typed state
  only.
- Restore Purchases binds a new installation to the existing verified
  subscription and shared quota account without resetting quota or automatically
  revoking another Mac. At most three Macs may remain enrolled.
- Short-lived access credentials authorize managed backend requests. A
  longer-lived, rotatable device/refresh credential remains in Keychain.
- Recording and canonical timeline preparation remain local and have no cloud
  duration cap. Only an explicit user action to transcribe with Meetless starts
  cloud preparation/upload; saving or completing a recording never uploads it.
  The single canonical timeline is then physically segmented into ordered
  upload/provider chunks of at most 10 minutes, with a shorter final chunk
  allowed. Recording-internal capture chunks, upload/provider chunks, and the
  logical billing timeline remain distinct, and physical chunks do not create
  multiple jobs or charges.
- The local Convex upload boundary uses generated upload URLs and storage IDs
  for bounded chunks rather than HTTP action bodies. Backend engine adapters may
  change without changing the client-facing managed provider or free BYOK path.
- Audio and provider output are temporary backend data. The durable transcript
  remains local unless separately authorized.
- Family Sharing remains disabled for V1.

### Accepted Owner Contract (2026-08-31)

- Monthly and annual products receive one backend-configured allowance in each
  subscription-anchored monthly period without rollover; its amount is not
  finalized. Production must fail closed and remain undeployable without an
  explicit configured subscriber allowance. A non-production hosted canary may
  use an explicitly labeled test allowance, never product authority. The
  seven-day trial receives 18,000 seconds total during the seven-day trial.
  Restore and product changes do not reset a period, and limit changes apply
  only to the next period.
- One verified subscription account may enroll three Macs. Restore binds a new
  Mac to the same account and quota without automatically revoking an old Mac.
- The server derives billable duration from validated sample count on one 16
  kHz mono PCM WAV timeline; client and provider duration claims are not
  authority, and overlapping microphone/system sources are not double charged.
- Cloud preparation/upload starts only after an explicit managed-transcription
  action. The server validates an immutable manifest with contiguous sample
  offsets/counts and rejects missing, duplicate, overlapping, or otherwise
  non-contiguous parts. It derives duration from accepted PCM16 sample counts
  and reserves/settles once for the logical job; retries and recovery cannot
  double-charge it.
- The physical upload/provider chunks are ordered and at most 10 minutes each;
  they are not separate timelines or billable jobs. V1 managed transcription
  does not provide diarization, and no user-facing 60-minute job cap is
  authorized. Any later safety ceiling requires new owner authority.
- The local-first Convex implementation is region-neutral and may proceed
  against a local deployment. US East versus EU West is deferred until before
  cloud production deployment; production deployment, region, credentials, and
  provider calls remain owner/external gates.
- Temporary audio, orphan uploads, provider results, and transcripts in transit
  have a 24-hour TTL. Jobs have a six-hour lease, and acknowledged local
  publication triggers earlier result deletion.
- A validly admitted job may finish after natural expiry within its lease;
  verified grace remains active, while refund or revocation stops work when
  observed. Ask and BYOK remain free; only managed transcription requires
  Premium.

### Foundation Proof Acceptance Boundary

The accepted foundation was one bounded fake-backed vertical proof. It
demonstrated:

1. a verified subscription lineage enrolls a device key; App User ID-only or a
   client-selected subscriber ID fails authorization; restore binds a second
   installation to the same quota account; and a credential can be revoked;
2. one managed job uses an immutable recording/canonical-timeline manifest and
   collision-resistant content identity: retries are idempotent, distinct
   recordings with identical bytes remain distinct, overlapping source ranges
   cannot be charged independently, and post-lease work requires active quota,
   a fresh admission, and a fresh lease with exactly one settlement;
3. the chosen duration authority rejects a false client duration;
4. temporary uploads/results are cleaned after success, failure, cancellation,
   expiry, and orphan recovery without persisting a transcript as durable
   backend meeting data;
5. provider completion, settlement ambiguity, checkpoint recovery, and
   publication are reconciled through the existing local transcript/citation
   lifecycle while the shared meeting lifecycle lease protects deletion;
   BYOK bypasses Premium/quota and Ask remains free.

The next authorized local implementation criterion is:

6. the region-neutral Convex boundary uses generated upload URLs and storage
   IDs for ordered physical chunks while preserving one logical billing
   timeline; provider execution remains replaceable and local `MeetingStore`
   remains the durable transcript owner.

The first five criteria define the accepted fake-backed foundation. Criterion
six is now authorized as local implementation; production Convex deployment,
region selection, credentials, provider calls, external store changes, and
final UI remain outside this repository-only frontier.

### R1 Fake-Backed Proof Disposition (2026-08-31; superseded)

Lead rejected predecessor candidate `51ee0cd61bae184d9936e2105294465f8de16108`
for the frozen MTF-001 through MTF-008 finding set. Its proof claims are
historical context only and are not acceptance evidence. The accepted
convergence candidate below supersedes this disposition.

### R1 Correction Batch Disposition (2026-08-31; superseded by convergence)

Lead rejected correction candidate `51ee0cd61bae184d9936e2105294465f8de16108`
for the frozen MTF-001 through MTF-008 finding set. Its proof claims remain
historical context only. The convergence correction below preserves the six
closed findings and addresses the two remaining blockers; Lead acceptance is
recorded below.

### R1 Convergence Correction Disposition (2026-08-31; accepted)

The accepted convergence correction candidate is
`cdc42fd44b8644b259a37876646cfd3f00aefa88`, prepared from
`ee55af2179d00bac7856f178f0b87f5b4fee9f19` and preserves original base
`64cf07d71bf82c798f8c3db417ada7d3c14ad7b5`. Lead acceptance observed the
following code/test evidence:

- `MTF-001`: `ManagedTranscriptionPolicy.reserve` reconciles expired leases
  before identity lookup; `reAdmit` requires active/grace entitlement, current
  quota, and creates a new admission/lease. The policy test covers stale
  admission rejection, fresh completion, and one ledger charge.
- `MTF-002`: `ManagedTimelineEvidence`, SHA-256 edge identities, immutable
  recording/audio keys, manifest/content conflict checks, and overlapping-window
  rejection remain in the policy. Policy tests cover false rebinding, identical
  bytes across distinct recordings, overlapping microphone/system timelines,
  and a false PCM timeline window; adapter tests cover tampered MP3 and the
  no-handoff-after-source-cleanup boundary.
- `MTF-003`: `ManagedTranscriptionService` creates one MeetingStore range with
  `rangeMs` equal to the canonical timeline duration and rejects any non-full
  range. `publishResult` reconciles durable MeetingStore state, publishes all
  checkpoints, and acknowledges the managed result only after `ready`. The
  adapter test uses a 496,000-sample (31-second) timeline, injects a crash after
  provider completion, rehydrates a new policy/service/store boundary, and
  proves one provider call, one full range, one charge, and a local citation.
- `MTF-004`: the managed service requires and holds the existing shared
  `MeetingLifecycleCoordinator` transcription lease through provider, settle,
  and MeetingStore publication. The blocked-provider test proves deletion is
  refused until release.
- `MTF-005`: provider status errors and non-configured status fail the job and
  release quota before provider execution; the adapter test proves the failed
  state and zero reservation.
- `MTF-006`: `Mp3Finalizer.stage` reuses validated source-timeline staging and
  writes the temporary canonical 16 kHz mono PCM WAV alongside the durable MP3
  in one finalization step. `RecordingService.finishSaved` hands it to the
  narrow managed-artifact consumer before `cleanupEligibleInventory`; without
  a consumer the finalizer-owned artifact is cleaned locally. The real
  RecordingService composition test proves source chunks are gone after save,
  the handoff artifact remains consumable, and managed publication consumes it
  and publishes citations through MeetingStore.
- `MTF-007`: `ManagedAllowanceConfiguration` is snapshotted into each period;
  later configuration affects only periods created afterward. The policy test
  proves reduction, next-period allowance, and exhaustion.
- `MTF-008`: `ManagedTranscriptionPolicy.snapshot`/`fromSnapshot` and the
  `ManagedTimelineArtifactStore` sidecar provide fake durable state and
  rehydration boundaries. The crash test creates new policy, artifact-store,
  service, and MeetingStore instances after provider completion; settlement,
  local publication, provider non-recall, and exactly one ledger charge are
  observed.

Convergence architectural decisions:

- `packages/managed-transcription-foundation` remains the one policy owner for
  verified lineage, revocable device credentials, snapshotted quota periods,
  reservation/settlement, jobs, admissions, and provider temporary state. Its
  snapshot boundary uses ordinary data only and has no Node, storage,
  transport, UI, RevenueCat, Convex, StoreKit, or provider dependency.
- `packages/meetless-plugin/src/finalizer.ts` owns creation of the temporary
  canonical timeline while validated chunks exist. The artifact is handed to a
  narrow consumer before source cleanup; the managed adapter consumes and
  cleans it after local publication. No post-cleanup inventory reconstruction
  or durable MP3-as-WAV parsing remains on the default path.
- `packages/meetless-plugin/src/managed-transcription.ts` verifies the saved
  MP3 and handed-off artifact at the edge, calls the existing
  `TranscriptionProvider`, and publishes only through `MeetingStore`. Ask and
  BYOK remain free; final Premium UI and production runtime wiring remain
  outside this frontier.

### Accepted Reusable R1 Structural Evidence (2026-08-31)

- [x] SwiftPM is the single host build owner. `MeetlessHost` is built through
  the pinned RevenueCat 5.87.1 dependency, and build/install/package workflows
  reject an artifact without real RevenueCat symbols.
- [x] Runtime authorization revalidates leases without holding its lock across
  Premium status, purchase, or restore waits; native focused tests cover clear,
  shutdown, revocation, and stale-lease denial.
- [x] The MAS contract requires the parent application-group entitlement and the
  inherited child sandbox closure, with explicit build-time Team ID/application-
  group inputs and deterministic positive/negative validation.
- [x] Provider/control discovery does not construct the Premium transport. The
  former Ask/retry Premium gate was proven on the candidate, but that behavior
  is now superseded by the free Ask path and is retained only as historical
  evidence that admission can occur before persistence/execution.
- [ ] No RevenueCat project, App Store profile, signing, upload, sandbox
  purchase, App Review, or public listing evidence exists in this correction.

### Production Integration Preflight Verdict (2026-08-31)

Two independent read-only preflights inspected accepted base `03d4249` without
repository or external mutation. Lead keeps Convex-first as the accepted
direction: Convex is credible as the transactional control plane and temporary
object store, but not as an assumed arbitrary-length synchronous audio
processor. A region-neutral local deployment is now authorized for the next
implementation frontier. Hosted production region, credentials/provider
access, real provider behavior, and target-market latency remain external
gates.

Frozen local correction findings:

- `CPF-001`: add a separate host-authenticated managed-upload port with bounded
  streaming/parts, idempotent completion, cancellation, and status recovery.
  It must not alter or reuse the direct/BYOK `TranscriptionProvider` contract.
- `CPF-002`: move managed canonical audio and metadata into private app-owned
  state. Only the durable user-visible MP3 may use the export destination.
- `CPF-003`: make finalizer-to-managed-owner transfer recoverable before source
  cleanup, including publication/saved/handoff/cleanup crash boundaries.
- `CPF-005`: use deterministic recording-bound timeline identity; caller input
  cannot create a second admission for the same recording.
- `CPF-007`: give local artifacts meeting ownership, creation/expiry state, the
  accepted 24-hour TTL, startup/orphan sweep, and meeting-deletion cleanup.
- `CPF-006-LOCAL`: persist a local pending/transcribing barrier before remote
  submission, recover it after restart, and reacquire the shared lifecycle lease
  for publication. Remote cancellation/provider semantics remain external.

`CPF-004` was not authorized as a guessed product limit in R2. The owner has
now explicitly rejected a user-facing 60-minute cap and permits local recording
and canonical preparation without a cloud duration cap. The local Convex seam
uses ordered physical upload/provider chunks of at most 10 minutes behind one
logical billing timeline. Any later operational safety ceiling still requires
new owner authority; native anchor-buffer policy and production provider limits
remain outside this frontier.

`PARALLEL_CHECK v1`: `SERIAL`. The ready corrections share finalizer,
RecordingService, private artifact ownership, MeetingStore deletion lifecycle,
runtime composition, and integration proof. Contract digest remains
`79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`.

R2 acceptance requires a fake transport with a canonical WAV larger than 25 MB
without full-file adapter buffering; duplicate part/completion recovery;
cancel/revoke and restart behavior; failpoints around finalization handoff;
success/failure/expiry/deletion cleanup; durable deletion refusal while managed
work is pending; unchanged Ask/BYOK behavior; focused proof, typecheck, build,
and unchanged authority digest. R2 does not install Convex, wire production,
choose a region or job limit, launch capture, use credentials, or mutate an
external service.

### R2 Pre-External Seam Candidate Disposition (2026-08-31; pending Lead closeout)

The repository-only R2 candidate is prepared from exact base
`66353f59038afba3407a7f61c280d91b0b3e612b`. Its final immutable commit and
complete changed-path manifest are reported in the peer handoff; this section
records the implementation and personally observed proof without treating it
as Lead acceptance.

- `CPF-001`: `FileManagedUploadPort` and `FileManagedUploadRepository` define
  a host-authenticated, provider-independent upload seam. Sessions and parts
  are ordinary private temporary state, parts are streamed into bounded files,
  duplicate/conflicting parts and completion are idempotent/explicit, and a
  fresh instance rehydrates status and receipts. The large proof streams a
  26,400,044-byte canonical WAV (>25 MiB) in 256 KiB parts.
- `CPF-002`: `ManagedTimelineArtifactStore` copies the finalizer-owned
  canonical WAV into a private per-recording directory with metadata and a
  24-hour expiry. The durable export remains the MP3; the managed artifact is
  consumed and removed after local publication.
- `CPF-003`: `RecordingService` persists the managed stage reference and
  handoff state through publication, saved, handoff, and source-cleanup
  boundaries. A fresh service rebuilds a missing managed stage from the frozen
  validated inventory before source cleanup, while an accepted handoff resumes
  without reassembling or re-calling the provider.
- `CPF-005`: finalizer evidence and the upload manifest use
  `recording:${recordingId}` as the canonical timeline identity; caller audio
  labels are ignored by the managed adapter and rejected by the upload edge.
- `CPF-007`: artifact metadata records recording/meeting ownership, creation,
  exact expiry, and the accepted 24-hour TTL. Startup sweeps remove expired,
  malformed, corrupt, and orphaned private artifacts; MeetingStore includes
  the deterministic private artifact path in its deletion manifest and refuses
  a saved recording while its handoff remains pending.
- `CPF-006-LOCAL`: `ensureManagedTranscript` persists the local pending barrier
  before provider submission. The shared lifecycle lease spans provider work
  and is reacquired for publication; MeetingStore remains the sole durable
  transcript/citation owner. Ask/BYOK code paths are unchanged.

Observed R2 proof, pending Lead closeout:

- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-upload.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/inventory.test.ts packages/meetless-plugin/test/recording-service.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts --maxWorkers=1` passed 9 files and 106 tests. This includes the >25 MiB stream, malformed/false WAV rejection, upload session restart, duplicate/completion/cancel cleanup, real finalizer handoff failpoints, provider-status release, durable deletion barrier, shared lifecycle lease, and provider-result publication recovery.
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed 6 files and 67 tests.
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` ran 17 files and 123 tests: 15 files/118 tests passed; the 5 failures were the pre-existing sandbox-denied localhost/Unix-socket listener tests in `chat-service.test.ts` and `control-server.test.ts` (`listen EPERM`). No R2-owned plugin test failed.
- `npm run typecheck` passed; `npm run build:meetless` passed; `git diff --check` remains required after this plan entry.
- The composition proof traverses real fixture `RecordingService` finalization and source-chunk cleanup, fake private artifact handoff, fake upload receipt completion, an injected post-provider-success crash, fresh policy/upload/store instances, one provider call, and MeetingStore citation publication. It does not claim real Convex latency or production provider behavior.
- No Convex package/config/project, production credential, provider call, native capture launch, StoreKit/RevenueCat mutation, signing, upload, publication, or external state change was attempted. The R2 candidate was validated against the then-frozen authority digest `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`; this revision records the amended digest above.

### R2 Convergence Ruling (2026-08-31)

Lead rejects candidate `966b9abd78481db001e912cc2e60d895c00bef37`
after bounded FAST closeout. The reviewer recommended acceptance, but the
artifact inspection leaves two accepted-contract gaps:

- `CPF-002` remains open because finalizer source timelines and
  `.managed.wav.stage` are still written under `exportRoot`. The frozen finding
  allows only the user-visible MP3 in the export destination; transient private
  managed audio must use an app-owned staging root before and during handoff.
- `CPF-007` requires a direct deletion regression correction: while the runtime
  is active, `ownedArtifactPaths` excludes expired meeting-owned artifacts, so
  meeting deletion can leave them until a later startup sweep. Deletion must
  own and remove the path regardless of whether TTL has just elapsed.

`PLAN_RECONCILIATION v12`: one bounded convergence is authorized on top of
`966b9abd`. Keep CPF-001, CPF-003, CPF-005, and CPF-006-LOCAL closed. Move only
private audio/source staging out of `exportRoot`, preserve MP3 atomic
publication, update stage enumeration/recovery/deletion accordingly, and prove
expired-artifact deletion while running. No third broad review is authorized;
Lead will inspect and run direct regressions on the convergence candidate.

### R2 Convergence Candidate Disposition (2026-08-31; accepted)

Lead accepts bounded convergence candidate
`7183b3d9a8da19ee51cd1f68ddad0bac7ba4b726`, prepared from exact base
`360e01675d46f0b9207358b1e84eddff814a7273`. No authority file or MeetingStore
production implementation changed.

- `CPF-002`: `Mp3Finalizer` keeps only the MP3 stage/publication in
  `exportRoot`. Source timelines and the managed canonical WAV use a
  deterministic per-recording staging directory below the MeetingStore-owned
  private artifact root. Persisted stage recovery, rebuild, enumeration, and
  startup cleanup cover the private root; the existing MeetingStore deletion
  manifest removes that root with the recording.
- `CPF-007`: running-runtime artifact enumeration retains meeting-owned paths
  after their 24-hour expiry. The direct regression obtains the path through
  `RecordingService.ownedManagedArtifactPaths`, deletes the meeting without a
  startup sweep, and observes the private artifact removed.
- `CPF-001`, `CPF-003`, `CPF-005`, and `CPF-006-LOCAL` remain unchanged and
  covered by the focused R1 regression set.

Observed convergence proof and Lead acceptance:

- The focused R1 set passed 9 files and 107 tests, including finalizer path
  assertions, all four publication/saved/handoff/cleanup restart failpoints,
  private-stage startup enumeration, and expired-artifact runtime deletion.
- Meeting domain/store regressions passed 6 files and 67 tests. The broader
  plugin suite passed 17 files and 124 tests in the full-access environment.
- `npm run typecheck`, `npm run build:meetless`, and `git diff --check` passed.
- The convergence candidate was validated against the then-frozen authority
  digest `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`;
  this revision records the amended digest above.
- No Convex/provider credentials or calls, native capture launch,
  StoreKit/RevenueCat mutation, signing, upload, publication, or external
  state change was attempted. This proof makes no production latency claim.
- Lead independently verified the exact seven-path delta and parent, inspected
  the private staging/deletion corrections, reran the 9-file/107-test focused
  proof, typecheck, build, diff check, and frozen authority digest. The only
  remaining work is owner-gated production integration and release evidence.

### Completed Frontier: MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-IMPLEMENTATION

Plan revision `v15` freezes the accepted managed-transcription behavior and
authorizes repository implementation against a region-neutral local Convex
deployment. This is no longer waiting on a product duration/size decision. The
implementation must preserve the accepted policy owner, shared lifecycle
lease, temporary-data rules, and local `MeetingStore` transcript/citation
ownership.

The frozen implementation contract is:

- Recording and canonical timeline preparation remain local and have no cloud
  duration cap. Completing or saving a recording never uploads it; cloud
  preparation/upload starts only after an explicit user action to transcribe
  with Meetless.
- After that action, one canonical 16 kHz mono PCM16 logical timeline is
  physically segmented into ordered upload/provider chunks of at most 10
  minutes, with a shorter final chunk allowed. Recording-internal capture
  chunks and upload/provider chunks are distinct, and the latter do not create
  multiple billable timelines or managed jobs.
- The server validates an immutable manifest with contiguous sample
  offsets/counts, rejects missing, duplicate, overlapping, or non-contiguous
  parts, derives duration from accepted PCM sample counts, and reserves/settles
  once for the logical job. Retry and recovery paths are idempotent and cannot
  double-charge.
- V1 managed transcription has no diarization and no user-facing 60-minute
  job cap. Any later operational safety ceiling requires new owner authority.
- The Convex seam uses generated upload URLs and storage IDs for bounded chunks;
  audio bytes do not pass through HTTP action bodies. Provider execution remains
  replaceable, and Ask/BYOK remain free.

The local implementation was accepted at `f93b705561eb6118c9ccbe7d0f9ae146db4f5df8`.
The observed Convex development target is recorded in `Current State`; no
production deployment, production allowance, provider behavior, production
latency, or external mutation is claimed here.

### Live Frontier: MANAGED-TRANSCRIPTION-CONVEX-HOSTED-DEV-INTEGRATION

This frontier advances the accepted local seam toward the owner-selected
Convex development target without selecting a production subscriber
allowance. It may proceed locally and against authorized Convex dev for the
configuration seam, authenticated development wiring, webhook handling, and
provider integration. External credentials and real provider spend remain
gated, and a hosted canary allowance must be explicitly labeled as test-only.

The frontier must preserve these boundaries:

- The subscriber allowance is configuration, not a newly chosen product
  number. Production fails closed and remains undeployable until an explicit
  subscriber allowance is configured; the seven-day trial remains five hours
  (`18,000` seconds) total.
- Each subscription-anchored monthly period snapshots its configured limit;
  unused allowance does not roll over, and later configuration changes apply
  only to later periods.
- Authenticated development requests continue to use server-verified
  subscription lineage and device credentials. RevenueCat lookup state and
  client-selected subscriber IDs do not become authorization proof.
- Generated Convex upload URLs and storage IDs carry bounded physical chunks;
  the immutable manifest, server-derived PCM duration, one logical billing
  timeline, idempotent settlement, temporary-data TTL, job lease, and local
  `MeetingStore` publication boundary remain unchanged.

The next credible proof is a hosted-dev canary with explicit test labeling:
authentication and webhook receipt, catalog-to-entitlement mapping, upload
and recovery behavior, provider invocation only when authorized, and cleanup.
It must not claim production allowance, production deployment, or provider
spend until those owner gates are supplied and observed.

### Incident-safe local proof enforcement (2026-09-01)

The hosted-development proof is closed at the Phase-2 boundary for this
candidate; no third backend attempt is authorized. Phase 1 now rejects
cloud/DNS/wrong-port/credentialed
URLs, redirects, selectors, deploy credentials, proxies, preload/TLS/Sentry
inputs, disallowed executables, inherited user HOME/XDG/temp state, repository
`.convex`/`.env.local`, parent traversal, outside paths, and symlink escapes
before process or network calls. It requires literal `127.0.0.1` on the two
proof-owned ports, `CI=1`, `DISABLE_BEACON=1`, an empty minimal child
environment with proof-root HOME/XDG/temp paths, and absolute `execFile`
allowlist entries. The CLI project mirror is physical proof-owned state; it
does not symlink back into the repository.

Static source enforcement covers the corrected orchestration and keeps generic
`npx convex deploy` outside this local proof guard; that generic production
command remains governed only by the repository deployment preflight. No
Convex cloud/control-plane/telemetry action is authorized by this proof, and
the repository-native Phase-1 gate runs absolute-Node syntax checks for the
guard, runtime helper, orchestration, and deployment preflight before the
pure guard, adapter, policy, and composition tests. The interrupted Phase-2
attempts are not acceptance evidence.

### R4 convergence boundary (2026-09-01)

This candidate closes the hosted-development R4 acceptance boundary, but does
not claim production readiness. The observable change is explicit labeled
allowance/configuration, device challenge and JWT boundaries,
Apple-authoritative lineage projection, authenticated RevenueCat
inbox/reconciliation policy, explicit fake-provider selection, bounded proof
tooling, and the complete hosted auth/storage/recovery/publication composition.
These responsibilities can change independently at their config,
vendor-adapter, auth, lifecycle, and process-boundary seams. Core policy
remains framework-free and external data is converted to plain data at the
edge.

Phase 1 remains the no-network repository gate: syntax/static checks plus
deterministic pure adapter/function-policy and existing local MeetingStore
composition tests. The hosted canary remains explicit opt-in, exact-target,
and fail-closed. Its process, URL, child-environment, CLI, deadline, stderr,
and cleanup guards remain covered locally. The corrected hosted run below
observed one complete auth/storage/fake-provider/recovery flow with publication
through the real MeetingStore boundary; this closes the R4 development
acceptance class without selecting production configuration.

The local enforcement level is repository-native Phase 1 and focused tests;
the retained diagnostic prerequisite is an explicit operator/environment gate.
No hook, CI requirement, or branch-protection rule was changed or verified.
The generic `npx convex deploy` command is outside the local guard and is not
claimed impossible to bypass; production preflight remains the repository
native check before that project-owned command. Hosted Convex deployment and
real Apple/RevenueCat/provider integration are separate external gates.

Observed no-network validation on 2026-09-01 before the corrected hosted run:
the absolute-Node Phase-1 command passed six files and 63 tests; the focused
hosted/upload suites passed 24 tests; and `build:meetless` passed. The hosted
run is separate external evidence and is reconciled below.

### PLAN_RECONCILIATION v1 — hosted development deployment preparation blocked (superseded, 2026-09-01)

The owner-approved pivot from the network-denied local backend route to the
authenticated hosted development deployment is recorded here. The exact target
is project `hoang-bang/meetless`, deployment `frugal-mandrill-646`, reference
`dev/hoang-bang`, cloud URL `https://frugal-mandrill-646.convex.cloud`, and site
URL `https://frugal-mandrill-646.convex.site`. This is deployment preparation
only; no hosted R4 acceptance claim is made.

After the no-network Phase-1 gate passed, exactly one corrected hosted attempt
was run. Its read-only environment-name check matched the exact target argv;
the one authorized mutation rotated only the approved 13 `MEETLESS_*` names,
and post-set validation matched that same allowlist. The exact
`convex dev --once --typecheck enable --codegen enable --tail-logs disable`
operation then reached the locked dev target but its
`POST /api/deploy2/start_push` request returned `408 Request Timeout` before a
revision was observed. No retry, rollback, broad cleanup, production action,
provider call, Apple call, RevenueCat dashboard change, or customer mutation
was made.

The historical pre-R5 mutated-name allowlist was: `MEETLESS_APPLE_VERIFIER_MODE`,
`MEETLESS_AUTH_AUDIENCE`, `MEETLESS_AUTH_ISSUER`, `MEETLESS_AUTH_KEY_ID`,
`MEETLESS_AUTH_PRIVATE_KEY_PKCS8`, `MEETLESS_AUTH_PUBLIC_JWK`,
`MEETLESS_DEPLOYMENT_MODE`, `MEETLESS_MANAGED_ALLOWANCE_SECONDS`,
`MEETLESS_MANAGED_ALLOWANCE_SOURCE`, `MEETLESS_MANAGED_PROVIDER_MODE`,
`MEETLESS_REVENUECAT_AUTH_MODE`, `MEETLESS_REVENUECAT_ENVIRONMENT`, and
`MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER`. This historical authorization-header
name is superseded by the R5 HMAC-only contract recorded below and is not a
supported current configuration.

Lead's post-failure audit records the current clean application state as
`functions=[]`, no tables, and empty `_storage`; exactly the approved 13
development environment names remain; no Convex/proof process remains; and
`.env.local` contains only the three non-secret selector names and is ignored.
The canary stage was not reached, so no canary account, upload, webhook receipt,
job, or MeetingStore publication was created. The 13 retained environment
names are deliberate dev-only material and must not be treated as production
configuration.

The recovery path recorded here was superseded by the owner-approved plain
`convex dev` route documented below. The prior network-denied local sandbox is
not the only next route and remains superseded by the owner pivot.

Remaining production gates are explicit: production subscriber allowance,
production issuer/key separation, real App Store Server API verification,
RevenueCat production webhook configuration, provider credential/access and
spend approval, sandbox purchase/restore, availability and regional latency,
production deployment, review, and publication. No production allowance is
selected here; the seven-day trial remains `18,000` seconds.

### PLAN_RECONCILIATION v2 — plain hosted development canary accepted (2026-09-01)

The owner-approved pivot to the existing authenticated development deployment
supersedes the earlier `start_push` preparation blocker. A normal authenticated
`node_modules/.bin/convex dev` run locked to project `hoang-bang/meetless`,
reference `dev/hoang-bang`, deployment `frugal-mandrill-646`, and completed with
`Convex functions ready!`; no watcher remains. The resulting function spec was
non-empty with 54 functions and 11 application tables. The public
`/managed-auth/jwks.json` route returned one public ES256 P-256 key with no
private component.

The approved 13 `MEETLESS_*` development environment names were the only names
mutated during the authorized hosted setup; the successful `--canary-only`
run did not rotate them or deploy. The historical canary read the then-current
webhook authorization and public auth configuration only in memory. Its
authorization-header configuration is superseded by the R5 HMAC-only contract.
No production
environment, `convex deploy`, `--prod`, real provider, Apple production API,
RevenueCat dashboard, or customer data was used.

The successful bounded canary observed device challenge/signature enrollment
and short-lived JWT authentication, Apple fixture lineage admission, a two-part
canonical upload with a largest part of 9,600,000 samples, one logical
601,000-ms fake-provider job, settlement and idempotent acknowledgement,
restart recovery, MeetingStore transcript and citation publication,
unauthenticated webhook rejection, authenticated RevenueCat SANDBOX receipt,
duplicate idempotent acknowledgement, asynchronous reconciliation, and
unique-account cleanup. Cleanup reported one account, lineage, device,
principal, job, upload, period, charge, and event removed, with zero remaining
storage objects or upload parts for that run. Deployed functions/schema were
retained. This run's cleanup covered only its own account projection; the later
residue audit and correction are recorded in `PLAN_RECONCILIATION v3` below.

The local implementation fix covered canonical part materialization copying
reused stream buffers and the canary assertion now reads transcript text from
MeetingStore checkpoints. The retained wrapper remains exact-target,
fail-closed, bounded, redacted, and opt-in. The complete hosted development
evidence closes R4 development acceptance; production allowance, issuer/key
separation, App Store Server API verification, RevenueCat production setup,
provider access/spend approval, production deployment, review, and publication
remain separate gates.

Final no-network closeout validation passed after the successful canary:
the 12-file focused regression command passed 156 tests; `npm run typecheck`
passed Paseo, Meetless, and app typechecks; `npm run build:meetless` passed;
the five affected script syntax checks passed; `git diff --check` passed; and
the concatenated product/ADR authority files recomputed to
`4f609ef15102282f49f47e34176894e64b361fbc3524a05b1441ff7a005487e4`.

### PLAN_RECONCILIATION v3 — hosted-development canary residue corrected (2026-09-01)

Lead's accepted finding `R4-HOSTED-001` identified four orphaned identity
clusters from earlier failed canary attempts. The read-only audit observed four
accounts, challenges, devices, lineages, periods, and principals, with zero
jobs, charges, RevenueCat events, upload parts, uploads, or storage objects.
All four device identities had the hosted-canary prefix; no customer data or
real device identifiers were observed. The prior successful canary had cleaned
its own account, but its zero-residue statement did not cover these earlier
clusters and is corrected here.

The smallest correction added a hosted-development-only operator janitor. It
accepts only a non-empty list of at most four canonical
`hosted-canary-device-<uuid>` IDs, refuses duplicates and unknown/ambiguous
devices, proves every device on each selected account is a requested canary
device, requires one fixture/SANDBOX lineage and one account, then reuses the
existing complete account cleanup mechanics. It returns only the requested
device IDs and bounded deletion counts. A separate hosted-development-only
read query returns canary IDs and a metadata-only count query covers all 11
managed tables plus `_storage`; neither returns account, lineage, credential,
receipt, or customer data. Interrupted hosted proof diagnostics now retain a
safe run ID and device ID so a later operator can submit the exact cleanup set.

After the no-network Phase-1 gate passed, the correction was deployed once to
the exact `frugal-mandrill-646` development deployment using the plain
`node_modules/.bin/convex dev` workflow. The watcher reached the exact
development target and `Convex functions ready!`, then was stopped; no
environment rotation occurred. A read-only deployment query returned exactly
the four observed orphan device IDs, and one exact-target CLI/admin mutation
removed four accounts, devices, lineages, periods, principals, and challenges;
it removed no jobs, charges, uploads, events, upload parts, or storage objects.
The subsequent metadata-only state audit reported zero for every managed table
and `_storage`. No fresh canary was needed because the correction's four-account
cleanup path was exercised against the observed residue. Functions, schema,
and the 13 approved dev environment names were retained; no production,
provider, Apple, RevenueCat dashboard, broad deletion, rollback, or push action
occurred.

The hosted canary remains opt-in and must report its run ID/device ID on an
interrupted run; it must not claim global zero residue without running the
metadata-only all-table audit. Remaining gates are production allowance,
production issuer/key separation, real App Store Server API verification,
RevenueCat production webhook configuration, provider credential/access and
spend approval, production deployment, sandbox purchase/restore, availability,
review, and publication. The seven-day trial remains `18,000` seconds and no
production subscriber allowance is selected here.

### PLAN_RECONCILIATION v8 — R5 repository acceptance (2026-09-01)

Foundation check v1 was sufficient against exact base `5cd62e5`; this repository
candidate does not intentionally open the external Apple, RevenueCat, Convex,
credential, signing, deployment, or purchase gates. During local validation,
one accidental `npx convex codegen` invocation reached the Convex CLI upload
stage and failed before typecheck; it was not retried and generated API drift was
reverted. The repository candidate is accepted from local evidence, while the
incident remains `CLOUD_STATE_UNKNOWN` and requires a separately authorized
read-only audit before any external phase. The
implementation keeps the accepted R4 fixture/canary path and fake transcription
provider while adding the real
App Store Server Library Node boundary, opaque native/plugin transaction handoff,
Apple-derived hashed lineage admission, explicit restore, three-Mac anonymous
listing/revocation, and HMAC-only RevenueCat webhook verification over
`timestamp.raw_body` with replay tolerance and idempotent lifecycle signaling.
The R5-001 correction makes revoked-device reactivation consume an active slot,
including the three-active-plus-revoked rejection case. The R5-002 correction
anchors first monthly/trial quota snapshots to verified Apple start/expiry dates
and preserves existing period usage and reset dates on replay; annual catalog
history remains intact without adding annual monthly slicing.

Lead accepted correction commit `7fd925c470f243a9966041789243373a1ba540cf`
as a direct four-path descendant of `1a15170d027f2c8f1c7241a536b80a95df3919cb`.
R5-001 and R5-002 are closed by the device-reactivation slot invariant and the
Apple-verified quota-period invariant. Personally observed repository evidence
was 82 focused tests, Convex and workspace TypeScript checks, and a clean
correction diff. This is repository-only acceptance and grants no authority for
cloud inspection or mutation, credentials, dashboard configuration, webhook
delivery, signing, deployment, or real sandbox purchase/restore.

The real path accepts only opaque `{ adapter, signedTransaction }` material at
the action boundary. The Node verifier returns normalized fields only to the
Convex mutation; the raw JWS and raw original transaction identifier are not
persisted or returned to the renderer. Fixture mutation/reconciliation remains
explicitly fixture-only. The monthly and annual catalog objects remain in the
native adapter, while monthly-only real sandbox purchase/restore is the later
acceptance gate. The active plan records the authority digest transition from
`4f609ef15102282f49f47e34176894e64b361fbc3524a05b1441ff7a005487e4` to
`d32d834f9e4424ebc35e7607e2f53cd69c3bf29975c810bebf8d40672df1f2aa` after the
explicit R5 owner decisions were added to ADR0005.

Repository verification for this correction candidate is local-only: Convex TypeScript,
workspace typecheck, focused policy/adapter/HMAC, contract/client/plugin,
surface, native boundary, build, syntax, MAS-baseline, and diff checks. No hook,
CI requirement, or branch-protection rule is changed or verified. A real Apple
sandbox transaction, Apple/RevenueCat credentials and dashboard setup, signed
Mac App Store package, external webhook delivery, Convex deployment, and
production allowance/provider/review/publication remain unmet gates.

### PLAN_RECONCILIATION v9 — R5 hosted-development prerequisites deployed (2026-09-01)

The owner explicitly opened the bounded Apple, RevenueCat, and existing Convex
development prerequisites while keeping production, real transcription spend,
and annual purchase testing closed. Apple now has one Mac App Store profile for
`com.meetless.app`: portal ID `8HJ7CY8645`, UUID
`51bc0400-219e-405a-8d37-e300afd72c53`, Apple Distribution identity
`Long Le (63M98WD275)`, expiration 2027-08-25. The profile was downloaded and
installed in Xcode's user provisioning-profile store; its application and team
entitlements were parsed locally and matched the accepted bundle/team boundary.
For the real local sandbox purchase, Apple also now has development profile
portal ID `XY38PGA3WP`, name
`Meetless Mac App Store R5 Sandbox Development`, UUID
`828a0bac-887f-4e60-9e4b-9da7690178bc`, expiration 2027-09-01. It contains the
installed Apple Development certificate expiring 2027-07-28 and only the
registered current Mac Studio UDID `00006041-000861C60EFA401C`. Its application
identifier, team identifier, and Keychain access group were parsed locally as
`63M98WD275.com.meetless.app`, `63M98WD275`, and `63M98WD275.*`; the profile was
installed in Xcode's user provisioning-profile store with mode 0600. No device
or certificate was created or changed.

RevenueCat app `appe0ef526253` now reuses the team's existing In-App Purchase
key `U5B866A76M` and App Store Connect API key `3FPFT7R8L6`; the app page was
reloaded and both associations plus valid IAP credentials were observed. Webhook
`whintgr572df9a8f6`, named `Meetless Convex Dev Sandbox`, targets only Meetless,
only SANDBOX, and only initial purchase, renewal, product change, cancellation,
billing issue, uncancellation, and expiration. HMAC signing is enabled; its
one-time secret was transferred directly into the exact Convex development
deployment without printing or persisting it in the repository.

Convex deployment `frugal-mandrill-646` now also contains the official Apple G2
and G3 root certificates published by Apple, selects
`app-store-server-api` verification, and selects RevenueCat `hmac` mode. A plain
`node_modules/.bin/convex dev` run reached the exact target and reported
`Convex functions ready!`; the watcher was then stopped. The deployed function
spec reported 60 entries. The metadata-only hosted-development audit reported
zero documents across all 11 managed tables and zero storage objects, and an
unsigned POST to `/webhooks/revenuecat` was rejected with HTTP 401. No provider,
production deployment, annual purchase, customer record, or storage object was
created.

The deploy regenerated the committed Convex API declaration for the R5 Node
Apple verifier and quota-policy modules. The hosted-development exact-name
allowlist now includes `MEETLESS_APPLE_ROOT_CERTIFICATES_BASE64`; focused tests,
Convex TypeScript, workspace typecheck, and diff checks passed. The superseded
`MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER` was subsequently removed after exact
owner confirmation. No other environment value changed. The resulting 14-name
deployment environment passed the current exact HMAC-only allowlist proof; the
metadata-only audit still reported zero documents in every managed table and
zero storage objects.

### R5 Mac App Store development packaging correction (2026-09-02; historical implementation evidence)

The prior local packaging claim is reopened. This correction closes only the two
MAS-DEV-001 blockers while keeping the direct DMG composer, direct contract JSON,
and direct runtime behavior unchanged. The MAS marker now resolves the exact
checked-in Paseo revision through an import-safe helper and validates the
resolved commit against the accepted pin before marker construction; importing
the helper does not run either packaging entrypoint. The native host derives its
signature policy from the exact packaged runtime-root contract: direct-DMG
packages retain the Developer ID requirement, while the MAS app-container path
requires only `Apple Development: Long Le (335C7MY4H4)` with bundle
`com.meetless.app` and Team `63M98WD275`. Resource attestation and identity
publication/migration use that same target policy, and an unknown packaged path
fails closed. Direct legacy identity migration remains restricted to the
existing exact Developer ID path; MAS migration is allowed only after the exact
MAS requirement is verified.

The target-specific MAS composition boundary remains: after the direct
composition is retained as provenance, the MAS bundle receives a generated
installation contract, package marker, and host configuration whose writable
state and recording destination resolve inside the Meetless app container. The
checked-in MAS contract remains the authority for `Meetless` and
`Meetless/recordings` inside container Application Support; the MAS runtime
rejects a direct `~/Documents/meetings` export override. External export still
requires a user-selected security-scoped destination and remains an explicit
runtime/product gate, not fabricated package metadata.

Because the app-container prefix exceeds Darwin's Unix-socket length limit, the
MAS runtime uses the existing hashed short-path mechanism for its ephemeral
recording transport socket under `/private/tmp`; durable runtime state and
recording exports remain container-owned. The direct target keeps its existing
socket rejection and path behavior.

The MAS host resolves the target-specific runtime root through the sandboxed
Application Support directory and passes the resolved container support root to
the runtime. The generic marker/schema and host-config envelope remain intact
because the packaged host and runtime validators consume those exact shapes;
the MAS contract's app-container-relative state paths are the target identity.
This keeps policy in the contract/runtime boundary and leaves transport,
storage, and vendor details at their existing edges.

The profile path is now the current user's Xcode profile directory with the
exact accepted `.mobileprovision` filename. The packager snapshots profile bytes
into the disposable proof root before composition, validates exact identity and
expiry, signs from that immutable snapshot, and compares embedded bytes to the
snapshot. Signed-closure validation classifies the outer `MeetlessHost` Mach-O
as parent-entitled code, checks nested Mach-Os against child entitlements, and
verifies every inventoried Mach-O without applying child entitlements to the
outer executable.

This is repository correction work only. Lead accepted immutable candidate
`6fe924d68c7bbb0f560ffbfed1501f67a66e0ea8` after independent artifact,
certificate-requirement, focused test, native, validator, typecheck, build,
syntax, frozen-contract, and clean-tree checks. The MAS package entrypoint,
Electron download, actual signing, launch, monthly purchase, restore, and other
external gates were not run or claimed.

Observed repository-only verification on 2026-09-02: the focused MAS/runtime/
direct-DMG command passed 3 files and 30 tests; `npm run validate:macos:app-store`,
`npm run typecheck`, `npm run build:meetless`, and `npm run build:native` passed;
the native command also ran `MeetlessHostTests` successfully. Both modified Node
files passed `node --check`; the direct helper probe resolved
`7618cda71e2836f9ba7e821286504841203cb745` without running the MAS packaging
entrypoint. `git diff --check` passed. The frozen-file `sha256sum` record digest
matched `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.
No checked-in CI workflow or executable local hook invokes the MAS packager;
branch protection was not queried and was not changed.

### R5 NATIVE-SCOPE-003 clean-checkout proof correction (2026-09-02; historical predecessor; closed by v41)

Package validation/readiness remains reopened at exact correction base
`34467fdd375fb7433d1a720759fb69684bed95a9` in the original family based at
`189d7d490d33498e9bb392a1f31fa30d2ce92781`. The prior candidate is not accepted
because its full inventory/source projection proof was conditional on retained
root `/private/tmp/meetless-mas-development-proof.Ffw0bs`; that root's exact
diagnostic was:
`native-binaries child member Contents/Resources/meetless/node_modules/convex/node_modules/@esbuild/darwin-arm64/package.json is outside its component scope`.
The failure occurred before MAS injection, signing, installation, or launch;
`/Applications` was untouched.

The already-correct resolver/classification behavior is preserved. This
correction exports the existing pure artifact-member builder as the smallest
test seam and adds one unconditional deterministic synthetic fixture through
the production source-root projection and inventory coverage validator. The
fixture covers exact top-level and nested `@esbuild/darwin-arm64`, nested
unscoped `node-pty`, Anthropic descendants, Mach-O-only artifact members,
exact full source roots, Convex `js-closure` and Sherpa model ownership, and
omitted/misassigned package provenance failures. No failed artifact is copied
or checked in.

Positive proof covers top-level/nested esbuild, nested node-pty, Anthropic,
exact manifest recognition, exact package-root source paths, Mach-O-only
selection, and unconditional in-memory inventory coverage. Negative proof
covers near-match Darwin names, ordinary esbuild and nested Convex
dependencies, deeper `lib/package.json`, Sherpa ownership, omitted/misassigned
nested evidence, and the former truncated source roots. The retained exact-
artifact test remains optional historical evidence only; clean-checkout proof
does not depend on it. No package manifest, lockfile, package composer,
validator consumer, authority document, or static component summary changed.
Close-out accepted `NATIVE-SCOPE-001`, `NATIVE-SCOPE-002`, and
`NATIVE-SCOPE-004`; at that stage only `NATIVE-SCOPE-003` was reopened pending
Lead acceptance. The v41 record below closes that finding.
The preserved `57b1020`, `189d7d4`, failed root `Ffw0bs`, and `34467fd` remain
historical correction evidence, not acceptance of this candidate. Every
external gate stays closed until new acceptance and a separately routed retry;
dependency order otherwise remains unchanged.

### R5 MAS embedded-profile signing correction (2026-09-02; current frontier)

Package readiness is reopened at exact base
`8311c9928a899b74833608eef1980bac12f66f04`, preserving accepted history through
`13f20d2eb49549f72098d103e0a49d1900a9248e` and checkpoint `8311c992`. The
retained read-only root `/private/tmp/meetless-mas-development-proof.GpvGZD`
records the exact failed command `npm run package:macos:app-store:development`:
`@electron/osx-sign` classified `Contents/embedded.provisionprofile` as binary,
then invoked `codesign` with child entitlements and received `Permission denied`.
The embedded profile was mode `0400`; its bytes matched the immutable snapshot
and its Apple CMS/profile field validation passed. The failure occurred before
the MAS manifest; `/Applications` was untouched, and no install or launch was
attempted.

The correction treats the CMS provisioning profile as data. A pure seam in
`scripts/lib/macos-app-store-development.mjs` derives the exact normalized
`Contents/embedded.provisionprofile` path and supplies a synchronous `ignore`
predicate. The MAS signer wires that predicate before the unchanged
`optionsForFile` route: the outer app keeps parent entitlements and every other
actual code object keeps child entitlements. The signer still uses
`preEmbedProvisioningProfile: true` from the immutable snapshot, and snapshot
and embedded profile modes remain `0400`; the selected source profile remains
untouched.

After signing, artifact validation still requires deep/strict bundle and
Mach-O verification, profile byte equality, and `security cms` parsing. It also
requires `codesign --display --verbose=2` on the embedded profile to fail with
the one expected `code object is not signed at all` diagnostic. Exit 0, a signed
profile, an unrelated failure, or extra diagnostic output is rejected.

Observed deterministic repository proof on 2026-09-02:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-app-store-development.test.ts` passed 1 file and 10 tests, covering exact normalized ignore, modeled pre-options routing, parent/child entitlements, negative path cases, and unsigned-profile diagnostics.
- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-app-store-contract.test.ts packages/runtime/test/mas-runtime-package-contract.test.ts packages/runtime/test/macos-package.test.ts --maxWorkers=1` passed 3 files and 41 tests.
- The non-signing subset of `packages/runtime/test/macos-package-signature.test.ts` passed 38 tests with 5 skipped; the two disposable ad-hoc signing tests were excluded by this frontier's no-real-signing rule, and three pre-existing diagnostic assertions remain incompatible with the current `docs/specs/macos-artifact-validation.md` authority wording.
- `npm run validate:macos:app-store`, both changed-file `node --check` commands, and `git diff --check` passed. No package, download, signing, signing retry, install, launch, or external action was run. The correction and this plan reconciliation remain pending Lead acceptance.

### R5 MAS authoritative Mach-O entitlement-type correction (2026-09-02; current frontier)

Package readiness is reopened at exact base
`81c9fe5e8fc2a28269dc88e9663e492c39900b7f`, preserving accepted profile-signing
correction `25257e4c96e743fd56ad80956bb1b31511e2c544`, checkpoint `81c9fe5`, and
history through `13f20d2eb49549f72098d103e0a49d1900a9248e`. The retained
read-only root `/private/tmp/meetless-mas-development-proof.GNud6q` contains the
exact signed artifact behind this correction: 43 thin arm64 Mach-Os, split as
16 `MH_EXECUTE`, 1 `MH_BUNDLE` (`node-pty` `pty.node`), and 26 `MH_DYLIB`
(including Sherpa and Electron framework libraries). The prior
`/private/tmp/meetless-mas-development-proof.GpvGZD` embedded-profile failure
remains historical evidence and is not mutated.

The exact retained-artifact failure was the post-sign entitlement read for the
signed `pty.node` `MH_BUNDLE`: `codesign --display --entitlements :-` returned
only its `Executable=` diagnostic and warning, with no entitlement plist, and
the validator rejected that absence as if it were an executable. The same
overbroad requirement covered signed `MH_DYLIB` objects.

The post-sign validator now classifies each inventoried Mach-O from its
authoritative `machOFileType`. The outer app and exact `Contents/MacOS/MeetlessHost`
executable require the exact parent entitlement keys; every other `MH_EXECUTE`
requires the exact inherited child keys; `MH_BUNDLE` and `MH_DYLIB` require
strict certificate-backed signing and thin arm64 evidence but no entitlement
plist or keys. Unknown or ambiguous types fail closed. Generic non-Mach-O data
does not enter this loop, and Electron `.app` containers remain distinct from
their contained executable checks. The existing signer, exact embedded-profile
ignore seam, immutable snapshot, profile byte/CMS validation, identity/team
checks, strict/deep verification, package contract, and inventory authority are
unchanged.

A pure MAS type-policy/classification/parser seam accepts the exact macOS
`codesign --display --entitlements :-` no-entitlements result only for the
`MH_BUNDLE`/`MH_DYLIB` policy. Missing executable entitlements, entitlement
plists/keys on bundle/dylib objects, permission/error output, and malformed
diagnostics are rejected distinctly. Deterministic tests cover outer/child
policy, missing/wrong child entitlements, absent/present bundle/dylib
entitlements, unknown types, extension counterexamples, and parser failures.
An optional retained-artifact audit is read-only; clean proof does not depend on
that root. No inventory/source authority changes, package/sign retry, install,
launch, or external action is part of this frontier. This correction and plan
reconciliation remain pending Lead acceptance.

Observed v44 repository proof on 2026-09-02: the focused MAS suite passed 1 file
and 12 tests; the MAS/package/contract regression passed 3 files and 41 tests;
and the selected non-signing nearest signing-boundary tests passed 19 tests with
24 skipped. `npm run typecheck`, `npm run validate:macos:app-store`, both changed
Node syntax checks, and `git diff --check` passed. The read-only GNud6q inventory
audit independently confirmed the 43-entry 16/1/26 Mach-O split and thin arm64
shape. No retained root, repository file, package artifact, install target, or
external service was changed by these checks. Lead acceptance remains pending.

### R5 MAS entitlement-validation convergence correction (2026-09-02; current frontier)

Package readiness is reopened at exact base
`f914864f3e746662b58bdfe75fd852eb1e6f63c0` for one final correction inside the
native checked-in MAS package-validator boundary. FAST closeout accepted the
v44 Mach-O type policy, then found two direct integration defects without
reopening architecture review: NONE-policy evidence serialization called
`Object.keys(null)` for a signed `MH_BUNDLE`/`MH_DYLIB` with no entitlement
plist, and the exact codesign entitlement-result parser rejected a valid
warning-free `Executable=<resolved path>` result because it required the known
deprecation warning.

The correction adds the smallest pure production seam for entitlement evidence:
plist-backed policies project sorted entitlement keys, while the NONE policy
projects an empty list from absent entitlements and rejects any present plist
or keys. The parser still requires exit zero, the exact normalized `Executable=`
target, and the exact output shape; it accepts only the known warning as an
optional second diagnostic line. The package validator consumes this projection
for nested signature evidence. Signer/options routing, identity/team/strict
verification, thin arm64 inventory, parent/child key checks, profile byte/CMS
validation, package contract, and all excluded gates remain unchanged.

Deterministic proof covers plist and absent evidence projection, both warning
forms, exact-target and output-shape failures, forbidden/missing entitlement
states, and the existing MAS/profile/signing-contract regressions. No package
command, signing or retry, install, launch, retained-root access, secret access,
or external action is part of this frontier. The correction and plan remain
pending Lead acceptance.

Observed v45 repository proof on 2026-09-02: the focused MAS development suite
passed 1 file and 12 tests; the three MAS/package/contract regression files
passed 41 tests; `npm run typecheck`, `npm run validate:macos:app-store`, both
changed Node syntax checks, and `git diff --check` passed. No broad signing
fixture, package command, signing retry, install, launch, retained-root replay,
secret access, or external action was run for this convergence correction.

### R5 MAS packaged host-attestation and child-registration boundary (2026-09-03; current frontier)

`PLAN_RECONCILIATION v55` accepts the c69f diagnostic correction and records
the exact attempt-8 packaged evidence. Attempt 8 validly packaged, signed,
installed, and launched through LaunchServices; sandboxed desktop PID `46289`
failed before the native argv helper because `ps` returned
`command="ps" purpose="parent PID for 46289" error.code="EPERM" errno=-1 syscall="spawnSync ps" status/signal null`,
with stdout and stderr absent. The exact proof root
`/private/tmp/meetless-mas-development-proof.tY0GlP` and diagnostic evidence
`/private/tmp/meetless-mas-diagnostic.SnLDCy` remain read-only. Artifact and
evidence roots were not inspected for secrets or cache child names.

The candidate starts at exact base `c69f26ee500e7cfa403139a99a4d81ed0b1ef5bf`
and keeps authority digest
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`
unchanged. It extends the existing authenticated transcription-capability
Unix socket with a bounded, versioned protocol: native LOCAL_PEERPID
authentication, exact desktop attestation, one-launch-generation host policy,
desktop-owned child registration, and registered-process self-attestation.
The native host validates exact configured and real executable identity,
device/inode/size/hash, argv, direct parent, role, endpoint policy, runtime
root, tokens, request IDs, and generation. Runtime and plugin packaged paths
consume this provider exclusively; development/static inspection retains its
existing native/system-tool adapters. RecordingService remains the capture
helper lifecycle and permission owner, with helper registration/readiness
before capture start. Startup cancellation, bounded shutdown, child exit, and
listener cleanup release registrations and processes fail closed.

Pure policy, native transport, exact desktop attestation, full
desktop/daemon/plugin/helper registration, replay/conflict/wrong-peer/stale-
generation/identity/argv/wrapper/empty-argument/replaced-process negatives,
packaged source-level forbidden-tool proof, native helper attestation, capture
lifecycle, focused runtime/plugin behavior, Swift builds/tests, typecheck,
build, syntax, package-contract, node, and diff checks are required and remain
repository-only evidence. No package/sign/install/launch retry, artifact child
execution, external mutation, secret/cache inspection, or push is part of this
frontier. The frontier and candidate remain pending Lead review; all external
gates stay closed.

### R5 packaged capture attestation convergence (2026-09-03; current frontier)

`PLAN_RECONCILIATION v56` records the accepted correction findings against
candidate `49c77aeb9e0a7b117d4c7dda51aaf8226a6b5c4f`:

- `HOST-ATTEST-CAPTURE-001`: the native capture helper must retain the
  validated canonical `runtimeRoot` and `CWD` checks but connect through the
  short validated relative endpoint/bind argument. It must not reconstruct an
  absolute Unix socket path that can exceed Darwin's AF_UNIX limit.
- `HOST-ATTEST-CAPTURE-002`: every attempt in the bounded attestation retry
  loop must create a fresh bounded request ID. A pre-registration rejection may
  consume an ID in native `attestRegisteredProcess`; retrying that ID must stay
  rejected while a fresh ID can complete after registration.

The correction is limited to the native capture helper and focused proof. It
does not change the accepted host-attestation architecture, process ownership,
signing/package policy, direct-development path, or external gates. Executable
native proof covers a long canonical root with a short relative endpoint,
pre-registration rejection followed by successful retry with distinct request
IDs, and wrong-CWD, absolute, traversal, and malformed endpoint rejection.
Native state proof covers consumption of the pre-registration ID and success
with a fresh ID. The frozen authority digest remains
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`; no
authority document changes are included. Package, sign, install, launch,
retained-root, secret/cache inspection, external operation, and push remain
closed. The correction candidate is pending Lead review.

### R5 host-attestation topology/state convergence (2026-09-03; current frontier)

`PLAN_RECONCILIATION v57` records the binding Route A ruling against exact
correction base `7ea0b2c3c2ddf873db8f996721bff4605de64490`, preserving original
frontier base `c69f26ee500e7cfa403139a99a4d81ed0b1ef5bf` and authority digest
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.
Vendor Paseo and daemon-worker remain unchanged. Native now pins the exact
daemon-worker path/argv as an unregistered intermediate and accepts only the
`D→S→W→P→C` chain, with plugin-process as the registered plugin role and
RecordingService/plugin ownership of the capture helper preserved. TypeScript
and native expected plugin identity/argv point to
`vendor/paseo/packages/server/dist/server/server/plugins/plugin-process.js`.

Registration, process attestation, status, and packaged lease checks snapshot
the launch generation and internal registration revision, revalidate exact
current owner/parent/intermediate identities across unlocked inspection, and
fail or retry when state changes. Registration revision advances on every
authority-affecting mutation, including registration, attestation, release,
prune, publish, and clear. Invalid owner chains are recursively pruned with
descendants; stale generations, replayed requests/tokens, conflicting roles,
and malformed identity/argv policy remain rejected. Native executable fixture
proof models `D→S→W→P→C` and covers owner-release races, recursive worker
cleanup, exact worker/plugin identity and argv, and packaged lease revision
invalidity. Direct-development/static inspection adapters and the prior
capture relative-socket/fresh-request-ID correction remain unchanged.

Focused native host/capture, runtime/plugin, typecheck, package/isolation,
MAS-baseline, syntax, and diff validation are repository-only proof. No
package/sign/install/launch retry, retained-root or secret/cache inspection,
external operation, or push is part of this frontier. The immutable candidate
is pending Lead review; all external gates remain closed.

### R5 packaged host-attestation lease-use closeout (2026-09-03; current frontier)

`PLAN_RECONCILIATION v58` records the accepted `HOST-ATTEST-LEASE-008-USE`
correction against exact parent/base candidate
`8ac474c2926c0f8f38c9b841127942869bc30e28`, preserving original frontier base
`c69f26ee500e7cfa403139a99a4d81ed0b1ef5bf` and authority digest
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.

Packaged leases retain the exact registered peer PID alongside their existing
launch generation and revision. `withValidLease` reuses the native bounded
snapshot/retry chain validator immediately before and immediately after its
unlocked action; `beginExecution` requires the same current packaged peer
validation before creating an execution. Development leases retain their
existing scalar validation path. No periodic reaper result is used as lease
authorization, and no arbitrary action runs while the state lock is held.

The native executable fixture proof first succeeds with a stable registered
`P→W→S` lease through both action and execution paths, then terminates `W` and
proves the previously issued lease is rejected before its action and by
`beginExecution` without an intervening status/prune call. Existing topology,
revision/race, relative-socket/fresh-request-ID, development-lease, recursive
cleanup, native host/capture, typecheck, and diff proof remain required. No
protocol, TypeScript, vendor, endpoint, topology, package/signing, or authority
change is included.

No package/sign/install/launch retry, retained-root or secret/cache inspection,
external operation, or push is part of this frontier. The immutable candidate
is pending Lead review; all external gates remain closed.

### R5 MAS container export round-trip correction (2026-09-03; current frontier)

`PLAN_RECONCILIATION v59` records attempt 9 and the exact correction boundary
against accepted base `bd2dcdf26e0a7d139dbe6203dd2186fcfaec57ef`.
Packaging, signing, profile, Electron, Mach-O, entitlement, package-contract,
and pinned-Paseo validation passed. The sole LaunchServices attempt then
stopped before readiness because the desktop's resolved MAS configuration
published its canonical app-container recording root as
`MEETLESS_EXPORT_ROOT`, while the daemon's second configuration resolution
treated any present value as a forbidden redirect.

ADR0005 keeps MAS writable state inside the app container and forbids an
external recording-root override. The canonical resolved container recording
root is therefore allowed to round-trip between owned processes; a differing
value remains rejected with the existing security-scoped-export guidance. The
native validation owner remains the focused MAS runtime package-contract test:
positive proof resolves a child configuration from the parent-projected
environment, while negative proof retains the external Documents redirect.

The retained attempt-9 proof root is
`/private/tmp/meetless-mas-development-proof.SCg3ZA`; the manifest SHA-256 is
`b887565311c60c0315c6d379a1814f137b19cd8f0e6e225a3e9ce8728ab5e57e`.
The prior app was restored exactly. No purchase, restore, premium, recording,
transcription, TCC, UI, Convex, production, upload, submission, publication,
App Review, push, secret disclosure, or RevenueCat mutation occurred. A new
external gate attempt remains closed until Lead accepts repository proof.

### R5 MAS host-config capture-helper binding (2026-09-03; current frontier)

`PLAN_RECONCILIATION v60` records attempt 10 against accepted exact base
`4096c3a6c5163531e110e45723dd42319f485aff`. Its retained root is
`/private/tmp/meetless-mas-development-proof.D0SWVP` and its manifest SHA-256 is
`7282632de92ee03295397e2d1bdb8e0dca9c8f5e3007c50b11d9f7dcaceb9683`.
Installed identity preflight stopped before LaunchServices because native host
configuration did not contain the capture-helper path expected by the packaged
runtime. No LaunchServices launch was attempted.

The accepted correction boundary keeps `installation-contract.json` as the
single packaged-resource owner. After digest verification, the Node host
resolver requires `package.resources.captureHelper`, resolves it with existing
bundle containment, and projects only the absolute result into internal
`HostLaunchConfiguration`. Strict schema-v2 `host-config.json` remains unchanged:
the field is neither emitted nor accepted there. Omission, non-string, traversal,
and absolute escape fail before child launch with ADR0004/artifact-contract and
rebuild guidance. The unchanged MAS configuration equals the RuntimeConfig
expectation; direct-DMG derives the same contract resource; development has no
packaged helper field. Existing installation-contract digest mismatch proof is
retained.

Focused MAS/direct/host-identity contract proof, typecheck, MAS baseline
validation, applicable Node syntax checks, diff/ancestry/path/authority checks,
and a clean tracked worktree are required repository-only evidence. The authority
digest remains `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.
Package, sign, install, launch, retained-root inspection, secret/cache inspection,
R4 fixture mutation, push, and every external gate remain closed.

Observed repository-only proof on 2026-09-03: the focused MAS, direct-DMG,
host-config, host-identity, and packaged-attestation command passed 5 files and
42 tests; `npm run typecheck` and `npm run validate:macos:app-store` passed;
`git diff --check` passed. No changed JavaScript file required a separate Node
syntax check. Checked-in CI does not invoke the focused correction command,
no configured executable local hook enforces it, and branch protection remains
unverified. The final ancestry, three-path manifest, unchanged authority files,
recorded authority digest, and tracked-worktree state are checked at immutable
candidate creation.

### R5 Attempt-11 runtime diagnostic and identity-byte convergence (2026-09-03; current frontier)

`PLAN_RECONCILIATION v61` records Attempt 11 proof root
`/private/tmp/meetless-mas-development-proof.TmI7ud`, manifest SHA-256
`93cc1e289c487b34d28ba77e60e7163a390b3b38bb346f532d5255b34552d8c5`, and host
PID `14710`. Runtime creation was observed, but no accepted D/S/W/P was
observed; registration returned a generic rejection. Recovery first observed
a byte mismatch and then successfully restored the exact prior bytes. These
facts are recorded from the supplied proof summary; the retained proof root is
not inspected by this correction.

The correction keeps registration fail-closed and adds a bounded local failure
category at the protocol edge: role, stage, check, and a normalized OS code
only. Generic malformed requests remain distinct, no shared last-error state is
introduced, and shutdown `EPERM` handling remains fail-closed. The transaction
serializer recursively reproduces the MeetlessHost Foundation JSON byte profile
(sorted keys, Foundation spacing, default slash escaping, two-space LF
formatting, and one terminal LF). Recovery continues to accept only exact prior
or exact canonical-next identity bytes. Native and Node golden vectors cover
complete identity fields, nested configuration, paths/slashes, escaped content,
arrays, numbers, and omitted optional fields; mutation and alternate-formatting
proof remains rejected. A real repository Node runtime with a detached daemon is
also exercised by the native test composition.

The authority digest remains
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`. Package,
sign, install, launch, retained-root inspection, secret/cache inspection, R4
fixture mutation, push, and every external gate remain closed. The candidate is
pending Lead review.

### R5 package-source Node proof closeout (2026-09-03; current frontier)

`PLAN_RECONCILIATION v62` records Lead's bounded closeout ruling for
`R5-MAS-REGISTRATION-DIAGNOSTIC-PACKAGE-NODE-PROOF`. `IDENTITY-BYTES-001`, its
serializer proof, and the categorical `REG-DIAG` implementation remain
accepted and unchanged. A full live production D→S→W→P bootstrap is explicitly
outside this native correction because it would start broader runtime/plugin
services and remains owned by a separately authorized external gate.

The repository proof now composes three inspectable levels. First,
`scripts/build-native.mjs` passes its exact `process.execPath` through the
test-only `MEETLESS_TEST_PACKAGE_NODE_SOURCE` binding to both debug and release
`MeetlessHostTests`. The native fixture requires an absolute canonical,
executable, non-empty regular file whose device/inode/size/hash identity equals
the live parent Node executable, then copies exactly that source to the package
contract's `runtime/node`, verifies source stability plus copied size/hash
before launch, and observes the detached daemon's exact package-contained
configured path, real path, argv, size, and hash. Pure negative cases reject an
absent, relative, non-canonical, non-executable, or wrong-source binding before
the real-node fixture can spawn. Second, the existing synthetic/native
H→D→S→W→P→C policy and race cases remain exercised by the same native test
binary. Third, focused package composition proof structurally inspects the
production composer and confirms `process.execPath` is copied to the contract's
`runtime/node` destination; existing host-attestation/topology and MAS contract
validation remain composed around it.

Observed repository-only proof on 2026-09-03: `npm run build:native` built and
passed `MeetlessHostTests` in debug and release with the explicit package-node
binding; the focused macOS package, packaged-host-attestation, and host command
passed 3 files and 48 tests; `npm run typecheck` and
`npm run validate:macos:app-store` passed; `node --check
scripts/build-native.mjs` and `git diff --check` passed. The native positive run
exercised exact package-source D→S detached registration, and its pure
validation covered all five required negative bindings. No package, sign,
install, launch, recording/helper action, `/Applications` mutation,
secret/cache inspection, retained-root inspection, R4 change, push, or external
action occurred. Every external gate remains closed. Local owning-command
enforcement is observed; no configured executable local hook or checked-in CI
invocation was found, and branch-protection enforcement remains externally
unverified. Authority digest remains
`fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.

### R5 MAS runtime-state transaction closeout correction (2026-09-03; current frontier)

`PLAN_RECONCILIATION v66` records the owner-confirmed Attempt 12 incident and
the serial closeout correction child of exact base `103a7a7` for
`R5-MAS-RUNTIME-STATE-TRANSACTION-CLOSEOUT-CORRECTION`.
Attempt 12 used a marker-authorized recursive runtime cleanup shape that mixed
approximately 829 MB of attempt-created state with approximately 37 MB of
pre-existing MAS state; the aggregate fell from approximately 37,632 KB to
approximately 24 KB. Its artifact root was
`/private/tmp/meetless-mas-development-proof.pwHECm`, its manifest SHA-256 was
`3c8fff584926cf0e1e0d082a65264b175d7e8a7c8b3eacf0cf007dba658b778a`, its
launch PID was `18597`, and its brief record was `16777/no 18082`. No
accepted readiness was established. The owner confirmed no external/manual
backup; the loss is unrecoverable and no reconstruction is claimed. Package,
install, launch, and external gates remain closed, and no retry is authorized.

The correction treats the entire exact contract-derived app-container runtime
root as one opaque preservation unit. The plain-data
`MAS_GATE_SESSION_TRANSACTION v2` boundary publishes a durable parent-side
construction intent before creating the construction directory, journals the
directory before active-slot publication, and keeps the journal outside the
movable root. Recovery can recreate the exact absent construction directory or
resume only an exact durable intent; an unexpected or ambiguous construction is
retained and reported, never deleted. It validates exact root/parent/identity
binding, current ownership, same-device topology, no-live-runtime evidence, and
an explicit positive free-space preflight minimum (not a reservation or
peak-use guarantee), then atomically renames the whole prior root into
same-volume quarantine. Every protected move is executed by the persistent
native `MeetlessMasGateMutation` session while it holds the same sibling
`lockf` kernel lock as `MeetlessHost`, using macOS `renameatx_np` with
`RENAME_EXCL | RENAME_NOFOLLOW_ANY`. The absence check is diagnostic only: a
post-check file, directory, or symlink collision returns kernel `EEXIST` and
preserves both source and destination. There is no reservation or ordinary
protected-rename fallback. Helper death before the syscall leaves the source
untouched; death after the syscall is recovered by inspecting both paths. It
creates a secure fresh root with package identity absent. The package
transaction continues to own only the `/Applications` bundle and identity
bytes.

The native helper resolves protected paths from trusted descriptors. It opens
the filesystem root once and traverses each absolute ancestor with
descriptor-relative `openat(..., O_NOFOLLOW)`. Before `renameatx_np`, the
resolved parents are mechanically checked against the authorized path class:
`runtime-sibling` is the held lock parent, `package-sibling` is the pinned
package parent, and `runtime-child` is beneath the bound runtime-root
descriptor. A replaced ancestor therefore fails on symlink or descriptor
identity mismatch before the syscall, while final destination races remain
kernel `EEXIST` failures that preserve both objects.

A stable kernel-backed sibling lock now binds the MAS coordinator and native
host. Every supplied gate lease must still prove its live kernel holder before
filesystem work. The gate holds the lock during mutation; an active
transaction requires a one-time durable handoff bound to owner/run,
exact fresh-root identity, active slot, identity path, and installed
bundle/executable identity. The host claims and holds the lock for its
lifetime, while the gate reacquires it only after stop and explicit absence
proof. JavaScript issues only bounded mutation commands and cannot mutate a
protected name after a one-time liveness check. With no active transaction,
normal direct or production startup remains valid while holding the same lock.
MAS process evidence is matched to the
exact H→D→S→W→P→C production topology: the supervisor is the titled
`Paseo Supervisor` process, and W is the exact
`vendor/paseo/packages/server/dist/server/server/daemon-worker.js` argv entry;
listeners, sockets, and open handles are also inspected. Undefined, false,
malformed, partial, or errored process/listener/socket/open-handle evidence is
not absence. Direct-DMG proof runners retain their separate direct-root
contract and do not claim MAS protection; the MAS-development coordinator is
the only repository-authorized MAS install/LaunchServices/stop/restore route.

The MAS install coordinator requires the exact release manifest and performs
the complete read-only MAS artifact validation before acquiring the transaction
or mutating `/Applications`: license/notices/package-inputs, symlink/load-path,
signer/profile/entitlements/Mach-O/Electron, contract/marker/pinned candidate
inputs, exact expected RevenueCat public SDK-key comparison, and closed
external-gate claims. It reuses the complete package-validator primitives for
the retained direct composition and final bundle closure rather than creating
a second policy implementation. The validator returns a frozen plain
`MAS_GATE_ARTIFACT_BINDING v1` with manifest hash, canonical bundle
path/fingerprint, artifact/candidate/package-input/artifact-input/license/
signature digests, and public-key SHA-256 only. The package transaction
`MAS_PACKAGE_TRANSACTION v4` receives that DTO, journals the device/inode
identity of transaction-owned package roots and temporary identity files, and
constrains cleanup intent to deterministic transaction-owned siblings. It
rechecks source/manifest before staging and before moving the prior
`/Applications` app, validates the staged copy, and requires the installed
fingerprint and root identity to equal validated staging. The production CLI
does not accept a bundle path as a substitute for that manifest and validator.
The coordinator has no injected validator result, artifact binding, or callback:
complete validation always executes, including the exact expected RevenueCat
public-key comparison. Fixture tests may inject only bounded low-level file,
stat, inventory, Mach-O, or owner-tool evidence readers; those adapters cannot
authorize quarantine or replace final bundle realpath/fingerprint checks.

Architecture acceptance for this correction is the smallest observable chain:
complete artifact validator → frozen plain artifact binding → MAS coordinator
→ JavaScript runtime/package transaction policies → native mutation port. The
native helper remains because Node has no proven same-holder macOS
`renameatx_np` no-replace capability; it may be removed only after an equivalent
Node capability is independently proven with the same lock-holder and crash
proof. The smallest proof is a live-holder exclusive rename, typed collision
preservation, pre/post-syscall holder-death recovery, source/staged/installed
identity agreement, and package-first rollback before runtime restore.

Restore ordering is stop/absence proof, package rollback and identity removal,
lock reacquisition, fresh-root detach to retained evidence, prior-root or
prior-absence restore, and archive-by-sibling-rename. Recovery is monotonic,
idempotent, and locally exercised across physical mkdir, rename, and journal-
publish boundaries, including subprocess SIGKILL. Any unjournaled or
ambiguous construction, root collision, path alias, symlink,
owner/device/inode/attestation change, live state, insufficient preflight
space, filesystem error, malformed journal, or lock/handoff mismatch retains
every remaining byte and fails closed with `MAS-GATE-CLEANUP-001`. There is no
copy fallback, recursive removal, or retained-evidence garbage collector.

The aggregate attestation is lstat-based and covers file-byte digests, literal
symlink targets, type/metadata, device/inode/link metadata, and internal
hardlink equivalence without recording child inventories, secrets, receipts,
or cache names. The claim is runtime-root-only: app-group state,
Preferences/Caches outside the root, Keychain, TCC, StoreKit/RevenueCat,
LaunchServices, and remote state are retained/reported and never cleaned or
claimed rolled back. Arbitrary same-UID shell deletion and external systems
remain outside repository enforcement.

The historical `975db2c` closeout candidate was rejected because construction
creation, lease liveness, no-replace destinations, stop authority, actual W
topology, and pre-install manifest validation were not sufficiently bound.
This child corrects those findings and is pending Lead review from exact base
`103a7a777c7b3cf61570cc971bec117cb18de8ad`, within the original family base
`8c6efffeb05a53100044aea8fbcf85e74304afee`; the historical rejected closeout
base was `975db2cc93c827fec24d58f361e94edd3dce84e8`, the original convergence
base is `4a32dfe8d8979e956dc6501334971363279de2bd`, and the prior accepted base
is `b3ff5ec83908201a40be9715df34c238d4eea498`. The old authority digest was
`8b2c3a70917c2c7e5b26cf9bcfe8c19bb5abeb9a54f0aeec6bf256e5440dca91`; the new
digest is `ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.
Both are SHA-256 values of the ordered path/hash manifest for ADR0003, amended
ADR0005, product monetization, and macOS artifact-validation authority files.

No MAS package/sign/install/LaunchServices launch or restore was executed for
this correction; no `/Applications`, real MAS root, secret, cache, R4
fixture, external system, CI, or branch-protection result was inspected or
mutated during implementation.

### Lead acceptance and Attempt 13 authorization (2026-09-03)

Lead accepted correction `ca26b6c045bbbb1c86aa46b2a0a0966205d645cd`,
whose exact parent is `103a7a777c7b3cf61570cc971bec117cb18de8ad`.
The accepted correction delta is limited to nine paths and closes the final
descriptor-ancestor and unconditional-validator findings. Lead inspection
confirmed descriptor-relative `openat(..., O_NOFOLLOW)` traversal, exact
runtime/package path classes, native `renameatx_np(RENAME_EXCL |
RENAME_NOFOLLOW_ANY)`, and the absence of a caller-supplied validator result.
Lead reran the focused coordinator/runtime/package proof: three files and 91
tests passed. The writer additionally observed native debug/release proof,
six descriptor/collision tests, thirteen full-validator tests, typecheck, MAS
baseline validation, syntax checks, and diff checks passing.

The owner subsequently authorized exactly one Attempt 13 retry. This opens
only dev-only MAS packaging, the accepted Apple Development signing identity,
transactional local installation, one exact LaunchServices launch, bounded
readiness inspection, owned shutdown, and deterministic package/runtime
restoration. It does not open purchase/restore, premium UI/status, real
transcription/provider/TCC/recording/export, RevenueCat mutation or secret
activity, Convex, production/annual action, upload/submission/publication/App
Review, or push. A failure returns to repository correction review without an
automatic retry.

### R5 MAS serial preflight correction (2026-09-03; rejected predecessor)

`FRONTIER_BRIEF v1 — SERIAL PREFLIGHT CORRECTION` was a bounded child of exact
base/current HEAD `3b68fb22c4453b2e66e6da934e44387c3d6e0964`, with accepted
implementation ancestor `ca26b6c045bbbb1c86aa46b2a0a0966205d645cd`. The
authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

Lead rejected this predecessor after the real read-only status command
promptly failed on its absent fixed index; its focused fixtures had seeded the
empty index and therefore did not expose the first-use bootstrap gap.

The correction replaced MAS container-Application-Support-parent discovery
with exact fixed probes. A durable `MAS_GATE_SESSION_INDEX v1` locator and
`MAS_GATE_SESSION_INDEX_INTENT v1` record use fixed paths and bounded
`lstat`/read validation; Node transaction discovery and native host preflight
do not enumerate the parent. The fixed active slot and existing v2
run-derived sibling paths remain unchanged. The index is locator-only: each
located construction intent, journal, quarantine, retained root, and archive
still receives the existing complete v2 binding and state checks. Unknown or
unregistered siblings are ignored and never mutated. Root moves retain the
native exclusive no-replace boundary, so exact destination collisions remain
fail-closed. Existing v2 journals and retained archives are not migrated or
deleted.

An absent or invalid fixed index is deliberately not treated as an empty
parent: an unregistered legacy v2 active construction therefore fails closed
with reconciliation guidance. This preserves the no-enumeration guarantee but
means MAS provisioning must establish the exact empty index before the first
transaction; this correction does not add a bootstrap or legacy migration
authority. The index is bounded to 256 retained session locators; capacity
exhaustion also fails closed while retained evidence remains untouched.

The coordinator now exports `readMasGateSessionStatus`, and the session CLI
continues to import status through that coordinator. Process rows accept empty
string elements in a non-empty string argv array, while empty/null/non-string
argv and malformed pid/ppid/executable evidence remain invalid. Exact owned
H→D→S→W→P→C vectors remain exact; MAS path tokens stay live/ambiguous, and
unrelated Paseo/MeetlessHostTests rows neither block nor become stoppable.

The provisional write scope permits exactly seven paths: the MAS transaction
module, MAS coordinator, native host, the two focused runtime tests, the
native-proof test path if needed, and this plan. This candidate changes six of
those paths; the native-proof test path was not needed because native
debug/release proof and the source guard cover the new boundary. No mutation
helper, package transaction, validator binding, direct-DMG,
package/sign/install/launch, authority, or external-action file was changed.

Observed repository-only proof for this candidate:

- focused transaction tests: 79 passed, including subprocess crashes before
  and after fixed index-intent publication, construction mkdir/journal, root
  renames, archive rename, collision preservation, malformed/missing/stale/
  path-mismatched/overflow locators, legacy active construction, and untouched
  unregistered siblings;
- focused coordinator tests: 14 passed, including coordinator status export,
  safe status fixture, empty argv elements for unrelated rows, exact MAS argv
  ambiguity, and no signal for a non-exact host;
- `npm run build:native`: production host/mutation artifacts and debug/release
  native host tests passed;
- `npm run typecheck`, `npm run validate:macos:app-store`, both modified
  module `node --check` commands, `git diff --check`, and both MAS/session CLI
  `--help` commands passed.

No real MAS root, `/Applications`, package/sign/install/launch, process stop,
secret/cache inspection, or external action was performed. Runtime-root
attestation may still enumerate the opaque runtime root itself; the prohibited
parent-level enumeration is absent. Native MAS locator behavior was compiled
and source-checked but not exercised against a real sandbox container.

### R5 MAS first-use bootstrap reconciliation (2026-09-04; prior frontier)

`CONVERGENCE_RECONCILIATION v2` is an immutable child of rejected candidate
`3e241440205d0793fcb0a0f652ddfe00e2e15031`. Lead’s real read-only status
command returned promptly but the candidate still threw when the fixed index
was absent; the focused fixtures had pre-seeded the empty index. This child
closes only that first-use gap. The owner explicitly authorizes the one-time
Attempt 13 initialization step: `Cho phép tạo chỉ mục lần đầu cho Attempt 13.`
That authorization does not open package, sign, install, launch, stop, or any
external action before Lead accepts this repository correction.

The current MAS contract/runtime projection is the only authority for the
bootstrap. Status performs exact bounded probes of the fixed index,
fixed index-intent, and fixed active slot. When all three are absent it returns
`status: "uninitialized"` with `state: "absent-safe"`; it does not claim a
transaction is absent and does not create the index. A present fixed
index-intent or active slot, malformed fixed record, or exact destination
collision fails closed. Unknown dynamic siblings remain untouched and
unowned; no parent enumeration, migration, deletion, or legacy ownership
claim is introduced.

Only the MAS coordinator install path can call the initialization seam. It
does so after the complete validator returns its recursively frozen artifact
binding and while holding the existing native exclusive stable lock. The seam
publishes one exact `MAS_GATE_SESSION_INDEX v1` 0600 same-device record through
the lease’s exclusive no-replace rename, re-reads and validates the durable
record, accepts an exact existing empty index idempotently, and never resets a
populated indexed session. Public begin plus recover/restore/archive and the
native host continue to fail closed when the index is absent. Initial
publication hard-crash boundaries retain either no index or a complete
re-readable index, with no lost record bytes.

The index capacity check now rejects a 257th begin before index-intent or index
publication, while the 256-entry indexed state remains status/recovery-usable.
Swift now rejects unknown keys for the bounded index, index-entry, and
index-intent records, matching Node’s exact-key checks. Swift transaction
journals intentionally claim only known required fields plus exact
schema/version/path/bounds validation; full unknown-key parity for the larger
v2 journal is not claimed.

This child changes seven authorized paths: the MAS transaction module, MAS
coordinator, native host, the two MAS-focused tests, the package-transaction
regression fixture, and this plan. Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`; no ADR,
product, validator-binding, mutation-helper, or package-transaction
implementation authority changed.

Observed repository-only proof for this frontier is recorded in the peer
disposition: focused transaction, coordinator, and package-transaction suites;
native production/debug/release build proof; typecheck; MAS baseline;
JavaScript syntax; structural no-enumeration/strict-schema checks; and diff
validation. No real MAS root, `/Applications`, package/sign/install/launch,
process stop, secret/cache inspection, external action, or push is performed.

### R5 MAS status read-only correction (2026-09-04; prior frontier)

`CONVERGENCE_RECONCILIATION v3` is an immutable child of
`12cecc38ae39a4b5e66016ddd637de020672f7d2`. Lead accepted finding
`STATUS-READONLY-007`: a real pre-acceptance invocation of
`node scripts/macos-mas-gate-session.mjs status` created
`/Users/tubakhuym/Library/Containers/com.meetless.app/Data/Library/Application Support/.meetless-mas-gate.lock`
with mode `0600` and `176` bytes because status acquired and prepared the
native mutation lease. This was an unintended external-state mutation and is
not claimed as read-only. Lead moved that exact file intact to
`/Users/tubakhuym/.Trash/meetless-mas-gate-lock-lead-status-probe-20260904-0001`
and verified the original MAS path was absent. The owner authorization remains
limited to `Cho phép tạo chỉ mục lần đầu cho Attempt 13.` after complete
artifact validation; it does not authorize this probe or any package action.

Unsupplied status now performs only exact fixed-path reads and a bounded
optimistic before/after snapshot of the fixed index, fixed index-intent, and
fixed active slot. It never acquires or prepares the native lease and never
writes lock metadata. A supplied live coordinator lease may be used for a
serialized read, but status still does not write lease metadata. Fixed-record
drift retries once and then fails closed with actionable retry guidance;
malformed or semantically inconsistent records remain fail-closed. Typed
`uninitialized`/`absent-safe`, parent no-enumeration, bootstrap, capacity,
argv, topology, and stop behavior remain unchanged.

The correction is limited to the transaction module, its focused transaction
tests, and this plan. Fixture proof snapshots the complete parent tree and
confirms missing-lock/index status leaves names, bytes, and metadata unchanged;
it also covers supplied-lease metadata preservation and inconsistent fixed
index-intent rejection. All further probes for this frontier use fixtures or
proof roots. The Lead-created Trash residue is not touched. No real MAS root,
Trash path, `/Applications`, package/sign/install/launch, process, secret/cache,
external system, or push is in scope.

### R5 MAS serial Applications-parent policy correction (2026-09-04; prior candidate rejected for APPS-PARENT-002)

`FRONTIER_BRIEF v1 — SERIAL APPLICATIONS PARENT POLICY CORRECTION` starts at
the exact accepted base/current tip
`69c97239c8903cbb9fb06af01302ea2b4e1ed0e6`. Attempt 13 is consumed. Its
pre-install failure exposed that JavaScript treated the private runtime/lock
parent and the package parent as one class: JavaScript prepared the runtime
lock before the native helper rejected the standard `/Applications`
`root:admin` mode `0775` package parent as group-writable. No package move,
install, restore, launch, or accepted readiness occurred. The existing app and
runtime remained unchanged. The exact attempt-owned lock is retained as
unchanged residue; this correction does not inspect or mutate it, and creates no
real MAS or `/Applications` residue. Attempt 13’s one-time fixed-index
authorization is spent; any retry requires new owner authorization.

The correction adds one pure/shared JavaScript package-parent policy seam. A
private package parent is current-user- or root-owned and non-group/other-
writable. The exact canonical `/Applications` package parent is accepted only
when it is a directory with UID 0, the resolved system `admin` GID, exact mode
`0775`, and the effective user is root or a supplementary admin member. The
JavaScript check runs before `prepareLockFile`; the native helper repeats the
policy from its descriptor after no-follow traversal and identity binding,
including before protected package renames. Existing descriptor-relative
`openat(..., O_NOFOLLOW)` traversal, pinned identities,
`renameatx_np(RENAME_EXCL | RENAME_NOFOLLOW_ANY)`, sibling names,
transaction-specific ownership, root-owned prior-app backup handling, runtime
parent policy, and MeetlessHost checks remain unchanged.

Fixture proof covers synthetic exact `/Applications` metadata and admin
membership, same metadata at another path, missing membership, wrong
UID/GID/mode, symlink/alias, writable private/runtime parents, pre-lock failure
without lock residue, native modeled policy positives/negatives, package
ancestor substitution/EEXIST, and package rollback. Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.
No package/sign/install/restore/launch retry, real MAS root or `/Applications`
inspection, exact attempt-lock mutation, Trash/secrets/cache/process/external
inspection, or push is permitted for this correction.

### CONVERGENCE_RECONCILIATION v1 — APPS-PARENT-002 native runtime owner closeout (2026-09-04; current frontier)

Candidate `7871962f7c032ed18139d1280e35e4391e3ac709` is rejected for the
accepted finding `APPS-PARENT-002-NATIVE`. Its native `assertSecureDirectory`
still accepted `st_uid == 0` for the runtime/lock parent and the bound runtime
root, even though the private-runtime contract requires exact current-user
ownership. The JavaScript caller’s rejection is not sufficient evidence at the
native mutation boundary.

The correction introduces one distinct native private runtime/lock directory
validator. It checks the opened descriptor’s current identity, requires a real
directory with `st_uid == getuid()` exactly, and rejects group/other write. The
validator is used for lock acquisition, held-lock revalidation, runtime-root
binding, and runtime-child mutation. Root ownership remains available only to
the package-parent private class and the exact `/Applications` system class.
The native modeled proof adds a current-user-owned private positive and
root-owned non-writable runtime/lock negative, while retaining the existing
Applications policy cases and all APPS-PARENT-001/003/004 behavior.

Attempt 13 remains consumed: the pre-install failure, unchanged old app and
runtime, retained unchanged exact attempt-owned lock residue, and no-retry/new
owner authorization requirement remain in the preceding record. This closeout
does not inspect or mutate real MAS state, `/Applications`, the exact lock,
Trash, secrets/caches, processes, or external systems, and does not retry
package/install/restore/launch or push. Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

Lead accepted candidate `b3d96b4c1618423a16f18fe271bc9e565974800c`
on 2026-09-04 after verifying exact parentage and the two-path correction
delta. Lead personally reran the three focused MAS transaction suites
(`132/132`), `npm run build:native`, `npm run typecheck`, the MAS baseline
validator, JavaScript syntax checks, and diff/worktree checks; all passed.
Independent FAST closeout returned `CLOSEOUT_PASS` for
`APPS-PARENT-002-NATIVE`, including the current-user positive, root-owned
runtime negative, descriptor revalidation, and preservation of the exact
`/Applications` package-parent exception. This is repository acceptance only.
Attempt 13 remains consumed and no new package, install, restore, launch, or
other external gate is authorized.

The owner then replied `Đồng ý` directly to the Lead's request for explicit
authorization of one new attempt. Lead binds that reply to exactly one
`R5-MAS-DEV-PACKAGE-SIGN-INSTALL-LAUNCH-ATTEMPT-14`: Phase 1 may build, sign,
and validate one fresh development MAS artifact from the accepted repository
tip; Phase 2 may install and launch only after a separate Lead artifact
checkpoint. This authorization does not open purchase/restore, premium UI or
status, RevenueCat mutation/dashboard/credential activity, Convex, production
or annual actions, real transcription/provider/TCC/recording/export, upload,
submission, publication, App Review, push, or secret disclosure. Existing
Attempt 13 and Lead-probe residues must be classified and preserved according
to their recorded ownership; no manual cleanup is authorized.

### R5 MAS Attempt 14 post-install identity/recovery correction (2026-09-04; superseded first correction)

`FRONTIER_BRIEF v1 — SERIAL ATTEMPT14 POST-INSTALL IDENTITY/RECOVERY
CORRECTION` was the sole-writer repository child of exact base
`470d109c81c14c144f352cd2b522dc6a1cf57142`; its first correction candidate
`24a9d88b76643a77eafb21bafdd835aa87d24886` was rejected at FAST closeout.
Accepted findings were `ATT14-POSTINSTALL-IDENTITY-001`,
`ATT14-POSTINSTALL-IDENTITY-002`, and `ATT14-POSTINSTALL-PROOF-004`;
`ATT14-RECOVERY-ORDER-003` remains preserved. Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The correction keeps the runtime transaction's pre-package fresh-root
readiness and identity-absence guard unchanged. The package transaction now
owns a read-only proof that derives the v4 journal from the exact package
target and runtime run ID, binds the package owner/run/artifact and candidate
fingerprint/identity, requires null prior identity bytes, and compares the
published identity by exact bytes, SHA-256 digest, and lstat metadata. It
rejects temporary/collision identity state, symlinked identity ancestry,
altered or missing package/identity state, wrong owner/run/path/artifact, and
non-committed journals before authorization. No semantic JSON equality or
permissive fallback is used.

The coordinator composes the raw runtime status with that package proof for
both status entry points, launch, and recovery. Launch requires active ready
runtime state, a committed package transaction, the exact authorized identity,
and a valid handoff before LaunchServices. Restore/recovery keeps the existing
stop/absence → package rollback → package-lease release → gate-lock
reacquisition → runtime restore → archive sequence. Strict package rollback
repeats the proof preflight before mutation; after package rollback, the
existing runtime identity-absence guard and restoration path remain the owner.
The runtime transaction does not read package journals and receives no
duplicate package-identity state.

The changed paths are exactly the package transaction module, MAS coordinator,
the package-transaction and coordinator focused tests, and this plan. No
native, runtime-transaction, validator, contract, direct-DMG, authority, or
external-action file changed. Repository-only negative proof covers wrong
owner/path/run, wrong candidate binding, non-committed state, missing or
replaced identity, symlink identity, strict rollback preflight, and launch
rejection with zero LaunchServices calls. The retained Attempt 14 run ID
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4` and all real MAS state remain untouched;
only repository fixtures were used.

Local proof and enforcement levels are recorded in the peer handoff. No hook,
CI, or branch-protection result is claimed by this repository-only correction.

### R5 MAS Attempt 14 package-proof authority and recovery-state convergence (2026-09-04; superseded first correction)

`CONVERGENCE_RECONCILIATION v1 — ATTEMPT14 PACKAGE-PROOF AUTHORITY AND
RECOVERY STATES` is the sole-writer repository child of correction base
`24a9d88b76643a77eafb21bafdd835aa87d24886` and original family base
`470d109c81c14c144f352cd2b522dc6a1cf57142`. FAST rejected the first correction
at closeout. This convergence preserves closed finding
`ATT14-POSTINSTALL-IDENTITY-001`, closes
`ATT14-POSTINSTALL-IDENTITY-002-AUTHORITY` and
`ATT14-POSTINSTALL-PROOF-004`, adds
`ATT14-RECOVERY-STATE-005`, and preserves `ATT14-RECOVERY-ORDER-003`.
Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The package transaction now owns distinct read-only launch and recovery
predicates. Launch remains committed-only and requires the exact current
candidate, artifact binding, published identity bytes/digest/metadata, and no
package collisions. Recovery derives only the fixed secure target/run journal,
binds owner/run/target/identity/artifact, recognizes every rollback state from
preparation through identity restoration, and checks the physical roots and
identity shape allowed by that exact state before package mutation. The
runtime transaction still owns fresh-root readiness and the identity-absence
guard; it does not read package journals or carry duplicate package identity.

The coordinator calls the package-owned readers directly and composes only
their plain results. No caller-supplied package policy reader remains. The
only fixture seam is a low-level path resolver used to map the fixed logical
`/Applications` target into a disposable package parent; it cannot return a
pre-authorized proof. Restore preserves stop/absence → package rollback →
package-lease release → gate-lock reacquisition → runtime restore → archive.
Strict rollback rereads the package-owned recovery predicate before mutation,
and the existing identity-absence and runtime restoration guards remain after
package rollback.

The focused proof uses an actual isolated committed package transaction for
coordinator status/launch and completes coordinator restore, retaining the
fresh runtime evidence while restoring the prior package/runtime roots. It
also proves prepared, staged, target-backed-up, candidate-installed,
identity-published, committed, and in-flight restoring states, plus malformed,
foreign, altered, missing, replaced, symlink, collision, unknown, and
impossible-state failures with no launch or rollback mutation. Changed paths
remain exactly the package transaction module, MAS coordinator, their focused
tests, and this plan. The
retained Attempt 14 run ID
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4` and every real MAS path remain untouched.

Local proof and enforcement levels are recorded in the peer handoff. No hook,
CI, or branch-protection result is claimed by this repository-only convergence.

### R5 MAS Attempt 14 strict lsof no-match correction (2026-09-04; superseded predecessor)

`FRONTIER_BRIEF v1 — SERIAL ATTEMPT14 STRICT LSOF NO-MATCH CORRECTION` starts
from exact base `c27bd86ffb27f888da25cd02c6ec4e0f6fffeda3`, in the original
family rooted at `470d109c81c14c144f352cd2b522dc6a1cf57142`. The accepted
findings are `ATT14-LSOF-SEMANTICS-001`, `ATT14-LSOF-ADAPTER-002`, and
`ATT14-LSOF-PROOF-003`; the package/runtime-transaction, native, package-proof,
LaunchServices, and external-state boundaries remain closed. Authority digest
remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The correction owns one shared classifier/parser for the exact listener and
runtime-root `+D` lsof invocations. Absence is accepted only for an exact
status-1 result with `error === undefined`, `signal === null`, and present
empty-string or zero-byte Buffer stdout/stderr. Whitespace, diagnostics,
missing or malformed streams, errors, signals, non-1 statuses, and status-0
empty/malformed/diagnostic-bearing output fail closed. Bounded status-0
`-Fpcn`/`-Fpct` records become live evidence without returning raw output.
Every spawn uses the fixed `/usr/sbin/lsof` path and a finite `maxBuffer`;
`+D` rejects a symlink or non-directory runtime root before invocation. Missing
runtime roots remain pre-package absence so the existing fresh-root transaction
topology is unchanged, while an actual missing-path lsof diagnostic is not
treated as absence.

The low-level `invokeLsof` fixture adapter returns raw process results only;
the package/coordinator policy remains inside the shared classifier. Existing
stop/absence and package-first recovery ordering are unchanged, as is the
runtime transaction's independent identity-absence guard. The changed paths
are exactly this coordinator module, its focused test, and this plan.

Required local proof includes the disposable exact `/usr/sbin/lsof -nP +D`
empty-directory, held-file, and missing-path cases; the complete injected
status/stream/signal/error/record/maxBuffer matrix; exact listener/+D adapter
arguments and finite buffer checks; all focused MAS transaction/coordinator/
package regressions; typecheck, MAS baseline, syntax, and diff checks. The
retained Attempt 14 run ID
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4` is read-only and remains untouched.
No package/sign/install/launch/stop/restore/archive/retry/push or real MAS
path inspection is authorized by this correction.

Local, hook, CI, and branch-protection enforcement levels are recorded in the
peer handoff; no hook, CI, or branch result is claimed unless directly
observed.

Lead accepted candidate `3ba7dc312b418133a99eb726787dbee156501db3`
on 2026-09-04 after personally rerunning the complete focused MAS transaction
set (`148/148`), typecheck, the MAS baseline validator, syntax, and diff checks.
Independent FAST closeout returned `CLOSEOUT_PASS` for all three accepted lsof
findings, including disposable real empty/held/missing-path behavior and the
bounded negative result matrix. This is repository acceptance only. The first
retained-run recovery invocation failed before rollback and was explicitly
no-retry; all package/runtime roots remain retained. A further coordinator
restore requires fresh owner authorization and must not include package,
install, or launch.

### R5 MAS Attempt 14 status-1 live lsof correction (2026-09-04; superseded predecessor)

`FRONTIER_BRIEF v1 — SERIAL STATUS1 VALID LSOF LIVE EVIDENCE CORRECTION` starts
from exact base `2ad81e5c9cabb1e07f954ffad7e47761559fe7d2`, in the original
family rooted at `470d109c81c14c144f352cd2b522dc6a1cf57142`. It accepts
`ATT14-LSOF-SEMANTICS-001-AMEND` and `ATT14-LSOF-STATUS1-LIVE-004`; the
authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The shared exact listener/runtime-root `+D` classifier now keeps an exact
status-1 result with present empty stdout and stderr as absence, while a
status-1 result with valid bounded purpose-specific `-Fpcn` or `-Fpct` records,
exactly empty stderr, `error === undefined`, and `signal === null` is live
evidence. Status 0 behavior is unchanged. Whitespace, malformed or invalid
UTF-8 output, over-bound streams, missing/non-empty stderr, defined errors,
non-null/missing signals, malformed streams, and records mixed with diagnostics
remain fail-closed. Neither live evidence nor a rejected inspection can cross
the stop/absence boundary into package rollback.

The injected policy matrix proves status-1 `Fpcn` and `Fpct` records, all
negative stream/status/error/signal/record/maxBuffer cases, and zero recovery
mutation callbacks for both status-1 live evidence and rejected diagnostics.
The disposable exact `/usr/sbin/lsof -nP +D` fixture proves an empty directory
is absent, a held file is live despite local lsof status 1, and a missing path
diagnostic is rejected. The existing package transaction/coordinator proof
continues to use an actual isolated committed package transaction and the
package-first restore composition; no package transaction, runtime transaction,
native helper, package proof, LaunchServices, or external state is changed.

Changed paths are exactly:
`scripts/macos-mas-development-gate.mjs`,
`packages/runtime/test/macos-mas-development-gate.test.ts`, and
`docs/plans/active/v1-paseo-foundation.md`. The retained Attempt 14 run ID
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4` and its fixed evidence remain untouched;
this repository correction is not authorization for another recovery
invocation. Local, hook, CI, and branch-protection enforcement levels are
reported separately in the peer handoff.

Lead accepted candidate `1351f8295ec06aebfc5de33adb857552a261376e`
on 2026-09-04 after verifying exact parentage and the three-path delta. Lead
personally reran the full focused MAS transaction/coordinator/package command
(`149/149`), `npm run typecheck`, the MAS baseline validator, syntax, diff, and
worktree checks; all passed. Independent FAST closeout returned
`CLOSEOUT_PASS` for both accepted findings and confirmed that status-1 valid
records are live evidence, exact empty streams remain absence, and both live
or rejected observations prevent recovery mutation. The retained transaction was not
touched. This is repository acceptance only; another coordinator restore
requires fresh owner authorization.

After one separately authorized read-only probe returned exact `ABSENT` with
no open-handle records, the owner stated: `Ok vậy mình đồng ý hoàn tác Attempt
14 và trả máy về trạng thái cũ`. Lead binds this to exactly one corrected
coordinator restore invocation for retained run
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4`. The authorization permits package-first
rollback, fresh-runtime retention, prior-runtime restoration, archive
publication, and the coordinator's own contemporaneous absence checks. It does
not permit package, sign, install, launch, a new attempt, manual filesystem
recovery, or any excluded external gate. Failure remains no-retry.

That historical authorization was not exercised. The current package lease
absence-order frontier is repository-only and does not authorize a retained-run
recovery invocation.

### R5 MAS Attempt 14 package lease absence-order correction (2026-09-04; current frontier)

`FRONTIER_BRIEF v1 — SERIAL PACKAGE LEASE ABSENCE ORDER CORRECTION` is the
sole-writer repository child of exact base
`f0ae83f029b64e0a7516f11f84d079e5a5a1bc0a`, in the original family rooted at
`470d109c81c14c144f352cd2b522dc6a1cf57142`. It accepts
`ATT14-PACKAGE-LEASE-SELF-OBSERVATION-001`,
`ATT14-PACKAGE-LEASE-SELF-OBSERVATION-002`,
`ATT14-PACKAGE-LEASE-ORDER-003`,
`ATT14-PACKAGE-LEASE-PROOF-004`, and
`ATT14-PACKAGE-LEASE-AUTHORITY-005`; the authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The package transaction's `recoverPackageTransaction`,
`restorePackageTransaction`, and `finalizePackageTransaction` paths now acquire
and validate the exact package mutation lease before calling `assertNoLiveHost`.
Only after explicit absence succeeds do they bind the runtime-root descriptor,
then immediately reassert the live lease before any package mutation. The
native lease, `+D` evidence, package proof/identity/collision checks, state-aware
recovery, runtime identity-absence guard, and package-first coordinator order
remain unchanged. No helper PID or descriptor is excluded and no fallback is
introduced.

The coordinator committed-transaction composition uses no `openHandles`
policy mock for its package status/launch/restore dependencies, so the accepted
bounded `+D` adapter inspects the disposable runtime root. The package tests
also exercise all three mutation APIs against an exact `/usr/sbin/lsof -nP +D`
empty-root result while a contender proves the package lease is already held;
successful completion proves the bind/mutation path follows the absence check.
Existing foreign-held, malformed, stale/spoofed/dead lease, wrong owner/run/
path/identity/artifact, collision, and recovery-state regressions remain in the
focused suites and fail before package/runtime/archive mutation.

Changed paths are exactly `scripts/lib/macos-package-transaction.mjs`,
`packages/runtime/test/macos-package-transaction.test.ts`,
`packages/runtime/test/macos-mas-development-gate.test.ts`, and this plan.
The retained Attempt 14 run ID
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4` and all real MAS state remain untouched;
this repository correction does not authorize another recovery invocation.
Local, hook, CI, and branch-protection enforcement levels are reported in the
peer handoff and are not inferred from repository tests.

Lead accepted candidate `7ae5d2d2a43c01ccf52eeba9282ce9b32376fb9c`
on 2026-09-04 after verifying exact parentage and the four-path delta. Lead
personally reran the focused MAS transaction/coordinator/package command
(`150/150`), `npm run typecheck`, the MAS baseline validator, syntax, diff, and
worktree checks; all passed. Independent FAST closeout returned
`CLOSEOUT_PASS`, confirming lease acquisition precedes absence, absence
precedes runtime-root bind, the lease is immediately reasserted before
mutation, and no helper exclusion or lsof weakening was introduced. This is
repository acceptance only. The retained transaction remains untouched and a
further coordinator restore requires fresh owner authorization.

The owner subsequently authorized exactly one invocation with the statement
`Cho phép coordinator recovery Attempt 14 thêm đúng một lần`. Lead binds this
authorization only to the coordinator restore of retained run
`2b2905cf-7acd-493f-9aa7-5a6401c1e2e4`, including its internal stop/absence
checks, package-first rollback, package-lease release, gate-lock reacquisition,
fresh-runtime retention, prior-runtime restoration, and archive/index
publication. It does not authorize package, sign, install, launch, a MAS retry,
manual filesystem recovery, secret/cache/Trash inspection, or any excluded
external gate. The authorization is consumed by one invocation regardless of
outcome; failure remains no-retry.

That authorization was consumed by exactly one coordinator restore invocation,
which exited `0`. The coordinator proved complete absence, restored the prior
package first, released the package lease, reacquired the gate lock, retained
the fresh runtime, restored the prior runtime, and published terminal archive
and index state. `/Applications/Meetless.app` matches baseline tree fingerprint
`7039ded32b778fcda21fae6d961d80e72508630b2aaa0c8d2abedf08103e2a14`
and CDHash `acfdb5223b4d492d86e13827babcea2c5df392dc`; the canonical runtime matches
retained aggregate digest
`130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de`.
The Attempt 14 package transaction paths and package identity are absent, the
fresh runtime is retained at its run-derived path, and the archive journal is
terminal `archived`. Attempt 14 recovery is complete; this does not authorize
a new MAS attempt or any excluded gate.

### R5 MAS Attempt 15 authorization (2026-09-04; current frontier)

The owner authorized one new attempt with the exact statement `Cho phép
Attempt 15 chạy`. Lead binds this to one serial two-checkpoint attempt: Phase 1
may invoke the development MAS package command exactly once in a fresh proof
root and perform complete artifact plus fixed-path preflight validation. Phase
2 may proceed without another owner prompt only after Lead accepts that
checkpoint; it may invoke the coordinator install/launch/readiness/recovery
sequence exactly once and must restore the prior package/runtime state on every
terminal path. A failure consumes the attempt and remains no-retry.

This authorization does not open purchase/restore APIs, premium UI/status,
RevenueCat mutation/dashboard/credential/cache-child inspection, Convex,
production/annual actions, real transcription/provider/TCC/recording/export,
upload/submission/publication/App Review, push, manual filesystem recovery, or
unrelated process control. Attempt 14 remains terminal `archived`; its retained
fresh runtime and evidence are not cleanup targets.

Phase 1 completed with exactly one successful package invocation. Lead accepts
the artifact checkpoint from proof root
`/private/tmp/meetless-mas-development-proof.D8xLdO`: bundle fingerprint
`3ef85dc193f62199a25f7821b0dc7ffd813e7fc09696b3f305969fb9aa2c8a9e`,
manifest SHA-256
`b5cd55f0a2c817bdee89f03b9c2497da2d9bcbac13fdd910ac9d96a21004c5c7`,
and outer CDHash `a42af0ffe3553848b05bb033eebc7c6384c9941e`. The complete MAS
validator and independent signature/profile, thin-arm64, entitlement, package
input, symlink/load-path, contract, endpoint, pinned-Paseo, runtime/helper,
license inventory, notice, and public-key-hash checks passed. The known broader
license review remains a separate release/submission Definition of Done; it
does not authorize publication and does not block this local development
launch proof. Phase 2 is admitted under the existing one-Attempt-15 owner
authorization without opening any excluded gate.

Phase 2 consumed that authorization. Coordinator install exited `0`; launch
exited `1`; the sole coordinator restore exited `1` before package rollback.
Run `9e749d2e-873e-48cd-b521-18b2d112cb3a` remains active/ready with the
Attempt 15 package transaction committed, the prior app preserved in its exact
run-derived backup, and the prior runtime preserved in quarantine with digest
`130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de`.
No owned process, target listener, canonical socket, or runtime-root open handle
remains. Attempt 14 remains terminal archived and untouched.

LaunchServices host PID `58290` claimed the handoff; supervisor PID `58297`
and worker PID `58299` ran, the plugin loaded, and `127.0.0.1:16777` listened,
but renderer `18082` did not reach readiness. The coordinator rejected the
native handoff because Swift's sorted-key rewrite was compared with
order-sensitive `JSON.stringify`. Recovery then rejected the authorized native
atomic identity republication: exact identity bytes still matched SHA-256
`9b05b0a14692eb76626b95686769af0701c4ee1078b42e143099f80f5b2789c8`,
but the inode changed. These lifecycle contracts require repository correction
and Lead acceptance. Attempt 15 is consumed; no recovery retry is authorized.

### R5 MAS Attempt 15 dev-only handoff and identity-inode correction (2026-09-04; Lead accepted)

Owner authority is the exact response `Bỏ qua đi, chặt quá` after being told
that the only mismatch was the identity-file inode while exact bytes/hash and
all other secure metadata matched. Lead binds that decision only to this
single-operator development gate: authorized native atomic republication may
change the published identity file inode during recovery, but exact bytes,
digest, decoded identity schema and values, path, uid/gid, mode, device, nlink,
size, owner/run/target, artifact/candidate, recognized state, symlink-free
ancestry, and collision/temporary absence remain fail-closed. Initial
publication and launch proof remain inode-strict. There is no flag, fallback,
adoption record, attestation protocol, journal rewrite, or production/publication
authority.

The correction starts at exact base
`a8d003fa4f104ca875fc971988f59a1334378fd3`. Its immutable commit is the
resulting seven-path candidate reported in `PEER_DISPOSITION v1`; the retained
run `9e749d2e-873e-48cd-b521-18b2d112cb3a` and its package/runtime evidence were
not inspected or changed. The implementation keeps the strict launch predicate,
adds a recovery-only identity metadata comparison that excludes only inode,
strictly decodes the complete published host identity, binds coordinator
handoff values to the committed package/artifact proof, compares recursive JSON
without key-order sensitivity, and requires exact outer and `freshRootIdentity`
key sets in both Node and native Swift.

Repository proof on the candidate covers Swift-sorted and insertion-order
handoffs; missing, extra, and wrong-type outer/nested fields; wrong owner, run,
root, path, bundle, artifact, and candidate; changed bytes/digest/value and all
non-inode identity metadata; symlink ancestry, leaf symlink, temporary, staging,
displaced, and same-content collisions; a real atomic same-content identity
replacement with a changed inode; and state-aware coordinator restoration in
package-first order. The coordinator result remains only `launch-claimed` and
does not contain renderer readiness; renderer `18082` readiness remains a
separate Definition of Done and its absence is not accepted as launch
readiness.

Personally observed validation: the two focused Vitest files passed 61 tests;
`npm run build:native` passed both debug and release native suites after a
direct `swift run -c release MeetlessHostTests` correctly failed for missing
owner-command environment `MEETLESS_TEST_PACKAGE_NODE_SOURCE`; `npm run
typecheck` passed; and `npm run validate:macos:app-store` passed. Final focused,
syntax, diff, ancestry, changed-path, authority-digest, and clean tracked-tree
results are recorded in the peer disposition.

No optional repository hook or checked-in CI invocation owns this focused
correction command. Branch-protection enforcement is external and unverified.
No hook/CI/branch setting was changed. All real MAS state, `/Applications`,
retained evidence, process, secret/cache/Trash, package/sign/install/launch/
stop/restore/archive/retry, purchase/restore, RevenueCat/Convex, production,
upload/submission/publication/App Review, external action, and push gates remain
closed.

Lead accepted immutable candidate
`0d3445b84d91053a1d0911ceaf184f7c2eb9dc51` after verifying its exact parent,
seven-path scope, clean tracked tree, and unchanged authority digest. Independent
FAST closeout returned `CLOSEOUT_PASS`: handoff equality is key-order-independent
but schema-exact, launch/publication remain inode-strict, and recovery alone
excludes only inode while preserving every other identity and lifecycle guard.
This repository acceptance does not authorize recovery or any new attempt.

The owner subsequently authorized exactly one invocation with the statement
`Cho phép coordinator recovery Attempt 15 đúng một lần`. Lead binds this only
to coordinator recovery of retained run
`9e749d2e-873e-48cd-b521-18b2d112cb3a`, including internal stop/absence,
package-first rollback, lease release/reacquisition, fresh-runtime retention,
prior-runtime restoration, and archive/index publication. It does not authorize
package, sign, install, launch, a new attempt, manual filesystem recovery, or
any excluded gate. One invocation consumes the authorization regardless of
outcome; failure remains no-retry.

### R5 MAS Attempt 15 journal-bound quarantine attestation correction (2026-09-04; Lead accepted)

`FRONTIER_BRIEF v1 — ATTEMPT 15 JOURNAL-BOUND QUARANTINE ATTESTATION`
starts from exact base `357723f9b1124ec0ca680a021f4ddb608764e799` and
accepts `ATT15-QUARANTINE-DIGEST-001`, `ATT15-QUARANTINE-STATUS-002`, and
`ATT15-QUARANTINE-RECOVERY-003`. The full
`MAS_GATE_RUNTIME_ROOT_ATTESTATION v1` stored in the active transaction journal
is the only quarantine mutation authority. The bare historical digest remains
narrative evidence and is not read or enforced by runtime code or tests.
Authority digest remains
`ffb467198389299cc1ca39187e6a05112bdf771101b4fd3a18221624a0ee0297`.

The smallest owner change reorders `assertReadyRoot`: after exact fresh-root
identity, it validates the current quarantine against the journal-bound full
attestation before applying the unchanged post-install identity-absence guard.
Coordinator `active/ready` synthesis therefore occurs only after that runtime
validation fails solely for the expected published identity. Package proof
remains package-owned; no package fields or authority were copied into the
runtime transaction, and recovery order is unchanged.

Fixture-only positive proof uses an actual committed package transaction and
shows that the current quarantine exactly equals the journal attestation before
post-install composition returns `active/ready`. Its fixture digest is derived
from current bytes and metadata, not a historical scalar. Negative proof covers
changed bytes, changed file metadata, changed quarantine-root identity,
quarantine symlink, quarantine collision, and missing quarantine while a
published identity is present. Every case rejects before the identity-absence
failure and preserves the observed fixture tree. A coordinator negative proves
that changed quarantine bytes prevent `active/ready` synthesis with zero
package-path resolution and no fresh-retain or archive creation.

Personally observed repository proof: the focused runtime transaction,
coordinator, and package transaction command passed 3 files and 164 tests;
`npm run typecheck`, `npm run validate:macos:app-store`, Node syntax checks for
both runtime/coordinator modules, and `git diff --check` passed. The candidate
changes exactly the runtime transaction owner, its focused test, the coordinator
focused test, and this plan. No production coordinator change was needed.

Preflight result is deliberately no-invocation: no real MAS or retained
evidence was inspected; `/Applications`, locks, processes, secrets, caches, and
Trash were not inspected or changed; and no package, sign, install, launch,
stop, restore, archive, retry, external action, or push occurred. The owner's
one-shot Attempt 15 recovery authorization remains unconsumed. Every external
gate remains closed pending Lead acceptance.

Lead accepted immutable candidate
`8e3401a20972849ba61a5c5401ddd88fcb8d17ca` after verifying exact parentage,
the four-path delta, clean tracked state, unchanged authority digest, and the
writer's `164/164` focused proof. Independent FAST closeout returned
`CLOSEOUT_PASS`: the full journal-bound quarantine attestation is checked before
the unchanged identity-presence guard, invalid quarantine state cannot be
synthesized as `active/ready`, and package authority plus recovery ordering
remain unchanged. The owner's prior one-shot recovery authorization was not
consumed by the failed custom preflight and remains valid for exactly one
coordinator invocation.

That authorization was consumed by exactly one coordinator restore invocation,
which exited `0` and returned `restored`. The coordinator proved complete
absence, restored the prior package first, released the package lease,
reacquired the gate lock, retained the fresh runtime, restored the prior
runtime, and published terminal archive/index state. The canonical app matches
baseline fingerprint
`7039ded32b778fcda21fae6d961d80e72508630b2aaa0c8d2abedf08103e2a14`
and CDHash `acfdb5223b4d492d86e13827babcea2c5df392dc`; its deep/strict signature
passed and original mtime was restored. The canonical runtime's full archived
attestation matches digest
`130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de`.
Attempt 15's active/quarantine/package transaction and published identity paths
are absent, its fresh runtime is retained at the run-derived path, and its
archive is terminal `archived`. Attempt 14 remains terminal and unchanged.
No owned process, target listener, canonical socket, or open handle remains.
This recovery is complete and authorizes no new attempt or excluded gate.

`PLAN_RECONCILIATION v1 — POST-ATTEMPT15 READINESS DIAGNOSIS` closes the
repository/retained-evidence diagnosis without a new production change. The
proven earliest failure was the pre-correction handoff comparison, not a
renderer bind failure. The host, supervisor, worker, plugin, and daemon listener
were observed; desktop creates renderer `18082` only after recording readiness.
Retained evidence contains no timestamped renderer-bind, HTTP-timeout, or later
bootstrap error, so it cannot distinguish recovery stopping the host during
that wait from an independent later renderer failure. The accepted recursive,
schema-exact handoff correction already owns the proven defect; no speculative
renderer correction is authorized.

Speech-model downloads and relay connection are separate Paseo startup side
effects. Local speech providers are enabled by default and start background
model reconciliation after daemon readiness. Meetless explicitly enables and
persists relay, so Paseo connects it after plugin startup. Neither behavior is
proven to cause renderer failure, and neither violates an accepted current
policy. Deferring either changes product behavior and requires owner authority.
Repository fixtures can prove handoff tamper rejection, renderer serving/abort,
readiness timeout/shutdown, and relay enable/disable behavior, but only a
separately authorized signed MAS launch can prove the full live composition.
The reconciled recommendation is to preserve current network behavior for one
future isolated readiness attempt so that the already-corrected handoff remains
the only changed variable; decide startup-network policy separately afterward.

### R5 MAS Attempt 16 authorization (2026-09-04; current frontier)

The owner accepted that recommendation with the exact statement `Giữ nguyên
network behavior và cho phép Attempt 16 đúng một lần.` Lead binds it to one
serial two-checkpoint development attempt. Phase 1 may invoke the MAS
development package command exactly once in a fresh proof root and perform
complete artifact plus fixed-path preflight validation. Phase 2 may proceed
without another owner prompt only after Lead accepts that checkpoint; it may
invoke one coordinator install, one LaunchServices launch/readiness sequence,
and one coordinator recovery. A failure consumes the attempt and remains
no-retry.

Attempt 16 preserves the current local speech-model reconciliation and relay
startup behavior so the accepted handoff/quarantine corrections are the only
relevant changed variables. This is diagnostic acceptance of existing network
behavior, not authority for new endpoints, credentials, purchase/restore,
RevenueCat mutation/dashboard/cache-child inspection, Convex, production,
recording/transcription/TCC/export, upload/submission/publication/App Review,
push, or manual filesystem recovery. Attempt 14 and Attempt 15 terminal
archives/fresh-retained evidence are not cleanup targets.

Attempt 16 stopped in Phase 1 before creating a proof root or invoking the
package command. Authoritative coordinator status returned terminal `archived`,
but the operator added an invalid stronger preflight requiring the durable
committed `.meetless-mas-gate-session.index-intent` record to be absent. The
record is contract-owned terminal evidence: when the exact index equals its
committed `after` value, status treats it as acknowledged and validates the
complete archived transaction composition. It must be retained, not removed.

No repository/runtime correction is required. Package count was `0`; app,
runtime, terminal Attempt 14/15 archives, lock, repository, and protected files
remained unchanged. The owner subsequently removed the prior accounting rule
with `Bỏ quy tắc đi đấy đi và triển khai cho mình`. Lead binds the replacement
contract as follows: a read-only admission/preflight failure does not consume an
attempt; the attempt is consumed when its first package command begins. From
that boundary onward, package/install/launch/recovery commands remain one-shot
and no-retry regardless of outcome.

Attempt 16 is therefore still authorized and unconsumed. Its next Phase 1 must
use repository coordinator status as the sole MAS session-state preflight and
must not add custom parsing or fixed-record absence checks. The complete
artifact validator remains the separate package authority. This accounting
change does not weaken transaction, mutation, launch, or recovery safety and
does not authorize any excluded gate.

The repository-native enforcement boundary is the coordinator status command,
not a second attempt-accounting subsystem: existing positive proof accepts an
exact committed index intent whose index equals `after`, while malformed,
pending, mismatched, or ambiguous intent/state remains fail-closed. The plan and
operator brief own command-count accounting because the repository intentionally
has no parallel control-plane task database. Local fixture proof exists; no
hook, checked-in CI, or verified branch-protection enforcement is claimed.

The resumed Phase 1 used only authoritative coordinator status, which returned
terminal `archived` for Attempts 14 and 15. It then invoked the package command
exactly once, consuming Attempt 16, and exited `0`. Lead accepts the artifact at
`/private/tmp/meetless-mas-development-proof.to7YjX/release/macos/Meetless.app`:
manifest SHA-256
`e377fbeb004f845a44241f29b545bdadab87640b2aff4b2c376bcc189536cf0e`,
bundle fingerprint
`e7243483893d9939287ff66c482590375f271cb626c31dcb1fc7b950eb514f65`,
artifact digest
`51aa64ed7dbe8311eed5c689b0145834d7a620807021db2859b4789c5aa4668a`,
and outer CDHash `555a31c82e2818d71393670d14d2a81875f6b016`. Complete MAS validation,
deep/strict signature, exact signer/team/profile, 43 thin-arm64 Mach-O and
entitlement closure, package/source/Paseo inputs, license inventory, and
public-key hash passed. No install or launch occurred in Phase 1. Lead admits
Phase 2 under the existing Attempt 16 authorization; all excluded gates remain
closed.

Attempt 16 Phase 2 invoked coordinator install exactly once and exited `1`
before runtime/package mutation because the expected build-scoped RevenueCat
public SDK key authority was unavailable to that process. Launch and recovery
counts were `0`; no Attempt 16 run ID, transaction, archive, or fresh runtime
exists. The old app/runtime and Attempt 14/15 terminal archives remain exact,
and no owned process, listener, socket, open handle, or startup network behavior
was created.

This was a Lead brief contradiction, not a repository or artifact defect: the
Phase 2 brief required complete artifact revalidation while also prohibiting
the operator from reading the public key value needed by that validator. The
accepted artifact remains byte-identical and deep/strict signed. The least-cost
next route is not a new package; it is a separately owner-authorized Phase 2-only
retry against the same artifact, loading only the one public SDK environment
variable from the already accepted owned mode-0600 file and never logging,
persisting, or passing its raw value in arguments. Attempt 16's original
authorization is consumed; no retry is currently authorized.

The owner subsequently authorized exactly one Phase 2-only retry with the
statement `Cho phép chạy lại riêng Phase 2 của Attempt 16 đúng một lần, dùng
artifact hiện tại và chỉ nạp public SDK key để validator kiểm tra`. Lead binds
this to the unchanged accepted artifact and exactly one coordinator install;
if install commits, exactly one LaunchServices launch/readiness sequence and
one coordinator recovery are authorized. The operator may load only
`MEETLESS_REVENUECAT_PUBLIC_SDK_KEY` from the accepted owned mode-0600
environment file for validation and child startup, without printing,
persisting, or passing the raw value in command arguments. Package count must
remain zero. Any terminal failure consumes this authorization and remains
no-retry; all other external gates remain closed.

The authorized Phase 2-only retry completed once for run
`c1fc6225-bd5c-4d96-a9df-387eb7b97133`. Coordinator install and launch both
exited `0`, and LaunchServices accepted handoff PID `99068` for the exact
installed artifact. The host then exited before process-parent proof, the
H→D→S→W→P chain, daemon `16777`, recording readiness, renderer `18082`, or HTTP
readiness. The bounded readiness observation ended with no owned process,
listener, socket, or runtime-root open handle.

Exactly one coordinator restore then exited `0`. Package rollback preceded
runtime restoration; the prior app returned with fingerprint
`7039ded32b778fcda21fae6d961d80e72508630b2aaa0c8d2abedf08103e2a14` and
CDHash `acfdb5223b4d492d86e13827babcea2c5df392dc`; the prior runtime returned
with inode `43589382` and full-attestation digest
`130c2d4de4cf4e6b9d63ce775860aa2bcd2f70012222c1d7d67d694af71dc6de`.
The fresh runtime and terminal archive remain at exact run-derived retained
paths. Repository-owned final status is terminal `archived` and live state is
absent. Attempt 16 is consumed and recovered; no retry is authorized.

Read-only retained-evidence diagnosis proved that the daemon did start and
listen on `127.0.0.1:16777`: the daemon log records server listen at
`23:17:03.620Z`, worker readiness at `23:17:03.896Z`, plugin load, and relay
connection. The desktop nevertheless timed out after 30 seconds because its
readiness predicate requires a live `desktopManaged` PID lock plus a matching
native registration marked `attested`. The implementation discards
registration-status errors, so retained evidence cannot distinguish PID-lock
observation failure from post-start native registration/attestation inspection
failure. At `23:17:32.888Z` the timeout cleanup intentionally sent `SIGTERM`;
the worker then exited cleanly with code `0`.

Renderer and later recording probes are downstream and non-causal: renderer
`18082` is created only after recording readiness, while the observed recording
`ECONNREFUSED` occurred after daemon cleanup. No renderer, sandbox, argv,
configuration, or network-behavior correction is justified by this evidence.
The smallest next repository change, if requested, is diagnostic only in the
runtime readiness owner: preserve each predicate component and a sanitized
native registration-status error before timeout. No functional fix or future
external attempt is currently authorized.

#### Readiness diagnostic correction accepted (2026-09-05)

The runtime desktop now retains a bounded, sanitized daemon-readiness summary
through the existing production decision path. Timeout output distinguishes PID
lock read/parse error, missing lock, non-`desktopManaged` lock, dead PID, native
registration inspection error, absent matching daemon registration, and
`attested: false`; it preserves the latest applicable lock/registration state
and the bounded set of states observed during retries. Error output admits only
fixed categories for the actual upstream PID-lock and host-protocol errors,
never raw messages, environment values, protocol tokens, or native rejection
detail. A separate bounded category set preserves earlier sanitized failures
when a later retry reaches another state. The success predicate, check ordering, network behavior,
30-second deadline with 100 ms polls, abort, direct-development behavior, and
central shutdown remain unchanged.

Local fixture verification passed: the new production-path diagnostic suite
(`28` tests), existing host/readiness/lifecycle/packaged-attestation suites (`56`
tests), and `@meetless/runtime` typecheck. No package, install, launch, native or
live-state probe, recording, external service, or all-in-one build/test ran.
This diagnostic candidate is not MAS runtime acceptance; a separately
authorized packaged attempt remains required.

Lead did not accept candidate
`fcae11c8ab8a76bd98f27b3a3a0b4bb6aedec5c0` for an external attempt: its
fixture used an invented errno while production transport emits plain static
errors, and its latest observation could drop an earlier sanitized reason.
This correction uses the inspected production error construction and retains a
fixed set of error categories across retries; it does not infer native causes
that the protocol does not expose.

Lead accepted correction `8759ec6d494018e2bfd7a01682b6f5af0fb2f409` after
bounded close-out of DIAG-001 and DIAG-002 against correction base
`fcae11c8ab8a76bd98f27b3a3a0b4bb6aedec5c0`, original frontier base
`7fd15cfd08d9f09c088b1b58db9d5373a9bb0817`. Ancestry, the complete three-path
manifest (desktop source, diagnostic test, this plan), and all four frozen
authority hashes matched. Lead personally reran the five focused suites (84
tests passed), runtime typecheck (passed), and diff whitespace checks (passed).
The error mapping matches the existing protocol's static errors and rejects
raw detail; error-to-other-state tests retain prior failure categories. The
runtime test seam calls the production wait function, and existing
packaged-attestation composition/host/readiness/lifecycle checks passed.
Review route: owning deterministic checks; no additional independent review
lane was needed for this bounded diagnostic-only delta. No native protocol,
recovery, network, readiness acceptance predicate, or product policy changed.
Both protected untracked paths remain untouched; no external gate or push ran.

### Risks And Recovery

- App Sandbox may reject the current nested Electron, Node, helper, listener, or
  writable-path topology. The MAS target now resolves writable state in its
  container, but the user-selected security-scoped export flow and actual
  sandbox launch remain open gates. Preserve the direct-DMG package path; do
  not weaken validation to make MAS pass.
- Store and RevenueCat credentials are external. Keep public SDK configuration
  build-scoped; never persist private keys or issuer secrets in the repository.
- Convex currently offers no APAC hosted region; upload latency and regional
  data placement must be measured before selecting a production deployment.
  The local implementation is region-neutral; production platform limits,
  action retries, workflow result persistence, and concurrency must be measured
  before external deployment. No user-facing duration cap is implied by those
  operational measurements.
- Convex mutations can own atomic admission and ledger transitions, but neither
  Convex nor the provider call is assumed exactly-once. Stable idempotency,
  reservation/settlement, ambiguous outcomes, and cleanup are application
  contracts.
- The local keychain has Apple Development and Apple Distribution identities,
  and both development and distribution profiles now match macOS
  `com.meetless.app`; the exact development profile is snapshotted before any
  package effects and must still be bound into and validated against a later
  signed package.
- App Review and store processing are external gates. Record exact states and
  do not claim publication before the public listing is observed.

### Validation

- Foundation R1: the fake-backed identity, quota, idempotency, duration,
  cleanup, local-publication, and free-path proof above.
- Completed local Convex frontier: generated upload URL/storage-ID transfer,
  ordered at-most-10-minute physical chunks behind one logical job, immutable
  manifest validation, and retry/idempotency against a local deployment. This
  evidence does not claim hosted production behavior.
- Current hosted-dev frontier: the deterministic configuration/auth/vendor
  adapter and lifecycle policy boundary is locally covered by Phase 1, while
  the exact hosted development canary is accepted below. External credentials
  and real provider spend remain gated; do not select the production subscriber
  allowance.
- Focused R1: free Ask/BYOK policy, managed transcription admission, and
  existing meeting-store publication proof. Purchase adapter, renderer
  boundary, and sandbox entitlement tests remain separate reusable evidence.
- Integration: packaged sandbox app with StoreKit/RevenueCat sandbox purchase,
  restore-to-new-installation, device enrollment, and managed transcription.
- Repository: typecheck, focused tests, build, and a MAS-specific package validator.
- Historical R5 MAS contract/runtime correction proof: target-specific
  contract/runtime positive and direct-path negative tests, direct-DMG
  regression, syntax, MAS baseline, typecheck/build, and frozen-authority
  digest. It remains implementation evidence for accepted candidate
  `6fe924d68c7bbb0f560ffbfed1501f67a66e0ea8`.
- Current `NATIVE-SCOPE-003` proof correction: the unconditional clean-checkout
  synthetic fixture exercises the production artifact-member source projection,
  Mach-O-only selection, exact native package roots, full inventory coverage,
  and omitted/misassigned provenance failures; the retained root `Ffw0bs` test
  remains optional historical proof. Focused Vitest, Node syntax, and diff
  check are required. The MAS packaging entrypoint and all
  package/download/sign/install/launch/purchase/restore operations remain
  unrun.
- External: App Store Connect processing, App Review submission, and public listing.

Observed predecessor R1 validation on 2026-08-31 (historical, not acceptance evidence):

- `npm run typecheck` passed; `npm run build:meetless` passed.
- `npm run test --workspace=@meetless/managed-transcription-foundation` passed
  (1 file, 7 tests).
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/chat-service.test.ts test/composition/managed-transcription-path.test.ts test/composition/chat-path.test.ts` passed (5 files, 32 tests).
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed (6 files, 66 tests).
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` passed (16 files, 112 tests).
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts test/composition/managed-transcription-path.test.ts` passed (3 files, 10 tests).
- `npm run test:composition` ran 5 files and reported 3 passed, with the
  pre-existing M6 transport timeout (120 seconds) and missing
  `@expo/vector-icons/build/createIconSet` module. It is not R1 proof.
- `npm test` completed its native/Paseo/build pretest and ran 71 files with
  65 passing and 6 baseline failures (715 tests, 709 passing): the same M6
  transport timeout and Expo module failure, three retained macOS signing
  diagnostic expectations, and one readiness deadline fixture. The new R1
  tests were included in the passing result.
- No real AVFoundation/Convex latency, production backend, credentials,
  StoreKit/RevenueCat mutation, signing, upload, or publication was attempted.

Observed first-correction validation on 2026-08-31 (historical, superseded):

- `npm run typecheck` passed, including Paseo type builds and the Meetless app
  typecheck; `npm run build:meetless` passed.
- Focused correction R1 command
  `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/chat-service.test.ts test/composition/managed-transcription-path.test.ts test/composition/chat-path.test.ts`
  passed (5 files, 38 tests).
- Affected domain/store command
  `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1`
  passed (6 files, 66 tests).
- Affected plugin/lifecycle command
  `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1`
  passed (16 files, 116 tests).
- `npm test` completed native/Paseo/build pretest successfully and reported
  65 passing files and 715 passing tests out of 71 files and 721 tests. The six
  pre-existing failures were the M6 transport timeout (120 seconds), two
  missing `@expo/vector-icons/build/createIconSet` imports, three retained
  macOS signing diagnostic expectations, and one readiness deadline fixture.
  They are outside the correction scope.
- `git diff --check` passed. The two authority files remain byte-identical to
  original base `64cf07d71bf82c798f8c3db417ada7d3c14ad7b5`; their frozen
  combined SHA-256 remains
  `79159e03961957296f0f110996c71e0fdde7790760b1dd63fcd40ebbab3637ae`.
- No real AVFoundation/Convex latency, production backend, credentials,
  StoreKit/RevenueCat mutation, signing, upload, or publication was attempted.

Observed convergence-correction validation on 2026-08-31:

- `npm run typecheck` passed, including Paseo type builds and the Meetless app
  typecheck; `npm run build:meetless` passed.
- Focused convergence command
  `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/inventory.test.ts packages/meetless-plugin/test/recording-service.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts --maxWorkers=1`
  passed (8 files, 94 tests). This includes the 31-second provider-result
  crash/retry and the real RecordingService finalizer handoff composition.
- The policy/adapter/composition subset after the final boundary checks passed
  (3 files, 16 tests).
- Affected domain/store command
  `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1`
  passed (6 files, 66 tests). Affected plugin/lifecycle command
  `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1`
  passed (16 files, 116 tests).
- `npm test` completed the native/Paseo/build pretest successfully and ran 71
  files: 66 passed and 5 failed, with 716 passing and 5 failed tests out of
  721. The failed files were the M6 transport timeout, two suites blocked by
  missing `@expo/vector-icons/build/createIconSet`, one macOS artifact-resign
  diagnostic assertion, and three macOS package-signature diagnostic
  assertions. The convergence tests were included in the passing result.
- No real AVFoundation/Convex latency, production backend, credentials,
  StoreKit/RevenueCat mutation, signing, upload, or publication was attempted.

## Completed Evidence

- [M7 and TCC historical ledger](../completed/v1-paseo-foundation-m7-accepted-history.md)
  preserves the full pre-reconciliation active plan, including accepted and
  superseded candidate identities, validation, owner holds, TCC R2/R3 evidence,
  and residual release gates. It is evidence, not current authority.
- [M0–M6 and design history](../completed/v1-paseo-foundation-m0-m6.md) preserves
  the accepted product and architecture foundation.
- [post-M3 harness evidence](../completed/post-m3-electron-harness-improvement.md)
  preserves the accepted installation-only harness capability.

## Reconciliation Record

- 2026-09-02 `PLAN_RECONCILIATION v51`: Lead accepted endpoint topology
  `180dbdd24ac8a9cf0396c88fe17cbab04ce0254a` and liveness convergence
  `62b49fe30b2f37c35504ee9c8ff58d3fcbf82ce7` at integration checkpoint
  `39013a89d1c63fdbbedbf45097fc6e076bf964a3`. Lead personally inspected the
  exact ancestry, authorized changed paths, short-bind/canonical-cleanup delta,
  shared golden vectors, and plan-only checkpoint; reran 52 focused endpoint,
  client, and lifecycle tests, 59 direct-DMG/MAS/host/readiness contract tests,
  native `MeetlessHostTests`, typecheck, syntax, stale-diagnostic, and diff
  checks. All passed. Attempt 6 now opens only the owner-authorized dev MAS
  package/sign/recoverable-install/exact-launch/bounded-readiness/owned-stop/
  restore lifecycle. No attempt-6 external result is accepted yet and every
  excluded gate remains closed.

- 2026-09-02 `PLAN_RECONCILIATION v52`: attempt 6 from exact accepted tip
  `beb7865abf7342ceebc0545850351e5cd631436a` reached the real LaunchServices
  topology (`MeetlessHost` with `ppid=1`) and then failed in the child runtime
  with `installed bundle identity drifted...`. Native Swift identity encoding
  uses recursive sorted keys; Node's constructed identity and parsed recorded
  identity were semantically/canonically equal in the retained read-only replay,
  but their raw insertion-order `JSON.stringify` bytes differed. Native and
  static inspection agreed on bundle, designated requirement, CDHash, binary
  hash, and MAS runtime root, so no scalar identity drift was observed. Receipt
  absence is unrelated to this correction.

  The accepted correction keeps complete strict identity attestation and makes
  the trusted context explicit: production installed/live inspection receives
  the RuntimeConfig-derived runtime root and MAS app-container support root;
  wrong context fails closed, while one-argument direct-DMG/external/static
  inspection remains compatible. Installed and live comparisons now parse the
  strict complete identity schema and recursively compare every value without
  key-order sensitivity. Expected packaged configuration binds `nodePath` to
  `RuntimeConfig.packageResources.nodeBinary`; development alone uses
  `process.execPath`. Transaction `nextIdentityBytes` uses the same recursive
  sorted-key pretty JSON plus newline as native Swift, preserving byte-level
  ownership and exact rollback checks. Focused positive/negative identity,
  trusted MAS context, compatibility, runtime wiring, and transaction
  recovery/mutation proof are included in the six owned code/test paths.

  The retained signed MAS artifact and attempt-6 runtime evidence remain
  read-only evidence; no artifact child was executed and no package, sign,
  install, launch, receipt, purchase/restore, RevenueCat/Convex, native source,
  config, container, external state, or push action occurred for this
  correction. Authority digest remains
  `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.
  Repository candidate and plan are pending Lead review.

- 2026-09-02 `PLAN_RECONCILIATION v53`: from exact base
  `eabdaceab58c2f984f9b8f3a617f9d9da2c97a6c`, the candidate placeholder is
  `<immutable-candidate-commit-pending>`. The accepted host identity/context
  correction at that base passed semantic equality in attempt 7 and remains
  unchanged. This candidate owns only the null-safe, lossless projection and
  formatting of startup-reachable `spawnSync` diagnostics in host/readiness;
  it retains the native argv inspector, exact PID ancestry, executable
  path/realpath/device/inode/size/hash, argv array boundaries, and fail-closed
  topology policy.

  Retained attempt-7 root `/private/tmp/meetless-mas-development-proof.lPh2Bk`
  reached packaged sandbox-inherit Node and logged only the masked diagnostic
  `Cannot read properties of undefined (reading 'trim')`. The original spawn
  failure fields were not retained, so no exact underlying errno or sandbox
  rejection cause is proven. The candidate preserves command/inspector path,
  fixed argument purpose, available Error fields, status/signal, and safe
  stdout/stderr without disclosing arbitrary command arguments. Positive valid
  argv and negative pre-exec, nonzero, signal, empty, and malformed-output
  proof are included. The focused host/readiness suite passed 2 files and 33
  tests, and typecheck passed. The full runtime owner ran 26 files with 355
  passing and 4 failures in existing macOS artifact-signing/resign diagnostic
  expectations outside this correction. The static signed thin arm64 helper
  remains evidence of presence only, not MAS spawnability.

  No package, native, plugin, entitlement, contract, lockfile, product
  authority, artifact, `/Applications`, container, external state, or push
  action occurred for this correction. All package,
  sign, install, launch, and external gates remain closed pending Lead review.
  After acceptance, exactly one controlled diagnostic MAS retry may decide
  whether the existing native argv inspector remains viable; no fallback,
  retry loop, process.argv substitution, self-report, or new attestation
  architecture is authorized by this reconciliation.

- 2026-09-02 `PLAN_RECONCILIATION v54` / `CONVERGENCE_RECONCILIATION v1`:
  FAST closeout accepted DIAG-001, DIAG-003, and DIAG-004 and reopened only
  DIAG-002. From exact parent/base
  `a6a46a56aeeff15a3b02f73a69a1566a1e5a8fd1` (original correction base
  `eabdaceab58c2f984f9b8f3a617f9d9da2c97a6c`), the child candidate
  placeholder is `<immutable-candidate-commit-pending>`. This correction
  changes only the shared formatted diagnostic projection and focused proof:
  raw stdout/stderr bytes are omitted at every call site, while stream
  presence/state, representation type, and byte length remain available.
  Error name/code/errno/syscall/path/message, status, signal,
  command/inspectorPath, and fixed safe purpose remain actionable; spawn
  argument arrays and environment remain undisclosed.

  Secret-sentinel and oversized string/Buffer proof covers ps, native argv,
  lsof, codesign, and plutil-like streams. Valid argv parsing, exact topology,
  and fail-closed empty/malformed/nonzero/signal behavior remain unchanged.
  The single future diagnostic MAS retry remains closed pending Lead acceptance;
  no fallback, retry loop, process.argv substitution, self-report, or new
  attestation architecture is authorized. Authority digest remains
  `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.

  No artifact execution, package/sign/install/launch action, secret/cache
  listing, external mutation, or push occurred for this correction. All
  package, sign, install, launch, purchase/restore, RevenueCat/Convex,
  production, upload, submission, publication, and other external gates
  remain closed pending Lead review.

- 2026-09-02 `PLAN_RECONCILIATION v50` / `CONVERGENCE_RECONCILIATION v1`:
  From exact unchanged base `94999f10e1e7d841209a695392e259c1b185f0f9`,
  candidate `62b49fe30b2f37c35504ee9c8ff58d3fcbf82ce7` closes the bounded
  IPC-003/IPC-005 correction without changing the accepted relative topology.
  Native transcription and Node recording stale/active probes validate their
  packaged composition and use the same short `bindArgument` as bind/connect;
  canonical paths remain limited to containment, identity, stat, marker,
  permission, and unlink checks. Real long-ASCII/Unicode-root bind/connect,
  stale reclaim, active-owner rejection, wrong-CWD, foreign-entry preservation,
  shutdown cleanup, and shared runtime/plugin/client/native golden-vector proof
  pass. Stable endpoint/package/host diagnostics cite ADR0003/ADR0004/ADR0005
  and the accepted `MEETLESS_RUNTIME_ENDPOINTS v1` package/runtime contract,
  with no plan-revision coupling. Direct-DMG and MAS package/host contract
  regressions, native `MeetlessHostTests`, typecheck, syntax, diff, and
  ancestry checks pass. The read-only D97 contract replay rejects its old host
  configuration before launch because the versioned endpoint policy is missing.
  All prior residues, failures, exact old-app restoration, public-key handling
  violation, authority digest, and excluded gates remain preserved; no package,
  sign, install, launch, secret/cache inspection, retained-root mutation,
  external action, R4 fixture change, or push occurred. Candidate remains
  pending Lead review.

- 2026-09-02 `PLAN_RECONCILIATION v49` / `CONVERGENCE_RECONCILIATION v1`:
  FAST closeout accepted IPC-001 and the selected relative AF_UNIX topology,
  but reopened IPC-003/IPC-005 because stale/active probes in both native and
  Node lifecycle owners used the overlong canonical socket path. On the
  attempt-5 113-byte topology this prevents deterministic stale recovery even
  though bind/connect uses the short relative endpoint. The final correction
  keeps the architecture fixed: use the short bind argument for liveness and
  canonical path only for stat, marker identity, permissions, and unlink; add
  real long-root bind/reclaim, active-owner rejection, and cross-language
  golden vectors; refresh v47 diagnostics. No third architecture loop or
  external retry is authorized by this reconciliation, and every excluded gate
  remains closed.

- 2026-09-02 `PLAN_RECONCILIATION v48`: from exact original base
  `0477b10b8eaea19244fa694c567b8a601714591a`, this candidate adds one pure,
  versioned packaged endpoint composition owner and adapters for native host,
  runtime, plugin, client, and renderer. Packaged bind/connect arguments are
  short relative names under one explicit app-container runtime-root working
  directory; canonical paths remain available for containment, identity,
  ownership, stat, and cleanup. It removes the MAS `/private/tmp` recording
  fallback, preserves distinct recording/transcription owners, runtime
  ancestry authorization, host locking, direct-DMG absolute behavior, and
  fail-closed endpoint ownership/cleanup. Electron module resolution is stable
  when packaged child CWD changes. Pure, package-contract, native, Node,
  client, renderer, lifecycle, direct-DMG, D97 replay, typecheck, syntax, and
  diff proof were run locally; the candidate remains pending Lead review. The
  authority digest is unchanged and no package, sign, install, launch, secret,
  cache, external gate, or push action was performed.

- 2026-09-02 `PLAN_RECONCILIATION v47`: attempt 5 from accepted tip
  `4d7dc17f3710dd4bfb055f242eb7eb4d79697f08` successfully packaged, Apple
  Development signed, validated, transactionally installed, and started the
  exact native host, then reopened before runtime readiness because the MAS
  app-container transcription socket expanded to 113 UTF-8 bytes against the
  103-byte Darwin address limit. The pre-existing app was restored exactly and
  all owned processes, listeners, sockets, and install transaction paths were
  released. Two independent foundation judgments rejected a filename-only
  fix; Lead selected short relative packaged endpoint names resolved from one
  explicit app-container runtime-root working directory, while retaining
  canonical absolute paths for ownership and cleanup. Native, Node, Electron,
  and renderer must consume the same versioned composition; the independent
  `/private/tmp` recording fallback is removed, durable app-container state and
  direct-DMG behavior remain unchanged, and clean long-ASCII/Unicode-home proof
  is required. The public SDK-key-bearing residue listing is recorded as an
  operational evidence-handling violation; no RevenueCat mutation or rotation
  is authorized. Every excluded external gate remains closed.

- 2026-09-02 `PLAN_RECONCILIATION v46`: Lead accepted immutable convergence
  correction `07d11ecdef9a1d75837b23a7c31173d4f36ae7e6` after personally
  inspecting the exact four-path delta, rerunning the focused MAS suite (12
  tests), the composed MAS/package/contract suite (51 tests), typecheck, MAS
  baseline validation, syntax and diff checks, and replaying the retained
  GNud6q signed artifact. The replay validated all 43 Mach-O objects as one
  parent, 15 child, and 27 no-entitlement policies; all 27 no-entitlement
  evidence records serialized with empty key lists. The repository frontier now
  opens only owner-authorized dev MAS package/sign/recoverable-install/exact-
  launch verification attempt 5. No artifact, install, launch, RevenueCat
  runtime read, or external result is accepted yet; all excluded gates remain
  closed.

- 2026-09-02 `PLAN_RECONCILIATION v45`: package readiness is reopened at exact
  base `f914864f3e746662b58bdfe75fd852eb1e6f63c0` for
  `R5-MAS-ENTITLEMENT-CONVERGENCE-CORRECTION`. FAST closeout accepted the v44
  authoritative Mach-O type policy but found two direct integration defects in
  the same validator boundary: NONE-policy evidence projection invoked
  `Object.keys(null)`, and entitlement diagnostics required the known warning
  instead of accepting the exact warning-free `Executable=` result. The
  correction is limited to the production projection/parser seam, package
  evidence wiring, deterministic tests, and this plan. No package retry is
  claimed; GpvGZD and GNud6q remain preserved read-only history, the authority
  digest is unchanged, every external gate is closed, and Lead acceptance is
  pending.

- 2026-09-02 `PLAN_RECONCILIATION v44`: package readiness is reopened at exact
  base `81c9fe5e8fc2a28269dc88e9663e492c39900b7f` for
  `R5-MAS-MACH-O-ENTITLEMENT-TYPE-CORRECTION`. Accepted profile-signing
  correction `25257e4c96e743fd56ad80956bb1b31511e2c544`, checkpoint `81c9fe5`,
  accepted history through `13f20d2`, and authority digest
  `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3` remain
  unchanged. Retained root `GNud6q` records the exact overbroad post-sign
  entitlement failure and the signed 16/1/26 `MH_EXECUTE`/`MH_BUNDLE`/`MH_DYLIB`
  counts; `GpvGZD` remains preserved prior failure history. The correction uses
  only existing inventory `machOFileType`, adds the pure type-policy and
  entitlement-result parser seam, and leaves signer/options routing unchanged.
  Deterministic positive/negative proof and optional read-only retained-artifact
  audit are required; clean proof does not depend on a retained root. Every
  external gate remains closed, dependency order is unchanged, and this
  candidate is pending Lead acceptance.

- 2026-09-02 `PLAN_RECONCILIATION v43`: Lead accepted immutable correction
  `25257e4c96e743fd56ad80956bb1b31511e2c544` after focused MAS and package
  proofs, typecheck/validation, and independent close-out passed all four
  `PROFILE-SIGN` findings. Three unchanged generic-signature tests retain stale
  authority-wording regex expectations; close-out ruled them unrelated to
  signer safety and retry readiness. The owner-authorized frontier reopens only
  dev MAS packaging, Apple Development signing, recoverable local installation,
  exact launch, bounded readiness, and inherent RevenueCat public-SDK
  configure/read behavior. Every other external gate remains closed; no
  artifact or external result is accepted by this verdict.

- 2026-09-02 `PLAN_RECONCILIATION v42`: package readiness is reopened before
  final signing for the embedded-profile signing correction at exact base
  `8311c9928a899b74833608eef1980bac12f66f04`. Accepted history through
  `13f20d2eb49549f72098d103e0a49d1900a9248e` and checkpoint `8311c99` remain
  preserved. Retained root `GpvGZD` records the exact `codesign`/`Permission
  denied` failure on `Contents/embedded.provisionprofile`; profile bytes/CMS/
  fields passed, the manifest was not produced, and no install or launch
  occurred. The exact-path ignore seam, unchanged code-object entitlement
  routing, and unsigned-data diagnostic parser are implemented and covered by
  deterministic repository proof; this candidate remains pending Lead
  acceptance. Every external gate is closed and dependency order is unchanged.

- 2026-09-02 `PLAN_RECONCILIATION v41`: Lead accepted immutable correction
  `13f20d2eb49549f72098d103e0a49d1900a9248e` after the unconditional clean-
  checkout proof passed independently, the focused suite passed 35 tests, and
  independent close-out closed `NATIVE-SCOPE-003` with no material findings.
  `NATIVE-SCOPE-001` through `NATIVE-SCOPE-004` are closed. The owner-authorized
  frontier reopens only dev MAS packaging, Apple Development signing,
  recoverable local installation, exact launch, bounded readiness, and inherent
  RevenueCat public-SDK configure/read behavior; every other external gate
  remains closed. No artifact or external effect is accepted by this verdict.

- 2026-09-02 `PLAN_RECONCILIATION v40`: close-out accepted
  `NATIVE-SCOPE-001`, `NATIVE-SCOPE-002`, and `NATIVE-SCOPE-004`; only
  `NATIVE-SCOPE-003` is reopened for unconditional clean-checkout proof. The
  correction starts at exact base
  `34467fdd375fb7433d1a720759fb69684bed95a9`, in original family base
  `189d7d490d33498e9bb392a1f31fa30d2ce92781`, and adds one deterministic
  synthetic path through production source projection and inventory coverage,
  including omitted/misassigned provenance rejection. The correction and proof
  are pending Lead acceptance. `57b1020`, `189d7d4`, failed proof root `Ffw0bs`,
  and `34467fd` remain preserved as unaccepted correction evidence. Every
  external gate remains closed until acceptance and a separately routed retry;
  dependency order is unchanged.

- 2026-09-02 `PLAN_RECONCILIATION v39`: package validation/readiness is reopened
  at exact original/current base `189d7d490d33498e9bb392a1f31fa30d2ce92781`
  for `R5-MAS-NESTED-NATIVE-COMPONENT-SCOPE-CORRECTION`. Retained failed proof
  root `/private/tmp/meetless-mas-development-proof.Ffw0bs` recorded the exact
  diagnostic that nested `@esbuild/darwin-arm64/package.json` was outside the
  `native-binaries` component scope; the failure occurred before MAS injection,
  signing, installation, or launch. Accepted correction `57b1020aa30f31b611141f5cc1e020ce8d3baf0c`
  and plan checkpoint `189d7d490d33498e9bb392a1f31fa30d2ce92781` remain
  historical accepted evidence. The shared resolver correction and bounded
  positive/negative retained-artifact proof are pending Lead acceptance. Every
  external gate remains closed until new acceptance and a separately routed
  retry; dependency order otherwise remains unchanged.

- 2026-09-02 `PLAN_RECONCILIATION v38`: Lead accepted immutable correction
  `57b1020aa30f31b611141f5cc1e020ce8d3baf0c` after verifying its exact parent,
  five-path scope, 32 focused tests, Node syntax, and the bounded independent
  close-out of `PKG-CLOSURE-001` through `PKG-CLOSURE-004`. The owner-authorized
  frontier now opens only dev MAS packaging, Apple Development signing,
  recoverable local installation, exact launch, bounded readiness, and inherent
  RevenueCat public-SDK configure/read behavior. Purchase, restore, production,
  annual-product, provider, deployment, upload, submission, publication, and
  every other external gate remain closed. No artifact or external effect is
  accepted by this repository verdict.

- 2026-09-02 `PLAN_RECONCILIATION v37`: package readiness is reopened at exact
  correction base `0e37877620ef11c5d590b3d3466c6ea6fd8f11c2` after retained proof
  root `/private/tmp/meetless-mas-development-proof.i9JfdG` recorded a failure
  before MAS signing/manifest: `@meetless/plugin` declared the root-lock
  workspace link `@meetless/managed-transcription-foundation`, but the fixed
  `localPackages` selection omitted it. `/Applications` was untouched and no
  launch occurred. The current correction owns selective closure validation,
  foundation `dist` packaging, and package-input binding; no package manifest or
  lockfile change is expected. The focused positive/negative regression passed
  1 file and 32 tests; three changed Node modules passed `node --check`; and a
  read-only full-selection probe passed 15 selected packages and 27 workspace
  links. Historical accepted implementation evidence at
  `6fe924d68c7bbb0f560ffbfed1501f67a66e0ea8` is retained; this new candidate is
  pending Lead acceptance, external gates remain closed, and dependency order
  otherwise remains unchanged.

- 2026-09-02 `PLAN_RECONCILIATION v36`: Lead accepted immutable repository
  candidate `6fe924d68c7bbb0f560ffbfed1501f67a66e0ea8`. Lead verified its exact parent
  and six-path correction delta, the complete ten-path chain from `d761a4d`,
  frozen seven-file zero diff and digest, actual local Apple Development
  certificate CN/OU compatibility with the parsed native requirement, 3 focused
  files and 30 tests, native `MeetlessHostTests`, MAS baseline, typecheck,
  Meetless build, Node syntax, pinned-Paseo resolver output, diff check, and
  clean tracked tree. MAS-DEV-001 is closed; MAS-DEV-002-narrowed, MAS-DEV-004,
  and MAS-DEV-005 remain closed; MAS-DEV-003 remains rejected. Repository
  acceptance opens no package, signing, launch, purchase, restore, deployment,
  push, or other external gate.

- 2026-09-02 `PLAN_RECONCILIATION v35`: the two deterministic MAS-DEV-001
  blockers are corrected within the existing boundaries. The marker resolver is
  import-safe, executes `git -C vendor/paseo rev-parse --verify HEAD^{commit}`
  against the repository root, and accepts only the ADR0001 pinned revision.
  Native packaged verification selects direct Developer ID or the exact R5
  Apple Development identity from the existing direct/MAS runtime-root contract;
  resource attestation and legacy identity migration use the selected policy.
  Focused positive/negative runtime and native proof, syntax, validator,
  typecheck, build, native-test, diff, and frozen-authority checks passed. The
  immutable candidate is pending Lead acceptance; MAS packaging and all external
  gates remain closed. MAS-DEV-002-narrowed, MAS-DEV-004, and MAS-DEV-005 remain
  closed, and MAS-DEV-003 remains rejected.

- 2026-09-02 `PLAN_RECONCILIATION v34`: the prior MAS development-packaging
  claim was reopened by `R5-MAS-DEVELOPMENT-PACKAGING-CORRECTION`. The active
  order is now MAS app-container contract/runtime composition, exact profile
  snapshot and signed-closure validation, repository candidate acceptance, and
  only later separately authorized package/sign/launch/monthly-purchase/restore.
  The correction base is `1a87e1e02191ad27eac619a51ca5b46a64b6a5a4`; the
  original base is `d761a4de816c974357c66690c56948ccdd914aef`; frozen authority
  digest is `fd54201d964757aedc5c4b33fd04bab64057bad3f6b35a8e820e7339a3bc56f3`.
  No external gate or prior accepted R4/R5 milestone is changed.

- Base snapshot: clean `main@3ab08d4f45699ee1dee49b75c6b0caf40086bdae`.
- The former 4,943-line active ledger moved to completed evidence; no evidence
  bytes were removed from that history.
- Executable references to the former active plan are replaced by stable ADR or
  specification/product authority. No semantic plan lint or new harness behavior
  is introduced. Harness doctor remains installation-only.
- `test/evidence/m3/20260819T153402Z-live/manifest.json` is immutable historical
  evidence and remains byte-identical.
- 2026-08-31 `PLAN_RECONCILIATION v4`: Lead accepted the managed-transcription
  direction with required decisions. The MAS/RevenueCat candidate
  `9f73a7199a65735219d98c2df0eff8de8a2ddcc9` is closed structural evidence;
  its Ask gate is superseded. The current frontier is docs/foundation contract
  work, and implementation remains blocked on the five owner/authority gates.
- 2026-08-31 `PLAN_RECONCILIATION v5`: the owner accepted all five managed-
  transcription contracts. Product policy and ADR0005 now own the free Ask/BYOK,
  quota/trial, three-Mac restore, sample-count duration, 24-hour TTL, six-hour
  lease, natural-expiry completion, and refund/revocation behavior. The next
  frontier is the bounded fake-backed foundation proof.
- This v5 reconciliation changes product and ADR authority plus this plan. It
  changes no implementation, executable contract, package, external service,
  credential, or store state.
- 2026-08-31 `FOUNDATION_PROOF R1`: the fake-backed policy owner, MeetingStore
  publication adapter, Ask-free service path, focused executable proof, and
  honest broader-suite limits were added from original base `64cf07d`. The
  authority files remain frozen and no production service or external state was
  changed.
- 2026-08-31 `FOUNDATION_PROOF R1-CORRECTION`: Lead rejected correction base
  `51ee0cd61bae184d9936e2105294465f8de16108` for MTF-001 through MTF-008. The
  correction candidate adds fresh post-lease admission, verified canonical
  timeline identity, checkpoint-publication recovery, shared lifecycle leasing,
  provider-status release, explicit temporary WAV preparation over the real
  inventory shape, period-snapshotted allowance, and snapshot rehydration. The
  locally observed proof is recorded above and remains pending Lead closeout;
  authority files and external state remain unchanged.
- 2026-08-31 `FOUNDATION_PROOF R1-CONVERGENCE`: Lead's closeout left MTF-003
  and MTF-006 open. The convergence candidate is based on `ee55af2`, preserves
  the six closed findings, creates one full-duration MeetingStore range with
  acknowledgement only after local publication, and moves canonical WAV
  creation into finalization before source-chunk cleanup. A fake durable
  artifact sidecar and fresh-instance crash proof cover provider-result
  recovery; the real RecordingService composition covers pre-cleanup handoff
  and post-cleanup publication. Lead accepted candidate `cdc42fd4` after
  independently rerunning the 8-file/94-test focused proof, typecheck,
  `build:meetless`, `git diff --check`, and the frozen authority digest. Authority
  files and external state remain unchanged.
- 2026-08-31 `PLAN_RECONCILIATION v9`: the bounded fake-backed foundation is
  closed. The next frontier is the production Convex/AVFoundation integration
  gate. Repository inspection found no Convex project, configuration, or
  deployment target, so no external project, credential, provider, or store
  mutation is authorized or attempted. Internal briefing may proceed; real
  regional latency and upload/action-limit proof waits on the owner gate.
- 2026-08-31 `PLAN_RECONCILIATION v15`: the owner froze the local-first Convex
  implementation contract. Local recording/canonical preparation has no cloud
  duration cap and upload starts only after explicit managed-transcription
  action; ordered physical upload/provider chunks are at most 10 minutes behind
  one logical billing timeline; immutable manifests and server-derived PCM
  duration govern idempotent reservation/settlement; V1 has no diarization or
  user-facing 60-minute cap. The combined authority digest is now
  `87625cb59c10e399767e34a2ecfd2bd92bf7e3a7598673fec267479dfdd7860e`.
  Region-neutral local Convex implementation is authorized; only production
  deployment/region, credentials, and provider access/calls remain deferred
  owner/external gates.
- 2026-08-31 `PLAN_RECONCILIATION v19`: the owner clarified that the seven-day
  trial remains five hours (`18,000` seconds) total, while reopening the
  subscriber monthly allowance amount. Product and ADR authority now describe
  that allowance as backend-configured with no selected production number;
  production fails closed and remains undeployable without an explicit value.
  The owner-selected/observed Convex target is project `Meetless`, dev
  deployment `frugal-mandrill-646`, US East (N. Virginia), with no production
  deployment. Apple and RevenueCat catalog observations are recorded above;
  credentials, webhook, sandbox purchase/restore, availability, deployment,
  review, and publication remain open. The current combined authority digest is
  `4f609ef15102282f49f47e34176894e64b361fbc3524a05b1441ff7a005487e4`.
- 2026-08-31 `ASK-FREE-UI-CORRECTION-R1`: from exact base
  `2e4a4b2099dc668429fc8d2dee1f2fb46928b1b4`, the meeting-surface Ask path was
  corrected to ignore inactive, unavailable, and missing Premium state. Ask
  now invokes its normalized question and clears the successful draft;
  recoverable retry remains `Retry question`; the action checks remain
  transcript-ready, provider/model or catalog selection, interactive, running,
  and callback availability. The Ask-only paywall, `Unlock Ask` labels, and
  Premium state/effect were removed. The public surface Premium props remain
  accepted for the existing managed-transcription host wiring but are no
  longer forwarded into Ask. Changed paths are exactly
  `packages/meeting-surface/src/index.tsx`,
  `packages/meeting-surface/test/surface.test.tsx`, and this plan. Observed
  proof: the focused surface suite passed 1 file and 30 tests;
  `npm run typecheck`, `npm run build:meetless`, and `git diff --check` passed;
  a scoped search found no `Unlock Ask` or `premiumActive` in the source/test
  paths. No hosted-dev frontier, authority digest, or external state changed.

### R3 local Convex implementation predecessor (rejected by Lead)

Observed on 2026-08-31 against the R3 implementation frontier. This is local
evidence only; it does not claim hosted Convex, production authentication,
provider execution, or acceptance by Lead.

- `convex/schema.ts` and the two Convex modules define server-owned temporary
  upload metadata, immutable sample-offset parts, one logical admission and
  quota ledger transition, six-hour lease, 24-hour expiry, idempotent seal /
  settlement / acknowledgement, and an internal-only local canary seed. The
  server checks each stored part's actual canonical WAV header, sample count,
  byte length, and digest before admission. Provider execution is a
  provider-neutral local action with one full-timeline range and no diarization.
- The pure foundation manifest validator remains Convex-free. The desktop
  adapter uses a required durable local POST/register journal, streams each
  normalized 44-byte-header PCM part through a generated upload URL, sends no
  audio bytes in function arguments, and resumes registered storage IDs after
  a process restart. FFmpeg metadata chunks are located at the edge; the
  logical manifest identity is canonical header plus PCM samples.
- Recording finalization remains the only creator of the private managed WAV.
  Save/finalize performs no Convex call. The explicit managed service persists
  the MeetingStore pending transcript barrier before remote admission, holds
  the shared lifecycle lease through publication, publishes to MeetingStore,
  then acknowledges remote temporary data and removes the private artifact.

Observed commands and results:

- `npx convex dev --once --typecheck enable --codegen enable` passed against
  anonymous local deployment `http://127.0.0.1:3210`; generated Convex types
  and local function preparation completed without a cloud account.
- `npx convex run internal.managedTranscription.seedLocalCanary
  '{"tokenIdentifier":"r3-final-canary"}'` passed. The seed is an internal
  test-only verified-lineage fixture, not production authorization.
- The anonymous local HTTP canary passed generated upload URL, direct storage
  POST, duplicate part registration, seal, ordered fake provider completion,
  duplicate settlement, duplicate acknowledgement, and cleanup. Observed
  result: `sealedStatus=reserved`, `providerStatus=provider_completed`,
  `providerRanges=1`, `settledStatus=succeeded`,
  `duplicateSettledStatus=succeeded`, `cleanedState=cleaned`, and zero
  remaining part records.
- The same local backend logged actionable failures for an over-bound part
  (`Managed physical part exceeds the accepted ten-minute sample bound`) and
  an incomplete manifest (`Managed seal requires every physical part exactly
  once and in order`), each naming the frozen authority files.
- `npx vitest run --config vitest.config.ts packages/managed-transcription-foundation/test/policy.test.ts packages/meetless-plugin/test/managed-upload.test.ts packages/meetless-plugin/test/managed-transcription.test.ts packages/meetless-plugin/test/recording-service.test.ts packages/meetless-plugin/test/meeting-lifecycle-coordinator.test.ts test/composition/managed-transcription-path.test.ts packages/meeting-domain/test/transcript.test.ts packages/meeting-store/test/store.test.ts --maxWorkers=1` passed: 8 files, 103 tests.
- `npx vitest run --config vitest.config.ts packages/meeting-domain/test packages/meeting-store/test --maxWorkers=1` passed: 6 files, 67 tests. `npx vitest run --config vitest.config.ts packages/meetless-plugin/test --maxWorkers=1` passed: 17 files, 127 tests.
- `npm run typecheck` passed, including Paseo type builds, Meetless project
  references, and the app typecheck. `npm run build:meetless` passed.
  `git diff --check` passed.
- The composition proof observes no Convex calls during real fixture
  RecordingService save/finalization, no WAV stage under exportRoot, only MP3
  output there, source-chunk cleanup, private artifact consumption, one local
  MeetingStore citation, and post-publication cleanup. The adapter proof uses
  a sparse 13,200,001-sample source and a synthetic seven-part logical
  manifest longer than 60 minutes without a user-facing duration cap.

Enforcement and limits:

- Local validation: the commands above are the repository-native evidence
  owners and passed. Optional hooks: no configured `core.hooksPath`; only
  stock sample hooks are present. CI: no checked-in `.github` workflow invoking
  these commands was found. Branch protection: unverified.
- The local Convex slice has no hosted region, production deployment,
  verified Apple lineage adapter, production credentials, or real provider
  action. US East/EU West selection, production limits/latency, provider
  cancellation, and external deployment remain owner gates. The internal
  canary seed must not be exposed as a production endpoint.
- The journal closes the returned-storage-ID/register ambiguity. A transport
  failure before a generated upload response is received cannot be reconciled
  by this repository without an external storage-listing/garbage-collection
  contract; this remains an owner/provider cleanup gate. No product duration
  or size cap was added.

Lead rejected candidate `0a82b39f758e8c2ec19e831ca1c8c1b75529763d`; its
evidence is retained here as predecessor history. The bounded correction below
was rejected at closeout for the residual `MTC-R3-006` sibling failure path;
the accepted convergence is recorded afterward.

### R3 lifecycle correction (rejected at closeout)

Lead rejected candidate `0a82b39f758e8c2ec19e831ca1c8c1b75529763d` at the
correction base with accepted findings `MTC-R3-001`, `MTC-R3-002`,
`MTC-R3-003`, `MTC-R3-005`, `MTC-R3-006`, `MTC-R3-007`, and `MTC-R3-008`.
`MTC-R3-004` was not accepted as a defect: the Lead ruling requires proving
Convex indexed read-then-insert behavior through concurrent local calls, and
requires reopening if that proof contradicts OCC/serializability. This
correction candidate preserves the ruling and records evidence pending Lead
closeout; it does not claim production behavior.

The correction adds identity-only recovery after natural expiry, current
entitlement checks only for new admission, durable cancellation generations,
execution tokens and attempts, atomic provider-result settlement with the
one-charge ledger transition, bounded indexed lease/TTL reconciliation, and
current-device validation on every action-to-internal path. Device revoke
stops in-flight work while account-owned terminal results remain recoverable by
an enrolled sibling. A ready MeetingStore transcript is checked before the
private timeline is prepared, so a fresh service retry does not require a
deleted artifact.

Observed mechanical proof on 2026-08-31:

- `npm run proof:managed-convex-local` passed against an anonymous
  local Convex deployment. The script started and stopped the local process,
  seeded only internal test principals, used generated upload URLs/storage IDs,
  ran concurrent begin and same-part registration, and cleared its account
  state. Its exact result was:
  `{"frontier":"MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION","result":"passed","anonymousLocalConvex":true,"concurrentBeginAndPartOCC":true,"providerInvocations":1,"logicalTimelineSeconds":31,"noCapLogicalTimelineSeconds":4200,"restartRecovered":true,"cleanup":"account state cleared"}`.
- That proof covered natural-expiry claim/complete/settle/retrieve/ack,
  duplicate settlement and acknowledgement, process restart, cancellation
  staleness, lease expiry and fresh admission, next-period allowance
  snapshotting, post-TTL non-settlement, device revoke with sibling recovery,
  same-audio immutable binding, distinct-recording identical bytes, the
  over-sixty-minute no-cap manifest, and an oversized stored Blob rejected by
  `Blob.size` before materialization. It also proved the accepted MTC-R3-004
  OCC premise locally; no lock table was added.
- The composition regression passed through real fixture
  `RecordingService` finalization, private canonical-artifact handoff before
  source cleanup, Convex-shaped publication through MeetingStore, artifact
  cleanup, and a fresh-service retry after the private artifact was gone. The
  retry issued only the recording job-status query.
- `npx vitest run --config vitest.config.ts packages/meetless-plugin/test
  --maxWorkers=1` passed 17 files and 127 tests; the affected domain/store
  command passed 6 files and 67 tests; the managed policy/upload/transcription,
  lifecycle, Ask/BYOK, domain/store, and managed composition command passed
  14 files and 163 tests.
- `npm run typecheck`, `npm run build:meetless`, and `git diff --check` passed.
  A broader command that included every composition file reported only the
  pre-existing `m6-transport-path.test.ts` 120-second timeout and the existing
  Expo icon module-resolution failure in `meeting-path.test.ts`; those files
  are outside this correction's managed path.
- The local proof uses a deterministic provider fake with one full-timeline
  range and no diarization. It does not claim hosted Convex, cloud provider
  execution, or production auth/lineage.

The seven-finding lifecycle correction evidence remains retained as closeout
context; its exact residual and current convergence candidate are recorded
below. The prior local implementation authority digest was
`87625cb59c10e399767e34a2ecfd2bd92bf7e3a7598673fec267479dfdd7860e`; the
current reconciled digest is recorded in `Current State` and the v19 record.

### R3 device convergence (accepted)

Lead's closeout of candidate `522faa0b1d1e78e54f0e7d0fc813fc0a0706ab01`
closed `MTC-R3-001`, `MTC-R3-002`, `MTC-R3-003`, `MTC-R3-005`,
`MTC-R3-007`, and `MTC-R3-008`; the exact remaining defect was the
`MTC-R3-006` sibling failure path. This candidate is based on that closeout
and does not reopen the accepted architecture or closed findings.

The convergence change requires the admitting device for any reserved or
running provider failure cleanup, and makes the provider action's catch path
call failure cleanup only after that action has acquired the winner execution
token. An enrolled sibling may still recover account-owned terminal status,
result, and acknowledgement. The local proof adds the direct sibling attempt:
the sibling rejection leaves the reserved job, admission, and period
reservation/usage unchanged, after which the admitting device settles once.

Observed mechanical proof on 2026-08-31:

- `npm run proof:managed-convex-local` passed against an anonymous local
  Convex deployment and exited 0. Its exact result was:
  `{"frontier":"MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION","result":"passed","anonymousLocalConvex":true,"concurrentBeginAndPartOCC":true,"providerInvocations":1,"logicalTimelineSeconds":31,"noCapLogicalTimelineSeconds":4200,"restartRecovered":true,"siblingDeviceIsolation":true,"cleanup":"account state cleared"}`.
- The new proof seeds two enrolled devices, admits on the primary, rejects the
  sibling's `runProvider` before failure cleanup, verifies the reserved job,
  admission, and period reservation/usage are unchanged, then runs the primary
  to one provider invocation and one settlement. It also retains the prior
  seven-finding lifecycle and concurrent OCC cases.
- The focused managed plugin/lifecycle/composition command passed 6 files and
  43 tests; `npm run typecheck`, `npm run build:meetless`, and `git diff --check`
  passed. The frozen authority digest remained unchanged.

Lead accepted convergence candidate
`f93b705561eb6118c9ccbe7d0f9ae146db4f5df8` on 2026-08-31 after verifying
its exact parent and four-path delta. Lead personally reran
`npm run proof:managed-convex-local`; the anonymous local proof passed with
`siblingDeviceIsolation: true`, one provider invocation, preserved OCC and
restart recovery, and owned-state cleanup. The direct managed
policy/upload/transcription/composition suite passed 4 files and 32 tests;
`npm run typecheck`, `npm run build:meetless`, `git diff --check`, and the
frozen authority digest also passed. This acceptance is local only and does
not claim hosted Convex, production authentication, provider credentials,
provider network execution, or external mutation.

## Validation

Acceptance validation is the command evidence recorded above. The accepted
convergence candidate locally exercises the fake policy and one real local MeetingStore
publication composition path; it does not
prove real Convex latency, regional placement, AVFoundation upload limits,
production backend behavior, provider credentials, external purchase mutation,
signing, App Review, or publication.

This v19 docs revision records local implementation acceptance and observed
development/catalog state; it does not claim production allowance, production
deployment, provider call, production latency, external credentials, sandbox
purchase/restore, review, publication, or other external mutation.
