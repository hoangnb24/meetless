# Execution Plan: Issue 19 backend quota diagnostics

Date: 2026-09-13

## Status

Completed

## Outcome

Deploy safe quota diagnostics to the app's development backend, then hand back
to the owner to explicitly retry Transcribe and inspect the logs.

## Context and authority

- Owner explicitly requested backend logs and deployment in this session.
- Issue #19 records a suspected stale quota period on the real YouTube attempt.
- `docs/product/monetization.md` owns quota behavior; this change preserves it.
- `docs/decisions/0005-mac-app-store-and-revenuecat.md` forbids audio, transcript,
  credentials, receipts, and raw transactions in ordinary logs.
- `docs/patterns/production-evidence.md` governs deployment identity evidence.

## Scope and approach

1. Add bounded structured diagnostics at quota preflight/admission boundaries.
2. Validate allowed, denied, and thrown paths and safe log fields.
3. Independently review the exact candidate and its deployment preparation.
4. Verify the live development baseline, deploy once using the native CLI with
   an explicit development selector, and compare deployed module hashes.
5. Tell the owner that logging is ready. The owner performs the real retry.

Implementation ownership: quota_logging agent owns backend/test edits. Root
owns deployment preparation/execution and this plan. A separate reviewer checks
the candidate. No quota repair, allowance reset, schema change, audio upload,
provider invocation, app replacement, or GitHub update is part of this work.

## Risks and recovery

- Diagnostics must not replace exceptions or expose private payloads.
- Baseline drift stops deployment for inspection. Preserve schema and data;
  use a reviewed forward correction if needed, not a data reset.
- Deployment proves code identity; the owner's retry remains separate runtime
  evidence and this task does not close issue #19.

## Progress

- [x] Read issue and relevant code, workflow, privacy and evidence requirements.
- [x] Implement and validate diagnostics.
- [x] Independent review.
- [x] Deploy and verify exact development candidate.
- [x] Hand back to owner for retry.

## Validation and result

- 22 focused actual-handler tests passed (`test/managed-quota-logging.test.ts`),
  covering quota outcomes, unchanged exceptions and private-field exclusion.
- Convex TypeScript check passed. Nine deployment guard positive/negative
  checks passed. Independent reviewer accepted the exact source and binding.
- Native development deployment exited 0 at 2026-09-13 13:39:22 UTC
  (20:39:22 +07). Separate post-deploy readback matched all 33 candidate modules
  and reviewed runtime metadata. Only `managedTranscription.js` changed;
  schema and other modules are unchanged.
- Lead ACCEPTS development deployment identity. Source SHA256:
  `bbc52c5c290c84019f6b486a17d7b8e5d5819b96c1c6efe5ed01660ce28a715b`.
- Evidence: `.artifacts/issue19/backend-diagnostics/` contains frozen source,
  module manifests, independent/Lead acceptance, execution and post-deploy check.
- Handoff: owner can retry Transcribe on the installed app and search backend
  logs for `managed_quota_check`. `stale_account_period` confirms the stale
  period branch on that request; other outcomes distinguish missing data,
  invalid ledger/period, insufficient allowance and allowed quota checks.
- Actual hosted log visibility and the recording retry remain untested until
  the owner's action. No audio/provider/account mutation was invoked by the
  agent. This completed diagnostics deployment does not close issue #19.
