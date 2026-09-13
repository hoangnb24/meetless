# Execution Plan: Meetless V1

Updated: 2026-09-13

## Current Work

2026-09-12 continuation: the owner authorized implementation starting with #9,
then continued processing of ready issues within accepted product decisions.
Root remains orchestrator; implementation and independent acceptance have
separate owners. Stop dependent work for a real blocker or an unmade product
choice; continue safe independent preparation. Existing dirty changes must be
preserved, and accepted deltas integrated separately.

### Current execution

- **#13 provider configuration decision — 2026-09-13:** owner corrects the
  proposed separate-login direction: Meetless must reuse existing coding-agent
  config/auth from the real user's home using the lookup paths and overrides
  already supported by Paseo, including on first installation/new machines.
  Accepted behavior is recorded in `docs/product/knowledge-and-citations.md`.
  This supersedes the dedicated-login proposal below; it is not authority to
  copy credentials, disable App Sandbox, or relocate Meetless/Paseo app state.
  Read-only inspection finds actual MAS parent/child entitlements have no
  external user-selected-file access and the native host has no bookmark/open
  panel route. Paseo provider env overlays exist, but `prepareRuntime` currently
  writes daemon config without a provider block. A path-only patch cannot prove
  access and is not being shipped as a fix.
  Concrete proposed MAS interaction: when Ask needs an existing provider's
  configuration outside the sandbox, explain the folder access needed, use the
  system folder chooser, preserve the grant with a security-scoped bookmark,
  and offer recovery when access is denied/revoked. Do not require a new provider
  login solely because the container has no auth file. This permission UI and
  its entitlements require the owner security/UX decision before implementation;
  no new provider request, credential action or app update was performed.

- **#13 Ask-focused continuation — 2026-09-13:** owner reports recording,
  Apple actions and audio checks previously satisfactory and authorizes starting
  with Ask using the existing transcribed meeting named Test. Root owns actual
  GUI execution/evidence; `ask_diagnosis` implemented the bounded source fix
  and completed read-only authentication diagnosis.
  Use the ready Test dated 2026-09-12 23:40 (the older Test is not ready).
  Scope is Ask → cited answer → citation playback and durable chat checks using
  the existing configured provider. No new recording/transcription/purchase is
  needed. This supersedes the earlier preparation-only restriction for this
  bounded Ask run, but does not claim the entire same-candidate journey passed.
  Before correction, installed inputs matched prior accepted manifest `826f9b2e`;
  33 local store/audio files were baselined in `.artifacts/issue13/ask-live/`.
  Selecting Codex GPT-5.6-Luna failed before a question was submitted: the
  provider feature check required the not-yet-created `chat-execution` directory
  (actual daemon ENOENT). At that point no inference or transcription request
  had been sent. Project #13 is now In Progress / Awaiting owner for the
  authentication decision below, not blocked by the completed #9/#10 inputs.
  Source `fa25aa5f` (SHA-256 prefix) is independently accepted; four fresh-root
  regression cases failed before the fix, 25 chat-service tests and typecheck
  passed after it. Full preserving update exited 0 on manifest `8bcfc899`;
  installed source matches, all 33 existing store/audio files were unchanged.
  Independent reviewer/Lead ACCEPTS actual model-selection fix only: selecting
  Luna succeeds and persists. One authorized Ask then failed definitively with
  HTTP 401 (missing authentication) after 18.366 seconds; no transcript segments
  were retrieved and no answer is claimed. The failed question survived switching
  meetings and returning to Test within the same app process, without appearing
  in the other Test. This is not relaunch proof. Root has not retried.
  Read-only auth diagnosis confirms a separate container Codex home without
  auth/config files, while ordinary Codex has ChatGPT auth metadata. No verified
  MAS provider-login/credential bridge exists in the relevant repository path;
  do not copy tokens or assume an ordinary shell login fixes the app. Proposed
  next work is dedicated provider sign-in for Meetless, pending owner product
  decision. Source fix committed as `56e73b1`. [Validation record](../history/issue-13-ask-validation-2026-09-13.md)
  records independent/Lead acceptance of selection only and the open Ask gate.

- **#7 complete:** product decisions promoted in `678c527`, independently
  accepted, pushed, issue closed and Project Done.
- **#9 complete:** source `8aadef0` plus corrections `6eaa779`; independent actual
  MAS review and Lead **ACCEPTS** exact manifest
  `6dde5d9ce4da9cf788fd91f2ba267d96ef506c75e5981890ec659e537f0a7b97`.
  Stop success, failed save, repeated Retry failure/success, duplicate suppression,
  readable details, truthful selected-recording status and persistence passed.
  Issue closed, Project Done. [Validation record](../history/issue-9-feedback-validation-2026-09-12.md)
  is committed/pushed as `0a15406`; it retains earlier failures and claim limits.
- **Preserving MAS update accepted:** `e33aa3b` adds the route; `b80cd1c` avoids
  prebuild ESM cache by probing with a fresh installed-client process. The full
  corrected build/sign/install/readiness run passed on the same `6dde...`
  artifact. Independent review and Lead ACCEPTS that bounded route. Earlier
  canceled/failed runs remain failed; no data reset or admin elevation occurred
  in the accepted update.
- **#6 accepted:** source `58d931a` and `487d277` plus exact MAS manifest
  `a3cca1f00f863ee652befbd69760d7c33fd74cef02e8f247170b0265adfc7d27`.
  Independent review and Lead ACCEPTS AC 1–8 in the monthly Sandbox scope.
  Owner purchase automatically active after 41.083 seconds with all eight
  categorical stages once; explicit Restore active after 16.047 seconds;
  relaunch active with zero new purchase/Restore dispatch. Seven recordings and
  all 29 store/audio files unchanged. No automatic Transcribe.
  [Validation record](../history/issue-6-premium-validation-2026-09-12.md)
  distinguishes focused proof, seven baseline native failures, retained earlier
  failures, source/actual artifact provenance and annual/production limits.
  Validation commit `49fe133` is pushed; issue closed and Project Done.
- **#11 complete:** owner approved 8 hours/month (28,800 seconds) for both
  paid plans; independently reviewed policy-only commit `57ca751` is pushed.
  Reviewed analysis, sources/scenarios and recorded owner decision satisfy #11
  acceptance. Lead ACCEPTS; issue closed and Project Done. Prices/trial/monthly
  allocation/no-rollover/no-reset rules remain. Production configuration and
  deployment are NOT applied; #16 explicitly owns that later acceptance.
- **#14 partially tested, awaiting owner availability:** normal second launch
  retained one host/daemon/listener and one observed window; quit/relaunch
  preserved data. Tool actions did not establish a background-to-foreground
  transition, so focus remains unproven. Reboot remains unattempted and needs
  owner timing/login. Do not fix code without an observed product failure or
  substitute relaunch for reboot. Issue stays open/Awaiting owner.
- **#10 complete:** independent reviewer and Lead ACCEPTS actual MAS manifest
  `ceef000ec9bc876dbce2cee79accc45aff628523cb40c8978a6d515832616e44`.
  Owner Monthly Sandbox + explicit same-Test Retry produced a readable local
  transcript in 9.383 seconds. Server-proven corrupt upload recovered through
  exactly one successor; one job/one charge of 23 seconds. Ordinary relaunch
  preserves transcript and eight audio files with no new upload/provider work
  or charge. Adverse-path guarantees retain their automated source/localhost
  evidence level; no actual double-click or induced network/provider failure
  is claimed. [Validation record](../history/issue-10-transcription-validation-2026-09-13.md).
- **Owner scope split after #12 validation — 2026-09-13:** owner explicitly
  closes #12 for accepted implementation and recorded evidence; remaining
  real quota validation moves to native sub-issue [#19](https://github.com/hoangnb24/meetless/issues/19),
  P2 / Todo / Later, for possible owner-led use in real situations. This is a
  scope decision, not a pass for the failed hosted attempt or signed quota UI.
  #15/#16 retain acceptance dependency on #19; preparation can continue.
  #12 is CLOSED and its Project item Done. Earlier OPEN statements below and
  in immutable validation records describe the evidence stage before this
  decision. See [owner handoff](../history/issue-12-owner-validation-handoff-2026-09-13.md).
  No P0 remains open. #13 (P1) is next; concrete preparation is in
  `.artifacts/issue13/READINESS.md` and its issue body. Owner Apple/audio/service
  actions remain pending; no new runtime or provider operation was performed.
  Updating #13 Project status/readiness returned GitHub server errors; issue
  body and this plan record the preparation, while Project fields need resync.
- **#12 core source/local validation accepted:** Lead and independent reviewer
  accept exact v3; source commit `02171f92b11a0be50bd8f5e0e8d3ef1dec0c369a`
  is pushed. Sixteen indexed source/test blobs match the frozen candidate.
  170 tests, isolated plugin/backend type builds, actual localhost Convex quota
  arbitration/settlement, and pinned compiler output/graph proof passed.
  Preflight and atomic seal use the same strict quota feedback contract; restart
  preserves a denial, while validated completed-result recovery clears stale
  quota feedback without fresh provider work. Quota-only transport renewal
  requires full old cleanup and no job; one corruption repair remains the bound
  across the entire logical lineage. Terminal jobs retain their existing TTL.
  [Core validation record](../history/issue-12-quota-core-validation-2026-09-13.md).
  This is not full #12 or production acceptance. Source ownership is released;
  no deployment, MAS update, provider call, or retention change was performed.
- **#12 local retention decision accepted — 2026-09-13:** the owner explicitly
  requires both saved MP3 and canonical WAV for every retained recording,
  including after successful transcription. They are removed only with user
  recording/meeting deletion. Policy `d41d6d5` is independently reviewed and
  pushed; this supersedes the earlier local-WAV 24-hour rule and the narrower
  quota-only proposal. Backend temporary TTL and existing job/billing rules
  remain unchanged. No new automatic rerun or transcript-overwrite flow is
  implied by retaining source audio.
  Source/local retention is independently reviewed and Lead ACCEPTS at pushed
  `560b408`: 85 tests of current candidate behavior, plugin typecheck, pinned
  compiler proof and three intended before-change failures. Scope includes retained
  handles, valid legacy metadata migration without changing WAV bytes, retained
  directory protection during sweep, and deletion via trusted recording IDs
  even when metadata is missing/corrupt. Previously deleted WAV bytes cannot be
  reconstructed from MP3. Read-only inventory found all 8 saved MP3s and 7
  canonical WAVs intact; the earlier successful Test recording already lacks
  its canonical WAV and metadata. No app update/deployment is authorized by
  source GO alone.
  `mas_update_path` owns the separately authorized preserving MAS update and
  retention-only actual proof. Signed manifest `d6988a77` installed and passed
  independent review/Lead acceptance for old audio/data preservation, seven
  valid V2→V3 migrations, new UI Record/Stop, actual quit/relaunch and installed
  client/server deletion of only the new owned recording. GUI Delete remained
  disabled for idle saved/untranscribed meetings and is not accepted.
  The bounded existing-policy correction is accepted and pushed at `61b0a83`:
  remove the broad parent `processing` guard while preserving actual active-work
  guards. 56 tests, types and actual Expo export passed. Signed follow-up
  manifest `826f9b2e` is independently reviewed and Lead ACCEPTS: actual GUI
  Delete enabled, named confirmation, Cancel preserving data, Confirm removing
  only the new meeting/audio pair and clearing selection. All old data remains
  unchanged; this closes the first run’s GUI finding. Proof
  remains limited to a new owned recording and preservation of old audio/data,
  without transcription/provider/purchase/account changes.
  Full #12 still needs hosted/backend and actual consumer validation. Hosted
  preparation remains read-only: a synthetic account is an explicit test
  dependency, and cleanup must safely cover failed-enrollment challenges,
  unregistered blobs and account-unscoped reconciliation. Existing platform
  maintenance contracts are pinned in `.artifacts/issue12/hosted-prep/`; an
  executable guarded proposal is being prepared without hosted calls.
  Cleanup correction `eaf7844` is independently reviewed, Lead ACCEPTS and
  pushed: 30 tests and backend typecheck passed. Absent uploads return before
  reconciliation; existing uploads reconcile only their trusted account, so a
  deleted fixture’s delayed callback cannot reconcile unrelated accounts.
  Backend candidate includes the shared quota source in its immutable closure;
  read-only preflight matches all 33 currently deployed modules to accepted #10.
  One guarded native development deployment and post-check passed; independent
  review and Lead ACCEPTS exact 33-module deployment identity at execution
  binding `6fcac37e`, with three intended module/map changes. Hosted behavior
  is not inferred from that identity check.
  Hosted proof is narrowed to preflight-only (2/3/4 seconds against a synthetic
  3-second period), with no audio POST/seal/provider; actual localhost proof
  separately covers concurrency/storage. Signed UI receiving a real quota
  denial remains unproven; no isolated signed-MAS auth route is established.
  One authorized hosted attempt stopped after a successful empty-delete probe
  and an uncertain challenge-creation HTTP failure: no returned challenge ID,
  session or quota denial. Two complete scoped audits observed zero rows but
  cannot establish request quiescence. Lead stopped dependent hosted execution;
  no retry or cleanup mutation followed. The journal and failed attempt are
  preserved in `.artifacts/issue12/hosted-prep/`. Local transport/status
  corrections remain future-review material, not successful hosted evidence.
  No global environment/provider or owner-account mutation is authorized.
  [Durable validation record](../history/issue-12-retention-validation-2026-09-13.md)
  is independently reviewed and pushed at `0caadd4`; full #12 remains OPEN.
- **#18 complete — development updater defect discovered during #6:** ordinary full update
  FAILED on the root-owned Apple receipt; rollback repeated recursive removal
  and failed. Separately reviewed recovery PASSED by retaining the partial app
  and installing the verified new staging under the stable lock. The original
  receipt, old app staging, backup `backup-4Hxp0H`, runtime and recordings remain
  intact. Recovery does not establish an ordinary updater pass. Correct the
  replacement/rollback route before another ordinary update; no permission
  changes, runtime reset or receipt manipulation is authorized.

The bounded #18 correction is independently accepted and pushed as `afeca3c`.
Twenty focused tests pass; actual documented `dev:mas:update -- --reuse-current`
on exact `a3cca...` passed with a real root-owned receipt in the canonical app.
The old whole app/receipt inode, seven recordings, 29 store/audio files and
runtime/lock identities were preserved. Validation record `07c1e34` is pushed;
issue closed and Project Done. Earlier full-update failure and emergency
recovery remain separate outcomes.

### #10 implementation ownership and next proof

The execution entries below through the previous accepted handoff are retained
history. Their pending actions and issue states are superseded by Current
execution above; they are not instructions to resume earlier attempts.

`issue9_impl` is sole source writer after the #18 runtime handoff, based on
HEAD `07c1e34`. `issue9_review` owns independent review. Scope is the minimal
contracts/client, plugin contribution/server/coordinator and necessary managed
polling/publication hunks, App/surface and direct tests. Preserve existing dirty
work and adopt only the relevant previously dirty feature pieces into the
reviewed HEAD candidate. No default backend/native/packaging/config changes.

Source candidate v1 (`368ad4cbedff256225411e6d63d2d3cc62d51941b9ee7e0633b634ea35cf9c1e`)
has 277 passing focused working-tree checks and passing project/app typechecks
in a separate HEAD-plus-feature extraction. Independent review requires two UI
corrections before integration: connection errors must not hide a durable ready
transcript, and Stop-to-saved must refresh the selected recording so Transcribe
appears without reopening the meeting. The writer owns both fixes and candidate
v2 proof. V1 is retained and is not accepted for integration or app update.

V2 full patch `5affd0ec78b4ac7eb6d8d2a31804314315b4dd6e97cf5a83aad5334c23014007`
fixes both findings. Independent review and Lead ACCEPTS the exact 17-file
source candidate for integration: 280/280 tests on the isolated extraction,
project/app typechecks and pinned compiler positive/negative proof pass. The
104-input server graph resolves the candidate without root Meetless source.
Fixture Metro preview could not resolve its environment; failed logs are retained
and no visual pass is claimed. Actual installed MAS UI inspection remains
mandatory before the owner test; all actual transcription, publication, ledger
and persistence gates remain open. This is source acceptance, not #10 completion.
Exact source integrated/pushed as `c1ca6ce`. `issue9_live` now owns the full
preserving `dev:mas:update` build/install and read-only actual UI inspection.
Root source/build lease is frozen during that run. No automated capture,
Transcribe/consent or provider calls are authorized; the observer is still
prepared only and awaits the owner's new recording.

Read-only locked-development metadata confirms the 14 public entrypoint kinds
and argument schemas the client uses; all return schemas are `any`, so actual
responses remain unproven. Provider mode is `real` and the `OPENAI_API_KEY` name
exists; its value was not read. No functions/provider, environment mutation or
deployment was invoked. Evidence: `.artifacts/issue10/read-only/`.

Selected-meeting saved evidence must come from its authoritative owner. The
explicit Transcribe flow enters cloud disclosure/consent, preserves meeting
context across purchase/recovery, requires another explicit Transcribe after
purchase, and never starts upload/provider work due to Stop, previous consent,
Premium or relaunch. Polling may observe/publish an already-started job, but
must not create or resubmit work implicitly. Preserve existing whole-recording
allowance and user Retry/charge semantics; do not infer new retry policy.

Source proof and an exact preserved-data MAS candidate come before the owner
cloud gate. Historical authority permits a short **owner-operated** real-provider
test on the locked development target; it does not authorize automated cloud
consent or an OpenAI request. Native capture currently enables both microphone
and system audio, so agent-generated TTS would not by itself establish a
nonprivate recording. Once the artifact is ready, the owner should create a new
short recording from a supplied nonprivate sentence and perform the first
Transcribe action. Do not use the seven existing recordings or reset consent.
Previous app-level consent may make the first Transcribe click dispatch work,
so agent UI checks must not assume that click only opens disclosure.
Production allowance/deployment remains #16 scope.

The live evidence collector is prepared, not executed, at
`.artifacts/issue10/read-only/job-metadata-query.js`. After the owner's test it
will read only the exact new job/recording and return whitelisted status,
attempt/timing fields and actual `managedCharges` count/seconds. Client settle
invocation counts do not prove charge counts. Part `requestId` is the outgoing
client request identity, not an OpenAI response request ID. No account, token,
receipt, signed URL, audio or transcript contents are included in this collector.
Independent review identified that acknowledgement cleanup can remove part rows;
sample metadata as soon as the new job ID appears, without delaying cleanup.
The backend `providerInvocationCount` increments at claim before HTTP and is
reported as claimed executions, not proof of actual provider request count.

Full preserving update completed successfully on exact manifest
`206dd2a5248d784854958d28228e92e659b029d73c19774b207a285489618edf`.
Host `99282` is running; prior host `27841` is absent. All seven recordings,
29 store/audio files, runtime/lock identities and retained protected receipts
are preserved. Shipped plugin source and generated app/contracts/client bytes
match the accepted source/actual producer; surface is bundled in the app.
Actual saved-detail UI shows enabled Transcribe and Transcript not started;
no new job-start diagnostic was observed after launch/selection. This is log
evidence, not a backend-ledger query. Evidence: `.artifacts/issue10/live/`.
Independent review and Lead ACCEPTS owner-test readiness only; #10 stays open.
Premium currently shows purchase availability; active access and its cause are
not inferred. No capture, Transcribe/consent, Premium restore/refresh, observer
or provider call was performed during this update/UI check.

Runtime/build ownership is released, with no pending operation. Root owns the next explicit
runtime GO. Unrelated dirty source/docs must not be discarded or blindly staged.

Owner test resumed on 2026-09-13 with a new saved meeting named Test (distinct
from the older Test). Its first owner-selected Transcribe reached Premium
required. One status refresh remained inactive; one ordinary Restore completed
failed after 7.891 seconds because native verification obtained no eligible
signed current entitlement. A successful StoreKit callback diagnostic means no
callback error, not active entitlement. The bounded transcription observer saw
no job and issued no metadata query; audio was not submitted. The new recording
and seven older audio files remain preserved.

A separate read-only query on the locked development target selected exactly
one consumed device/key in the observed refresh time window. Its actual App
Store adapter monthly SANDBOX projection has stored principal state expired and
expiry 2026-09-12 23:08:09 +07 (last verified 23:06:23 +07). The lineage's stored
active label has the same past expiry and does not grant access. This is time
correlation, not cryptographic host binding or a fresh Apple-status lookup; no
cause for renewal ending is inferred. Independent diagnosis accepts this
interpretation. Evidence: `.artifacts/issue10/read-only/premium-projection-result.json`
and `.artifacts/issue10/live/owner-attempt-handback.md`. No new code defect is
established. Continuing requires an owner-operated new Sandbox purchase and
verified active Premium before the owner explicitly selects Transcribe again.
No automatic purchase, entitlement override or repeated Restore is authorized.

The owner completed a new Monthly purchase: UI active at 2026-09-13 09:39:49
+07, with all eight categorical stages. The stored new Sandbox expiry was
09:41:46 +07. A later Transcribe attempt was rejected; actual UI observed at
10:23 still showed Premium active in the sidebar while the detail said Premium
required. No exact click time is available, so this is not described as an
immediate post-purchase failure. A repeated read-only projection query confirms
stored expired access. No job or audio submission occurred.

The stale sidebar is a concrete #10 UI defect separate from expiry. Under
experience.md's inactive/unverified gate authority, `issue9_impl` owns only
App.tsx and direct App tests to reflect fresh managed gate results, retain
catalog/meeting context, distinguish unavailable verification from inactive
access, and reject stale responses after a newer Premium operation. No timers,
entitlement policy, implicit refresh/purchase/Restore/Transcribe or backend
changes are introduced. `issue9_review` independently reviews the frozen delta
before integration. Actual source/build remains on c1ca6ce/206dd2 until then.

For the next owner test, prepare the observer before purchase and have the owner
purchase and immediately select Transcribe in one flow. The former 180-second
total observer window was shorter than the observed 206-second purchase flow.
`issue9_live` owns task-local observer preparation for up to 15-minute log
observation with a separate 180-second/60-query metadata bound after a job
appears. This changes only test evidence collection, not application behavior.
Observer preparation is accepted with 36 local synthetic checks, including a
late job whose final acknowledgement metadata arrives after the log deadline.
`observer.mjs` SHA-256 is `8a0e9fba3623e609c4d7da13ae6138fd7551715a9a6f24746148a7aa3522b08a`;
no runtime/backend execution of this revision has occurred.

The stale-badge correction is independently reviewed and Lead ACCEPTS exact
two-file patch `0580541719791baa9411b324ce3c8f41a93070a8b8eb3657add8c372b92bfc39`.
The old behavior fails both targeted checks; all 92 App tests on the isolated
candidate and its app/dependency typechecks pass. It is integrated/pushed as
`ee6e848`. `issue9_live` now owns a full preserving MAS update, including all
eight current recordings and the owner's new Test; shipped source is frozen
during that run. No automatic purchase, capture or Transcribe is authorized.
Old artifact 206dd2's stale badge remains failed actual evidence; the new
candidate's actual UI and all transcription end-to-end gates remain pending.

The full preserving update passed on exact new manifest
`6fee9338e5075abb696aede28031d08c37ec7f4a94d1f11af23df565e1d66fff`.
Host 77072 replaces 99282; all eight saved recordings and 33 current data/audio
files remain unchanged, as do runtime/lock identities. The prior whole app and
its root-owned receipt (inode 52520358) are retained. Accepted source and actual
generated/installed files match. Actual new Test detail is readable with
Transcribe enabled and inactive Premium shown at startup; no job-start marker
was observed. This does not claim an actual active-to-expired gate transition
on the new artifact; that branch has focused proof only so far. Evidence is in
`.artifacts/issue10/premium-gate-update/`. Runtime/build ownership is released;
independent review and Lead ACCEPTS owner-test readiness only. The 15-minute
observer started at 2026-09-13 03:46:11.563 UTC and ends log observation at
04:01:11.563 UTC, bound to the new Test only. The owner now purchases Sandbox
Monthly and immediately selects Transcribe in one flow; the agent observes
only. #10 remains In Progress / Awaiting owner, with actual end-to-end proof open.

The owner completed the one-flow test. Premium became active at 03:54:39.983
UTC; upload began 29.626 seconds later and failed after 3.274 seconds. This is
not an expiry gate. Exact recording 74f4ef97-359d-4ed4-b238-5ae00fb55378 remains
saved. The observer retained durable_start/upload_requested/upload_failed,
then ended at its 15-minute bound without a job ID or provider dispatch marker.

Separate read-only backend evidence proves one upload session with the complete
722,178-byte part registered but still uploading and unadmitted. Function-log
evidence identifies sealUpload's stored-part digest mismatch at
managedTranscriptionActions.ts:48:45. Its immutable expected descriptor is not
the digest of received bytes. V2 of the sanitized function-log summary corrects
an initial parser error that treated null as an error string; both are retained.
No raw logs, audio, credentials or receipt contents are included in evidence.

`issue9_impl` reproduced the cause with the actual stream producer and synthetic
PCM, no network: a reused Buffer view is overwritten while the upload consumer
still holds earlier chunks. Cases below the 65,536-byte PCM boundary pass;
32,769 samples and the actual 361,067-sample size fail while lengths match.
Immutable chunk ownership is independently accepted and pushed as `f1b19e7`.
The exact isolated candidate passed 31 focused tests, dependency/plugin typechecks
and pinned compiler positive/negative proof. Both stream corruption regressions
failed before the fix. Backend digest validation remains unchanged. Installed
MAS `6fee...` does not yet contain this correction.

The registered corrupt session also needs recovery: existing Retry skips its
received part and repeats seal rejection; cancel/TTL alone cannot renew the key.
Independent review and Lead accept the bounded successor-session design under
existing explicit Retry/no-double-charge authority. Only explicit Retry may
request server verification of actual registered bytes. A proven mismatch before
any timeline job can atomically create one linked successor with the same
manifest, logical identity and original expiry. Duplicate requests return that
same successor; old requests and cleanup remain isolated by session ID. Current
ownership, cancellation, expiry, verified storage references, entitlement and
absence of every existing-job state must be rechecked at commit. Preserve
mismatch evidence after cleanup. Status, polling and relaunch never repair.
Source is now independently accepted and pushed as `e4ca5c3`, exactly nine
repair-only files over accepted baseline `f1043ee` (patch SHA-256
`41f795b3f88f18f715df3fd86c7dc1240ebc5ea1b678b84ca64f212784948700`).
Lead ACCEPTS source only: 42 plugin tests, 5 localhost actual-handler repair
tests and 17 actual-handler fixture guard cases pass, plus 2 unchanged untracked
localhost transition tests as supplemental proof. Three intended negative-before
failures, scoped typechecks and pinned compiler positive/negative proof pass.
The 104-input graph binds all changed plugin producers. Localhost charging proof
uses a fake provider; hosted/OpenAI/app outcomes remain unproven.
Unchanged test harness `1955c2f` was adopted separately for clean-checkout tests;
its installed local-backend executable prerequisite remains explicit. Exact
candidate, extraction, index, HEAD and working-tree blobs were checked.
Source writer is released. Evidence: `.artifacts/issue10/transport-repair/`.

Backend baseline provenance is now accepted independently and by Lead. At
2026-09-13 04:26:15.840 UTC, read-only native source retrieval from the locked
frugal-mandrill-646 development target matched all 33 remote module hashes.
Native bundling of the frozen local source reproduced every source/source-map
byte and environment, including schema and virtual config. Initial differences
were conclusively resolved as dependency path topology and virtual config path;
no normalization or ignored mismatch remains. Evidence:
`.artifacts/issue10/backend-baseline/PROOF.md`, final parity SHA-256
`75abc63dc7ad4563cd6a4e894aa1bb1dc3b3dc6a5128903cf2b6cb4f060b4112`.
This establishes current deployed code identity, not historical deployment,
environment values, schema/data state or production acceptance.

Lead ACCEPTS the separate six-file existing-deployed baseline sync `f1043ee`,
using only independently verified frozen index blobs. The moving working tree
and every unrelated dirty file remain preserved. The repair-only delta was
integrated separately against this baseline. No backend deployment, cleanup,
provider invocation or automated Retry occurred. The owner should not Retry
until both recovery and the updated MAS are accepted. #10 remains open/In
Progress; owner-test readiness is cleared.

### #10 guarded backend update and MAS preparation

Lead and independent review ACCEPT the private backend deployment candidate:
source manifest `bf0e034dd5786abec4501f75a4b7947c29e66324c6e8e31d4368fd78730e2c87`,
guard `7b706ce00e1875ee08501f83bdde7eefac3facec453af1594c8cb2b5ffb69289`.
Native bundle comparison changes only managedTranscription.js,
managedTranscriptionActions.js and schema.js; the remaining 30 modules retain
exact source/map/environment bytes. Private backend typecheck passes. The
explicit development selector, exact source/dependency hashes and file set,
cleared inherited overrides and fresh deployed-baseline comparison are checked
before native dev --once. No environment/provider policy change is included.
Root granted one guarded execution: native CLI exit 0/ready at 04:41:43 UTC.
Separate read-only verification at 04:41:52 matched all 33 candidate module
hashes/environments; source/dependency guards still pass. Lead independently
compared the remote hashes and ACCEPTS this bounded module deployment only.
Post-proof SHA-256 `93cd7438286785782234489b8314b583d2056a72895d6a187f886153a410f812`;
see `.artifacts/issue10/backend-deploy/EXECUTION.md`. No repair or provider call
was invoked; environment/configuration values were not changed.

Rollback to the old 33-module baseline is compatible only before any repaired
successor rows exist. After an owner Retry creates linked rows, use a compatible
forward correction; never blindly restore old schema/unique lookup or delete
rows to force rollback. Deployment itself does not create successor rows.

Read-only MAS preflight found eight saved recordings with unchanged audio and
no pending work. The correct current data baseline is now 34 files, including
the failed-upload journal; the earlier 33-file pre-test count is historical.
Actual installed app remains 6fee... and still lacks both upload corrections.
After backend handback, Root granted the full preserving MAS update to
`issue9_live`; all shipped source and HEAD are frozen at `e4ca5c3` during it.
No agent Retry, purchase, consent, capture or provider call is authorized.

### #10 corrected MAS ready for the same owner Test

Full preserving update passed on exact MAS manifest
`ceef000ec9bc876dbce2cee79accc45aff628523cb40c8978a6d515832616e44`:
exit 0, eight meetings ready, new host 50903, strict installed signatures pass.
All 34 store/audio files and pending journal remain byte-identical. Reviewer
independently matched all 104 installed compiler input hashes to the accepted
candidate; Root inspected actual Test UI with saved audio and Retry available.
V2 diagnostic evidence uses current stages and proves zero new transcription
markers within the update/selection log window; legacy-marker V1 is retained.

Receipt metadata changed before backup/rename (04:50:46 vs 04:54:45/04:55:03
UTC); retained whole app inode is unchanged. No actor or earliest receipt inode
preservation is claimed. Optional external-Node installed compiler probe failed
SIGTRAP at sandbox initialization and produced no bundle; it was not retried.
Installed source/producer identity and working signed-app consumer are proven;
live in-memory compiled bundle is not captured. Both limits remain in
`.artifacts/issue10/transport-repair-update/HANDOFF.md`.

Independent review and Lead ACCEPTS owner-test readiness only; source/build
ownership is released. Root authorized the unchanged 15-minute observer with a
fresh baseline for the same Test 74f4ef97-359d-4ed4-b238-5ae00fb55378. The owner
purchases Monthly Sandbox, waits for Premium active, then immediately selects
Retry transcription without returning to chat between steps. No new recording
is needed. Actual repair/real provider/local publication/charge/persistence
remain pending; #10 is open/In Progress/Awaiting owner.

### Previous accepted handoff

Issue #8 implementation and acceptance are complete: `a558e3e` fixes MAS media
execution, and actual Retry, fresh Stop, full runtime restart, saved-state
persistence and OS playback passed independent review. Lead **ACCEPTS** issue #8
on the exact artifact recorded below. The fixed app is installed and running.
The one-time legacy session disposition is complete; original data and prior
artifacts were retained without deletion. Source `a558e3e` is pushed to main; GitHub issue #8 is closed and its Project
item is Done. #9 is Todo / Awaiting owner after its prerequisite completed.

Use the [short MAS development loop](../../macos-development.md) for ordinary
development. The issue #8 ad hoc operation is historical evidence, not a new
workflow or a reason to extend the recovery engine.

- Repository: policy, code, evidence and this current handoff.
- [GitHub Project](https://github.com/users/hoangnb24/projects/1): status,
  priorities and dependencies. The current execution above supersedes prior awaiting-selection status.
- #9 owns stale saved-audio feedback; #14 owns broader launch/reboot behavior.
- Existing unrelated working-tree changes remain outside this task.

## Outcome

Make one coherent MAS journey reliable: record → Stop → audio saved locally →
explicit Transcribe → readable local transcript → meeting-scoped Ask and cited
playback. Buying Premium updates access automatically, but never starts or
resumes transcription. Store distribution and managed-production readiness
remain distinct later acceptance gates.

## Confirmed Product Decisions

The following decisions were explicitly accepted by the owner in this
conversation on 2026-09-12. They override conflicting automatic-transcription
wording in older documents; issue #7 has promoted them into the product and
decision documents in commit `678c527`. Runtime acceptance remains issue-specific.

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
6. Owner approved the reviewed recommendation on 2026-09-12: 8 hours/month
   for both paid plans. Annual allocation remains monthly; existing no-rollover
   and no-reset-on-restore rules remain. Intended prices and trial 7 days/5 hours
   are unchanged. Production configuration must follow this authority; test
   allowance is not a substitute for it.

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

The owner selected and completed #8, then authorized the continuation recorded
above. #9 owns UI feedback and #6 owns Premium behavior.

## Issue #8: Accepted Result

- Source: `a558e3e`, runtime config and media-closure regression tests only.
  MAS selects the signed in-bundle tools; direct-DMG snapshots are unchanged.
- Before: the identified installed MAS app reproduced `spawn EPERM` through
  Retry with tools selected from the writable container. Three regression tests
  failed before the source fix. After: 36/36 focused tests and full build passed.
- Exact candidate manifest SHA-256:
  `368aae572b03818e0428f68305bde9be919a8efbd539251e5f2ae726b1756c65`.
  Full artifact validation, installed signatures and source/installed fingerprints
  passed. Current durable artifact is `.artifacts/macos-mas-development/current`.
- Native MAS Retry saved the original recoverable recording; fresh microphone +
  system capture Stop saved a separate readable MP3. No Retry-save button remains.
- Full owned-host stop proved absence; ordinary relaunch created a new host on
  the same runtime inode. Whole MeetingStore and both saved file hashes remained
  unchanged. Both MP3s decoded, and the new one played with macOS `afplay` after
  restart (exit 0). UI reopened the saved meeting; no transcription was requested.
- Independent reviewer and Lead accept the actual #8 completion criteria.
  This does not claim subjective audio intelligibility, citation-player behavior,
  reboot/second-instance coverage, billing or release acceptance.

### Ad Hoc Disposition Completed

The owner authorized a one-time data-preserving disposition after the legacy
coordinator became stuck. Under the stable lock and fresh absence proof, root
verified the original runtime attestation and retained a byte-checked full backup.
Exactly five legacy session records were moved together into a named retained
directory. The original package and prior current artifact were also retained.
No data, journal or identity was deleted or edited to force success.

The exact reviewed candidate replaced the old app while canonical data remained
unchanged. Ordinary native startup refreshed its identity through the existing
same-bundle/path/designated-requirement rule. No coordinator/framework code changed.
Historical launch, archive and direct-shell-probe failures remain failed evidence;
the ad hoc disposition does not retroactively make those gates pass.

Evidence and retained locations are recorded in
[the issue #8 validation record](../history/issue-8-save-validation-2026-09-12.md).
Private audio/logs stay in `.artifacts/macos-mas-development/issue-8/` and are not
uploaded. Keep backups until separate cleanup is authorized. Local validation
passed; no CI/branch-protection enforcement is claimed.

## Documentation Cleanup — Completed 2026-09-12

The accepted simple development route is now in ADR0005 and the short guide,
linked from the documentation and decision indexes. Long legacy operating steps
and obsolete execution briefs were removed from current guidance; evidence stays
in clearly marked history. This plan keeps only current decisions, results and
remaining work.

Independent review accepted the docs against actual command behavior. Local links
across eight documentation files and `git diff --check` passed; the original
historical snapshot is unchanged. Lead accepts this documentation cleanup only.
No application code, installed state, release validation or data retention
behavior changed. The later ad hoc disposition is recorded above.
