# Execution Plan: Issue 19 subscription and quota reconciliation

Date: 2026-09-13

## Status

Complete for the implemented development recovery scope. Reviewed, deployed,
installed, and accepted by the owner after the requested sandbox retry.
Background verification and ambiguous cross-product lapse handling remain
explicit limitations, not completed capabilities.

## Outcome

A verified purchase or refreshed Apple subscription updates Premium access and
the applicable quota period consistently. Same-period replay preserves usage;
a verified new period receives one allowance; stale evidence cannot roll back
newer state. Explicit Transcribe can recover without another purchase.

## Authority and context

- Owner approved implementing the shared reconciliation path after the real
  retry at 20:49:36 +07 confirmed `stale_account_period` on `beginUpload`.
- `docs/product/monetization.md`: paid monthly allowance for both plans,
  subscription-anchored monthly periods, annual monthly releases, no rollover,
  no current-period reset on Restore/product changes, snapshotted limits,
  idempotent settlement and explicit Transcribe.
- ADR0005: Apple verification owns entitlement; backend derives the shared
  account from verified lineage; no raw transactions, original IDs or secrets
  persisted/logged; no automatic Restore; at most three Macs.
- Logging already deployed in this session is preserved. Existing dirty files
  include `convex/managedTranscription.ts`, its logging test and completed plan.
- Use `docs/patterns/encoding-invariants.md` and
  `docs/patterns/production-evidence.md`; local proof is not hosted acceptance.

## Approach and ownership

1. Separate original subscription anchor, current transaction purchase, expiry,
   and Apple-signed evidence date in the verified contract.
2. Implement one atomic subscription/quota reconciliation owner, preserve
   historical periods/reservations/charges, and reuse it for purchase and
   authenticated refresh. No unverified time-based grant.
3. Connect fresh read-only StoreKit transaction retrieval to existing-device
   refresh without purchase, Restore, silent enrollment or automatic Transcribe.
4. Reconcile supported pending lifecycle signals only when matching Apple proof
   establishes their result. Unproven events remain pending verification.
5. Run focused positive/negative tests and real local Convex boundary proof;
   independent reviewer assesses exact candidate before any deployment.
6. Deploy within previously authorized development scope if ready. Owner keeps
   control of the actual purchase/Transcribe actions and audio.

Root owns plan, integration, the localhost harness/test and deployment prep.
`apple_period_fields` completed normalized Apple contract and associated tests.
`quota_logging` owns backend quota/schema/auth/reconciliation and backend tests.
`native_subscription_refresh` owns private native transaction transport and plugin
refresh wiring/tests. `logging_review` is the independent reviewer.
`subscription_boundary` performed read-only native/refresh boundary exploration.
Implementation/reviewer ownership stays separate under `~/.Workspace.md`.

## Accepted decisions and remaining boundaries

- Sandbox quota acceleration: owner approved one quota period per verified
  monthly term and 12 equal test periods within each new verified annual
  schedule. Active plan changes retain the established accelerated cadence.
- Lapse/repurchase: owner approved on 2026-09-13 that the new verified purchase
  date anchors the new period, while a still-active quota period stays unchanged.
- Active plan switch: owner approved preserving remaining hours and the existing
  renewal schedule. Monthly-to-annual on September 25 preserves a September
  10–October 10 period and renews again October 10–November 10. No short bridge
  allocation is authorized. Implemented and validated within the evidence
  boundaries below.
- No raw-ID persistence or new trust source is authorized. Current repository
  has a signed-JWS verifier, not an App Store API lookup client. Independent
  background lifecycle verification needs additional capability; do not claim
  that a processed webhook means entitlement/quota reconciliation completed.

## Risks and recovery

Backward-compatible optional persisted fields allow existing rows to be read;
legacy rows receive fresh verified evidence before new allowance is granted.
Keep all old quota/usage/reservations intact. Reject ambiguous evidence rather
than resetting account state. Preserve deployed logging and original audio.
Do not reuse the earlier indeterminate hosted-fixture mutation route.

## Progress

- [x] Confirmed real stale-period exception and purchase/enrollment mismatch.
- [x] Inspected accepted rules and current verification, refresh, webhook paths.
- [x] Owner period decisions recorded and promoted to monetization policy.
- [x] Verified transaction contract and ordering fields implemented.
- [x] Shared reconciliation and consumer paths implemented with accepted timing rules.
- [x] Focused tests and local Convex proof passed for implemented scope.
- [x] Independent review and exact candidate acceptance.
- [x] Development deployment/identity verification and paired native update.
- [x] Owner handoff prepared with explicit actual-runtime evidence limits.
- [x] Owner confirmed the requested sandbox retry works as expected; detailed
  live provider receipts and quota counters were not independently inspected.

## Validation

Required cases: initial purchase, same-period replay, verified renewal,
multiple missed periods, expired-to-paid recovery, trial-to-paid and annual
monthly boundaries under accepted rules; concurrent/replayed updates and
out-of-order proof; refund/revocation evidence; pending event correlation;
device-account mismatch; unchanged old usage/reservations and settlement;
invalid/missing proof; no secret payloads in persisted/logged state.

## Result

The reviewed fix was deployed to `dev:frugal-mandrill-646` on 2026-09-13
at 21:41 +07. Independent readback verified all 35 candidate modules and
unchanged runtime metadata. The signed paired app was installed at
`/Applications/Meetless.app` using the data-preserving update path and launched
successfully with all nine meetings. All 17 pre-existing audio files matched
their original size and SHA-256 afterward. Purchase and Transcribe remain
owner-controlled and were not triggered by this work.

Recovery artifacts: `.artifacts/issue19/subscription-reconciliation-deploy/`
contains the frozen source, dependency manifest, exact module comparison,
review binding, Lead acceptance, execution and readback evidence.
`.artifacts/issue19/app-reconciliation-update/` records the signed candidate and
audio preservation. Prior app/runtime backup remains under
`.artifacts/macos-mas-development/update-backups/backup-KzXYw5`; previous app is
`/Applications/.Meetless-previous-731d76ed-5a02-4a52-ba4c-d7eba14cb1e8.app`.

Observed validation:

- Root `npm run typecheck` passed.
- Backend TypeScript passed; latest worker targeted run passed 81 tests.
- Final root backend runs passed 144 tests across nine suites, including
  hosted-dev, transitions, upload repair, cleanup, preflight, logging and
  reconciliation. Earlier 113-test results are superseded by this final run.
- Plugin/native transport focused tests: 46 passed. Swift debug build and full
  native boundary executable suite passed, including authorized absent proof
  versus rejected authorization, no automatic enrollment and no proof exposure.
- Actual localhost Convex test passed: concurrent renewal, old reservation
  settlement across period change, repeated settlement, current-period charge,
  replay/older evidence, wrong lineage rejection and insufficient quota denial.
  Apple and provider remain explicit fixtures. Initial test harness attempt
  incorrectly settled after only one of two physical provider parts; corrected
  harness awaits both parts and retains this failure explanation.
- No checked-in `.github`/`.githooks` files found; local proof only, no CI run or
  branch protection enforcement claimed or changed.
- Fresh read-only development baseline matched all 33 deployed logging modules.
  Local guard and nine positive/negative guard tests passed. Exact candidate
  binding `1165b275732bf45b29c237fd8505e0c26f40ba6a1df35d173acffe2feaf2f656`
  was independently accepted before deployment; all 35 resulting modules were
  verified afterward. No production deployment occurred.

Remaining external scope: purely background webhook verification is unavailable
without an Apple lookup capability. The implemented path resolves supported
signals established by fresh client-supplied proof; unsupported/unproven
signals remain awaiting verification. A cross-product purchase after a gap in
observed history retains the established schedule because the latest transaction
alone cannot prove whether it was an active switch or lapsed repurchase.

## Final review refinements

- Apple transaction reason is optional verified evidence. Automatic renewal or
  missing reason cannot prove a lapse merely because stored coverage is stale.
  Explicit same-product purchase evidence is required for the bounded repurchase
  path; cross-product gaps still cannot distinguish a switch from a lapse using
  only the latest transaction. Preserve the established schedule in that case.
- Read-only inspection of the actual development account found no persisted
  cadence and an already-expired legacy snapshot lasting roughly 40 hours,
  inconsistent with one sandbox term. Do not reinterpret that span as a cadence.
  Preserve its historical accounting; fresh verified evidence establishes the
  first sandbox schedule only after the old snapshot ends, with no overlapping
  allocation. Active legacy snapshots and authoritative revocations remain
  independently respected. Reviewer accepted this migration approach.
- Full production app build passed, including native debug and release suites.
  Signed paired Mac candidate passed the actual repository consumer validator
  independently. Manifest SHA-256:
  `e09efc7cba37933a474e2c60cde7c595f286616fbf28484eb9e8f56f4b0ac806`.
  Bundle fingerprint:
  `78753619b0be2683bd76978d8b3d8fc4467db85b6c155cc98d9685f4a41cb5ba`.
  Artifact validation alone does not establish StoreKit or purchase acceptance;
  subsequent owner-reported runtime acceptance is recorded below.

Installed-app status check at 21:43 +07 returned Premium `inactive` through
the actual client interface; no purchase or transcription was triggered.
The owner was asked to make a fresh sandbox purchase and explicitly select
Transcribe for the saved recording. The owner subsequently reported "works as
expected" in this conversation. This is owner-observed acceptance of the
requested retry, not an independent inspection of provider receipts, exact
quota deductions, or every subscription lifecycle edge case. The implementation
plan is complete on that basis; the documented external limitations remain.

## Hosted confirmation and issue closure — 2026-09-14

The owner explicitly authorized closing issue #19 with the implementation and
evidence available today, moving the remaining real validation to
[issue #20](https://github.com/hoangnb24/meetless/issues/20) for later testing,
then committing and pushing the work. This is a recorded scope decision, not
a claim that untested cases passed.

Read-only development logs and ledger inspection confirmed the two successful
owner-driven jobs from 2026-09-13 at 22:38 and 22:41 (+07):

| Canonical samples (16 kHz) | Billed seconds | Recorded provider invocations | Charge rows |
| --- | --- | --- | --- |
| 678,446 | 43 | 1 | 1 |
| 1,394,541 | 88 | 1 | 1 |

Each recording had one matching logical job. Both pre-upload and job-admission
checks allowed the requests. Their shared period had 131 used seconds, zero
reserved seconds, and charge rows summing to 131. The configured limit was
18,000 development-test seconds, not production policy. Completed jobs were
acknowledged and their temporary uploads cleaned. No new provider call or
account mutation was performed for this inspection.

Issue #20 retains hosted exactly-enough/insufficient quota, signed-app denial
and reopen behavior, blocked-to-new-allocation behavior, concurrency, and
actual retry/disconnect evidence. Normal successful attempts establish correct
accounting for those attempts only. Background Apple verification and ambiguous
cross-product lapse history remain known limitations for billing/production
acceptance; closing #19 does not remove those boundaries.
