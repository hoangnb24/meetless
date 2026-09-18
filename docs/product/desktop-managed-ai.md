# Desktop Managed AI

Accepted by the product owner on 2026-09-18 for Epic E1.
Amended after the 2026-09-18 Ask interview and release-first directive.

## Authority And Scope

This is the current product contract for the desktop pivot. Where V1 documents
conflict, this contract replaces existing-coding-agent Ask, free new Ask calls,
future BYOK precedence, companion-client delivery, and the old subscription
offer as requirements for this phase. It does not authorize deleting those
implementations, user credentials, or data. Non-conflicting recording, evidence,
credential, host-ownership, and billing-safety constraints remain in force.
See [ADR0008](../decisions/0008-desktop-managed-ai-pivot.md) for execution limits.

Meetless targets macOS and Mac App Store distribution. Users need neither a
coding agent nor an API key. Mobile is a later phase; web companions, durable
cloud sync, multi-device accounts, external documents, cross-meeting questions,
automatic summaries, and action-item extraction are outside this phase.

## User Flow

Record → Stop and save audio locally → explicit Transcribe with access/quota
checks and consent → local transcript → explicit Ask with access/quota checks
and consent → cited answer → play the source audio.

Ask is scoped to the open meeting. Citations resolve known transcript segment
IDs, not model-written timestamps. Insufficient evidence must be stated.
Recordings, transcripts, and chat remain on the Mac across quit/relaunch.
Errors, quota exhaustion, and subscription expiry never delete local evidence.

### Accepted Ask Behavior

- Ask remains transcript Q&A, not a general assistant. Greetings/off-topic input
  get a gentle invitation to ask about the meeting, not an operational error.
  History resolves follow-ups; factual evidence comes only from the transcript.
  Missing evidence is stated without speculation; clarification is allowed.
- A failed question stays in history and never blocks a new question. Retry is
  deliberate, only for the latest failed/incomplete question; an older question
  is resent as a new question. Successful retry replaces that question's visible
  failed/partial answer without duplicating the question; retain attempt metadata.
- Stream tentative text, validating citations at completion. Stop or disconnect
  keeps partial text labeled incomplete, excluded from subsequent model context
  and evidence. Invalid final citations keep the text labeled unverified, disable
  invalid source links and exclude that answer from subsequent model context.
  Both cases allow explicit retry or a new question, never automatic retry.
- Switching meetings lets a running Ask finish and save to its original meeting.
  Different meetings may run concurrently, at most one active Ask per meeting.
  Stop cancels the selected operation; quitting or closing the red window button
  requests cancellation of all operations and preserves incomplete text. Reopen
  never automatically resumes or resends. Cancellation does not guarantee that
  provider processing or cost stops.
- Basic paragraphs, lists, emphasis and source-audio links are sufficient. Rich
  tables/code blocks and a full-app redesign are not required. Chat UI internals
  may change to reuse an SDK, but existing audio, transcripts and chat must survive.

These are accepted target behaviors, not claims about build 7. Implementation
order follows the Epic's release gates; omitting an accepted behavior from the
first release requires an explicit owner scope decision.

## Free And Subscription Access

Recording, reading existing transcripts/chat, and audio/citation playback remain
free, including when subscription or purchase services are unavailable.
The subscription includes both Meetless-managed Transcribe and Managed Ask.
Inactive or unverifiable subscription access and exhausted applicable quota
block new managed AI requests, with a purchase, restore, status, or recovery
path; they do not block access to existing local data.

Price, whether and how a trial is offered, trial allowance, paid quotas, shared
credits versus separate limits, model selection, and new Ask usage/error/
cancel/retry settlement semantics remain owner decisions in E3. V1 prices,
trial terms, and allowances are historical, not defaults for this pivot.
Existing transcription billing-safety rules remain constraints; they do not
implicitly define Ask charging. No unlimited free or trial AI access is granted.

## Data, Consent, And Retention

Transcribe sends the selected recording's audio for processing. Ask sends the
open meeting's transcript, the user's question, and the conversation history
needed to answer it. It does not send other meetings or audio as Ask context.
Durable audio, transcript, and chat storage stays on the Mac.

Each operation requires a deliberate user action. Ask disclosure/consent is
accepted once per meeting, persists across reopen and transcript changes, and
does not need reconfirmation for every Ask/Retry. This supersedes the initial
E2 per-operation confirmation design; it does not change Transcribe consent.
Every Ask/Retry still requires an explicit send action. Declining leaves local
data intact. Saving, updating the app,
relaunching, buying/restoring a subscription, or a quota reset never starts an AI
request automatically. Prior consent alone does not authorize background upload.

Meetless backend content is temporary: delete inputs and outputs within
24 hours, sooner once the app acknowledges durable local publication. Existing
stricter transcription cleanup rules remain in force. This is a backend policy,
not evidence of implemented cleanup or a claim about AI-provider retention.
For E2, Human accepted the disclosed OpenAI retention: abuse monitoring may
retain content up to 30 days, with stated legal/safety exceptions for longer
retention. `store:false` does not establish ZDR. Use foreground Responses with
`gpt-5.6-luna` and `store:false`, without Files/Conversations/hosted tools. Verify
actual configuration and applicable model caching behavior; do not claim ZDR or
provider deletion within 24 hours. A different privacy boundary returns to Human.

Provider credentials remain backend-only. Preserve existing trusted-host,
authentication, Sandbox/Production isolation, and no-sensitive-content-in-logs
boundaries. Backend expiry does not delete local files. Local recording deletion
remains user-directed; this decision authorizes no cleanup of real user data,
keys, backups, or legacy services.

## Delivery Boundary

E1 approved policy/documentation; the subsequent Human directive authorizes E2
code changes, builds, installation, sending meeting transcripts to OpenAI, and
TestFlight uploads. No experience cost ceiling is imposed; record actual usage
and cost without inventing a cap. OpenAI is the selected Ask provider, not a
decision on the E3 customer offer. Human subsequently selected `gpt-5.6-luna`,
accepted the disclosed provider retention for E2, and authorized Sandbox backend
deploy/config. Verify the exact Sandbox target; Production stays unchanged.
App Review, release, migration, and production changes need separate authority.
Build 7 has bounded evidence of one real Ask success and two subsequent
`invalid_answer` failures, with failed-thread recovery blocking new questions.
E2 integration feasibility is accepted under the subsequent Human-approved
milestone boundary; usable Ask/runtime quality is not. E4 owns recovery/parser
remediation and the approved Ask contract. Human authorized that next bounded
implementation after the E2 audit; no Production or release authority is added.
See the Epic for exact evidence and remaining gates.
The release goal is a usable Mac App Store product, not endless polish. Assess
release blockers early; TestFlight success is not App Review approval. The goal
does not itself authorize Production changes, submission or public release.
