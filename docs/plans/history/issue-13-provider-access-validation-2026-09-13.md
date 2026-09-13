# Issue 13: existing Codex access and Ask validation

Date: 2026-09-13. Issue: https://github.com/hoangnb24/meetless/issues/13

## Outcome and scope

The owner authorized Ask on the existing ready Test and approved a macOS folder
chooser with remembered access to reuse existing coding-agent configuration.
Codex folder reuse, delayed selection, a real cited answer, and chat persistence
passed on the signed MAS artifact identified below. Playback acceptance is
recorded separately for the final correction. This is bounded Ask acceptance;
recording, purchases, transcription and the full same-candidate #13 journey
were not repeated. Claude Code/OpenCode folder integration remains unavailable
in this implementation, and no broader provider claim is made.

## Source and actual artifacts

- `56e73b1`: earlier first-use model-selection correction.
- `2426c21`: scoped Codex folder access, bookmarks, native bridge and Ask UI.
- `c923184`: asynchronous chooser results and correct Paseo provider configuration.
- `f4568e1`: natural audio-end completion and short-clip state race correction.
- First folder-access manifest: `5fdb208a88273030d5e0c92557cb2c4eaea8f58959e78bd8b81a9e558ad3392b`.
- Accepted Ask manifest: `848b22f64cd00a770342f92fbc1eb5e1faed1fe13ad80436a3ed3938099fa251`.
- Final playback manifest: `4936c9c229ce7794bfdea9e866f9214bcd7149f8f295a6d4cd69e297517e5b90`.

Each update used `npm run dev:mas:update`, the real build/sign/validate/preserving
install path. Consumer: `/Applications/Meetless.app`, its embedded Electron UI
and installed plugin. Runtime/config, provider bridge, chat service and UI entry
bytes were compared with built inputs for the accepted Ask artifact. Native
scoped file entitlements were validated by the packaging path; children retain
App Sandbox inheritance. The pinned Paseo revision did not change.

## Observed behavior and retained failures

The original real Ask failed with HTTP 401 and is retained as a failed attempt.
The same question was manually retried after granting access; no credentials
were copied and no provider-specific account/login was created. Meetless data
and isolated Paseo state remain in the app container; the provider receives its
approved existing CODEX_HOME.

| Check | Observed result |
| --- | --- |
| First candidate picker | Cancel recovered; selecting Home was rejected inside the native chooser before acceptance. Exact Codex folder bookmark saved. |
| First candidate long picker | Failed UI result after Paseo's 60-second RPC deadline despite saved native grant. Retained as failure. |
| First candidate relaunch | Failed: real Paseo persisted-config consumer rejected `providers.codex`. Correct producer is `agents.providers.codex`. |
| Corrected delayed picker | Still pending at 92.814 seconds; granting the exact folder then showed the saved-access/reopen message without the false failure. |
| Corrected normal relaunch | Exit 0 and host/plugin ready; bookmark restored, actual provider config points to existing Codex home, no repeated chooser. |
| Manual Retry | Completed in 21.293 seconds, retrieving one valid transcript segment. Answer correctly identified Airbnb leaving React Native in 2018 and the decision still being cited seven years later in 2025. |
| Chat isolation/durability | One question and one answer; old failed attempt retained. Other Test has no copied answer. Normal quit/relaunch restores identical chat and selection with no automatic Ask. |
| Citation resolution | Opens the validated 00:00–00:22 segment and its transcript text. |
| Original playback state | Remained Playing after 72.386 seconds. Retained as a failure; web playback lacked natural-ended handling. |
| Final playback | Same stored citation transitioned from Playing evidence to Evidence played. Completed state was observed after 45.288 seconds; this observation delay is not engine completion latency. |
| Data preservation | Eight meetings remain; original meeting/recording/transcript/consent rows and audio hashes unchanged throughout. Changes to meeting-store JSON are the authorized chat selection/thread/attempts. |

The original app-owned bookmark was temporarily renamed while the app was
stopped to repeat first-grant validation. It was retained for recovery and the
temporary backup removed only after the new grant and successful relaunches. This
was not provider credential migration. Normal updater app/runtime backups remain.

## Validation and acceptance

Local proof includes native boundary tests (exit 0), 23 signing checks,
TypeScript/app typechecks, provider-access UI/transport tests, and 72 playback
and transcript-selection tests. Transport tests use a real Unix socket and
cover strict responses, cancellation and request identity. A separate fake-clock
broker test keeps one operation pending beyond five minutes; the actual chooser
observation was 92.814 seconds. Runtime regression uses the real pinned `loadPersistedConfig` and
`resolveConfigFromPersisted`: old shape fails with the observed diagnostic;
correct shape reaches `agentProviderSettings.codex.env`. Earlier mirrored JSON
assertions did not establish consumer compatibility and are not presented as
sufficient evidence. Test summaries are labelled as summaries where raw output
was not retained; native raw output and actual update/error logs are retained.

Independent reviewer and Lead ACCEPTS the Codex folder-reuse/Ask/chat-durability
scope on the accepted Ask manifest. Final playback decision:
Independent reviewer and Lead ACCEPTS the final playback correction on its
identified artifact. The successful Ask was not repeated on that final artifact. No production release, universal coding-agent support,
new-machine test, audible-output quality assessment, or full #13 journey is claimed.

Local evidence: `.artifacts/issue13/provider-access/` and
`.artifacts/issue13/ask-live/`. Main records include actual-ask-result.json,
actual-ask-review-acceptance.json, preserved accepted-ask-manifest.json,
source/correction/playback acceptance maps, update/relaunch logs, picker and chat
screenshots, data snapshots, and final playback evidence. Raw transcript/UI
snapshots stay local; only this validation account is committed.
