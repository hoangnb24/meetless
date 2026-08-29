# Meetless Trustworthy Meeting Experience

## 1. Purpose

Meetless needs one clear path from recording a call to using its evidence.
The current product can complete this path, but its UI exposes product internals,
splits meeting creation from recording, and places too many tasks in one long
surface.

This document defines the target UX for the V1 loop:

`Record → Process → Read transcript → Ask → Check and play evidence`

The experience must help one person know what Meetless is doing, what is safe,
and what action to take next. It must keep local-first ownership and cited
answers visible without making daemon, provider, model, or request details the
main content.

## 2. Existing Product Context

### Product role

Meetless is a personal, local-first meeting recorder and knowledge tool. The
desktop host records Zoom or Google Meet, saves local audio, transcribes it, and
owns meeting data. Web and mobile are companion clients while the host is
available.

### Current relevant journey

1. The desktop app connects to a local Meetless host.
2. The user can enter a title and select **Create meeting**.
3. A separate top strip has **Start recording**.
4. The recording strip changes to elapsed time, Pause, and Stop.
5. The meeting appears in a recent list with a raw lifecycle value such as
   `DRAFT`, `PROCESSING`, or `READY`.
6. The user opens a meeting.
7. The detail shows cloud-transcription consent when needed, provider status,
   transcript state, timed segments, provider and model choices, chat history,
   and the Ask composer in one scroll area.
8. A transcript timestamp or answer citation starts bounded audio playback.
9. A companion first enters Direct LAN or an encrypted-relay offer. When its
   host is offline, it shows an explicit host state instead of a false empty
   list.

### Current screen inventory

- Desktop meeting list and creation form.
- Global recording strip.
- Wide meeting list and meeting detail.
- Compact meeting list and full-screen meeting detail.
- Transcription consent and transcript states.
- Meeting-scoped Ask thread and provider/model controls.
- Citation playback action.
- Companion pairing.
- Companion connecting, restoring, online, and offline states.

### Current conventions to retain

- A dark application shell with one high-contrast primary action.
- A persistent meeting list on wide screens.
- List-to-detail navigation on narrow screens.
- Timed transcript segments that can play audio.
- A global recording control that does not depend on the open meeting.
- Explicit recovery actions such as Retry and Change host.
- The terms **Meeting**, **Transcript**, **Ask**, **Pause**, **Stop**, and
  **Host offline**.

### Current problems to correct

- **Create meeting** and **Start recording** look like separate tasks. The user
  cannot tell which action begins the real workflow.
- Host, daemon, provider, request, and lifecycle text competes with user content.
- Recording setup does not explain microphone and system-audio readiness.
- Stop does not give a strong handoff from active recording to safe local
  processing.
- Raw statuses do not explain progress or the next safe action.
- The transcript and Ask thread form one long scroll. The composer, answer, and
  source evidence can lose context.
- The full model inventory is more prominent than the question task.
- Citation playback has weak visible state and no persistent evidence context.
- Companion pairing starts with transport mechanics instead of one recommended
  path.

### Product constraints

- Only desktop records system audio in V1.
- The first verified recording host is macOS 26.4 arm64. Other desktop claims
  require separate proof.
- Microphone and system audio are selected by default.
- Only one recording can be active.
- Capture writes recoverable chunks. A failed finalization must not require a
  new recording.
- Stop creates a collision-safe local MP3 under `~/Documents/meetings/`.
- Saved audio transcribes automatically after one-time cloud-processing
  disclosure and consent.
- Transcript segments have stable IDs and audio ranges.
- Ask is scoped to one open meeting. Supported answers require known segment
  citations. Unsupported answers must state that the meeting has insufficient
  evidence.
- Chat history is durable per meeting.
- Speaker diarization is not a V1 release requirement. The UX must work without
  speaker names.
- Companions do not become an offline source of meeting truth.
- Cross-meeting Q&A, automatic summaries, action-item extraction, calendar
  ingestion, and team collaboration are out of scope.

## 3. Target User Experience

The user must be able to:

- Start a meeting recording from one clear action.
- Understand proposed audio-source checks and any source requirement that later
  receives product and runtime authority.
- See at all times when recording is active, paused, stopping, processing, or
  safe.
- Leave a recoverable failure with confidence that completed audio is not lost.
- Scan meetings by title, date, duration when known, and meaningful status.
- Open one meeting and keep its identity visible while reading or asking.
- Read a complete timed transcript without technical provider details.
- Ask a question while the transcript remains the fixed source of truth.
- See progress where the answer will appear.
- Open a citation beside the claim, inspect the transcript evidence, and play
  the cited interval.
- Return later and continue the same meeting thread.
- Pair a companion through one recommended path and recover when the host is
  offline.

The experience must feel clear, calm, and recoverable. Each state must answer:

1. What is happening?
2. Is my recording or meeting safe?
3. What can I do now?

## 4. User Journey

### Desktop primary journey

`Meeting library`
→ `Record meeting`
→ `Recording setup and source readiness`
→ `Active recording`
→ `Stop`
→ `Saving local audio`
→ `Transcribing`
→ `Meeting ready`
→ `Read transcript`
→ `Ask this meeting`
→ `Supported answer or insufficient evidence`
→ `Open citation`
→ `Play supporting interval`
→ `Return later with state restored`

### Meaningful branches

- A proposed audio-source check is unavailable → explain the source and recovery
  action in setup → recheck when runtime support exists. Do not block Start
  unless product policy defines the source as mandatory.
- Recording is paused → keep elapsed context and show one dominant Resume
  action.
- Capture is interrupted → show whether recoverable audio exists → preserve
  completed chunks and move to save/finalization recovery. Do not offer capture
  Resume after the recording helper or host session is lost.
- MP3 finalization fails → keep the meeting and completed audio visible → Retry
  save without recording again.
- Transcription consent is unknown → disclose cloud processing → Allow and
  continue, or leave the saved local recording untranscribed.
- Transcription fails → keep saved audio and offer Retry transcription.
- Ask fails → keep prior messages and the failed question → Retry that question.
- The meeting has insufficient support → show the required insufficient-evidence
  result, not a fabricated answer.
- A companion loses its host → keep known meeting context visible but disabled →
  reconnect and revalidate → restore interaction.

## 5. Flow Specification

### Flow: Record a meeting

**Trigger**

The user selects **Record meeting** from the desktop shell.

**Steps**

1. Open a focused recording setup surface.
2. Collect or confirm the meeting title.
3. Prototype microphone and system-audio readiness as separate proposed checks.
   These checks become factual only when the runtime exposes truthful readiness.
4. If a supported check fails, name the source and provide the relevant repair
   action. Do not block Start unless accepted product policy requires that source.
5. The user selects **Start recording**.
6. Replace setup with the route-independent active recording control.
7. Show active state, title, elapsed time, Pause, and Stop.
8. On Stop, move immediately to a saving state. Do not imply that the transcript
   is ready.
9. Confirm when the MP3 is safe. Continue transcription as a separate state.
10. Keep the meeting visible in the library throughout processing.

**Decision points**

- Title requirement and any approved default.
- Source ready or source blocked.
- Pause or continue.
- Stop now or continue recording.

**Exit conditions**

- Saved and transcribing.
- Saved without transcription consent.
- Recoverable save failure.
- Terminal capture failure with no valid media.

**Failure / recovery**

- Keep permission failures inside recording setup.
- Recheck readiness after the user returns from system settings.
- If recoverable audio exists, state this before the Retry action.
- Never use a generic error when Meetless knows whether audio is safe.

### Flow: Read and inspect one meeting

**Trigger**

The user selects a meeting from the library.

**Steps**

1. Mark the selected meeting clearly.
2. Open its detail without removing the wide-screen library.
3. Keep title, date, duration when known, and user-facing status in a persistent
   header.
4. Show the complete transcript as timed segments.
5. Selecting a timestamp resolves and plays that segment's bounded audio.
6. Keep compact playback state visible until bounded playback ends, fails, the
   meeting changes, or another citation starts.

**Decision points**

- Wide or narrow layout.
- Transcript ready, processing, failed, or unavailable.
- Play a segment or continue reading.

**Exit conditions**

- Select another meeting.
- Return to the list on a narrow screen.
- Continue to Ask for the same meeting.

**Failure / recovery**

- A transcript error must not hide the saved recording.
- A playback error stays attached to the selected citation or segment.
- On narrow screens, Back returns to the prior list position.

### Flow: Delete one meeting

**Trigger**

The user selects **Delete** from an open meeting.

**Steps**

1. Show a confirmation that names the meeting.
2. State that deletion is permanent and has no undo.
3. Disable Delete while that meeting is capturing or finalizing audio,
   transcribing, or running Ask.
4. After confirmation, delete only that meeting's durable graph, audio,
   chunks, transcript and sidecars, chat, and owned temporary files.
5. Keep the action pending until the host returns an explicit result.
6. On success, refresh the library and clear the deleted detail. Do not open
   another meeting unless the current navigation path makes that selection
   race-free.

**Failure / recovery**

- A failure before the durable commit keeps the meeting and restores staged
  files.
- Cleanup after the durable commit is retried on restart and must not recreate
  meeting state.
- A repeated request for an absent meeting returns **not found** and changes
  nothing.
- Show a safe error and preserve the list and detail when deletion fails.
- A delete request must never change a different meeting.

### Flow: Ask and verify

**Trigger**

The user opens Ask for a meeting whose transcript is ready.

**Steps**

1. Restore the meeting's existing thread.
2. Keep the meeting identity and source scope visible.
3. If no valid provider/model is selected, request selection through one compact
   control.
4. The user enters a meeting-scoped question and selects **Ask**.
5. Add the user turn immediately.
6. Show progress in the answer location, for example **Searching transcript**
   and **Checking evidence**. Do not expose request counts.
7. Show one terminal result:
   - supported answer with citations next to supported claims;
   - **The meeting does not contain enough evidence**;
   - failed attempt with an inline Retry action.
8. When the user selects a citation, keep the answer visible and reveal the
   matching transcript segment.
9. Offer **Play from here** for the validated audio range.

**Decision points**

- Provider/model selection is valid or requires repair.
- Supported, insufficient, or failed result.
- Inspect citation, play evidence, or continue asking.

**Exit conditions**

- Continue the thread.
- Select another meeting.
- Leave and restore the same thread later.

**Failure / recovery**

- Preserve the question and prior messages.
- Retry only the failed question.
- Do not silently replay a lost request after restart or reconnection.

### Flow: Pair and return on a companion

**Trigger**

The companion has no valid host profile, or the user selects **Change host**.

**Steps**

1. Present one recommended encrypted-relay pairing path.
2. Let the user paste the complete pairing link.
3. Keep Direct LAN behind a secondary **Set up Direct LAN** action.
4. Validate and save the pairing profile.
5. Show **Connecting to host**.
6. Show **Checking meetings and access** while host state is revalidated.
7. Open the meeting library only after validation succeeds.
8. On later launches, reconnect automatically and restore validated host state.

**Decision points**

- Recommended pairing or Direct LAN.
- Retry current host or Change host.

**Exit conditions**

- Online with validated meeting state.
- Paired but explicitly offline.
- Pairing input remains available for correction.

**Failure / recovery**

- Keep invalid input for correction, except secrets that must be cleared.
- Keep known meeting rows visible but disabled when the host is offline.
- **Change host** must explain that it replaces local pairing information and
  does not delete meetings from the desktop host.

## 6. Screen & State Inventory

### Screen: Desktop meeting workspace

**Purpose**

Provide the stable home for recording, scanning meetings, and opening one
meeting.

**Entry conditions**

Desktop launch with the local host starting, online, or failed.

**Required information**

- Meetless identity.
- Host readiness in user terms.
- Record meeting action.
- Meeting title, date, duration when known, and meaningful status.
- Clear selected row.

**Primary action**

**Record meeting** when no recording is active.

**Secondary actions**

Select meeting; refresh or retry host connection when needed.

**States**

- Starting Meetless.
- Empty library.
- Populated library.
- Recording active, with global control present.
- Host startup error.
- Meeting list error.

**Exit / transition**

Open recording setup or selected meeting detail.

### Screen: Recording setup

**Purpose**

Make the start of capture deliberate and explore source readiness without
presenting unproven runtime state as fact.

**Entry conditions**

The desktop user selects **Record meeting** and no other recording is active.

**Required information**

- Meeting title.
- Proposed microphone readiness, labeled as proposed until runtime-backed.
- Proposed system-audio readiness, labeled as proposed until runtime-backed.
- Clear explanation when macOS permission or capture is blocked.

**Primary action**

**Start recording**.

**Secondary actions**

Cancel; open system settings when required; recheck.

**States**

- Proposed checking.
- Proposed ready.
- Missing title.
- Microphone blocked.
- System audio blocked.
- Start pending.
- Start failed.

**Exit / transition**

Active recording or return to the prior workspace.

### State: Active recording control

**Purpose**

Keep recording status and control available independent of navigation.

**Required information**

Title, recording/paused state, elapsed time, and any safe interruption message.

**Primary action**

Pause while active; Resume while paused.

**Secondary actions**

Stop.

**States**

- Starting.
- Active.
- Paused.
- Control pending.
- Interrupted but recoverable.

**Exit / transition**

Saving local audio.

An interrupted helper or host session does not return to Active through Resume.
It moves to recording completion and recovery.

### State: Recording completion and recovery

**Purpose**

Separate safe capture from later processing and remove uncertainty after Stop.

**Required information**

- Whether completed audio is safe.
- Current action: saving MP3 or transcribing.
- Next action when recovery is needed.

**Primary action**

None during normal progress; **Retry save** or **Retry transcription** on a
recoverable failure. For a terminal no-media failure, use **Back to meetings**.

**States**

- Finalizing audio.
- Audio saved.
- Waiting for transcription consent.
- Transcribing.
- Ready.
- Recoverable save failure.
- Transcription failure.
- Capture failed — no recoverable audio. State that no usable recording was
  preserved. Do not invent a retry or deletion rule.

**Exit / transition**

Meeting detail or continued background processing.

### State: Transcription consent

**Purpose**

Explain cloud processing before the first saved recording is sent for
transcription. Confirm that the local recording is already safe.

**Entry conditions**

Saved local audio exists and cloud-transcription consent is unknown.

**Required information**

- The saved MP3 will be sent to OpenAI for transcription.
- The local recording remains saved if the user does not allow transcription.
- Ask is unavailable until a transcript is ready.

**Primary action**

**Allow cloud transcription**.

**Secondary actions**

**Not now** or leave the meeting detail. This keeps the recording local and
untranscribed.

**States**

- Consent required.
- Grant pending.
- Grant failed with retry.
- Granted and transcription starting.

**Exit / transition**

Allow moves to Transcribing. Not now leaves the meeting saved without a
transcript and permits normal navigation.

### Screen: Wide meeting detail

**Purpose**

Let the user read the source and ask about it without losing meeting context.

**Entry conditions**

A meeting is selected on a wide desktop or web surface.

**Required information**

- Persistent meeting header.
- Transcript task area.
- Ask task area.
- Compact playback state when active.

**Primary action**

Read Transcript or Ask, based on the active task.

**Secondary actions**

Play timestamp; inspect citation; change provider/model through compact settings.

**States**

- Detail loading.
- Recording or processing.
- Consent required.
- Transcript failed.
- Transcript ready.
- Ask empty, running, history, insufficient, or failed.
- Citation resolving, playing, or failed.

**Exit / transition**

Select another meeting while the library remains visible.

### Screen: Narrow meeting detail

**Purpose**

Provide the same meeting tasks without compressing list, transcript, and Ask
into one screen.

**Entry conditions**

A meeting is selected on mobile or a narrow web viewport.

**Required information**

Persistent meeting identity, Back, Transcript/Ask task switch, and compact
playback.

**Primary action**

Use the active Transcript or Ask task.

**Secondary actions**

Back to meetings; play evidence.

**States**

Use the same content states as wide detail. Show one task area at a time.

**Exit / transition**

Back returns to the previous meeting-list position.

### State: Transcript

**Purpose**

Present the complete meeting record and its playable time ranges.

**Required information**

Ordered segments, readable timestamps, text, and current playback relation.

**Primary action**

Read.

**Secondary actions**

Play a timestamp.

**States**

- Loading.
- Consent required.
- Processing.
- Ready with segments.
- Ready with no spoken text.
- Failed with retry.
- Disabled while companion host is offline.

**Exit / transition**

Ask, playback, or another meeting.

### State: Ask

**Purpose**

Support a durable, source-scoped conversation.

**Required information**

Meeting scope, prior turns, current progress, answer outcome, citations, and
compact provider/model status.

**Primary action**

Ask a question.

**Secondary actions**

Select provider/model; stop an active answer if supported; retry a failed
question; inspect citation.

**States**

- Selection required.
- Empty thread.
- History restored.
- Searching transcript.
- Checking evidence.
- Supported answer.
- Insufficient evidence.
- Failed question.
- Offline disabled.

**Exit / transition**

Continue thread, inspect evidence, or change meeting.

### State: Citation evidence and playback

**Purpose**

Connect an answer claim to trusted transcript and audio evidence.

**Required information**

Claim marker, cited transcript segment, time range, and playback state.

**Primary action**

**Play from here**.

**Secondary actions**

Return to answer.

**States**

- Resolving citation.
- Evidence visible.
- Playing.
- Completed.
- Failed.
- Disabled offline.

**Exit / transition**

Return to the answer with meeting and scroll context preserved.

### Screen: Companion pairing

**Purpose**

Connect a companion to one desktop host with a clear default and repair path.

**Entry conditions**

No valid profile or Change host selected.

**Required information**

Recommended method, pairing-link instruction, Direct LAN alternative, and what data
remains on the host.

**Primary action**

Pair securely.

**Secondary actions**

Set up Direct LAN; cancel repair.

**States**

- Entry.
- Link entry.
- Direct LAN entry.
- Validating.
- Saving.
- Invalid input.
- Unreachable host.

**Exit / transition**

Connecting and revalidating, or stay for correction.

### State: Companion connection and offline recovery

**Purpose**

Keep host availability distinct from meeting-list emptiness.

**Required information**

Known host identity when safe, connection state, last validated meeting context,
and repair actions.

**Primary action**

Automatic reconnect; **Try again** when automatic recovery stops.

**Secondary actions**

Change host.

**States**

- Connecting.
- Checking meetings and access.
- Online.
- Reconnecting.
- Host offline with known meetings retained.
- Host offline with no validated list.
- Pairing repair required.

**Exit / transition**

Online meeting library or pairing.

## 7. Interaction Requirements

- Use one recording entry. Do not keep an independent meeting-creation task in
  the main library.
- Keep active recording controls visible across desktop navigation.
- Show source readiness only as a proposed prototype state until the runtime
  provides truthful signals and product policy defines which sources block
  Start.
- Do not require confirmation for normal Stop if Stop preserves audio. Require a
  guard only for an action that can discard recoverable capture.
- After Stop, change the language from capture to local saving immediately.
- Replace raw lifecycle values with task language. Examples: **Saving audio**,
  **Transcribing**, **Ready**, and **Needs attention**.
- Keep the wide meeting list and selected state stable while the detail changes.
- Give Transcript and Ask independent scroll context on wide screens.
- On narrow screens, show one task area at a time and preserve list position on
  Back.
- Keep the meeting header stable while the user changes task area.
- Keep provider/model choice compact. Show the current choice. Expand the full
  list only when the user changes it or when the saved choice is invalid.
- Put Ask progress where the answer will appear. Do not use a detached global
  spinner.
- Keep citations next to supported claims. Do not present model-written
  timestamps as trusted citation identity.
- Opening a citation must preserve answer context, reveal the validated segment,
  and make playback available.
- Starting another citation stops the prior interval before the next begins.
- A failure must stay attached to the operation that failed and preserve valid
  prior content.
- Reconnection must restore and validate host state before it enables actions.
- Offline must never be rendered as a valid empty meeting library.
- Do not depend on temporary Mobbin image URLs. Use the canonical links below.

## 8. UX Patterns & Research Findings

### Pattern: Focused recording with persistent controls

**Research finding**

Recording products separate setup, active capture, and processing. They use a
large timer, persistent Pause/Stop controls, and an explicit post-stop state.

**Decision**

ADAPT.

**Application to Meetless**

Use one focused setup and explore microphone and system-audio readiness. Keep
the active control global. Replace cloud-upload language with local saving and
recoverability. Do not make readiness a blocking gate without separate
authority.

**Evidence**

- [Fireflies — Starting a voice recording](https://mobbin.com/flows/2e0c4e46-3edd-4f2e-9477-b472092dcfee)
- [Riverside — Recording a session](https://mobbin.com/flows/7a5685e7-9d0d-44c5-afe1-4cdc3eef545d)
- [Zoom — Starting a recording](https://mobbin.com/flows/ef4fc368-5c8f-42b8-b9f1-6b5605b6f698)

### Pattern: Contextual permission recovery

**Research finding**

A capture failure works best when it names the failed source and keeps repair in
the setup context.

**Decision**

ADOPT.

**Application to Meetless**

Name microphone or system audio. Provide the system-settings action when valid,
then recheck readiness after return.

**Evidence**

- [Slack — Screen-capture permission failure](https://mobbin.com/screens/ea7333f6-196c-452d-a095-9d59bd504225)

### Pattern: Destructive recording exit guard

**Research finding**

Loom keeps Resume available before a destructive cancel action and explains the
loss.

**Decision**

ADAPT for destructive exit; REJECT for normal Stop.

**Application to Meetless**

Guard only an action that discards recoverable capture. Normal Stop is a safe
transition to local saving and must not use loss language.

**Evidence**

- [Loom — Canceling a recording](https://mobbin.com/flows/1cafb230-ff87-424f-83fd-525c90f5a582)

### Pattern: Dense meeting library with stable detail context

**Research finding**

Meeting products use compact rows with useful metadata. Detail views keep title,
time context, transcript navigation, and playback visible.

**Decision**

ADAPT.

**Application to Meetless**

Use compact rows and a strong selected state. Keep the wide library visible.
Prioritize the full transcript instead of an automatic summary.

**Evidence**

- [Fireflies — Meetings flow](https://mobbin.com/flows/0ae822f6-f66b-4c2a-a071-5c1d7e958ab7)
- [Fireflies — Selected meeting detail](https://mobbin.com/screens/2ce22b6e-0a8e-4c71-a031-9b656c5a7780)

### Pattern: Transcript and AI as separate task areas

**Research finding**

Otter keeps the transcript as the main reading area and AI Chat in a separate
pane on wide screens. Its mobile detail uses separate tasks under one persistent
meeting header.

**Decision**

ADOPT.

**Application to Meetless**

Use a wide Transcript/Ask split. On narrow screens, use one task at a time. Do
not add Summary or Comments because they are outside V1.

**Evidence**

- [Otter AI — Transcript with AI Chat](https://mobbin.com/screens/01981d27-dce2-4dce-a344-3cb6185da831)
- [Otter AI — Mobile conversation detail](https://mobbin.com/flows/0ec83093-2f0d-43f1-baaa-5ebb94c37269)

### Pattern: In-place transcript search

**Research finding**

Apollo filters transcript segments, highlights matched terms, and retains media
context.

**Decision**

INSPIRATION.

**Application to Meetless**

This is useful future behavior, but transcript search is not an accepted V1
requirement. Do not add it to the first prototype unless product scope changes.

**Evidence**

- [Apollo — Searching a transcript](https://mobbin.com/flows/eb84a950-c797-431f-a3c2-93e2233cd9a2)

### Pattern: Source-scoped chat with claim-level citations

**Research finding**

NotebookLM keeps source scope, conversation, and citations together. User and
assistant turns are visually distinct, and citations sit beside supported
claims.

**Decision**

ADOPT.

**Application to Meetless**

The open meeting is the fixed source. Keep the transcript visible and attach
citation controls to supported claims.

**Evidence**

- [NotebookLM — Grounded question and answer](https://mobbin.com/flows/a9ac908a-cd81-47d4-b929-be83ec5c9501)

### Pattern: Progress in the answer location

**Research finding**

Sana shows generation progress where the answer will appear and keeps a stop
control in the composer. Its evidence area moves from finding to used source.

**Decision**

ADAPT.

**Application to Meetless**

Show user-facing steps such as **Searching transcript** and **Checking
evidence**. Do not expose internal agent or request details.

**Evidence**

- [Sana AI — Chat with an uploaded file](https://mobbin.com/flows/94e678f2-9063-4aec-9c36-a57f90426a4b)

### Pattern: Citation opens evidence without losing the answer

**Research finding**

Perplexity changes from checking to highlighted source excerpts in a side panel
while the answer remains visible.

**Decision**

ADAPT.

**Application to Meetless**

Reveal the validated transcript segment beside the answer and provide **Play
from here**. Web source cards are not applicable.

**Evidence**

- [Perplexity — Checking sources](https://mobbin.com/flows/8684b407-d701-4f86-be4a-2c6194217572)

### Pattern: Prominent model inventory

**Research finding**

Developer tools make model and generation settings prominent. This supports
experimentation, not a meeting task.

**Decision**

REJECT.

**Application to Meetless**

Keep the selected provider/model visible through one compact control. Do not
show every model as a row of primary buttons.

**Evidence**

- [OpenAI Platform — View history](https://mobbin.com/flows/849d18f5-a084-4b55-a195-f806e9eb1ce7)

### Pattern: Recommended pairing with a secondary fallback

**Research finding**

WhatsApp makes QR linking primary and keeps a fallback secondary. Roku keeps
manual network entry out of the primary connection path and preserves failed
input for repair.

**Decision**

ADAPT.

**Application to Meetless**

Make encrypted-relay link entry the recommended path. Put Direct LAN behind an
explicit secondary action. Treat QR as future inspiration, not required
prototype behavior.

**Evidence**

- [WhatsApp — Linking a device](https://mobbin.com/flows/68f4feef-9d10-4a55-bee2-e907a859ca4e)
- [Roku — Manual device connection](https://mobbin.com/flows/5fa6d66e-693f-40d9-964b-2ea1896d4d6f)

### Pattern: Offline keeps known content visible

**Research finding**

Sonos separates failed connection, repair progress, and success. LARQ keeps the
known device visible with an explicit offline state.

**Decision**

ADOPT for state structure; ADAPT for meeting content.

**Application to Meetless**

Keep known meeting rows visible but disabled. Show **Host offline**, Try again,
and Change host. Revalidate before enabling actions.

**Evidence**

- [Sonos — Reconnecting to a device](https://mobbin.com/flows/a5202be7-d44d-46b7-a1ba-6e1ebe3bfa5b)
- [LARQ — Device offline](https://mobbin.com/flows/8becc79a-e731-4115-9317-1a0e3ab87144)
- [Quicken — Reset connection](https://mobbin.com/flows/ee653d21-47d6-4c18-9761-71b027b58d9a)

## 9. Visual / Interaction Reference Board

| Our screen/state | Reference | What to study | Usage |
|---|---|---|---|
| Recording setup | [Fireflies — Start recording](https://mobbin.com/flows/2e0c4e46-3edd-4f2e-9477-b472092dcfee) | Focused hierarchy, title, dominant start action | Adapt |
| Active recording | [Riverside — Recording session](https://mobbin.com/flows/7a5685e7-9d0d-44c5-afe1-4cdc3eef545d) | Persistent timer, active marker, Pause/Stop | Adapt |
| Post-stop processing | [Zoom — Start recording](https://mobbin.com/flows/ef4fc368-5c8f-42b8-b9f1-6b5605b6f698) | Clear transition from capture to processing | Adapt |
| Permission failure | [Slack — Capture permission](https://mobbin.com/screens/ea7333f6-196c-452d-a095-9d59bd504225) | Named failure and in-context recovery | Adopt |
| Meeting library | [Fireflies — Meetings](https://mobbin.com/flows/0ae822f6-f66b-4c2a-a071-5c1d7e958ab7) | Row density, date grouping, metadata scan | Adapt |
| Wide meeting detail | [Otter AI — Transcript and AI Chat](https://mobbin.com/screens/01981d27-dce2-4dce-a344-3cb6185da831) | Transcript dominance, separate Ask pane, player | Adopt |
| Narrow meeting detail | [Otter AI — Conversation detail](https://mobbin.com/flows/0ec83093-2f0d-43f1-baaa-5ebb94c37269) | Stable header, task switch, list-to-detail | Adopt |
| Ask empty/history | [NotebookLM — Grounded Q&A](https://mobbin.com/flows/a9ac908a-cd81-47d4-b929-be83ec5c9501) | Source scope, turn hierarchy, inline citations | Adopt |
| Ask running | [Sana AI — File chat](https://mobbin.com/flows/94e678f2-9063-4aec-9c36-a57f90426a4b) | Inline progress and source-finding state | Adapt |
| Citation evidence | [Perplexity — Checking sources](https://mobbin.com/flows/8684b407-d701-4f86-be4a-2c6194217572) | Keep answer visible, highlight evidence | Adapt |
| Companion pairing | [WhatsApp — Linking a device](https://mobbin.com/flows/68f4feef-9d10-4a55-bee2-e907a859ca4e) | Primary/fallback hierarchy; QR itself is not required | Adapt |
| Direct LAN repair | [Roku — Manual connection](https://mobbin.com/flows/5fa6d66e-693f-40d9-964b-2ea1896d4d6f) | Progressive disclosure and inline field error | Adapt |
| Reconnecting | [Sonos — Reconnecting](https://mobbin.com/flows/a5202be7-d44d-46b7-a1ba-6e1ebe3bfa5b) | Retained structure, progress, explicit success | Adapt |
| Host offline | [LARQ — Device offline](https://mobbin.com/flows/8becc79a-e731-4115-9317-1a0e3ab87144) | Known entity remains visible with offline state | Adopt |

## 10. Product Decisions

These decisions are intentional for the first prototype. Section 11 states
their authority level.

1. Use one desktop **Record meeting** entry. Do not show a separate main-screen
   **Create meeting** task.
2. Put title and proposed source readiness in recording setup. Do not treat
   readiness as a hard gate without accepted policy and runtime evidence.
3. Keep active recording controls route-independent.
4. Treat Stop as a safe transition to local saving. Guard only destructive
   discard.
5. State whether audio is safe during every recovery path where the runtime
   knows the answer.
6. Keep the meeting library visible on wide screens and use a full-screen detail
   transition on narrow screens.
7. Keep the meeting header stable across Transcript, Ask, and citation playback.
8. Use a wide Transcript/Ask split. Use one task area at a time on narrow
   screens.
9. Keep provider/model selection compact and secondary.
10. Put Ask progress in the answer location.
11. Attach citations to supported claims. Citation selection reveals the
    validated segment and a **Play from here** action.
12. Keep prior content during local failures and host reconnection.
13. Never show host-offline as an empty meeting library.
14. Make encrypted-relay link pairing the recommended companion path. Keep
    Direct LAN as a secondary setup path. QR is an optional research variant,
    not required prototype behavior.
15. Do not add summaries, action items, cross-meeting search, transcript search,
    or speaker-dependent layout to this prototype.

## 11. Assumptions & Open Questions

### Confirmed

- The V1 user is one person.
- Desktop records microphone and system audio; companions do not.
- Recording controls must remain available independent of route.
- Audio capture is recoverable and finalization can retry without recording
  again.
- Saved audio transcribes automatically after one-time consent.
- The meeting list, complete timed transcript, meeting-scoped Ask, durable chat,
  validated citations, and bounded citation playback are V1 behavior.
- Supported answers need citations. Insufficient evidence must be explicit.
- Companions use Direct LAN or Paseo encrypted relay.
- Companion host-offline is not an empty meeting state.

### Evidence-backed recommendation

- Merge meeting creation and recording entry into one Record meeting flow.
- Explore microphone and system-audio readiness in setup, subject to runtime
  evidence and a product decision on blocking behavior.
- Keep Transcript and Ask visible as separate wide-screen task areas.
- Use full-screen list-to-detail navigation on narrow screens.
- Keep provider/model configuration compact.
- Show answer progress in place and citation evidence beside the answer.
- Recommend relay pairing and progressively disclose Direct LAN.
- Retain known meeting rows during reconnect and offline states.

### Assumption

- A meeting title is collected before recording starts. The repository requires
  titles in the current implementation, but product authority does not define a
  default or whether the user may rename later.
- The wide layout can support a persistent library, transcript, and Ask area
  without making the transcript unreadable. The exact proportions need design
  testing.
- The runtime can expose truthful source-readiness and audio-safety states. If it
  cannot, the prototype must label these states as proposed, not factual.
- The companion can retain safe meeting-list metadata while offline. It must not
  present this data as current host truth.

### Open question

- Is the meeting title required before capture? If yes, what is the approved
  default or validation rule?
- Must both microphone and system audio be ready, or may the user continue with
  one source after a warning?
- Should recording start immediately or use a short countdown? Mobbin supports
  a countdown, but product authority does not require it.
- What exact user-facing phrase may describe encrypted relay pairing?
- Should Meetless add QR pairing later? Current behavior and authority support
  pasted relay links, not QR scanning.
- What host identity is safe to show before trust is established?
- When does automatic reconnect become an explicit offline state?
- Which meeting-list fields may a companion retain and show while offline?
- Should citation evidence open in a side panel, move transcript focus, or use a
  dedicated split? The prototype should test side-panel or split behavior first.
- Does the runtime support stopping an in-progress Ask attempt? If not, omit the
  Stop action and keep visible progress.
- Current V1 behavior supports automatic bounded play and automatic stop. Do not
  add visible Stop, Pause, progress, or seek controls without separate authority.

## 12. Non-goals

This UX work does not define:

- Production architecture, APIs, storage schemas, or components.
- Visual branding, design tokens, typography, or pixel specifications.
- Calendar ingestion, automatic meeting detection, or call-joining bots.
- Team workspaces, sharing, or realtime collaboration.
- Automatic summaries, decisions, action items, or artifact workflows.
- Speaker diarization as a required experience.
- Cross-meeting Q&A, document folders, or global knowledge search.
- Transcript search in the first prototype.
- Mobile recording.
- Offline meeting truth on companion devices.
- A production implementation plan.
