# Issue #10: Managed transcription validation

Accepted by independent reviewer and Lead on 2026-09-13. The owner confirmed a
successful transcript after Monthly Sandbox purchase and explicit Retry on the
same new Test recording. This record accepts #10 with actual packaged-path
proof plus the executable adverse-path checks identified below; it is not
release, Ask, billing-distribution, or production-configuration acceptance.

## Exact source and artifact

- `c1ca6ce`: selected saved-recording Transcribe, explicit cloud consent and
  Premium flow, automatic progress/local publication, duplicate suppression.
- `ee6e848`: reconcile stale Premium badge when the current transcription gate
  establishes inactive or unverifiable access; protect newer Premium operations.
- `f1b19e7`: copy each streamed PCM chunk so later reads cannot overwrite bytes
  still retained by the HTTP consumer.
- `f1043ee`: separately record the existing deployed backend baseline. Native
  reproduction matched all 33 deployed modules byte-for-byte, including maps
  and execution environment. This did not silently adopt other dirty work.
- `1955c2f`: retain the unchanged isolated localhost production-handler harness.
- `e4ca5c3`: explicit failed-Retry repair of server-proven corrupt, unadmitted
  transport; preserve canonical identity and original TTL; retain mismatch
  evidence, fence old requests, and create no third generation.
- Actual MAS manifest: `ceef000ec9bc876dbce2cee79accc45aff628523cb40c8978a6d515832616e44`.
  Full preserving update exited 0 with eight meetings ready and valid installed
  signatures. All 104 installed server inputs match accepted producer evidence.
- Locked hosted development target: `frugal-mandrill-646`. One guarded native
  deployment changed only two upload modules and schema; all 33 post-deploy
  module hashes match the reviewed candidate. The other 30 modules, including
  provider and auth code, are unchanged. Provider mode was read-only verified
  `real`; no environment values were changed and no provider secret was read.

## Actual successful recording and recovery

The owner used the new Test recording `74f4ef97-359d-4ed4-b238-5ae00fb55378`.
The seven older recordings were not submitted. Canonical audio is 361,067
samples at 16 kHz, 22,567 ms; billable duration rounds up to 23 seconds.

The first upload on the earlier MAS artifact failed during server digest
verification, before admission or provider work. Its complete registered part
contained different bytes from the immutable descriptor. Actual stream-producer
reproduction identified a reused Buffer view; the original failure is retained.
The successful Retry used the corrected stream and the same recording/manifest.

Read-only backend evidence after Retry and again after relaunch proves:

- Exactly two linked transport attempts: original
  `kd70bcvywm09z5shhc8jkdtbch8ebjrf` and successor
  `kd759egvv0ks2t538eszc4z8j98eapw1`, with reciprocal links.
- The original is cleaned, with cancellation fence incremented and durable
  server-observed digest mismatch evidence still present. It has no job/charge.
- Both keep canonical identity and original expiry `1789358109860`; repair
  did not extend temporary retention or manufacture a different recording.
- One job, `jn750796mx7dwczf5d0gfq3a4d8eaz5c`, succeeded, settled, acknowledged
  and cleaned. One charge of exactly 23 seconds exists; it stays one after
  relaunch. Execution-attempt and claimed-invocation counters are both one.

The actual UI displayed readable transcript text. Local transcript contains one
segment from 0 to 22,567 ms, matching the whole accepted timeline. The owner
confirmed success. Text/audio content is not copied into this repository record.

## Observed timing

Categorical stages recovered from retained exact-recording log ranges, in UTC:

| Stage | Time | From durable start |
| --- | --- | --- |
| Durable start / upload requested | 05:52:48.948 | 0 |
| Upload ready / provider requested | 05:52:54.722 | 5.774 s |
| Provider result | 05:52:57.901 | 8.953 s |
| Settlement completed | 05:52:58.280 | 9.332 s |
| Local publication completed | 05:52:58.331 | 9.383 s |
| Acknowledged | 05:52:58.822 | 9.874 s |

The prepared 15-minute observer ended at 05:18:42 with no job, before this owner
attempt. Its empty result is retained. Later bounded read-only log recovery
established all eight stages and one job ID. The provider-part rows were already
cleaned before metadata inspection; their historical per-part metadata is not
reconstructed. Claimed invocation count is not a captured OpenAI HTTP request ID
or independent network-request count.

## Preservation and no implicit transcription

Before the owner Retry, all 34 store/audio files, including the failed-upload
journal, survived the update unchanged. Actual current-stage log evidence shows
no new transcription starts/uploads/provider dispatch during update/selection.
The original legacy-marker interpretation is retained and superseded by V2.

After success, ordinary shutdown established host 50903 absent; the accepted
launch route started host 52672 on the same installed artifact. All eight audio
files and the local transcript retained their hashes. The same Test reopened
Ready and readable. Relaunch emitted only recovery/publication/acknowledgement
for the existing job, with no new start/upload/provider dispatch. A final
read-only ledger query confirmed no additional charge.

## Executable adverse-path proof and limits

Accepted isolated source checks cover coalesced duplicate starts, no dispatch
from reads/relaunch, inactive/unverified Premium denials, failures preserving
local audio, and provider-completed recovery without duplicate charge. These
are automated source/localhost proofs, not actual MAS double-click or induced
network/provider-failure experiments. Prior actual Premium-denial attempts and
the actual digest failure/Retry are retained separately.

The initial feature candidate passed 280 focused tests. Badge correction passed
92 exact App checks; stream correction passed 31 focused checks. Repair passed
64 checks in committed sources (42 plugin, five localhost actual-backend tests,
17 actual-handler fixtures), plus two unchanged untracked localhost transition
tests as supplemental evidence. Scoped typechecks and pinned compiler positive
and targeted negative proof passed. Three repair negative-before cases failed
for the intended reasons. The localhost provider is fake; it is never used as
proof of the actual hosted real-provider result above. Local harness execution
requires installed dependencies and the existing cached local Convex binary.
No new CI or branch-protection enforcement is claimed.

Receipt metadata changed before backup/rename; the retained whole old app kept
its inode. Earliest preflight receipt identity and the replacement actor are not
claimed. An optional external-Node probe of the installed sandbox-inherit
esbuild binary failed SIGTRAP during sandbox initialization, produced no bundle,
and was not retried. Installed source/producer identity and the running signed
app are verified; a live in-memory compiled bundle was not captured.

After successor records exist, the old backend schema/unique lookup is not a
safe automatic rollback. Any needed correction must retain compatibility with
the linked records; no deletion or blind rollback is authorized by this record.
An Ask error was visible before relaunch; Ask was not invoked or accepted by
this validation. Wider journey/release validation belongs to #13 and later work.

## Retained evidence

Local private evidence is under `.artifacts/issue10/`: `source-candidate-v2/`,
`premium-gate-correction/`, `upload-buffer-correction/`, `transport-repair/`,
`backend-baseline/`, `backend-deploy/`, and `transport-repair-update/`.
Key actual files include `owner-success-recovered-stages.json`,
`owner-success-local-proof.json`, before/after-relaunch UI screenshots,
`owner-success-after-relaunch.json`, and the read-only results
`transport-repair-result.json`, `transport-repair-after-relaunch.json`, and
`owner-success-job-metadata.json`. Raw audio, receipts, credentials and private
transcript contents are not published. Earlier failed attempts remain failed
historical evidence; this acceptance does not relabel them as successful runs.
