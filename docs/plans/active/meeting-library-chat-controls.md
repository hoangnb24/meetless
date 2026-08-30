# Execution Plan: Meeting Library And Chat Controls

## Current State

- `plan_revision`: `v1`
- `current_frontier`: `STALE-RECORDING-DELETE-OWNER-ACCEPTANCE`
- `state`: `BLOCKED_OWNER_VALIDATION`
- `depends_on`: owner validation of the already-committed stale failed-Recording deletion correction
- `candidate`: committed stale failed-Recording deletion correction; installed behavior remains owner-unaccepted
- `pending_ruling`: owner UI acceptance of the stale failed-Recording deletion behavior
- `blocked_by`: owner UI acceptance; automated checks must not delete or mutate real meeting data
- `next_action`: await owner acceptance, preserving committed chat/design behavior and all other boundaries

## Ownership And Authority

Date: 2026-08-30

- Owner: `meeting-library-chat-controls` owns only stale failed-Recording owner acceptance.
- Owned scope: owner validation of deletion for a stale failed Recording row.
- Authority: `docs/product/experience.md` and `docs/product/recording.md`; implementation evidence is completed history.

## Outcome

Keep the stale failed-Recording deletion acceptance visible as one small active
frontier. The scrollbar, provider/model controls, meeting implementation,
package/media transaction, and release-startup work are completed evidence or
separate authority; they are not reopened here.

## Live Frontier

A persisted `Recording` label is not proof that capture is active. The committed
correction allows the Delete action to reach the existing store/lifecycle safety
gate when runtime state is absent or belongs to another meeting. A genuinely
active, interrupted, recoverable, finalizing, pending/transcribing, or running
Ask operation remains protected; refused deletion must remain visible to the
user. The correction was covered by the focused App proof and the installed
owner-retest build, but owner acceptance of the stale row is still missing.

The owner validation must use a disposable or already-authorized test meeting
and report the visible confirmation, deletion result, and refusal behavior. No
automated validation may delete, reset, or mutate the owner's real Meeting,
recording, export, or chat state.

## Stable Product Authority

- [Meetless trustworthy meeting experience](../../product/experience.md) owns
  the user-visible delete flow and active-recording protection.
- [Recording](../../product/recording.md) owns recording lifecycle and local
  preservation expectations.
- The [completed implementation history](../completed/meeting-library-chat-controls-implementation-history.md)
  preserves the accepted chat/design implementation, deletion policy, focused
  proof, owner-retest evidence, and the stale-Recording diagnosis. It is not a
  live authority source.

## Explicit Boundaries

- Do not reopen committed chat controls or design work.
- Do not change provider/model behavior, scrollbar behavior, runtime startup,
  package/media transaction, signing, TCC, companion transport, or recording
  lifecycle in this frontier.
- Keep the existing durable store/lifecycle protection as the deletion authority;
  this plan owns only the final owner-facing acceptance.

## Reconciliation Record

- Base snapshot: clean `main@3ab08d4f45699ee1dee49b75c6b0caf40086bdae`.
- The former 614-line active implementation ledger moved to completed evidence;
  its implementation and validation records remain inspectable.
- No product behavior is changed by this correction. The active plan retains
  only the stale-delete owner decision and its safety boundary.

## Validation

The reconciliation validation and exact changed-file list are recorded in the
peer handoff for frontier `MEETLESS-HARNESS-AUTHORITY-CORRECTION`. This frontier
remains blocked on owner validation and is not accepted by automated proof.
