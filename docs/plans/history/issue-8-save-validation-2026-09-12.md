# Historical evidence: issue #8 save validation, 2026-09-12

This is an archived execution record, not current instructions or authorization.
For current work read [the active plan](../active/v1-paseo-foundation.md); for
local MAS development read [the current guide](../../macos-development.md).
Old pending actions and implementation briefs below are superseded.
The failed launch/recovery attempts remain evidence; they are not waived.

# Execution Plan: Meetless V1 — Issue #8 Recording Save

Date: 2026-09-12

## Status

**Active: issue #8 selected by the owner on 2026-09-12. Source repair and live Retry/Stop accepted;
builds passed; relaunch/persistence unproven; recovery archive blocked.**

The owner requested reconciliation of the existing plan, a GitHub Project with
categorized dependent issues, and cleanup of the active plan, then a pause for
their decision. That planning work is complete; product implementation and
release acceptance remain open. Historical “current opened scope”, writer
assignments, build-in-progress states, and next-run instructions in the snapshot
below are superseded as task status, not instructions to resume execution.

- Project: [Meetless — V1 recovery and release](https://github.com/users/hoangnb24/projects/1).
- Reused the existing empty Meetless project and open issues #5/#6; created #7–#17.
- Issue #8 is In Progress; other issues remain Todo. Priority remains a recommendation.
- Readiness separates Awaiting owner, Blocked by prerequisites, and Later.
- Native GitHub dependencies express prerequisites for completion/acceptance.
  Independent investigation can be possible before those prerequisites finish.
- No issue creation authorizes package/install/launch, purchase, provider spend,
  deployment, data cleanup, or publication. Issue #8 execution authority is
  recorded below; other issues have not started.

## Outcome

Make one coherent MAS journey reliable: record → Stop → audio saved locally →
explicit Transcribe → readable local transcript → meeting-scoped Ask and cited
playback. Buying Premium updates access automatically, but never starts or
resumes transcription. Store distribution and managed-production readiness
remain distinct later acceptance gates.

## Confirmed Product Decisions

The following decisions were explicitly accepted by the owner in this
conversation on 2026-09-12. They override conflicting automatic-transcription
wording in older documents; issue #7 promotes them consistently into the product
and decision documents before the affected implementation is accepted.

1. Stop saves local audio only. Premium, previous consent, relaunch, or a later
   quota reset never automatically starts transcription or upload.
2. The user selects **Transcribe** for each saved recording. Saved without a
   transcript is a normal completed state. Cloud disclosure/consent belongs to
   that explicit action.
3. Without Premium, offer purchase/restore in the recording context. After a
   successful purchase, update Premium without a manual Refresh; the user
   presses Transcribe again. No deferred transcription auto-resume is needed.
4. If the whole recording exceeds remaining managed allowance, explain this
   before upload, do not transcribe a partial recording, and retain local audio
   for a later explicit attempt when allowance is available.
5. Defer BYOK credential-entry UI for the first release. Record/save/play remain
   free; the shipped transcription UI uses Premium. Existing free Ask/citation
   policy and future free BYOK precedence are unchanged.
6. Analyze costs, then ask the owner to select the paid monthly allowance.
   No number has been approved. Existing intended prices and trial 7 days/5
   hours remain unchanged. Test allowance is not production authority.

## Evidence And Limits

- Current source inspection finds a 30-second Premium UI wait followed by a
  manual Refresh path; a test explicitly protects that behavior. Issue #6 owns
  convergence and replacement of that assertion with the agreed behavior.
- Local MAS log observations from 2026-09-11 show about 66 seconds between a
  purchase dispatch and plugin active, including human interaction. This is
  not a measured backend-only latency and does not identify the slow service.
- The same logs contain three spawn EPERM errors in the recording sequence.
  The historical plan records a similar relocated-media execution defect fixed
  and a successful saved recording on 2026-09-09. The current failing executable
  and artifact regression have now been traced for #8 below; the historical
  diagnosis alone was not used as proof of the current cause.
- Recoverable recording errors are collapsed into the same Retry-save message,
  and several transcription errors become generic failure copy. #9/#10 own the
  feedback and handoff behavior.
- The latest historical dev:mas checkpoint accepted package/install/startup and
  a listMeetings RPC only. It explicitly did not accept purchase, transcription,
  App Store distribution, or release. Its artifact inventory digest was
  `2f460dbf9d40909c04885fb74207dce7af350d63c0b28091a0d8f0c56a66a543`;
  this is historical provenance, not a claim about the currently running app.
- This planning pass did not run the app, make a purchase, transcribe audio,
  deploy Convex, or run product tests. Local logs are not uploaded to GitHub.

## Backlog And Dependencies

GitHub owns issue status, classification and dependencies for owner selection.
The repository remains the source of product policy, code and acceptance evidence.
This table is the migration snapshot, not a second independently maintained
progress ledger. Project Readiness is manually maintained, not automated.

| Issue | Proposed priority | Prerequisites |
| --- | --- | --- |
| [#8](https://github.com/hoangnb24/meetless/issues/8) Sửa lỗi Stop/Retry save bị spawn EPERM trên bản MAS hiện tại | P0 | — |
| [#6](https://github.com/hoangnb24/meetless/issues/6) Fix successful monthly sandbox purchase becoming failed Premium state | P0 | — |
| [#9](https://github.com/hoangnb24/meetless/issues/9) Làm rõ trạng thái lưu audio và kết quả Retry save | P0 | #8 |
| [#7](https://github.com/hoangnb24/meetless/issues/7) Chốt tài liệu V1: Stop chỉ lưu, Transcribe là thao tác riêng | P1 | — |
| [#10](https://github.com/hoangnb24/meetless/issues/10) Hoàn thiện thao tác Transcribe từ audio đã lưu đến transcript | P1 | #7, #8, #6 |
| [#11](https://github.com/hoangnb24/meetless/issues/11) Phân tích chi phí và chốt hạn mức Premium hàng tháng | P1 | — |
| [#12](https://github.com/hoangnb24/meetless/issues/12) Kiểm tra hạn mức trước upload và báo rõ khi không đủ cho recording | P1 | #7, #11, #10 |
| [#13](https://github.com/hoangnb24/meetless/issues/13) Kiểm chứng toàn bộ hành trình trên một bản MAS đã đóng gói | P1 | #9, #10 |
| [#14](https://github.com/hoangnb24/meetless/issues/14) Kiểm chứng mở lại app và second-instance handoff trong MAS | P2 | — |
| [#15](https://github.com/hoangnb24/meetless/issues/15) Hoàn tất kiểm chứng StoreKit, RevenueCat và billing cho phát hành MAS | P2 | #6, #12 |
| [#16](https://github.com/hoangnb24/meetless/issues/16) Hoàn tất cấu hình và kiểm chứng managed transcription production | P2 | #11, #12, #13, #15 |
| [#17](https://github.com/hoangnb24/meetless/issues/17) Chuẩn bị và duyệt phát hành Mac App Store | P2 | #13, #14, #15, #16 |
| [#5](https://github.com/hoangnb24/meetless/issues/5) Design the Meetless purchase presentation around Apple's system confirmation | P3 | #6 |

The owner selected #8. Other issues remain unassigned and are not opened by
this selection. #9 owns UI feedback polish and #6 owns Premium behavior.

## Reconciliation With The Previous Active Plan

- Recording/TCC/finalization obligations → #8 and #13, with recovery feedback #9.
  The host/helper permission boundary in ADR0004 stays authoritative.
- Purchase correctness and app-owned presentation → existing #6 and #5.
- Explicit managed transcription and follow-through → #7, #10, #12 and #13.
- Unresolved subscriber allowance → #11; no implicit production default.
- Packaged second-instance/relaunch → #14.
- Store/IAP/annual/trial/device/webhook acceptance → #15.
- Managed production region, configuration, lifecycle/cleanup/latency → #16.
- Store metadata, legal/licenses, clean-install/update and publication → #17.
- Accepted startup/build foundations stay evidence to reuse, not tasks to
  rebuild. Historical candidate acceptance does not prove the new artifact.
- Superseded direct-DMG notarization remains historical, not a MAS prerequisite.

## Risks And Recovery

Existing working-tree code and untracked files predate this planning pass;
none were reset, committed, deleted or accepted by the planning pass. Issue #8
source acceptance is limited to the exact candidate below. Preserve recordings and application
state. Do not use old live-process, ownership, transaction or package assertions
as current truth; revalidate the selected run through its repository runbook.

The old plan is preserved byte-for-byte in
[the superseded execution snapshot](../history/v1-paseo-foundation-through-2026-09-12.md).
Its SHA-256 is `d752e437acf3df5c9ca0005124872cb1401216d5caa94b566be11e83d0f75229`.
It contains historical incomplete work and is deliberately not labeled Completed.
The earlier [MAS UI history](../completed/v1-paseo-foundation-mas-ui-history.md)
also remains available. To inspect or recover old wording, use the snapshot;
do not restore obsolete active instructions over the current issue #8 scope.

## Planning Validation

Planning validation passed on 2026-09-12: all 13 issues are open and present
in the repository-linked project, with Priority/Area/Readiness and Todo fields
verified by API readback. All 20 native blocked-by links match the intended
acyclic graph. The V1 priorities table exposes the classification fields.
The archived plan matches its original SHA-256; local navigation links and
`git diff --check -- docs/plans` pass. No product acceptance is implied by
these planning checks.

Issue #8 must retain behavior-level proof on the exact MAS artifact and actual
producer/consumer. Apply
[production evidence](../../patterns/production-evidence.md) where relevant.
Fixtures can support a regression but cannot establish the real user journey.

## Issue #8 Execution

Owner selected issue #8 after reviewing its expected behavior and real-MAS
validation route. Read `~/.WORKSPACE.md` (explicitly requested), repository
workflow, workspace protocol and production-evidence pattern. This scope opens
routine investigation, bounded repair, relevant build/package/live validation
and tracker updates needed for #8; no purchase/transcription/provider spend or
user-data deletion is included.

Coordination: root owns the plan, diagnosis, production verification and final
acceptance. `issue8_implementation` owns source repair; `issue8_review` independently
reviewed its exact result. Documentation updates are delegated separately. Other
issues have not started.

- [x] Read current issue, authorities and inspect ownership/working-tree state.
- [x] Identify the media-tool routing defect in source → package → live consumer.
- [x] Bind a failing observation to the current artifact and preserve data.
- [x] Delegate one bounded implementation with production-faithful proof design.
- [x] Independently review exact source candidate and focused validation.
- [x] Build Meetless and complete the root full build.
- [ ] Package/signature-validate and preserve the exact MAS candidate.
- [ ] Validate Stop/save, retained-recording Retry, playback and relaunch on MAS.
- [ ] Integrate only accepted scope, publish evidence and update issue/project.

Important discovery before execution: `dev:mas fresh` currently recursively
resets the canonical runtime. Do not run it for #8 because existing recordings
must be preserved. Inspect the established preserving coordinator/installation
route; package building alone is separable from runtime reset. Root is stopping
the baseline app before any future preserving install; install/launch success
for the new candidate has not been established.


### Baseline And Implementation Brief

Root reproduced Retry through the installed Electron UI on 2026-09-12 at
14:34:25 local; host-runtime log reports spawn EPERM, with unchanged recoverable
recording and no finalization intent/output. Live plugin environment resolves
both tools to the writable runtime `media-tools/bin`, while source and installed
`packagedMediaTools` unconditionally snapshot media for every packaged target.
The first finalizer subprocess is ffmpeg. ADR0005:190–198 requires in-bundle
MAS execution with full closure validation; direct-DMG snapshot remains valid.
The signed bundle's ffmpeg has child sandbox/inherit entitlements.

Baseline host SHA-256:
`25f3ab312d0911f4840043a9ff640e080de42fcd087f984c3b386eddf4d2321c`.
Baseline manifest SHA-256:
`81fd2e74392e11d1abe3b5fac0317089624c7ade88083edef71e3b30890505c9`.
Source config SHA-256 before worker edits:
`da73166ce9136e0176c24935b2bde4ab998ba0d938394cd13bb8d000624cb731`.

Private, ignored evidence is in
`.artifacts/macos-mas-development/issue-8/baseline/`: original MeetingStore
copy (74 files), byte inventory, artifact/state summary, before/after logs and
Retry UI screenshot. Existing record retains 72 chunks (36 microphone and 36
system). Raw logs/media remain local; do not publish them to GitHub.

Implementation owner: `issue8_implementation`, exclusively runtime config and
media-closure/config tests. It must retain contract-derived MAS identity, select
and validate the signed bundle closure before any snapshot lifecycle, preserve
existing container media, and keep direct-DMG behavior. Root owns artifact work.
The focused proof must exercise actual resolveRuntimeConfig → prepareRuntime,
positive in-bundle/no-copy and preserved old snapshot, missing/escaping closure
rejection, and direct-DMG snapshot regression. No UI polish or new topology.

### Accepted Source And Pending MAS Proof

Independent reviewer `issue8_review`: **Đạt**, no source blockers. Root
**ACCEPTS source only** for the following SHA-256 identities:

- Runtime config: `7d213be76b7c7ddb39947834276b74411357d9abc91581a67cfb1051e55e445a`.
- Media-closure test: `7b375dc9ac6fc44ce54d49f530e62f6b5a5660bb23135aabc21251142c88b2ad`.
- Patch: `2b570bbfa7576780f1eefd1f01e62e640862854606c4e86164e0c4f7ac42a4ef`.

Regression proof: three failures before the repair; 36/36 config and
media-closure tests pass afterward. `build:meetless` and root `npm run build`
passed; full-build evidence is
`.artifacts/macos-mas-development/issue-8/build.log`. These checks do not
establish installed MAS behavior or production acceptance.

Packaging/signature validation passed through the actual producer, in scratch
and again after retaining the candidate in a unique ignored durable directory.
Manifest SHA-256: `368aae572b03818e0428f68305bde9be919a8efbd539251e5f2ae726b1756c65`.
Artifact: `.artifacts/macos-mas-development/issue-8/meetless-mas-issue8-BjywU8/release/macos/Meetless.app`.
Independent source and packaged-artifact reviews passed.

### Live Result And Acceptance Limit — 2026-09-12

The public preserving coordinator installed the exact candidate after stopping
the baseline host. It quarantined the complete original runtime and retained the
original package. Run ID: `6b441b4b-a3bf-4646-a9e7-819d4254c095`.
The real MeetingStore/export input was independently byte-copied under lock into
the fresh test runtime; no hardlinks, identity or transaction records were copied.
Original inputs remained unchanged.

The launch gate **FAILED** host-handoff binding within its five-second window.
Native nevertheless claimed the real handoff and became ready. A later strict
package-proof read also **FAILED** because native identity republication changed
its inode. These failures remain separate; root did not alter a guard, journal,
identity, or fabricate package proof. Exact installed executable/config/media
hashes, deep signature verification, process ancestry and live plugin environment
independently bound the running consumer to the reviewed candidate. Both media
executables were selected from the installed signed bundle.

Observed through the actual UI and durable store:

- Retry of copied recording `13e7b22c-c840-4c87-9f54-453007750a08` saved
  208,881 bytes, SHA-256 `bfffd93105264c2df3c3fa84b0c4754c78487cfb6b34f8f41061baf317f1577b`.
- Fresh native microphone + system recording
  `6a4d5d3d-a5dc-4e66-9c2f-ff966f034170` stopped and saved 215,865 bytes,
  SHA-256 `d9e705fae3aa4163baee83a15c49ec6a25035c76b0e8da4e8185965a3ad7b432`.
  Each source had nonzero captured samples. Separate filenames preserved the
  earlier output. Both recordings reached durable `saved` with matching hashes.
- Screenshots show Audio saved locally and no Retry-save button. The stale
  generic needs-attention and Processing-audio labels remain findings for #9.
- OS `afinfo` read both MP3s; `afconvert` decoded the new MP3 to 602,496 frames
  at 16 kHz; `afplay` played it with exit 0. This does not prove subjective
  intelligibility of each source or playback through the app after restart.
- An extra direct-shell bundled-ffprobe inspection **FAILED** with SIGTRAP;
  it was outside the native sandbox inheritance path and is not counted as a
  successful product-consumer check. The actual finalizer verification passed.

Independent final review: **Đạt có giới hạn**. Root **ACCEPTS** the exact source
repair and bounded live Retry/Stop result, but **does not accept full issue #8
completion**. Relaunch/persistence and playback after restart remain unproven;
the coordinator launch failure is not waived. No cloud transcription was
requested; absence of upload is not established by these logs alone.

Private evidence stays in `.artifacts/macos-mas-development/issue-8/`, including
`source-candidate.json`, `production-input-copy.json`,
`independent-live-binding.json`, `meetings-after-stop.json`,
`saved-audio-proof.json`, `fresh-capture-levels.json`, screenshots, decode result,
and original/candidate logs. Do not publish captured audio or private runtime
records to GitHub. Fixture/local checks passed; CI/branch protection unverified.

Source-only commit: `a558e3e` (`fix(runtime): execute MAS media tools from signed bundle`),
exactly the two reviewed files; unrelated existing changes remain untouched.
The commit has not been pushed and does not assert full issue acceptance.

### Recovery Blocker — Preserve Current State

Public restore stopped the owned candidate host and restored the original package
before restoring the original runtime. Original host SHA-256 is again
`25f3ab312d0911f4840043a9ff640e080de42fcd087f984c3b386eddf4d2321c`.
Independent reviewer compared the entire restored runtime aggregate with the
pre-test attestation: exact match, digest
`083acf06c75d6f640700315ddb0bfd365dab464a3b744ce7dbe2cd6fd5ef055b`.
Root also matched every original MeetingStore/export entry against the pre-test
copy inventory. Test MP3s and evidence remain separately retained.

Restore **FAILED** at archive with a live-runtime observation; subsequent actual
inspection returned explicit absence (no processes/listeners/sockets/open handles).
Do not infer the transient observation's cause. Current transaction phase is
`restored`, package state `identity-restored`. Public status now **FAILS** because
package recovery expects identity absence although the canonical runtime correctly
contains the restored original identity. Original app is stopped; normal relaunch
has not been attempted while the active test transaction remains incomplete.

No supported public resume route passed. The transaction-only archive primitive
would bypass the required coordinator package-first route (`scripts/macos-mas-gate-session.mjs:18–19`)
and was not invoked. No guard, journal, identity, root or attestation was changed
to make recovery pass. Do not reset runtime, reinstall, repeat the known-failing
recovery loop, reuse the consumed handoff, or claim cleanup complete.

Required next decision: authorize a bounded correction at the coordinator's
already-restored runtime/package proof composition, with independent review and
real recovery proof, so it can finish the preserved session without weakening
identity/attestation validation. This is a separate scope from the media routing
repair; stop under repository guidance for difficult recovery. Then establish a
valid persistence/relaunch path for #8. Keep #8 open; #14 owns broader launch work.
No broader transaction-framework changes have been made.

## Final Acceptance Addendum — 2026-09-12

The owner explicitly authorized ad hoc disposition to finish #8. The reviewed
one-time script retained the original whole runtime, old app, old current artifact
and exactly five legacy session siblings, keeping the stable lock and canonical
meeting data. It did not delete state, edit journals/identity or alter the engine.
The exact previously reviewed candidate passed full artifact validation, signature
and fingerprint checks, then used ordinary startup with no active session.

Retained runtime/session directory:
`~/Library/Containers/com.meetless.app/Data/Library/Application Support/meetless-issue8-retained-6b441b4b-a3bf-4646-a9e7-819d4254c095`.
Original app: `/Applications/.meetless-issue8-retained-6b441b4b-a3bf-4646-a9e7-819d4254c095/Meetless.app`.
Prior current artifact: `.artifacts/macos-mas-development/issue-8/previous-current-before-ad-hoc`.
These remain private retained evidence, not disposable cleanup targets.

Actual original Retry and fresh mic+system Stop both reached saved in the ordinary
runtime. Full owned-host stop passed absence, then ordinary relaunch changed host
PID 96920 to 97356 on the same canonical runtime inode 51230577. Whole MeetingStore
remained identical, UI listed both recordings and opened the new one with no Retry
save. OS `afinfo` and `afconvert` read both actual outputs after restart; `afplay`
played the new output with exit 0. No cloud or new player UI was required for #8.

- Recording `13e7b22c-c840-4c87-9f54-453007750a08`: 208881 bytes, SHA-256 `bfffd93105264c2df3c3fa84b0c4754c78487cfb6b34f8f41061baf317f1577b`, saved before and after restart.
- Recording `3a362932-04b2-40fd-b1a7-a3cda5c2c461`: 142713 bytes, SHA-256 `dfd6b03de20d3d3dc22694de2fce998f149969f8603693dee2ba8e1d1ec3d7c7`, saved before and after restart.

Independent final review: **Đạt** against actual issue #8 criteria. Lead **ACCEPTS**
source `a558e3e` and the exact MAS artifact for issue #8 completion. Stale generic
needs-attention/Processing-audio UI stays with #9; reboot, second-instance and
citation-player acceptance remain separate scopes. Earlier failed gate/probe
attempts above are not relabeled successful.

Evidence: `ad-hoc-result.json`, `ordinary-live-binding-1.json`,
`ordinary-launch-1.json`, `ordinary-stop-runtime.json`, `ordinary-launch-2.json`,
`ordinary-before-restart.json`, `ordinary-after-restart.json`,
`restart-persistence-proof.json`, `after-restart-playback.json`,
`ordinary-capture-levels.json`, screenshots and actual MP3s, all under the private
ignored issue-8 artifact directory. No new product code beyond `a558e3e`.

Closeout: `a558e3e` pushed to main; issue #8 closed as completed, Project Done.
Issue #9 retains the UI finding and awaits owner selection; no other issue started.
