# Issue #12: Quota core source validation — 2026-09-13

## Decision and scope

Lead **ACCEPTS the source/local core only** at commit
`02171f92b11a0be50bd8f5e0e8d3ef1dec0c369a`, following independent review.
The commit is pushed to `main`. Issue #12 remains open: the local canonical
WAV retention decision, hosted backend proof, and actual MAS consumer
validation are not complete. This is not production acceptance.

Authority is issue #12 and `docs/product/monetization.md`'s whole-recording
preflight and later explicit attempt rule. Existing atomic admission, billing,
retry lifetime, and temporary backend data rules remain authoritative.
Dependencies #7, #11 and #10 were accepted before this implementation.

## Accepted source identity

- Base: `c5ffe9940e7b8a2a30c0a150164828408e6b9e56`.
- Frozen candidate: `.artifacts/issue12/core/candidate-v3/`.
- Sixteen source/test paths are bound in `candidate-v3-identity.json`.
- Task-only patch SHA-256:
  `eca3a9e0be8bbfa0310d971c0acdfab64d4873bcb59ce430e84f7c228175f74c`.
- Lead and reviewer independently matched the working files and snapshot.
  Lead also matched every indexed blob before committing; no unrelated path
  was staged. The Git-formatted index diff differs from the plain unified
  handoff patch only in representation, not the accepted file bytes.
- The new pure shared source contract is
  `packages/meeting-domain/src/managed-quota.ts`, SHA-256
  `6405c8a450fba40ca1c9d6e3269e0f34eed840f65048dd45fbf9021037f7923c`.
  Future deployment snapshots must include this dependency outside `convex/`.

## Behavior and proof

`beginUpload` checks the full authenticated canonical manifest before returning
an unadmitted upload session. It does not reserve quota. Atomic seal admission
rechecks available allowance and reserves once. Existing reserved/running or
provider-completed/succeeded work does not demand another reservation. Invalid or stale quota periods fail
closed without inventing calendar rollover policy.

The backend, plugin and store share one strict quota-denial validator. Required
and remaining duration and the verified reset snapshot survive restart.
Host-generated copy uses readable durations and local date/time. Explicit
successful preflight clears a prior block; a validated existing completed
result also clears it before publication, without fresh upload/provider work.

A server-marked quota-deferred upload can obtain a fresh transport after full
cleanup of the old expired attempt, only with unchanged canonical identity and
no logical job in any state. Its new bytes have a new TTL; old bytes are not
retained longer. Mixed transport lineage is validated, and quota renewal does
not replenish the one corruption repair permitted per logical recording.
Previously admitted terminal jobs retain their existing TTL/admission rules.

Observed on the exact v3 candidate:

- 170 tests passed across 13 files. Plugin/dependency and backend TypeScript
  builds passed in the isolated snapshot.
- Actual localhost Convex HTTP calls exercise exact allowance, insufficient
  allowance, preflight without reservation, two concurrent seals after successful
  preflights, one reservation winner and a typed denial loser, the durable quota
  deferral marker, existing reserved/completed recovery, and idempotent settlement.
- Local configuration: synthetic canonical audio, 20-second allowance labeled
  `hosted-development-test`, fixture authentication and fake provider. Runtime
  mode is `hosted-development`, but the backend target is strictly localhost. No hosted deployment
  or real OpenAI request was used.
- In-memory actual-handler fixtures cover cleanup prerequisites, successor
  idempotency, unchanged old TTL, all eight job states, malformed lineages,
  stale period rejection and the corruption-repair bound across quota renewals.
  They do not prove real elapsed 24-hour cleanup.
- Actual MeetingStore restart tests cover stale quota feedback with both
  `provider_completed` and `succeeded` remote-result fixtures, repeated recovery,
  and a pending/quota crash state, with no new preparation/upload/provider calls.
  Actual ledger idempotency is separately established by localhost Convex.
- The actual pinned Paseo compiler produced retained client/server bundles.
  A metadata-only private compiler copy produced byte-identical output and a
  dependency graph including the built shared quota module. An invalid entry
  failed with the intended compiler diagnostic. This is compiler evidence,
  not signed MAS runtime evidence.

## Negative evidence and reproduction

The new localhost preflight test fails against the base producer because that
producer returns an upload session for insufficient quota. Its use of the new
validator is an explicit test-only negative-proof dependency.

The superseded v2 candidate failed both completed-result recovery regressions
with the actual store schema error caused by stale quota feedback. v3 fixes
that path. A subsequent test-only failure concerning an omitted `undefined`
JSON field is retained separately; the corrected field-absence assertion passes.

Evidence and exact reproduction commands are in
`.artifacts/issue12/core/HANDOFF.md`, `candidate-v3-tests.log`, both v3 type logs,
`v3-pinned-compiler.json`, the pinned output/graph files, `before-negative.log`,
and `v2-recovery-negative.log`. Earlier candidates and failed development runs
remain preserved. The core tests and isolated backend harness change are
committed with the implementation.

## Outstanding decisions and runtime gates

The prior accepted local canonical WAV artifact expires after 24 hours. Lossy
MP3 cannot recreate the exact bytes already bound to a backend manifest. The
owner has been asked whether to retain the private WAV only for quota-blocked
recordings until transcription succeeds or the recording is deleted, requiring
about 115 MB per audio hour. No answer or retention change is assumed. Backend
temporary data would still expire within 24 hours under that proposal.

Hosted preparation is read-only so far. A synthetic account would be an
explicit administrative test dependency, not proof of Apple verification or
actual owner/MAS use. The existing cancel/cleanup path removes job checkpoints,
but failed-enrollment challenges, unrecoverable unregistered blobs, and
account-unscoped reconciliation during cleanup still require a bounded recovery
plan before a hosted run. The environment-mutating standard canary is not
approved for this work.

No production allowance/provider configuration, deployment, native packaging,
app update, real provider call or actual MAS quota interaction was performed.
Existing local audio and retention code were not changed by this source commit.
Only source/local validation is accepted. No CI run or branch-protection
configuration was verified or changed.
