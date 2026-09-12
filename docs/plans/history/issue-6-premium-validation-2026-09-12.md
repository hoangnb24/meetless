# Issue #6: Monthly Premium validation

Validated: 2026-09-12. Independent review and Lead **ACCEPTS** the bounded
monthly Sandbox purchase, explicit Restore and relaunch scope of issue #6.
Premium updates automatically after a late successful purchase, without Refresh
or automatic transcription. Seven saved recordings and all 29 store/audio files
remain unchanged.

## Accepted source and actual candidate

- `58d931a`: UI-generated operation UUIDs, typed retained outcomes and recovery
  polling that never redispatches Purchase; correlated categorical diagnostics.
- `487d2779f340e92822a9754cf7d485efc5f83499`: native diagnostics persist through
  the existing host log using a dedicated duplicated descriptor. Callback and
  enrollment behavior are unchanged by this correction.
- Exact MAS development manifest SHA-256:
  `a3cca1f00f863ee652befbd69760d7c33fd74cef02e8f247170b0265adfc7d27`.
- Artifact digest:
  `be6941c063773914e3ffab31ef2862b9d37051cc4354d9533c1fc7ad0c8a9ee1`.
- Package-source snapshot:
  `18924d20a968b6d998ce5a182c18684302cf579451597cf1341a9e26da8750c1`.

The real producer built and signed this candidate with the configured MAS
development inputs. Installed strict validation, signature/CDHash matching and
actual plugin readiness passed. The artifact includes the retained dirty
baseline recorded by its source snapshot; accepting #6 does not accept that
unrelated work or claim the standalone clean HEAD produced this artifact.

## Actual monthly, Restore and relaunch

The owner personally completed Monthly in Apple Sandbox. The observer performed
no purchase or Apple account interaction. Operation
`90bd7b37-6328-4f83-a6c7-6df75029cf02` recorded each of the eight stages exactly
once after deduplicating mirrored log entries: UI dispatch, plugin RPC dispatch,
native RPC dispatch, trusted native invocation, SDK callback, trusted native
completion, plugin completion and UI completion.

The SDK callback arrived after 31.932 seconds, native completion was `pending`
after 33.085 seconds, plugin completion was `active` after 41.062 seconds and UI
completion was `active` after 41.083 seconds. Native `pending` precedes the
required plugin verification/enrollment boundary; the reviewed contract returns
public active only after that boundary succeeds. SDK callback category `active`
alone is not verified entitlement. There was no early terminal failure, manual
Refresh or automatic Transcribe. Current UI reported active Premium.

One explicit Restore on the same candidate, operation
`31cc6029-08ea-4b35-8ad9-548e5b16bd69`, recorded the same eight stages once and
reached UI active after 16.047 seconds without an account prompt. Ordinary quit
proved the complete old host `20813` process tree absent. Documented relaunch
started host `23434`, reported ready with seven recordings and automatically
showed active Premium. No new purchase/Restore dispatch occurred after the
relaunch cutoff. Runtime and stable-lock identities were preserved.

Local evidence: `.artifacts/issue6/native-log-live/monthly-handback.md`,
`monthly-operation-summary.json`, `monthly-current-identity.json`,
`post-monthly-restore-summary.json`, `post-monthly-quit-proof.json` and
`post-monthly-relaunch-state.json`. Private UI evidence stays local.

## Focused proof and its limits

The source proof contains 93 focused contract/client/plugin/UI tests, TypeScript
checks and five selected native checks. Controlled-clock delayed-completion
tests prove pending past 30 seconds without a stale failure. The old UI fails
the negative proof. Focused tests cover cancellation, recoverable failures,
repeated clicks, duplicate callbacks/enrollment, status convergence and the
no-automatic-Transcribe rule. Exact source graphs and earlier failed attempts
are retained in `.artifacts/issue6/source-integration/`.

The native sink correction passed focused real-file logging checks with stderr
discarded. Sending writes back to stderr made the negative check fail. Its
synthetic callback record was only local formatting proof; the actual candidate
monthly and Restore runs above supply SDK callback evidence.

There is no pending-UI screenshot from the new candidate's owner purchase; its
timestamps prove the 41.083-second operation and absence of an early terminal.
The controlled-clock UI proof and the older candidate's visible 52-second
pending state remain separate evidence. Full native testing reproduced seven
pre-edit baseline attestation failures; no full-suite pass is claimed. No live
cancellation, annual or production transaction was attempted in this final run.
Operation results remain for the plugin process lifetime. Ambiguous transport
loss can remain pending, and recovery-response loss is not proven recoverable.

## Retained failures and recovery

The earlier `6dde...` candidate's owner purchase automatically reached active
after about 58 seconds, and Restore/relaunch passed. However, its host stderr
was discarded by LaunchServices, losing three native stages. Those stages were
not reconstructed from UI success. That gap caused the native sink correction.

The new full update initially FAILED: recursive replacement encountered the
root-owned nested Apple receipt after removing most of the installed app, and
rollback repeated the failing removal. Backup `backup-4Hxp0H` was retained.
Independently reviewed bounded recovery verified new and old staged apps,
retained the whole partial app without modifying its receipt, then installed
the exact new candidate using no-replace renames under the stable lock.
Recovery and ordinary launch PASSED; all data, the original receipt inode,
backup and old staging were preserved. This does not turn the original full
update into a pass. The recursive-removal defect requires correction before
another ordinary update.

Before the new owner purchase, Restore operation
`797982d1-5e77-44ca-b228-3b070283168c` truthfully FAILED after 14.027 seconds with
“No active Premium purchase was found.” Its complete categorical chain remains
recorded; no expiry/backend root cause is inferred. One explicit normal status
Refresh subsequently cleared the error and enabled purchasing. This failure
is separate from the accepted post-purchase Restore and is not reclassified.

## Acceptance and handoff

AC 1–8 are satisfied by the focused layer proof and the exact-candidate actual
monthly, active Restore and relaunch evidence above. This is #6 acceptance,
not annual billing, release, managed-provider production or unrelated dirty
source acceptance. No new CI, hook or branch-protection enforcement is claimed.
Receipts, signed transactions, raw SDK errors and account data are not included
in this record or uploaded with the issue.

#10 may proceed from the accepted Premium behavior and the product decisions
in #7. Correct the observed development updater defect before its next use.
