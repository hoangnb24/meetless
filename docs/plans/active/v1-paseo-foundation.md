# Execution Plan: Meetless V1 On Top Of Paseo

Date: 2026-08-16

## Status

Active

Post-M3 Electron Harness POC: accepted after fresh rerun. On 2026-08-20 the
project owner then used the supported host launch, completed a fresh recording,
opened its transcript, and audibly played cited audio. That owner-observed live
flow satisfies the dependency for beginning M4. The Harness native-provider
`invalid` result remains a diagnostic caveat; it is not an M4 blocker and does
not reverse the accepted M3 evidence.

## Outcome

Deliver a personal, local-first Meetless V1 that keeps Paseo's cross-platform
client/daemon shape while adding a separate meeting knowledge domain.

The observable V1 workflow is:

```text
Record Zoom/Meet on desktop
  -> save a recoverable local MP3
  -> transcribe into timestamped segments
  -> select a meeting and read its complete transcript
  -> chat with that meeting through an existing coding agent such as Codex
  -> cite every grounded answer
  -> click a meeting citation to play the supporting audio interval
```

Desktop is the recording host. Web and mobile are companion clients for
browsing meetings, reading transcripts, asking questions, and playing
cited audio while the host daemon is reachable.

## Product Authority

This plan records the accepted product-owner decisions:

- V1 is for one person, not a shared company workspace.
- The primary meeting source is Zoom/Google Meet.
- Meetless must have desktop, web, and mobile clients shaped like Paseo.
- Desktop recording captures microphone and system audio.
- The default audio export is under `~/Documents/meetings/` using the requested
  `HH-DD-Mm-YY.mp3` convention; collisions must never overwrite an existing
  recording.
- Existing Paseo coding-agent providers, including Codex, answer questions in a
  chat scoped to the open meeting.
- Answers grounded in the open meeting include resolvable citations.
- A meeting citation can seek playback to the supporting audio interval.
- Cross-meeting Q&A and user-selected document folders are post-MVP work.
- Mobile is for reading and question answering, not V1 system-audio recording.
- V1 companion clients reach the desktop host through direct LAN pairing or
  Paseo's encrypted relay.
- Milestone 3 transcribes English, Vietnamese, and mixed English/Vietnamese
  code-switching without translation through the official OpenAI audio
  transcription endpoint using `gpt-transcribe` and the explicit language set
  `["en", "vi"]`. No local speech model is part of Milestone 3.
- The OpenAI credential is application-owned Keychain material under service
  `com.meetless.openai-api-key` and the current macOS-user account. It must not
  enter repository files, environment variables, command-line arguments,
  manifests, logs, renderer state, daemon configuration, or meeting state.
- Saved recordings transcribe automatically after one-time cloud-processing
  disclosure/consent. Milestone 3 adds no recording-duration cap; retry and
  live acceptance remain bounded and record request/usage metadata when the
  endpoint returns it.

Focused authority now lives in [`docs/product/`](../../product/README.md).
The Paseo adoption and update contract lives in
[`docs/decisions/0001-maintained-paseo-fork.md`](../../decisions/0001-maintained-paseo-fork.md).

## Context

Meetless starts as a new repository with Repository Harness installed and no
product implementation. Paseo is available at `../paseo` and already provides:

- an Expo app shared across mobile and web;
- an Electron desktop wrapper;
- a local Node.js daemon and managed desktop subprocess lifecycle;
- WebSocket client/protocol infrastructure, reconnect behavior, host pairing,
  and encrypted relay transport;
- coding-agent provider discovery and lifecycle for Codex, Claude, and other
  providers;
- microphone capture, audio processing, speech-to-text provider boundaries,
  and local/OpenAI speech implementations.

Paseo's existing product domain is coding work: projects, workspaces, agents,
timelines, terminals, Git, schedules, permissions, and MCP tools. Those entities
do not model meetings, recordings, transcript segments, citations, or knowledge
sources. Meetless must reuse infrastructure without making meeting policy
depend on those coding-domain entities.

Relevant upstream authority to inspect before changing copied or shared areas:

- `../paseo/AGENTS.md`
- `../paseo/docs/architecture.md`
- `../paseo/docs/protocol-compatibility.md`
- `../paseo/docs/data-model.md`
- `../paseo/docs/providers.md`
- `../paseo/SECURITY.md`
- `../paseo/LICENSE`

## V1 User Stories

### P0: complete one trustworthy meeting loop

1. **Start recording.** From a persistent top-sidebar/menu action, the user can
   start a new meeting with microphone plus system audio selected by default.
2. **Observe recording.** A global recording indicator shows elapsed time and
   exposes pause/stop without depending on the current route.
3. **Preserve audio.** Recording is written incrementally; a renderer crash,
   daemon restart, or temporary finalization failure does not discard all
   completed audio chunks.
4. **Export MP3.** Stopping finalizes an MP3 under
   `~/Documents/meetings/`. Existing files are never overwritten.
5. **Transcribe automatically.** A saved recording becomes ordered transcript
   segments with stable IDs and audio time ranges. Transcription can retry
   without recording again.
6. **Browse and read meetings.** A sidebar lists meetings. Selecting one opens a
   detail screen containing its complete ordered transcript and timed segments.
7. **Chat with one meeting.** From the open meeting, the user selects Codex or
   another configured Paseo coding-agent provider/model and asks a question.
8. **Receive grounded answers.** A supported answer cites transcript segments;
   an unsupported answer says that the meeting does not contain enough evidence.
9. **Continue later.** Leaving the meeting or restarting the app preserves its
   chat history; reopening the meeting restores the thread for continuation.
10. **Play evidence.** Clicking a citation opens the meeting player and seeks to
   a small interval around the cited segment.

### P1: companion devices

1. **Use companion clients.** Web/mobile clients can list meetings, read
   transcripts, ask grounded questions, and stream cited audio
   through the connected daemon.
2. **Explain host availability.** When the personal daemon is offline, companion
   clients show that local knowledge is unavailable instead of displaying a
   misleading empty state.

## Scope

In scope:

- Personal, local-first storage and processing.
- Paseo-derived desktop, web, and mobile application shell and design system.
- A desktop recording path for Zoom/Meet microphone plus system audio.
- Platform-specific capture adapters behind one recording contract.
- Recoverable chunk recording and post-stop MP3 finalization.
- Meeting, recording, transcript, durable meeting-chat, and citation models
  with explicit lifecycle states.
- Automatic transcription after recording.
- Existing Paseo coding-agent provider discovery and agent execution.
- Meeting-specific tools that give agents bounded retrieval rather than placing
  the entire knowledge base into one prompt.
- Meeting sidebar/detail navigation, complete transcript reading,
  single-meeting chat, and citation playback.
- Web/mobile companion access after the P0 loop is proven.

Out of scope:

- Team workspaces, company identity, sharing, access-control lists, and realtime
  collaboration.
- Cloud storage or cloud sync as the source of truth.
- A general Notion-style block editor.
- Calendar integration, automatic meeting detection, or bots that join calls.
- Task-system synchronization.
- Speaker diarization as a release gate.
- Recording system audio from mobile applications.
- Offline mobile replicas of the full personal knowledge base.
- Automatic meeting summaries, decision extraction, action-item extraction, and
  proposed/accepted/dismissed artifact workflows.
- Cross-meeting Q&A and document-folder indexing.
- Making every desktop operating system pass the first recording checkpoint at
  once; platform rollout order requires an explicit decision after the capture
  spike.

## Architecture Boundary

### Reuse from Paseo

- **App shell:** Expo routing, responsive desktop/web/mobile layout, design
  tokens, host connection runtime, and existing UI primitives where their
  behavior remains appropriate.
- **Desktop shell:** Electron packaging, managed-daemon lifecycle, permission
  surfaces, and safe main/preload/renderer boundaries.
- **Daemon infrastructure:** startup/config/logging, WebSocket sessions,
  reconnect/snapshot patterns, host pairing, and encrypted relay transport.
- **Coding agents:** provider discovery, provider/model selection, process
  lifecycle, streaming results, and existing Codex/Claude integrations.
- **Speech mechanics:** useful microphone/audio primitives, resampling, VAD,
  local model management, and speech provider implementations after coupling is
  measured.
- **Protocol practices:** Zod wire schemas, capability negotiation, dotted RPC
  names, additive compatibility, and generated inbound validation.

### Add as Meetless-owned policy

```text
Meeting
  -> Recording
  -> TranscriptSegment[]
  -> MeetingChatThread[]
  -> Citation[]
```

Minimum lifecycle model:

```text
Meeting:    draft -> recording -> processing -> ready -> archived
Recording:  recording -> finalizing -> saved
                     \-> interrupted -> recoverable | failed
Transcript: pending -> transcribing -> ready | failed
Chat:       ready -> running -> ready | failed
```

The meeting core accepts plain IDs, time ranges, paths, text, and lifecycle
values. It must not import Electron objects, WebSocket messages, provider SDK
types, or Paseo agent/workspace records.

### Dependency direction

```text
Expo/Electron UI -> meeting use cases <- daemon adapters
                                      <- recording adapters
                                      <- transcript providers
                                      <- retrieval index
                                      <- coding-agent adapter
```

Expected independent changes and their boundaries:

| Predicted change | Boundary | Smallest proof | Remove boundary if |
| --- | --- | --- | --- |
| System capture differs across macOS, Windows, Linux, and browser | `RecordingSource` adapter | Each supported adapter produces the same recoverable recording contract | Meetless permanently supports one capture runtime |
| Local and remote transcription may change independently | `TranscriptionProvider` | One audio fixture yields ordered, timed segments through each supported provider | Only one implementation remains and the port isolates no policy |
| Coding-agent providers vary while meeting chat stays stable | Existing agent provider infrastructure plus a Meetless chat adapter | Codex and a deterministic fake answer from the same bounded meeting context | Meeting chat stops using coding agents |

### Coding-agent integration

Do not map a meeting or meeting chat session to a Paseo agent or workspace. The
user starts an agent run for a question scoped to the open meeting. Meetless
supplies explicit tools such as:

```text
get_transcript_segments(segment_ids)
```

The application resolves citations from returned stable IDs. A model-generated
free-form timestamp or path is display text, not trusted citation identity.

## Approach

### Milestone 0: establish the safe Paseo adoption strategy

- Inventory exact Paseo packages and files required by the P0 loop.
- Decide how an independent Meetless repository consumes a maintained Paseo
  fork without copying Meetless product policy into Paseo. Record repository
  ownership and upstream-update strategy before implementation.
- Audit AGPL and third-party licenses for the intended distribution model.
- Run a desktop capture spike that proves microphone plus Zoom/Meet system audio
  on the first selected desktop OS.
- Decide the first supported desktop OS and define the remaining V1 platform
  matrix from evidence, not from the shared UI alone.

Acceptance boundary: a small spike records both sides of a real or controlled
Zoom/Meet call and the repository has an accepted adoption/update decision.

Current state: Milestone 0 is complete. The adoption decision, inventory,
license limits, product authority, and evidence-bounded platform matrix are
recorded. A controlled two-participant Google Meet produced distinct
microphone/system artifacts and a mixed MP3 on macOS 26.4 arm64. See
[`docs/macos-capture-spike.md`](../../macos-capture-spike.md). Milestone 1 has
also completed with the isolated Paseo runtime and real Electron, web, and iOS
meeting surfaces described below.

### Milestone 1: compose the shell and meeting domain

- Bring up the Paseo-derived daemon, Electron shell, web app, and one mobile
  client without importing coding workspace screens as the Meetless product.
- Add plain meeting lifecycle types and focused use-case tests.
- Add capability-gated, validated `meeting.*` plugin RPC contracts and
  Meetless client methods over Paseo's existing generic plugin RPC transport.
- Add a meeting store that owns atomic state transitions and paths.

Acceptance boundary: desktop creates and lists a meeting through real
client/daemon wiring; web/mobile can read the same list while connected.

### Milestone 2: durable desktop recording

- Implement the first `RecordingSource` adapter for microphone plus system
  audio.
- Stream recoverable chunks to the daemon-owned recording session.
- Finalize MP3 with collision-safe naming under the requested default folder.
- Implement recording/finalization/recovery UI and lifecycle events.

Acceptance boundary: a controlled Zoom/Meet call contains both speakers; a
forced renderer exit leaves recoverable audio; stop produces a playable MP3
without overwriting an existing file.

#### Milestone 2 implementation contract

`FOUNDATION_CHECK v1` (2026-08-17):

- **State owner:** the daemon-side Meetless plugin, through one extended
  `MeetingStore`, owns recording lifecycle, committed-chunk inventory,
  finalization intent, and saved output identity. The renderer is a controller
  and observer. Media files are durable evidence, not a second lifecycle owner.
- **Lifecycle:** `recording -> finalizing -> saved`; capture or finalization
  interruption becomes `interrupted -> recoverable | failed`; `recoverable`
  can re-enter `finalizing`. Valid committed chunks make transient capture,
  helper, encoder, and I/O failures recoverable. `failed` is reserved for
  proven unrecoverable media loss or corruption.
- **Cross-boundary invariants:** at most one active recording; every committed
  chunk has exactly one `microphone` or `system` source identity; pause/stop is
  acknowledged only after open chunks are durably closed; existing exports are
  never replaced; source chunks remain until the published MP3 is readable and
  the exact saved path and identity have been durably recorded.
- **Required mechanisms:** a supervised signed Swift ScreenCaptureKit helper;
  daemon-allocated session directories; temporary-write, file-sync,
  atomic-rename, and directory-sync chunk commits; an immutable finalization
  chunk-set digest; same-filesystem MP3 staging; durable publish intent; atomic
  no-replace publication; decode/readability and identity verification; startup
  reconciliation; serialized retry; cleanup only after durable `saved`.
- **Dependency direction:** route-independent Expo controls -> desktop-only
  local control adapter -> daemon recording use cases <- `MeetingStore`, chunk
  filesystem, `RecordingSource`, and MP3 finalizer adapters. Native, filesystem,
  codec, Electron, and WebSocket types do not enter recording policy.
- **Status:** `FOUNDATION_ACCEPTED` at
  `ebfc456b18c56fad5fabed90d1ceb42a0c536379`. The extended store atomically
  couples Meeting and Recording transitions, rejects inconsistent persisted
  lifecycle families, preserves immutable finalization intent across retry,
  and gates chunk cleanup on the exact readable, durably saved output. Lead
  verification passed 53 focused tests and the full 54-test typecheck,
  build, and Expo-export gate; independent correction review accepted the
  frozen commit with no material finding.

`PLAN_RECONCILIATION v1` (2026-08-17, after the third accepted Milestone 2
frontier):

- **Accepted and absorbed:** the macOS capture boundary, crash-safe durability
  boundary, and durable lifecycle foundation are no longer discovery work.
- **Dependency order:** unchanged. Implement one integrated desktop recording
  slice against the accepted store, then freeze/review it, then run automated
  renderer-exit, daemon-restart, collision, and retry proofs before the
  controlled two-speaker Zoom/Meet call.
- **Ownership:** keep the native helper, daemon service, finalizer, private
  desktop transport, and global controls in one integration frontier because
  their protocol and recovery behavior meet at the acceptance boundary. Do not
  open parallel writers over those moving contracts.
- **Scope check:** unchanged. Milestone 2 ends at durable playable recording;
  transcription, citation playback, transcript reading, and meeting chat remain later
  milestones.

`LIVE_ACCEPTANCE_HANDOFF v1` (2026-08-17):

- **Candidate:** integrated implementation `185919b63ae797ad102317d72d91716d05f48c81`
  remains the accepted automated candidate; this live attempt did not modify it.
- **Attempt result:** failed before capture. A two-participant Google Meet was
  active with the host camera off and microphone on, and the owner reported
  speaking both requested phone phrases. However, the recording-control socket
  refused connections, no capture helper was running, the daemon-owned meeting
  store contained no recording files, and no MP3 or collision artifact was
  produced. The phrases therefore cannot be treated as recorded evidence.
- **Acceptance:** Milestone 2 remains incomplete. Automated fixture evidence is
  not a substitute for the missing production ScreenCaptureKit call artifact.
- **Retry order:** prove an authoritative active production recording and live
  microphone/system chunk commits; prepare the stop/finalization and collision
  evidence targets; only then create/join the controlled call and request owner
  phrases; finally stop, decode-probe, inspect both sources, and verify the
  collision target remained byte-identical.
- **Evidence:**
  [`test/evidence/m2/20260817T135955Z-live-failed/manifest.json`](../../../test/evidence/m2/20260817T135955Z-live-failed/manifest.json).

`FOUNDATION_CHECK v1 — M2 local TCC host prerequisite` (2026-08-17):

- **Responsible application:** the immutable local
  `~/Applications/Meetless.app` bundle, identifier `com.meetless.app`, is the
  sole Meetless-owned TCC identity. It is launched only through LaunchServices
  and remains alive above the existing desktop CLI, isolated daemon, Meetless
  plugin, and direct `meetless-capture` helper. Paseo.app, Terminal, Codex, and
  direct bundle-executable launch are not accepted responsible ancestors.
- **Preserved architecture:** Electron remains the recording controller; the
  daemon plugin and `MeetingStore` remain the sole recording-session authority;
  the helper stdin/stdout protocol, persistence, finalization, collision, and
  cleanup lifecycles are unchanged. No second capture app or IPC channel exists.
- **Local identity:** `npm run host:install` creates and ad-hoc signs the frozen
  local bundle once, then records its canonical path, designated requirement,
  CDHash, executable inode/size/SHA-256, and exact repository/runtime launch
  configuration. A valid installation is left byte-identical by ordinary
  builds and repeated install commands. Drift fails closed; replacement is
  explicit through `npm run host:install -- --replace` and requires regranting
  capture only to `~/Applications/Meetless.app`.
- **Lifecycle commands:** `npm run runtime:host` attests the installed identity
  and invokes `open`, while `npm run runtime:host:stop` terminates only the exact
  LaunchServices-owned host and lets it propagate shutdown through its owned
  composition. Production desktop startup and pre-owner readiness reject a
  runtime whose supervisor chain is not
  `MeetlessHost -> desktop CLI -> Paseo Supervisor`.
- **Observed local identity:** designated requirement
  `cdhash H"63923ac54863b9f1733cb5203cfd60ca77a43dc3"`, CDHash
  `63923ac54863b9f1733cb5203cfd60ca77a43dc3`, and host binary SHA-256
  `778cecc4cf526724c7dc525b3bbc806c841e35d65a42016782825b112d83213d`.
  Repeated corrected LaunchServices starts retained that identity. The final
  observed chain was host PID `64735`, desktop PID `64738`, supervisor PID
  `65262`, daemon PID `65319`, and plugin PID `65328`.
- **Recording-authority guard:** immediately before a production recording
  creates a session or helper, the Meetless plugin verifies that its live
  process ancestry contains the configured host PID and that the host's live
  executable path/device/inode/size/SHA-256/CDHash/designated requirement match
  the recorded installed identity. Direct daemon/plugin/socket production
  starts fail before helper spawn; the observed direct daemon rejection created
  neither recording socket nor helper. Existing fixture-mode tests remain
  exempt, and generic meeting create/list remains available without bootstrapping
  the recorder or granting recording control.
- **Bounded shutdown and replacement:** desktop SIGTERM/SIGINT cancels startup,
  closes Electron and the renderer, asks the owned supervisor to drain its
  daemon/plugin/helper, and verifies release of the recording socket and 6777;
  a bounded owned-process-group kill is the final fallback. Active recording
  shutdown persists the accepted interrupted/recoverable state. Install and
  replacement refuse while the exact installed host is live.
- **M2 provenance limit:** `ppid == 1`, the exact installed live identity, and
  the repository LaunchServices launcher are sufficient observable provenance.
  Cryptographic anti-reparenting and adversarial detached local-process spoof
  resistance remain deferred hardening outside M2 authority.
- **Open proof condition:** the preserved store contains terminal failed records
  with no readable committed chunks, including
  `16036ac4-09bf-4132-a3fe-903ee1eaf445`; the currently selected latest record
  is `544255a2-6808-499f-9ee3-07c1e24b2167`. The default store therefore reports
  authoritative `failed`, not `idle`. This host frontier does not alter or
  delete daemon state. Lead must disposition the failed record through the
  accepted recording lifecycle before the owner-facing capture attempt.
- **Milestone 7 deferral:** Developer ID signing, hardened runtime, notarization,
  production packaging, clean-install attribution, and distribution remain M7
  gates. They are not added to this bounded local M2 host.

`LIVE_PARTIAL_RECOVERY_HANDOFF v1` (2026-08-18):

- **Candidate and route:** candidate
  `c82da856d25a2f4a59e24e7e46ea440a77ed5b7b` ran through the installed
  `~/Applications/Meetless.app` host and real Electron controls. Production
  recording `c6bc6fd6-a254-4ea3-8b00-480b2bc1ed84` started with helper PID
  `39773`; both source types committed and pre-owner collision evidence was
  prepared.
- **Partial result:** the owner reported only the phone/system phrase, “Phone
  audio confirms the system recording channel.” No local microphone phrase was
  supplied. Phrase audibility and a playable MP3 remain unproved; no
  finalization or source cleanup occurred.
- **Retained source state:** after host shutdown and queued-event drain, the
  daemon store retained 20,136 committed chunks (12,926 microphone and 7,210
  system). The durable record incorrectly remained `recording` with no helper;
  immediate relaunch then timed out while bootstrap revalidated every known
  chunk. The correction must expose this retained session as `recoverable`
  without replacing or deleting its chunks.
- **Evidence:** the compact identity manifest is
  [`test/evidence/m2/20260818T031937Z-live-partial/manifest.json`](../../../test/evidence/m2/20260818T031937Z-live-partial/manifest.json).
  The collision sentinel remains intact at
  `/Users/tubakhuym/Documents/meetings/09-18-08-26.mp3`, with planned output
  `09-18-08-26-2.mp3`; its content hash is explicitly unclaimed because bounded
  reads from the protected Documents location did not complete.
- **Later owner action:** after Lead accepts recovery and a fresh production
  preflight, physical presence near the Mac with the phone is still required
  for both the microphone and system phrases. This handoff does not request
  that action.

`FOUNDATION_CHECK v1 — M2 scalable inventory recovery` (2026-08-18):

- **Trigger evidence:** production validation at candidate `b0fa863` found
  340,944 committed-name WAV files for recording
  `c6bc6fd6-a254-4ea3-8b00-480b2bc1ed84`, while MeetingStore knew 20,136
  before the attempt. The synchronous orphan loop adopted 567 entries through
  567 whole-store rewrites, then the bootstrap RPC timed out after 30 seconds.
  Durable state remained stale `recording`; 320,241 unknown WAVs remained.
- **State owner:** MeetingStore remains the sole recording lifecycle authority.
  A recording-owned immutable inventory sidecar is durable media metadata, not
  a second lifecycle store. MeetingStore atomically publishes its path, digest,
  counts, and reconciliation state.
- **Lifecycle:** stale capture first becomes
  `recoverable + inventory: pending` in one bounded atomic store mutation. The
  control socket and compact authoritative status may then open while a
  cancellable background scan builds an unreferenced candidate inventory.
  Only a fully validated, synced, content-addressed inventory may atomically
  transition to `inventory: complete`. Missing or identity-changing previously
  committed chunks transition reconciliation to `blocked` rather than silently
  dropping media.
- **Cross-boundary invariants:** Start remains blocked by the unresolved
  session. Retry/finalization and cleanup are forbidden while inventory is
  pending, scanning, or blocked. Finalization freezes and consumes the exact
  completed inventory digest. Every original WAV remains until a readable MP3
  exists and `saved` is durably committed. Cancellation or crash may leave an
  unreferenced candidate sidecar, but never a partially authoritative inventory.
- **Required mechanisms:** stream directory entries with bounded concurrency;
  validate containment, filename/timeline identity, WAV readability, size, and
  hash; publish one immutable inventory with one MeetingStore pointer commit;
  expose bounded source counts/reconciliation/retry eligibility instead of the
  complete chunk array; build at most one staged timeline per source before the
  final MP3 mix. Do not construct one FFmpeg input/filter per raw WAV.
- **Recurrence prevention:** normal ScreenCaptureKit callback jitter must not
  flush a chunk. The helper targets approximately one-second chunks and closes
  early only for pause, stop, or a genuine timeline discontinuity. Real gaps
  remain represented by timestamps. Validation includes an explicit upper
  bound on chunks produced per recorded minute.
- **Dependency direction:** recorder status/UI and finalization consume the
  compact inventory policy; the scanner, sidecar codec, filesystem, helper,
  and FFmpeg remain outer details. No renderer-owned capture or lifecycle state
  is introduced.
- **Required proof:** a 340,944-file production-derived scale case reaches
  authoritative `recoverable/pending` within the desktop startup bound; retry
  is unavailable before completion; cancellation at scan and publish boundaries
  never changes the authoritative partial count; completed counts include every
  valid microphone/system file and all previously committed identities; the
  bounded two-source finalizer produces a readable MP3 without deleting source
  WAVs before durable `saved`.
- **Status:** `STABLE` at candidate
  `6921456f451ca51f49d09b661a2e8d2e4f897b77`, which includes scalable inventory
  candidate `384102a1d9fb0d2c8939bbeaa082eed78a68484c` plus authoritative native
  source-failure propagation. The accepted proof covers 340,944 entries,
  exact known identities and canonical digest, cancellation without partial
  adoption, overlap/backward-PTS rejection, current-byte revalidation, bounded
  two-source finalization, and compact status. Candidate `b0fa863` remains
  accepted only for renderer failure-status propagation.
- **Source-failure review disposition:** `CLOSED`. At current HEAD, the
  production ScreenCapture callback emits authoritative `captureFailed` when a
  writer rejects backward PTS instead of swallowing the error. A fresh
  `npm run build:native` and the seven-test capture-helper supervision suite
  passed on 2026-08-18; no capture or owner action was used for this check.
- **Production recovery result:** `PASS` at repository candidate
  `ced1ad95bf17568e77e1af13903943b8f112c338`. Launch through the installed
  MeetlessHost exposed authoritative `recoverable/scanning` within 20 seconds,
  with Retry unavailable and no helper. Reconciliation then atomically
  published a 340,944-entry inventory (215,718 microphone, 125,226 system),
  cleared inline chunks, and enabled Retry. The immutable sidecar contained
  exactly 340,944 lines and its SHA-256 matched the durable pointer digest
  `cc9753501b16edbf1353ed58f91de07298b8bf54e3ee894bee554de9a8c1c31f`.
  MeetlessHost shutdown removed the complete owned runtime tree, ports, socket,
  and lock while preserving `recoverable/complete`, the pointer, digest, and
  every source WAV. Accessibility inspection did not yield a usable Electron
  window, so rendered Retry visibility remains explicitly unobserved.
- **Partial-run finalization result:** `PASS` for durability/playability only.
  The host-owned control protocol finalized the recovered inventory to
  `/Users/tubakhuym/Documents/meetings/12-18-08-26.mp3`. FFprobe decoded MP3,
  16 kHz mono, duration 2,504.567063 seconds, size 12,796,893 bytes. File
  SHA-256 `afa8c84210fca393d35546145aa6819d6c5d8f975a9b035fd69928e14c7ddcca`
  exactly matches MeetingStore's durable saved identity. Original WAV cleanup
  occurred only after `saved`; the immutable inventory sidecar remains. This is
  not M2 acceptance: the phone phrase has not been audibility-verified and no
  local microphone phrase was supplied. The evidence manifest records that
  boundary without upgrading either channel claim.
- **Next production gate:** when the owner is physically at the Mac, start a
  fresh production session and request the bounded owner retry only after
  authoritative active status, exact production helper identity, committed
  microphone and system chunks, and prepared collision/finalization targets
  are all observed.
- **Remote-owner retry result:** `PARTIAL`, not M2 acceptance. After the closed
  backward-PTS failure-propagation proof and a fresh production pre-owner pass,
  temporary Meet `xch-vupi-wuc` captured the owner's reported phone/system
  phrase only. The owner was not physically near the Mac, so no local
  microphone phrase was supplied. Stop durably saved a readable 16 kHz mono MP3
  at `13-18-08-26-2.mp3`; the prepared `13-18-08-26.mp3` collision sentinel
  remained byte-identical. The evidence manifest preserves the playable and
  no-overwrite facts while explicitly leaving phrase audibility, microphone,
  and both-speaker acceptance unproved.
- **Precise remaining owner action:** at a later time when physically beside
  the Mac with the phone, complete one fresh bounded call: say the phone/system
  phrase, mute the phone, then say the local microphone phrase toward the Mac.
  Lead must again prove active production readiness before supplying that call
  link and must inspect the finalized artifact before accepting M2.
- **Final live acceptance (2026-08-18):** `ACCEPT` for the documented M2
  functional boundary at candidate
  `26b29ec38c6f1c21eef61064aea514f67fef4485`. A fresh MeetlessHost production
  preflight attested the exact helper with no fixture arguments, authoritative
  active status, committed microphone/system chunks, and prepared stop and
  collision targets before temporary Google Meet `iir-kqyx-aus` was created.
  The owner separately heard the exact phone phrase in the source-labelled
  system clip and the exact local phrase in the source-labelled microphone
  clip. Both were intelligible but noticeably distorted/static-like; no clean
  or normal-quality claim is made. Stop published readable MP3
  `22-18-08-26-2.mp3` without changing the prepared `22-18-08-26.mp3`
  sentinel, durably saved the exact path/size/hash before raw cleanup, retained
  the immutable inventory sidecar, and the full Meetless runtime then shut down
  cleanly.
- **Acceptance ruling:** degraded-but-intelligible audio satisfies the existing
  M2 boundary of distinguishable speakers plus playable durable recording; the
  boundary did not specify clean/studio-quality audio, so Lead does not add
  that criterion retroactively. The distortion is nevertheless a real
  release-quality risk: its cause and remediation must be decided before M7
  release acceptance, and this evidence must not be presented as normal audio
  quality.

Reconciliation note (2026-08-19): the earlier partial-run “next production
gate” and “remaining owner action” entries above are retained as historical
evidence and were superseded by final acceptance. Runtime candidate `26b29ec`
produced the accepted call; commit `55e5c2e` published the final evidence and
acceptance record.

The first `RecordingSource` is one macOS 15+ Swift helper using one
ScreenCaptureKit stream with separate `.audio` and `.microphone` outputs. The
daemon plugin supervises it over a small source-labelled control/event
protocol. EOF or helper failure durably closes completed chunks and makes the
session recoverable. Keeping the stream alive while paused, closing current
chunks before pause acknowledgement, discarding paused buffers, and starting
new chunks on resume makes elapsed time and the saved timeline exclude paused
duration.

Recording commands and status use Paseo's existing Electron-only local
transport to a private daemon-plugin control socket. Generic plugin RPC remains
the meeting/companion API but is not the recording-control authority because it
does not identify an Electron caller. Web and mobile therefore cannot obtain
the V1 recording capability merely by connecting to the daemon.

Chunk recovery adopts only fully renamed, readable source chunks with valid
identity; temporary files are ignored or quarantined. Finalization persists a
publish intent before atomic no-replace publication. After a crash between MP3
publication and the `saved` transition, restart may adopt that exact readable
output only when it matches the persisted identity; otherwise the existing file
is untouched and a new collision-safe destination is selected. Retry reuses the
same committed chunks and never records the meeting again.

Milestone 2 host proof may use an explicitly resolved and attested local
`ffmpeg` with MP3 support. Bundling its dynamic libraries, license notices,
signing, hardened-runtime configuration, notarization, and clean-install
permission attribution remain Milestone 7 distribution gates; they do not
weaken Milestone 2's source build, executable hash, real-host permission, or
both-side call evidence.

### Milestone 3: transcription and audio-grounded citations

`FOUNDATION_CHECK v1` (2026-08-18): M2's saved-MP3 identity and atomic store are
accepted prerequisites. Current HEAD has no transcript/citation model, and the
pinned Paseo OpenAI adapter cannot satisfy the accepted model, bilingual, or
credential boundary. Milestone 3 therefore first adds a Meetless-owned
transcript foundation and does not route the key through Paseo, Node, Electron,
the isolated daemon, or renderer.

- The signed `MeetlessHost` owns a native OpenAI transcription capability. It
  reads the exact Keychain item in process, calls only the official OpenAI
  endpoint, and returns normalized transcript/status data over private IPC;
  plaintext credentials never cross that boundary. A host-owned native secure
  configuration/disclosure flow may create or import the final Keychain item.
- `TranscriptionProvider` remains a Meetless interface. The sole production M3
  adapter is the native OpenAI capability; provider SDK/request types do not
  enter meeting policy, and no local provider is implemented.
- Meetless deterministically plans half-open audio ranges `[startMs, endMs)`
  from the exact saved MP3. Each checkpoint binds recording ID, MP3 SHA-256,
  planner version, ordinal, and range. Segment IDs are derived from that stable
  range identity, not provider wording, so retry text variation cannot break a
  previously issued citation.
- `MeetingStore` owns `pending -> transcribing -> ready | failed` transcript
  lifecycle, bounded retry metadata, request/usage counters, startup
  reconciliation, and immutable published transcript sidecars. Completed
  ranges checkpoint durably; a crash can duplicate only the in-flight request
  and cannot expose a partial transcript as authoritative.
- A saved recording automatically creates/resumes transcription after consent.
  `failed` remains retryable from the same MP3 without recording again;
  `meeting: processing` becomes `ready` only after atomic transcript publish.
- Citation APIs accept only a known stable segment ID, resolve its authoritative
  saved-audio range in application code, and return/play a bounded audio
  interval. Model-written timestamps are never playback authority.

Acceptance boundary: committed minimal English, Vietnamese, and mixed-language
fixtures pass real bounded OpenAI transcription without translation; repeated
and restart/resume runs preserve segment IDs/ranges and completed checkpoints;
transient failure proves bounded retry and usage/request accounting; negative
inspection proves the credential is absent from process environments/arguments,
logs, manifests, renderer messages, meeting state, and published evidence; and
a real UI citation click audibly plays the expected spoken interval. M2
recording integrity checks remain green.

Live acceptance checkpoint (2026-08-19): the accepted OpenAI-only path passed
through the signed Keychain-trusted host and real Meetless UI. The final bounded
run scheduled exactly the three committed fixtures and completed each in one
request: English retained 4/4 expected tokens, Vietnamese retained 6/7 (85.7%),
and mixed English/Vietnamese retained 10/10 without translation. The narrow
Vietnamese correction preserved the exact phrase and Linh voice while slowing
delivery and adding a natural clause boundary; no provider, model, endpoint,
language, or acceptance-threshold change was made. All meetings became ready,
stable ranges/segment IDs resolved bounded MP3 citations, and restart
reconciliation retained all three published transcripts without another
provider request. A real Chrome click played the Vietnamese citation's
authoritative `[0, 3204)` ms interval with output temporarily unmuted at 20%; no
load/playback error appeared during the 4.06-second observation, and the prior
muted/0 output setting was restored immediately afterward. Live inspection of
23 process argument/environment sets plus runtime logs, manifests, renderer
artifacts, and meeting state found zero credential-name or key-shaped hits.
Passing evidence was atomically published at
`test/evidence/m3/20260819T153402Z-live/`. The exact isolated process tree then
stopped, and the original production meeting state was restored byte-for-byte
(12,871 bytes; SHA-256
`79cfbbbb64720b353d87d19553e058f6738edc0c7237456ee9216ca2f7334964`).

#### Post-M3 plan reconciliation

`PLAN_RECONCILIATION v1` (2026-08-19, after M1-M3 acceptance):

- **Accepted foundation:** M1 remains the frozen isolated Paseo composition;
  M2 remains accepted against its durable-recording boundary; M3 remains
  accepted against its bounded bilingual fixture, credential-isolation,
  restart, and citation-playback boundary. Milestone completion records the
  accepted evidence at that boundary, not a claim that Meetless is already
  product-ready.
- **Current correction gate:** a later manual product journey observed Start
  Recording fail during TCC/capture startup and leave a zero-chunk session in
  `recoverable`. With no committed media, that state contradicts M2's lifecycle
  contract and blocks the normal `record -> transcribe` path. Resolve this
  bounded regression and prove failure classification plus a fresh recording
  handoff before M4 relies on newly recorded input. M4 may use already
  published M3 transcript fixtures while the correction is isolated, but must
  not present that as end-to-end product proof.
- **Deferred release gaps:** static-like recording distortion, stable signing
  and permission attribution across replacement/update, packaging/notarization,
  long-recording transcription coverage, physical-device/LAN-or-relay companion
  proof, and single-window/visual-quality acceptance remain open. Audio,
  signing, packaging, and permission persistence are M7 gates; companion
  connectivity is M6/M7 work. Single-window behavior and visual quality need
  explicit acceptance authority before implementation rather than being
  inferred from M1's functional create/list proof.
- **Next dependency order:** reconcile and close the zero-chunk recording
  correction; then implement M4 against the accepted MeetingStore and M3
  transcript/citation contracts. Rerun M1 coexistence proof only if isolation,
  desktop authority, plugin transport, or shared app composition changes.

`POST-M3-ZERO-FIX` corrected candidate record (2026-08-20):

- **Diagnosis:** capture startup/helper interruption correctly enters inventory
  recovery before classification because zero store-known chunks can still hide
  valid durably renamed orphan WAVs. The defect was the reconciler's terminal
  `chunkCount === 0` branch: it treated a conclusive zero-media scan as an
  ordinary scan error, so `MeetingStore` persisted `recoverable/blocked` rather
  than lifecycle `failed`.
- **Candidate:** baseline `266f4e5` correctly added the domain-owned zero-media
  transition, MeetingStore delegation, and typed `ZeroValidMediaError`, but
  review found its start control response could settle while inventory was
  still `recoverable/pending`. The corrected descendant makes
  `startInventoryScan` return its existing scan promise and awaits that promise
  only in the recording-state start-failure path before rethrowing the original
  start error. Existing asynchronous startup/helper reconciliation and the M2
  `assessInterruptedRecording`/`MeetingStore.assessInterruption` API are
  unchanged. The exact correction commit is recorded in the peer disposition.
- **Behavior proof:** 44 focused domain/store/inventory/service tests pass. A
  gated scan proves the rejected start promise remains unsettled until the store
  already contains `failed`, zero chunks, pending inventory, and no retry
  eligibility. The positive startup path still discovers a valid store-unknown
  orphan WAV, publishes a one-chunk complete inventory, and remains
  `recoverable` with retry enabled. Missing/identity-changing committed media
  remains blocked.
- **Repository validation:** `npm run typecheck` passes. `npm run test:focused`
  completes with 172 passing tests and one unchanged runtime readiness timing
  failure (inner socket-request timeout text won a race against the expected
  outer startup-deadline text); that readiness file passes 18/18 in isolation.
  The exact final `git diff --check` result is recorded in the disposition.
- **Live-proof readiness:** the corrected automated candidate is ready for a
  fresh production capture-start failure and valid-media interruption handoff.
  No live product journey was attempted in this bounded writer scope; an
  existing Meetless desktop-managed runtime predates this frontier and was not
  changed or stopped. M4 remains unopened and newly recorded M4 input remains
  gated on Lead acceptance of this correction and any separately owned live
  handoff.

`POST-M3-LIVE-INPUT` candidate record (2026-08-20):

- **Observed cause:** LaunchServices owns the accepted accessory host at
  `~/Applications/Meetless.app` (`com.meetless.app`, `LSUIElement=true`), which
  starts runtime desktop and then spawns the repository Electron.app
  (`com.github.Electron`). Paseo creates that BrowserWindow hidden and its
  `ready-to-show` path only called `show()`. The spawned Electron application
  therefore rendered visibly without becoming the active app or focused
  window: Computer Use saw only the outer container and pointer/keyboard input
  did not reach the renderer. Invoking the exact window's macOS Raise action
  immediately activated it, exposed the HTML accessibility tree, and revealed
  both inputs as settable. The concurrent DerivedData SwiftUI application
  (`com.themrb.meetless`) is a separate identity and was neither used nor
  changed.
- **Candidate:** the Meetless Electron bootstrap now activates
  `com.github.Electron` with `app.focus({ steal: true })`, then shows and focuses
  each BrowserWindow when it is ready. Review correction
  `POST-M3-LIVE-INPUT-R1` replaces two incomplete partial-order checks with one
  complete mechanical order: isolated user-data path, listener registration,
  ready-to-show, app activation, window show/focus, then Paseo import. Positive
  checked-in proof and negative missing-app-activation, missing-window-focus,
  and import-before-listener fixtures name the active-plan authority and
  required correction. Host ownership, recording lifecycle, renderer UI,
  native applications, signing, and permissions are unchanged.
- **Live proof:** the repository-owned accepted chain was stopped and restarted
  through `npm run runtime:host:stop` and `npm run runtime:host`; LaunchServices
  relaunched `com.meetless.app` at the accepted path and the desktop-managed
  runtime became ready. Without a Raise action, Computer Use immediately saw
  the exact repository Electron HTML tree. Recording title accepted
  `POST-M3 live input proof`; Tab moved focus directly to Start, mechanically
  proving it enabled. Start was not invoked, no recording was created, and the
  proof title was cleared afterward. No OS permission was altered.
- **Validation:** corrected launcher guard and its positive/negative tests pass
  7/7;
  relevant composition passes 1/1; `npm run typecheck` passes. `npm run
  test:focused` completes with 174 passing tests and the same unchanged runtime
  host direct-launch timeout (empty stderr after five seconds). `git diff
  --check` and the exact candidate commit are recorded in the peer disposition.

`POST-M3-POINTER-HIT` candidate record (2026-08-20):

- **Corrected diagnosis:** the prior AX/set-value handback did not prove physical
  pointer interaction and the owner still reproduced failure. The pinned
  Electron hidden-titlebar overlay owns roughly y=0–29 while the old recording
  controls began at y=9 and placed their modeled center at y=29. Owner evidence
  confirmed a center click around y=25 missed while a lower-edge click at y=38
  reached the field. Durable `failed` state and its visible zero-media message
  do not disable Start; this was a hit-test overlap, not lifecycle policy.
- **Candidate:** only the desktop-gated global recording strip receives
  titlebar clearance. A pure pointer-geometry model sets the control top below
  the 29 px overlay plus the existing 9 px visual gap, yielding modeled
  `top=38`, `center=58`, and `minHeight=87`. The style consumes the same model.
  Negative proof shows the old center does not clear the titlebar; positive
  proof shows the corrected top and center do, while rendering preserves the
  authoritative failure message. No broader meeting UI or runtime/lifecycle
  code changed.
- **Physical live proof:** after repository-owned host stop/start, the 1490×768
  Electron window rendered title and Start at approximately y=30–61. A real
  coordinate click at title center `(533,46)` focused the recording title, and
  normal queued typing entered `POINTER-HIT-0836`. A non-invoking right-click at
  Start center `(1114,46)` opened the renderer context menu, proving pointer
  delivery below the titlebar without starting recording. The proof title was
  cleared afterward; zero-media failure remained visible and no recording was
  created.
- **Validation:** focused meeting-surface/meetless-app tests pass 22/22;
  composition passes 1/1; `npm run typecheck` passes. Final diff validation and
  candidate identity are recorded in the peer disposition.

`POST-M3-ELECTRON-HARNESS` authority and gate (2026-08-20):

- **Owner authority:** the 2026-08-20 project-owner directive extends this
  correction through capabilities 1, 3, 4, and 5 only. Playwright Electron
  renderer automation, a stable unique tested desktop identity, controlled
  UI-test-only accessibility, and one correlated UI-to-M3 proof are required;
  XCUITest is excluded.
- **Allowed boundary:** deterministic fixture capture and a controlled
  transcription provider may prove repository composition when they are
  explicitly labeled. Production keeps `com.meetless.app` as its sole host/TCC
  authority and must not force Chromium accessibility. Playwright/DevTools and
  AX events do not establish physical WindowServer pointer delivery or live
  Zoom/Meet source capture.
- **Forbidden boundary:** generic `com.github.Electron` identity in the new
  harness, production accessibility leakage, missing or mismatched
  renderer/socket/store/helper/chunk/MP3/transcript correlation, and regression
  to the old title-bar overlap must fail with actionable diagnostics.
- **Harness experiment:** the completed record is
  [`post-m3-electron-harness-improvement.md`](../completed/post-m3-electron-harness-improvement.md).
  It preserves the false-positive preflights, wrong identity, pointer overlap,
  Computer Use attachment failure, and owner interventions. A materially
  equivalent fresh agent discovered and exercised the capability without owner
  UI intervention; the bounded POC Harness decision is **Keep**.
- **Dependency disposition:** **OPEN FOR M4.** The implementation and fresh-agent
  Harness rerun are accepted, and the project owner subsequently observed the
  supported app complete a fresh recording -> transcript -> audible cited-audio
  flow. This manual observation is not an automated native-provider manifest or
  a release-readiness claim; the Harness `invalid` diagnostic remains tracked
  separately without blocking M4.

`POST-M3-E2E-IMPL` base candidate record (2026-08-20, superseded by
`POST-M3-E2E-IMPL-R1`; base commit
`83b981bd6a02e6155269dc4849f7e69a89e2984b`):

- **Implemented boundary:** the candidate adds Playwright Electron renderer
  smoke support through the experimental `_electron.launch()` API and an
  integrated LaunchServices proof that attaches to the exact host-owned,
  run-scoped renderer CDP endpoint. It uses logical identity
  `com.meetless.desktop`, exact `com.meetless.app` bundle path/CDHash, host ->
  desktop -> Electron ancestry, runtime instance ID, and fresh run ID. It does
  not create or install a second application or TCC owner.
- **Controlled runtime:** a one-shot expiring envelope under the accepted
  runtime root is consumed into a marker before CDP, fixture/provider controls,
  or optional forced accessibility are applied. Missing, malformed, expired,
  or mismatched envelopes fail closed to production behavior. The production
  bootstrap has no accessibility enablement; the integrated proof uses the
  least-required labels-only controlled mode and does not claim an AX event.
- **Correlated proof:** the deterministic fake-provider run passed title entry,
  visible Start/Stop, socket recording/saved/idle status, MeetingStore saved
  identity, helper and microphone/system chunk identities, MP3 SHA-256, and a
  ready generated transcript. It is explicitly fixture/generated evidence, not
  physical-click, TCC, or live Zoom/Meet evidence. The native-provider attempt
  reported the current signed-host capability as invalid and skipped without
  substituting fake evidence.
- **Mechanical negatives:** source/envelope tests cover generic identity,
  production accessibility leakage, invalid/missing envelope, each important
  correlation stage, and the accepted 29 px title-bar geometry. At the base
  candidate checkpoint, the Harness record still awaited a fresh rerun and M4
  remained closed.
- **Candidate validation:** `npm run test:post-m3` passed 29 tests;
  `npm run validate:isolation` passed 46; `npm run test:composition` passed 1;
  `npm run test:focused` passed 194; `npm run typecheck` passed;
  `proof:post-m3:smoke` passed as experimental renderer-only evidence; and
  package-level `proof:post-m3` passed deterministic fake evidence while
  reporting native capability `invalid` as an explicit no-substitution skip.

`POST-M3-E2E-IMPL-R1` is accepted at commit
`1cbba679f35b0fcc7117305dc0ea3c8197d9139c`. It corrects only the
accepted POC blockers: active marker host/desktop PID-start binding and owned
shutdown removal, same-UID `0700`/`0600` runtime-file enforcement, independent
installed-host/socket `runtime.uiTest`/trusted-bridge correlation with exact
Electron ancestry, nonzero native-incomplete proof semantics, and cleanup
failure reporting with preserved-state diagnostics. At this candidate
checkpoint, M4 remained closed pending the separate real-flow disposition.

R1 local evidence is focused and does not change that gate: `npm run
test:post-m3` passed 37 tests; `npm run validate:isolation` passed 54 tests;
composition and typecheck passed; the experimental renderer-only smoke passed;
the deterministic fake proof passed with generated-fixture labels; native-only
exited 1 with explicit `incomplete`/`native-provider-unavailable` and no fake
substitution; and combined `proof:post-m3` exited 1 with fake `passed` plus
native `incomplete`. Both proof manifests reported cleanup `passed`, including
staged-root removal, original-root restoration, and owned run-state removal.

The required fresh-agent rerun independently discovered the runbook and package
commands, passed the experimental renderer smoke, passed the complete
deterministic fixture correlation with the same 5,589-byte MP3 identity, and
passed 37 focused tests without retries or owner UI action. Native proof exited
1 as `incomplete` because the signed-host capability remains invalid, with no
fake substitution. Cleanup restored the original runtime digest and left no
owned processes or run-state files. This closed the Harness-improvement rerun
while the original real-flow gate remained open. The project owner's subsequent
supported-launch recording -> transcript -> audible cited-audio observation
satisfied that dependency for starting M4. The lossy native-provider `invalid`
diagnostic remains a caveat rather than a replacement for the accepted M3 and
owner-observed evidence.

### Milestone 4: meeting sidebar and transcript reader

- Reuse Paseo's sidebar layout, navigation patterns, responsive behavior, theme,
  and UI primitives without mapping meetings to Paseo workspaces.
- List Meetless meetings in the sidebar and route selection to a meeting detail
  screen.
- Render the selected meeting's complete ordered transcript with loading, empty,
  processing, failed, and ready states.
- Keep each displayed transcript segment connected to the accepted M3 citation
  and audio-playback behavior.

Acceptance boundary: through the real app/daemon composition, a user selects a
meeting from the sidebar, reads its complete ordered transcript, and clicks a
segment timestamp to hear the expected audio interval.

#### Milestone 4 implementation contract

`FOUNDATION_CHECK v1` (2026-08-20):

- **State owner:** `MeetingStore` and the meeting domain remain the sole owners
  of meeting and transcript lifecycle. `AppContent` owns transient selection,
  request ordering, and the existing citation-playback handle; the surface owns
  presentation only.
- **Lifecycle:** an unresolved selected-meeting request renders `loading`; a
  missing transcript renders `empty` unless its authoritative meeting is still
  processing; transcript `pending`/`transcribing` renders `processing` without
  exposing partial checkpoints; transcript or retrieval failure renders
  `failed`; only transcript `ready` renders the complete stored segments.
- **Cross-boundary invariants:** meetings remain Meetless records; the displayed
  ready segment order is the daemon/store order; timestamp interaction crosses
  the UI boundary with only the stable `{ meetingId, segmentId }` identity and
  continues through the accepted M3 resolver and bounded audio player.
- **Required mechanisms:** reuse Paseo's inspected 320 px desktop sidebar plus
  flexible detail pattern and its compact list-only/detail-only navigation;
  keep the global recording strip outside that navigation; preserve the
  existing M1 and post-M3 proof correlations while migrating their selectors.
- **Dependency direction:** `MeetingStore/domain -> plugin/client wire ->
  AppContent selection state -> meeting surface`; playback returns through
  `timestamp -> AppContent -> citation resolver -> M3 audio player`.
- **Status:** stable. No provider-selection, coding-agent, chat, durable-chat,
  cross-meeting retrieval, or document-folder dependency is required by M4.

`LEAD_RULING v1 — M4-UI-REVIEW-R1` (2026-08-20):

- **Decision:** accept deterministic snapshot
  `4fbbfdffc3dc06b3aa09a99dc233953ecba8724a967e5e5a8dddef59a1bdac9a`
  at base `8ee00b6d5e9b610e014f2dbad330d63b73f1adb9` as the frozen UI candidate.
- **Observed behavior:** desktop renders the meeting sidebar and selected detail
  together; compact clients replace list with detail and expose Back; selecting
  the whole row opens the meeting; the five transcript states are explicit;
  non-ready checkpoints are hidden; ready timestamps carry only M3 citation
  identity.
- **Review correction:** the first candidate removed selectors consumed by the
  accepted M1 and post-M3 proof scripts. The replacement migrates M1 to the
  unique meeting-row ancestor, migrates post-M3 to the meeting row and
  `transcript-ready`, and flattens duplicate failed-state dispatch. Independent
  correction review found no remaining material issue.
- **Verification:** 24 targeted surface/app/playback/recording tests, 47
  post-M3 checks, relevant typechecks, script syntax checks, Expo web export,
  and `git diff --check` pass. The known direct-host five-second stderr timing
  failure remains outside M4 and unchanged.
- **Open acceptance dependency:** exercise a generated multi-range target and a
  distractor through the real installed-host app/daemon composition, verify
  exact complete order and timestamp-to-audio correlation, and restore the
  pre-run runtime state before marking M4 complete.

`DEPENDENCY_REQUEST v1 — M4-PROOF` (2026-08-20):

- The installed-host proof reached the selected target in the real Electron
  renderer, but the visually selected row exposed no `aria-selected`,
  `aria-current`, `aria-pressed`, or equivalent selected-state semantic.
  `accessibilityState={{ selected: true }}` did not reach the rendered DOM.
- Evidence publication failed closed. The proof's 12 positive/negative checks,
  47 post-M3 checks, typecheck, and cleanup passed; the pre/post owner-runtime
  digest matched byte-for-byte at
  `44eff9f3054d51752601da256df9e77be74446241dbf3b1b40a0d61f4ec78533`.
- **Lead ruling:** M4 remains open. Correct only the sidebar row's truthful
  accessibility semantic, then rerun the unchanged real-composition proof.

`REOPEN_REQUEST v1 — M4-FINAL-REVIEW` (2026-08-20):

- The selected-row correction made the real proof pass its product path, and
  the owner runtime again restored to the identical digest. Final review found
  that the proof-owned private temporary directory still retained its clicked
  citation MP3 and screenshot even though the manifest reported cleanup passed.
- The publication validator also did not mechanically require every recorded
  cleanup boolean and rejected private paths through an incomplete denylist.
- **Lead ruling:** product behavior remains accepted; M4 remains open only for
  proof cleanup/publication. Remove exact proof-owned temporary artifacts on
  success and failure, require their absence before publication, validate every
  cleanup fact and a strict privacy-safe manifest, then publish a fresh run.

`PLAN_RECONCILIATION v1 — M4-CLEANUP-CONVERGENCE` (2026-08-20):

- **Finding family:** two review rounds exposed one shared proof-cleanup/privacy
  gap: first the fresh clicked-audio root survived, then older attempt roots and
  additional raw-audio/log manifest channels were found.
- **Authoritative mechanism:** every M4 run owns one exact run-identity temporary
  root; its `finally` path removes only that validated non-symlink root on both
  success and failure. Publication requires all runtime/restoration booleans,
  zero owned host PIDs, and observed artifact-root absence. The only promotable
  evidence is a non-empty screenshot in an exact staging directory whose file
  set is allowlisted and atomically renamed after cleanup. Recursive manifest
  validation rejects absolute paths, raw/source fields, and byte payloads.
- **Historical convergence:** all exact earlier M4 attempt roots were inspected
  and moved to Trash; a final `/private/tmp` root audit found none remaining.
  Positive/negative validation covers cleanup facts, private paths, raw audio,
  raw logs, and byte payloads.
- **Routing guard:** one final read-only correction review is allowed. Any new
  finding in this same cleanup/privacy family stops symptom-level patching and
  proof reruns; Lead must freeze the history and revisit the shared mechanism
  before dispatching more work.

`LEAD_ACCEPTANCE v1 — M4` (2026-08-20):

- **Decision:** accept deterministic candidate
  `2ec7822d612f325b397e0aef4d73b35596c3170742df0645495de18b8f4f71bb`
  at base `8ee00b6d5e9b610e014f2dbad330d63b73f1adb9` and close Milestone 4.
- **Real composition:** installed-host run
  `m4-proof-1787239284747-1fcf4d87` rendered the target and distractor Meetless
  meetings, exposed truthful selected-row semantics, and rendered the target's
  exact three authoritative segments in order with no distractor text.
- **Playback:** clicking the third timestamp resolved the target meeting,
  recording, segment, text, and `[60000,65000)` range; browser media time
  advanced to the bounded five-second stop and the clip analyzed as the
  generated 880 Hz marker.
- **Preservation and cleanup:** the accepted installed host/run/renderer/store
  identities correlated; no host PID, run state, proof temporary root, source
  audio, trace, or private path remained in durable evidence. The owner runtime
  restored byte-for-byte with matching digest
  `44eff9f3054d51752601da256df9e77be74446241dbf3b1b40a0d61f4ec78533`.
- **Repository proof:** 213 focused tests, 20 M4 validator tests, 47 post-M3
  tests, typecheck, Expo web export, syntax checks, and `git diff --check`
  passed. Final read-only review found no P0-P2 issue.
- **Evidence:** manifest
  `test/evidence/m4/m4-proof-1787239284747-1fcf4d87/manifest.json` has SHA-256
  `82d841dcb6719540930cf895100479bcc31e5bf7b2763c2bfcd6d688238b8071`;
  screenshot SHA-256 is
  `26edd2bcbac2955cd93fb6eb2d28e58a0defce71c90ba98889c323a965329f15`.
- **Boundary:** this is generated-fixture, machine-observed browser playback
  evidence. It does not claim live capture, native-provider transcription,
  human-heard speaker output, CI/branch enforcement, or release readiness.

### Milestone 5: chat with one meeting

`FOUNDATION_CHECK v1 — M5` (2026-08-21):

- **State owner:** `MeetingStore` is the sole durable owner of one V1 chat
  thread per meeting, ordered messages, attempts, provider/model values,
  retrieved segment IDs, validated citations, and failure/retry state.
- **Lifecycle:** chat is `ready -> running -> ready | failed`. Starting a turn
  atomically appends one user question and one running attempt. Only one turn
  can run. Retry reuses that user message and creates a new attempt. Restart
  changes running work to retryable failed and never replays it.
- **Cross-boundary invariants:** durable chat contains only Meetless IDs and
  plain values. A supported answer has at least one unique citation. Every
  citation was retrieved by that attempt and resolves through the thread
  meeting's immutable ready M3 transcript. Insufficient evidence has no answer
  text and no citations; the surface renders its canonical status wording.
  Provider, timeout, and malformed-output failures stay operational failures.
  Durable Meetless messages are the only later context authority.
- **Required mechanisms:** schema v4 with lossless v1-v3 migration; strict
  corruption gates; one-thread and one-active-turn checks; serialized atomic
  store mutation; separate completion and operational-failure transitions;
  explicit restart reconciliation with no replay.
- **Dependency direction:** meeting chat policy uses plain values; `MeetingStore`
  binds citations to the M3 transcript. Later coding-agent and retrieval
  adapters depend on this foundation. No Paseo agent, workspace, session, or
  timeline identity enters domain or store state. The accepted neutral shared
  execution cwd and one auto-archived agent per question remain later adapter
  concerns and are not persisted here.
- **Status:** `FOUNDATION_ACCEPTED`. Lead accepted candidate `7042c0b` after
  inspecting the durable contracts, persistence boundary, migration behavior,
  and failure/retry lifecycle.
- **Candidate evidence:** `7042c0b` is the accepted M5 foundation candidate.
  `npm run test:focused` passed 36 files and 236 tests;
  `npm run typecheck` passed; the focused domain/store rerun passed 6 files and
  48 tests; and `git diff --check` passed. The M5 progress item remains open.

- Reuse Paseo provider/model discovery, provider selection, agent execution,
  streaming, chat composer, and message presentation where their behavior fits.
- Scope each chat thread and every retrieval call to the currently open meeting.
- Give the coding agent bounded transcript retrieval tools and validate returned
  transcript segment IDs before rendering citations.
- Persist meeting chat messages so leaving the meeting or restarting the app
  does not discard the thread and reopening the meeting can continue it.
- State that the meeting lacks enough evidence when its transcript cannot
  support an answer.

Acceptance boundary: through the real composition, Codex answers a supported
question about a recorded fixture with a citation that opens the expected
transcript/audio interval; after an app restart the meeting restores that chat
history and can continue it; and an unsupported question returns the explicit
insufficient-evidence response.

`LEAD_ACCEPTANCE v1 — M5` (2026-08-21):

- **Decision:** accept candidate
  `e0b7e067ac11947991955bf41eafdc36eda6184e` and close Milestone 5.
- **Candidate:** the accepted boundary includes the
  accepted durable foundation, strict chat RPC contracts, Paseo provider/model
  selection, one disposable neutral agent per question, opaque meeting-scoped
  MCP retrieval, validated same-run citations, restart/retry behavior, chat UI,
  composition proof, and durable evidence.
- **Real composition:** installed-host run
  `m5-proof-1787252645153-a13cc0c1` used real Codex `gpt-5.6-sol`. It answered
  the supported 880 Hz question with the third segment, opened and bounded the
  cited five-second 880 Hz audio interval, restored the durable thread after an
  exact-host restart, and returned `insufficient_evidence` with null text and
  no citations for the unsupported question. Both turns used zero operational
  retries.
- **Privacy and cleanup:** the persisted meeting state contained no Paseo agent,
  workspace, session, or timeline identity. Raw provider errors are replaced
  before durable or wire state. The neutral workspace was absent from the
  active registry after restart. Archive failures stay observable and retain
  ownership for retry. The run removed all owned process, state, staging, and
  artifact roots. The original runtime was restored byte-for-byte with digest
  `fd0bcd22dc1814b81dc89ce4b777ba1f1107bac04cfbc32678dff27e0c145ac8`.
- **Repository proof:** typecheck passed; focused tests passed 37 files and 248
  tests; composition passed 2 files and 2 tests; the full suite passed 46 files
  and 299 tests; the M5 evidence validator passed 14 tests; and `git diff
  --check` passed.
- **Evidence:** manifest
  `test/evidence/m5/m5-proof-1787252645153-a13cc0c1/manifest.json` has SHA-256
  `0dd6bae129df0b27d9c00aa675b82f2b37e5c1646fd79961cbce181ed2fd0164`;
  screenshot SHA-256 is
  `63a4b938a4b6223b3c72d2af4e69951520a974bfd1bf2025a2fbf4e8698a05bb`.
- **Independent review:** DEEP review found and closed
  `M5-P1-PRIVACY-001`, `M5-P2-CLEANUP-001`, and
  `M5-P2-CLEANUP-002`. Final CLOSEOUT on candidate `e0b7e06` returned
  `CLOSEOUT_NO_FINDINGS` with no new material direct regression.
- **Evidence limit:** this is generated-fixture, machine-observed browser audio
  evidence. It does not prove live Zoom/Meet capture, native-provider
  transcription, human-heard speaker output, CI or branch enforcement, or
  release readiness.

### Milestone 6: companion web/mobile experience

- Present meeting list/detail, transcript, chat, and cited audio on web/mobile.
- Support direct LAN pairing and Paseo's encrypted relay with the existing
  reconnect behavior.
- Make daemon-offline state explicit.

Acceptance boundary: a physical paired mobile client completes the same
grounded question, citation, and audio-playback path through direct LAN and
through Paseo's encrypted relay; disconnecting the host produces the designed
offline state. For V1, that offline state means an explicit host-offline status
and no misleading empty replacement for a previously known meeting list. It
does not require opening or retaining meeting detail while disconnected.

#### Milestone 6 foundation gate

`FOUNDATION_CHECK v1 — M6` (2026-08-21, discovery):

- **State owner:** the daemon-side `MeetingStore` remains the only durable
  meeting, transcript, chat, and citation owner. Companion storage may retain
  only Paseo host/pairing configuration and transient presentation state; it is
  not a meeting-data replica or an offline knowledge source.
- **Lifecycle:** companion connectivity must distinguish unpaired, connecting,
  online, interrupted/reconnecting, and host-offline states. An offline host
  never becomes an authoritative empty meeting list. Reconnection must
  revalidate the selected meeting, complete transcript, durable meeting chat,
  and citation path before new interaction.
- **Cross-boundary invariants:** direct LAN and relay select transport outside
  Meetless meeting policy and carry the same capability-gated plugin RPCs. The
  relay trust anchor, E2EE handshake, and reconnect mechanics remain owned by
  the pinned Paseo client/relay/server seams. Mobile has no recording
  capability. A visible citation still crosses the UI boundary only as stable
  `{ meetingId, segmentId }` and resolves audio from the connected host.
- **Accepted invariant authority:** the project-owner directive and
  `docs/product/overview.md` require both direct LAN and Paseo encrypted relay,
  explicit host-offline behavior, no cloud source of truth, and no V1 mobile
  system-audio recording. Allowed behavior is a paired companion using either
  accepted transport and reconnecting to the same host-owned state. Forbidden
  behavior is a loopback-only companion, unencrypted relay application data,
  reconnect-disabled transport, offline-as-empty presentation, companion
  meeting storage, or mobile recording. There is no accepted exception.
- **Current evidence:** Meetless currently resolves one raw daemon URL, creates
  a reconnect-disabled `DaemonClient`, renders connection failure through the
  ordinary list surface, and uses a browser-only `Audio` implementation. Its
  isolated host configuration rejects non-loopback listeners and disables
  relay. The pinned Paseo fork contains stored direct/relay host profiles,
  direct and E2EE relay transport construction, connection-state observation,
  reconnect, pairing offers, and relay-side encrypted sockets.
- **Required mechanisms:** stored pairing without meeting-data persistence; one
  observable connection owner built on the pinned Paseo direct/E2EE relay
  `DaemonClient`; authenticated direct LAN; relay trust anchored only by the
  daemon public key in the Paseo offer; capability revalidation and selected
  meeting/transcript/chat refresh after reconnect; explicit offline
  presentation; native bounded MP3 playback; a host configuration that enables
  the accepted transports without weakening isolated runtime ownership;
  positive and negative transport/invariant proof; and privacy-limited
  physical-device evidence for both paths.
- **Dependency direction:** `companion pairing/presentation -> Meetless client
  adapter -> pinned Paseo direct or E2EE relay transport -> daemon plugin ->
  MeetingStore`; citation audio returns through the same selected connection.
  Transport, Expo, WebSocket, and relay crypto types do not enter meeting
  domain/store policy.
- **Status:** `FOUNDATION_REQUIRED`. Independent client-lifecycle judgment
  returned `REOPEN_REQUEST`: Meetless disables reconnect, bypasses stored
  pairing, collapses offline into ordinary list behavior, rejects LAN binding,
  disables relay, and has no native audio adapter. Independent relay/security
  judgment returned `DEPENDENCY_REQUEST`: the pinned direct, E2EE relay,
  reconnect, pairing-offer, and connection-observation seams are sufficient,
  but Meetless has not composed them. One serial foundation/integration writer
  owns the complete moving scope; dependent surface or proof writers do not
  start before Lead accepts that candidate.

`LEAD_RULING v1 — M6-FOUNDATION-DISCOVERY` (2026-08-21):

- **Decision:** accept both dispositions, reopen the companion foundation, and
  create one serial implementation frontier. The pinned Paseo transport
  premise remains valid; the current raw-URL, reconnect-disabled Meetless
  composition is rejected for M6.
- **Security:** direct LAN must use Paseo's password-authenticated direct TCP
  behavior. Relay must use Paseo's E2EE transport and daemon-public-key trust
  anchor. Pairing links, direct passwords, transcript/audio payloads, and raw
  transport logs are private and cannot enter durable evidence. V1 adds no
  cloud meeting storage or alternate source of truth.
- **Lifecycle:** the companion profile/session owns only pairing and connection
  state. `MeetingStore` remains the durable product owner. Connection loss
  cancels old in-flight work, preserves the selected meeting identity only as
  presentation state, renders explicit offline/reconnecting state, and does not
  convert retained or unknown host state into an empty list. Reconnect
  revalidates capabilities and reloads the selected meeting, complete
  transcript, and durable chat before enabling new interaction.
- **Boundary:** `pairing/profile -> Meetless connection session -> existing
  MeetlessClient RPC -> pinned plugin transport -> MeetingStore`. Reuse the
  narrow pinned transport, offer, endpoint, and connection-state seams; do not
  import Paseo coding-domain replicas or map meetings to Paseo host/session
  records. Native audio is a presentation adapter for the existing validated,
  bounded citation payload.
- **Predicted change:** connection method, interruption, and mobile playback
  can change independently of meeting/chat policy. Keep this boundary only
  while at least direct and relay transports or web and native audio runtimes
  remain supported; remove it if one permanent runtime makes the port isolate
  no real variation.
- **Automated acceptance:** positive and negative proof covers direct auth,
  relay offer/E2EE construction and invalid trust data, stored pairing without
  meeting data, reconnect/offline transitions, lost-RPC non-replay, capability
  revalidation, selected-detail refresh, offline-not-empty rendering, no mobile
  recording controls, and bounded web/native citation playback. The real
  composition must exercise both transports before physical acceptance.
- **Physical acceptance:** on one physical mobile device, use the same
  authoritative fixture and supported question through authenticated LAN and
  then a fresh Paseo relay offer. For each path: list/open the meeting, render
  the complete transcript and restored chat, ask, validate the citation, and
  audibly play its bounded interval. Disconnect the host and observe offline;
  restart and observe reconnect. Publish only redacted device/build/transport,
  stable IDs/range, state transitions, and boolean human-heard playback facts.
- **Plan changed:** yes. M6 implementation is serialized behind this foundation
  and M6 remains open until the physical acceptance boundary passes.

`PLAN_RECONCILIATION v1 — M6-FOUNDATION-REOPEN` (2026-08-21):

- **Accepted since last reconciliation:** M5 durable chat, integrated grounded
  question/citation/audio behavior, and its accepted privacy/cleanup
  corrections remain dependencies and need no duplicate M6 implementation.
- **Code-changed assumptions:** the existing raw daemon URL and companion
  polling were M1/M4 scaffolding, not the accepted Paseo pairing/reconnect
  composition assumed by the old M6 outline. Loopback-only host configuration,
  disabled relay, and browser-only audio also invalidate direct physical
  acceptance.
- **Absorbed or obsolete work:** a UI-only offline banner, raw-URL LAN launch,
  polling-based reconnect, and separate later native-audio patch are removed as
  invalid frontiers. They are one lifecycle-sensitive vertical foundation.
- **Dependency changes:** first accept one integrated pairing/connection/native
  audio candidate; then run adversarial review and correction if needed; then
  run automated direct/relay composition; then request only the physical mobile
  actions that cannot be automated.
- **Foundation changes:** M6 moves from discovery to
  `FOUNDATION_REQUIRED`. The pinned Paseo transport remains stable; the
  Meetless adapter/composition is the missing foundation.
- **Parallel frontier:** none. Pairing, host exposure/authentication, reconnect,
  offline presentation, selected-state refresh, and native citation playback
  share lifecycle and acceptance contracts and have one writer.
- **Next frontier:** `M6-FOUNDATION-INTEGRATION`, deterministic workspace
  snapshot, followed by one `DEEP` exploratory lifecycle/security review of the
  frozen candidate.
- **Plan updated:** yes.

`LEAD_RULING v1 — M6-DEEP-REVIEW-R1` (2026-08-21):

- **Reviewed candidate:** digest
  `04b9acff4fe44031f4921826d21881ec2cf99d3941775b3d6f9b007157245eb1`,
  base `8aca992df1cf90f0acd6f7a5c8cee5059c50f891`, 25 reviewed files,
  with pinned Paseo commit
  `ee3420e80d93f7f0c875fcd45e816a5a9d06188f`. The reviewer reproduced
  the digest before and after review.
- **Verdict:** reject the candidate for acceptance and require one bounded
  correction batch. Freeze and accept all nine exploratory findings:
  `M6-R1-P1-AUTH-001`, `M6-R1-P1-ENDPOINT-001`,
  `M6-R1-P1-ENV-001`, `M6-R1-P1-LIFECYCLE-001`,
  `M6-R1-P1-LIFECYCLE-002`, `M6-R1-P1-UI-001`,
  `M6-R1-P1-PAIRING-001`, `M6-R1-P2-AUDIO-001`, and
  `M6-R1-P2-PROOF-001`.
- **Security ruling:** trim and reject blank direct passwords, enforce the
  accepted loopback/private-LAN endpoint policy in the companion adapter, and
  keep both direct-password keys out of renderer and Electron environments.
  Daemon authentication gets a daemon-only secret environment. Direct
  passwords in ordinary pairing-profile storage remain a documented authority
  uncertainty; secure-storage policy is not invented in this correction.
- **Lifecycle ruling:** one session epoch or abortable equivalent must guard
  rehydration and every UI RPC commit. Capability, meeting list, selected
  transcript, and durable selected-meeting chat restoration form one
  revalidation transaction. Failure cannot publish `online`; it must retry or
  close the connection so a new lifecycle event can recover.
- **Surface and pairing ruling:** compact selected detail must show explicit
  offline/reconnecting state and disable all detail/chat/citation controls
  until revalidation completes. A visible change-host/transport action replaces
  only the stored connection profile so one installed client can prove both
  required transports and repair bad pairing data.
- **Cleanup and proof ruling:** native clip/player cleanup must cover file,
  player, play, cancel, timeout, and failure paths. Composition sessions close
  in `finally`; child processes must terminate, escalate when needed, and have
  termination asserted.
- **Preserved evidence:** focused review tests passed 52 tests in 7 files; the
  direct and local E2EE relay composition test passed; relay trust stayed
  public-key anchored with no plaintext fallback; pairing storage rejected
  meeting data; mobile recording and microphone permission remained absent;
  offline list state stayed distinct from an empty list; four no-emit package
  type checks passed. These strengths do not waive the accepted defects.
- **Evidence limit:** review used loopback and a local Wrangler relay. It did
  not prove a physical device, private LAN, hosted relay, native launch, or
  human-heard audio. M6 remains open.

`DURABLE_HANDOFF v1 — M6-CORRECTION-R1` (2026-08-21):

- **Current state:** `CORRECTION_REQUIRED`. The M6 foundation contract and
  pinned Paseo premise remain accepted. Candidate digest `04b9acff...` is the
  correction base, not an accepted release boundary.
- **Frozen work:** correct only the nine accepted finding IDs above and their
  direct regressions. Preserve host-only meeting/chat truth, strict relay E2EE,
  direct authentication, no mobile recording, existing M1-M5 behavior, and the
  owner's dirty authority edits. Do not add cloud storage, QR scope, secure
  storage policy, cross-meeting behavior, or unrelated dependency cleanup.
- **Ownership:** reuse the foundation writer as the only product-code and proof
  writer for one correction batch. The DEEP reviewer remains independent and
  owns a later `FAST` `CLOSEOUT` against the frozen findings and correction
  delta. Lead owns this plan and final technical acceptance.
- **Required writer proof:** targeted positive and negative tests for every
  finding; direct and local E2EE relay composition; focused tests, typecheck,
  isolation validation, app build, candidate snapshot, and diff check. Report
  dependency/build side effects without broad remediation.
- **Next frontier:** `M6-CORRECTION-R1`, then one close-out review. Only after
  automated acceptance can Lead request the physical-device LAN, hosted Paseo
  relay, host-disconnect/reconnect, and human-heard cited-audio actions.
- **Completion guard:** do not mark M6 complete before the physical acceptance
  boundary recorded above passes through the real application composition.

`LEAD_RULING v1 — M6-REVIEW-CLOSEOUT-R1` (2026-08-21):

- **Reviewed candidate:** digest
  `6ae4985ecc3724959ae5c7bb429811bc96bb5407e46ef3ffedb060f1cbab4a1a`,
  correction base `04b9acff...`, repository base `8aca992...`, and the
  unchanged pinned Paseo commit. The reviewer reproduced the digest before and
  after close-out and inspected all 14 correction-delta files.
- **Verdict:** accept the `REOPEN_REQUEST`. Close
  `M6-R1-P1-AUTH-001`, `M6-R1-P1-ENV-001`,
  `M6-R1-P1-LIFECYCLE-001`, `M6-R1-P1-LIFECYCLE-002`,
  `M6-R1-P1-UI-001`, `M6-R1-P1-PAIRING-001`,
  `M6-R1-P2-AUDIO-001`, and `M6-R1-P2-PROOF-001`.
  Keep only `M6-R1-P1-ENDPOINT-001` open.
- **Open evidence:** direct profile validation converts IPv4 octets with
  `Number` before it proves that every source octet is non-empty decimal text.
  It accepts `10.0.0.:6777` and `10..0.1:6777`, which can normalize to a
  different host.
- **Evidence limit:** close-out remains automated loopback/local-relay proof.
  It does not satisfy the physical-device acceptance boundary. M6 remains
  open.

`CONVERGENCE_RECONCILIATION v1 — M6-ENDPOINT-R2` (2026-08-21):

- **Finding family:** this is the second correction for the direct-endpoint
  validation family. The failure is a bounded lexical-validation omission,
  not a failed transport, lifecycle, or source-of-truth premise.
- **Binding correction:** before numeric conversion, require exactly four
  non-empty decimal IPv4 octets. Preserve the accepted loopback/private-IPv4
  policy and current port validation. Reject both reproduced malformed forms
  and equivalent empty-octet input.
- **Frozen closures:** the eight closed finding IDs above cannot be reopened or
  changed by the writer. Their code changes remain in the candidate.
- **Ownership and scope:** the original M6 writer owns one narrow delta in
  `packages/meetless-client/src/companion.ts` and its direct companion tests.
  No other product writer runs. Docs and vendor remain excluded.
- **Required proof:** negative tests for `10.0.0.:6777` and
  `10..0.1:6777`, positive loopback/private-LAN checks, focused companion
  tests, client typecheck, candidate snapshot stability, and diff check.
- **Review:** reuse the same independent reviewer for one `FAST` `CLOSEOUT`
  restricted to `M6-R1-P1-ENDPOINT-001`, the new delta, and direct
  regressions.
- **Next frontier:** `M6-ENDPOINT-CORRECTION-R2`. Automated foundation
  acceptance and physical acceptance remain pending.

`LEAD_RULING v1 — M6-REVIEW-CLOSEOUT-R2` (2026-08-21):

- **Reviewed candidate:** digest
  `faed235bcf1e4560a8f9b5a25cf118bfd7f944c2119f300d6903fbe705c30a82`,
  candidate base `6ae4985e...`, repository base `8aca992...`, and the
  unchanged pinned Paseo commit. The reviewer reproduced the digest and
  inspected both correction files.
- **Verdict:** close `M6-R1-P1-ENDPOINT-001`. Source IPv4 text now requires
  exactly four non-empty decimal octets before numeric conversion. Nine
  forbidden boundary inputs were rejected, six allowed loopback/private-LAN
  inputs were accepted, stored-profile revalidation passed, 26 companion tests
  passed, client no-emit typecheck passed, and no direct regression was found.
- **Automated disposition:** accept `faed235b...` as the M6 automated
  foundation candidate. All nine frozen DEEP-review findings are closed. The
  writer's broader evidence also passed focused tests, direct/local-E2EE relay
  composition, full typecheck, isolation validation, Expo web build, native
  Swift boundary build, and the full test rerun. One unchanged readiness timing
  test failed once and passed alone and in the full rerun.
- **Acceptance limit:** automated proof used loopback and a local Wrangler
  relay. It does not prove a physical private-LAN device, hosted Paseo relay,
  real native launch, host disconnect/reconnect presentation, or human-heard
  cited audio. This ruling does not complete M6.

`PLAN_RECONCILIATION v1 — M6-AUTOMATED-ACCEPTANCE` (2026-08-21):

- **Status:** `PHYSICAL_ACCEPTANCE_REQUIRED`. No implementation or review
  frontier remains open. The M6 foundation contract, correction batch, and
  close-out are accepted at candidate `faed235b...`.
- **Physical sequence:** prepare one authoritative meeting fixture and build
  the real companion app; pair one physical mobile device through authenticated
  private LAN; prove list, detail, complete transcript, restored scoped chat,
  grounded answer, stable citation, and bounded cited-audio playback; disconnect
  and restart the host to prove offline and reconnect; then replace only the
  pairing profile with a fresh hosted Paseo encrypted-relay offer and repeat the
  same meeting-scoped path.
- **Evidence policy:** retain only redacted device/build/transport facts,
  stable meeting/segment IDs and cited range, connection-state transitions,
  validation results, and boolean human-heard playback. Do not retain direct
  passwords, pairing links, relay secrets, transcript text, answer text, or
  audio payloads.
- **Residual risks:** direct passwords remain in ordinary AsyncStorage because
  secure-storage authority is unresolved; physical platform behavior and
  hosted relay availability are unproven; the Xcode 26 `fmt` workaround is
  temporary; dependency audit findings remain outside this M6 correction.
- **Completion guard:** M6 stays open until both physical transport paths and
  the designed host-offline state pass through the real application
  composition.

`PHYSICAL_PREFLIGHT v1 — M6-IOS-AUTH-HOST` (2026-08-21):

- **Device proof:** physical iPhone 15 Pro Max “The Mrb”, iOS 18.7.2, was
  paired over a wired connection, booted, trusted, and in Developer Mode. The
  signed Release candidate built from `faed235b...` with zero Xcode warnings,
  installed on the device, and launched by bundle identifier. No simulator was
  substituted.
- **Host proof:** a temporary non-published direct password and wildcard LAN
  listener produced a real signed host daemon with `authRequired: true`; the
  hosted Paseo relay control connected. The password was not printed or
  retained in evidence.
- **Failure:** the host-internal readiness `DaemonClient` connected without the
  configured password and was repeatedly rejected. The desktop renderer uses
  the raw `connectMeetlessClient` path, which also has no authenticated local
  credential seam. The real host composition could not reach stable readiness
  for physical pairing and shut down.
- **Cleanup:** the temporary launch environment password was removed. The
  installed signed desktop host was restored to its previous loopback
  configuration. No acceptance interaction, transcript, question, citation,
  or audio observation was claimed.

`LEAD_RULING v1 — M6-PHYSICAL-PREFLIGHT-REOPEN` (2026-08-21):

- **Verdict:** reopen the M6 host-authentication foundation. Automated
  candidate `faed235b...` remains useful evidence for the companion, relay,
  lifecycle, surface, and audio adapters, but it is not an acceptable real-host
  composition while authenticated LAN prevents host-owned local clients from
  starting.
- **Premise invalidated:** one password-authenticated wildcard listener cannot
  be introduced only at runtime configuration. Host-internal readiness and the
  desktop UI also cross that authenticated server boundary. Passing no
  credential fails; passing the direct pairing password into renderer or
  Electron environments would reopen the accepted secret-isolation defect.
- **Required design boundary:** preserve an authenticated private-LAN edge and
  a working local host/readiness/desktop path without exposing the direct
  pairing password to renderer content, Electron environment, logs, URLs, or
  durable evidence. Preserve the pinned Paseo relay E2EE path and host-only
  meeting state. Do not bypass authentication for remote clients or weaken the
  accepted endpoint policy.
- **Status:** `FOUNDATION_REOPENED`. Obtain independent lifecycle/composition
  and security-boundary judgments before selecting a correction. No physical
  acceptance action resumes until the signed host remains ready under LAN
  authentication and both local and companion paths are proven.
- **Next frontier:** `M6-HOST-AUTH-DISCOVERY`; then one serial correction,
  adversarial review, real-host preflight, and the unchanged physical-device
  acceptance sequence.

`LEAD_RULING v1 — M6-HOST-AUTH-DISCOVERY` (2026-08-21):

- **Dispositions:** accept both independent `DEPENDENCY_REQUEST` results. The
  lifecycle review found four local/proof crossings and proposed a host-owned
  authenticated local port. The security review proved that pinned Paseo has
  one listener, no loopback exception, and no safe existing general desktop
  broker; it proposed peer-address-scoped loopback authorization.
- **Binding boundary:** update the pinned Paseo server so a direct WebSocket
  upgrade from the actual TCP socket loopback peer can omit the bearer. Keep
  Paseo password validation unchanged for every non-loopback direct peer. Use
  only the normalized socket peer address; `Origin`, `Host`, forwarded headers,
  requested URL, renderer claims, and client identity cannot grant local
  authorization.
- **Why this boundary:** Meetless already trusts the local OS user when the
  daemon is loopback-only. The rule preserves that trust while adding remote
  LAN authentication. A local proxy would grant the same local trust but add a
  second listener, forwarding protocol, process lifecycle, and failure mode.
  Two daemons risk duplicate plugin/store ownership. Renderer password
  delivery, origin-only auth, and new general capability tokens are rejected.
- **Local clients:** signed-host readiness, desktop UI, and existing proof
  clients continue through the same typed Paseo/plugin RPC path without the
  direct pairing password. The companion remains separate: private-LAN direct
  sends the password; hosted relay uses daemon-key-trusted E2EE. No meeting
  state or transport policy moves into the renderer.
- **Dependency change:** this requires a new reproducible Paseo submodule
  commit and parent gitlink update. The old pin `ee3420e...` remains the change
  base, not the accepted post-correction pin. Do not leave an uncommitted or
  dirty submodule as candidate evidence and do not push the dependency commit.
- **Security invariants:** test IPv4 loopback, IPv6 loopback, and IPv4-mapped
  loopback; reject private-LAN no-password and wrong-password clients; reject
  public/non-loopback peers; prove foreign-origin and no-origin remote requests
  do not gain local authority; preserve password success, relay E2EE, and
  daemon-key trust. Keep password bytes out of renderer/Electron environment,
  URL, argv, logs, and evidence.
- **Lifecycle proof:** authenticated wildcard signed host must reach stable
  recording/plugin readiness; desktop list/detail/chat/citation paths remain
  available; stop/restart stays owner-safe; companion reconnect revalidates and
  does not replay lost RPCs. Existing M1-M5 proof clients must remain valid.
- **Known limits:** peer loopback authorization trusts local same-user
  processes, not code-signing identity. Direct `ws://` password transport does
  not protect the password from a LAN observer; M6 authority requires direct
  LAN plus separately encrypted relay but does not authorize a new TLS/VPN
  requirement. Report this residual risk. Direct profile secure storage remains
  unresolved authority.
- **Status:** `FOUNDATION_CORRECTION_REQUIRED`. One serial writer owns the
  Paseo auth seam, direct tests, parent pin, and Meetless signed-host regression
  proof. Physical acceptance remains paused.

`DURABLE_HANDOFF v1 — M6-HOST-AUTH-CORRECTION` (2026-08-21):

- **Correction base:** Meetless candidate `faed235b...`; Paseo commit
  `ee3420e...`; physical Release install/launch passed, but authenticated signed
  host readiness failed as recorded above.
- **Writable owner:** one writer owns `vendor/paseo/packages/server/**`, the
  Paseo submodule commit, parent gitlink, and direct Meetless runtime/proof tests
  needed to disprove the failure. Docs remain Lead-owned. Companion, store,
  meeting policy, and unrelated dependencies are frozen unless a direct compile
  correction is required.
- **Required candidate:** clean committed Paseo submodule identity, deterministic
  parent snapshot, focused server auth/WebSocket tests, Meetless readiness and
  isolation tests, direct/local-relay composition, full typecheck and focused
  suite, signed wildcard-host preflight with password required remotely and
  stable local readiness, diff check, and explicit evidence limits.
- **Review:** one `DEEP` exploratory review of the new dependency/auth boundary,
  followed by correction and `FAST` close-out if findings are accepted.
- **Completion guard:** do not resume owner interaction on the physical iPhone
  until Lead accepts the new host-auth candidate and real signed-host preflight.

`LEAD_RULING v1 — M6-HOST-AUTH-REVIEW-R1` (2026-08-21):

- **Reviewed candidate:** parent digest `31f0a90e...`, repository base
  `8aca992...`, Paseo base `ee3420e...`, and clean local Paseo candidate
  `c81cb847...`. The fresh DEEP reviewer accounted for all 32 parent-manifest
  files and all three Paseo commit files.
- **Verdict:** reject the candidate for acceptance and freeze all three review
  findings: `M6-HOST-AUTH-REVIEW-R1-PRIVATE-BIND-001`,
  `M6-HOST-AUTH-REVIEW-R1-PREFLIGHT-CLEANUP-002`, and
  `M6-HOST-AUTH-REVIEW-R1-SUBMODULE-REPRO-003`.
- **Private-bind ruling:** M6 host configuration supports loopback or the
  password-protected wildcard IPv4 listener for LAN. Reject an exact private
  IPv4 host bind because a local connection to that address has a non-loopback
  socket peer and cannot use the passwordless local authorization rule. The
  companion still pairs to the machine's private LAN address. Do not add a
  renderer credential path or broaden loopback authorization.
- **Cleanup ruling:** host-auth preflight cannot suppress stop or launch
  environment cleanup failures. Aggregate cleanup errors, verify no owned host
  process, listener, socket, or temporary password remains, and emit `passed`
  only after those checks succeed. Forced stop/unset failures must fail the
  proof.
- **Reproducibility ruling:** do not push the Paseo commit. Add a bounded,
  content-addressed git bundle in the parent repository containing the exact
  `c81cb847...` object and a mechanical fresh-checkout/fetch/checkout check.
  The candidate snapshot must bind the bundle and expected Paseo commit. A clean
  local submodule alone is not portable proof.
- **Preserved strengths:** direct auth uses the actual socket peer; Origin,
  Host, forwarding headers, URL, and client identity grant no authority;
  loopback/mapped/wrong/correct/private/public/malformed/absent peer cases were
  checked; relay attachment stays separate; local direct and E2EE composition,
  secret stripping, lifecycle, ownership, companion, and M1-M5 focused
  regressions passed.
- **Evidence limit:** no physical device, hosted relay, signed native launch,
  full build, or live state-changing preflight was run by the reviewer. M6
  remains open.

`DURABLE_HANDOFF v1 — M6-HOST-AUTH-CORRECTION-R1` (2026-08-21):

- **Correction base:** parent `31f0a90e...`, Paseo `c81cb847...`. Correct only
  the three frozen finding IDs and direct regressions. Preserve the accepted
  peer-address auth rule and all prior M6 closures.
- **Ownership:** reuse the host-auth writer as the only writer. Writable scope
  is host-listen policy/tests, fail-closed preflight/tests, bounded Paseo bundle
  and reproduction tooling, candidate snapshot binding, and direct compile
  corrections. Docs and unrelated product code are frozen.
- **Required proof:** exact private-bind rejection plus loopback/wildcard
  positives; forced stop and launch-environment cleanup failures; clean-state
  verification before pass; fresh temporary checkout reproducing the exact
  Paseo commit only from parent contents; focused auth/runtime tests; signed
  wildcard preflight; composition; typecheck; focused/full suites; stable
  snapshot; clean submodule; diff check; safe final restoration.
- **Close-out:** reuse reviewer `4eed00a1...` for one `FAST` `CLOSEOUT` against
  the frozen findings, correction delta, and direct regressions.
- **Status:** `CORRECTION_REQUIRED`. Physical-device acceptance remains
  paused.

`LEAD_RULING v1 — M6-HOST-AUTH-REVIEW-CLOSEOUT-R1` (2026-08-21):

- **Reviewed candidate:** parent digest `24db5abf...`, base `31f0a90e...`,
  Paseo commit `c81cb847...`, and content-addressed bundle
  `0cd59fbf...` at 78,982,401 bytes. Candidate and submodule identities stayed
  stable and the Paseo worktree was clean.
- **Verdict:** close `M6-HOST-AUTH-REVIEW-R1-PRIVATE-BIND-001`,
  `M6-HOST-AUTH-REVIEW-R1-PREFLIGHT-CLEANUP-002`, and
  `M6-HOST-AUTH-REVIEW-R1-SUBMODULE-REPRO-003`. Accept `24db5abf...` as the
  automated M6 host-auth candidate.
- **Accepted behavior:** host listen policy now supports loopback or
  password-protected `0.0.0.0`; exact private/public binds fail. Cleanup
  aggregates all failures and proves no process, listener, socket, temporary
  root, or launch password before pass. Parent contents reproduce the exact
  unpushed Paseo commit through a verified bundle.
- **Validation:** reviewer reruns passed 33 cleanup/runtime tests, 18 Paseo auth
  tests, four composition tests, 58 isolation tests, 297 focused tests, bundle
  fresh checkout/verify, syntax checks, and diff checks. Writer evidence also
  passed the full 353 tests, typecheck, app build, signed wildcard host
  preflight, and safe final restoration.
- **Residual cost and risk:** the portable bundle adds about 75.3 MiB; direct
  LAN remains unencrypted `ws://`; loopback authorization trusts local
  processes rather than signed identity; direct-password secure storage remains
  unresolved. These do not satisfy or waive physical acceptance.

`PLAN_RECONCILIATION v1 — M6-PHYSICAL-RESUME` (2026-08-21):

- **Status:** `PHYSICAL_ACCEPTANCE_REQUIRED`. No implementation or review
  frontier remains open. The real signed wildcard host is now an accepted
  preflight boundary.
- **Next sequence:** rebuild/install the current Release app on the trusted
  physical iPhone; pair through authenticated private LAN; prove the complete
  meeting/chat/question/citation/audio path and offline/reconnect; replace the
  profile with a fresh hosted E2EE relay offer; repeat the same path; record
  only the approved redacted evidence.
- **Completion guard:** M6 remains open until every physical observation above
  is complete.

`PHYSICAL_ACCEPTANCE_PROGRESS v1 — M6-DIRECT-LAN` (2026-08-21):

- **Observed on the physical iPhone:** authenticated Direct LAN pairing
  succeeded, the meeting list rendered, and one meeting-scoped question
  returned a normal response. The answer displayed `Play citation`, but tapping
  it produced no audible audio.
- **Bounded diagnosis:** the native playback adapter created and started an
  Expo player without first configuring the iOS audio session. This leaves the
  app on the ambient session, which is muted by iPhone Silent Mode. The accepted
  correction configures foreground playback in Silent Mode while explicitly
  disabling recording and background recording; it does not redesign audio.
- **Correction proof:** the focused playback suite passed 8 tests, the app
  type-check passed, and the corrected Release app built with zero warnings or
  errors, installed on the paired physical iPhone, and launched.
- **Observed correction result:** on that corrected physical Release app,
  tapping `Play citation` produced audible audio and playback stopped by
  itself. The physical Direct LAN cited-audio boundary is passed.
- **Evidence limit:** this observation does not prove host offline/reconnect or
  Paseo encrypted-relay behavior. Those remain unobserved.
- **Observed offline result:** after the owned host stopped, the physical iPhone
  showed `Host offline` and retained the known meeting list instead of an empty
  state. However, the previously open selected detail was no longer visible,
  and offline list items did not open. The explicit-offline and
  offline-not-empty requirements passed; selected-detail retention did not
  match the accepted lifecycle contract and is not passed.
- **Reconnect state:** the same signed host was restored with the same Direct
  LAN authority. The physical iPhone then displayed
  `Connected · host state restored`; the same meeting detail opened; and the
  previous question and answer remained present. The Direct LAN reconnect and
  durable meeting-chat restoration boundary is passed.
- **Remaining offline limitation:** the selected detail itself was not retained
  while offline. That part remains failed even though reconnect restored the
  selected meeting and durable chat.
- **Transport limit:** no Direct LAN observation proves Paseo encrypted-relay
  behavior. Relay physical acceptance remains pending.
- **Observed encrypted-relay result:** on the physical iPhone, the Paseo relay
  pairing link connected successfully, cited-audio playback worked, and a new
  meeting-chat question returned a working response. These observations do not
  by themselves prove any relay surface or citation-validation detail that the
  owner did not report.
- **Observed relay restoration result:** the owner then observed the meeting
  list, reopened the same meeting, saw its complete ready transcript, and saw
  both the earlier Direct LAN chat and the new relay chat. The physical
  encrypted-relay gate is passed and will not be repeated for the offline
  correction.
- **M6 status:** `PHYSICAL_ACCEPTANCE_REQUIRED`. The accepted offline lifecycle
  contract still fails selected-detail retention. M6 is not complete.

`FOUNDATION_CHECK v1 — M6-OFFLINE-DETAIL` (2026-08-21):

- **State owner:** `AppContent` owns transient selected-meeting identity;
  `MeetingStore` remains the only durable meeting/chat owner.
- **Lifecycle:** connection loss must retain the selected identity and render
  the existing compact detail with explicit offline state and disabled actions.
- **Invariants:** the correction adds no offline RPC, companion meeting cache,
  transport behavior, relay change, or mobile recording capability.
- **Dependency direction:** companion connection state updates app presentation
  state, which selects the existing meeting surface.
- **Status:** `STABLE`. The observed defect is one bounded lifecycle correction
  followed by focused review and a physical offline/reconnect rerun. Completed
  Direct LAN, cited-audio, reconnect, and encrypted-relay proof stays closed.

`M6-OFFLINE-DETAIL-CORRECTION v1` (2026-08-21):

- **Accepted finding:** `M6-PHYSICAL-OFFLINE-DETAIL-001`. Compact Back remained
  active during interruption and could clear the app-owned selected meeting.
  The earlier surface-only test held a fixed selected ID and did not exercise
  the app callback that cleared it.
- **Candidate:** digest
  `7311bcad8b35b924869521cfabd7e290ac99dfc31c00f5277c722dd1b39aeeb9`,
  correction base `db48566aad88b0ca47f249fda48ce4aa1dffe55ad247977820aa0a7e6c255478`.
  The candidate disables compact Back while interaction is unavailable and
  adds an app-composition regression across reconnecting, offline,
  revalidating, and online states.
- **Writer proof:** 52 focused app/surface tests passed; app and surface package
  typechecks passed; the candidate digest was stable; diff check passed.
- **Review:** `FAST` `CLOSEOUT` is pending against only the accepted finding,
  four-file correction delta, and direct regressions. No physical acceptance
  claim is made before review and the real-iPhone offline/reconnect rerun.

`LEAD_RULING v1 — M6-OFFLINE-DETAIL-CLOSEOUT` (2026-08-21):

- **Decision:** `REVISE_PLAN`. Accept the review's `CLOSEOUT_FINDINGS`; keep
  `M6-PHYSICAL-OFFLINE-DETAIL-001` open.
- **Reason:** the physical observation did not include a Back action. On the
  correction base, the new lifecycle test already retains selected detail
  through reconnecting/offline and restores it after revalidation. The
  candidate first fails only because Back is not disabled. It therefore closes
  a separate interaction path but does not reproduce or explain the observed
  spontaneous detail loss.
- **Candidate disposition:** digest `7311bcad...` is not accepted as the cause
  correction. Its focused tests and no-regression evidence remain useful, but
  they do not satisfy physical acceptance.
- **Next frontier:** one controlled physical diagnostic records the iPhone app
  process identity before and after host loss while the owner makes no UI
  action. A process/remount change and an in-process state clear require
  different corrections. No product code changes before that distinction.

`CONVERGENCE_RECONCILIATION v1 — M6-OFFLINE-DETAIL` (2026-08-21):

- **Finding family:** `M6-PHYSICAL-OFFLINE-DETAIL-001`; one correction and one
  close-out are frozen at base `db48566a...` and candidate `7311bcad...`.
- **Failed premise:** an available offline Back control caused the reported
  detail loss. The owner reported no Back action, and the base already retains
  detail under the mocked status sequence.
- **Decision:** continue bounded cause investigation. Do not redesign audio,
  transport, relay, meeting persistence, or navigation. Do not repeat completed
  relay proof.
- **Discriminator:** monitor the real Release app process across a controlled
  host disconnect with the same detail open and no owner interaction. Correct
  only the observed remount/lifecycle mechanism, then run one focused review
  and physical offline/reconnect rerun.

`M6-OFFLINE-DETAIL-CONTROLLED-RERUN v1` (2026-08-21):

- **Physical setup:** the owner opened the same meeting detail on the physical
  iPhone and made no screen interaction. Meetless app PID `22146` was recorded
  before host loss.
- **Observed result:** after the owned host stopped and port `6777` had no
  listener, the same meeting detail remained visible with `Host offline`. The
  iPhone app retained PID `22146`; no native app restart occurred.
- **Reconciliation:** the earlier list observation is not reproducible as an
  untouched host-loss transition and is superseded for acceptance by this
  controlled no-touch observation. It remains recorded as an ambiguous prior
  observation, not reinterpreted as a pass.
- **Rejected candidate:** `7311bcad...` is not causal proof and its four-file
  speculative Back-control delta was removed. The deterministic workspace
  returned exactly to `db48566a...`. App/surface tests passed 51 tests, both
  package typechecks passed, and diff check passed after removal.
- **Restoration:** the same signed host was restored; its owned process and
  wildcard listener on port `6777` are live. Direct LAN reconnect had already
  been physically observed with `Connected · host state restored`, reopened
  detail, and durable prior chat.

`OWNER_AUTHORITY v1 — M6-OFFLINE-SCOPE` (2026-08-21):

- **Required:** show explicit host-offline state and do not replace known
  meetings with a misleading empty state.
- **Not required:** opening, accessing, or retaining meeting detail while the
  host is disconnected.
- **Reconciliation:** this ruling supersedes prior M6 plan language that made
  selected-detail retention an offline acceptance gate. It closes
  `M6-PHYSICAL-OFFLINE-DETAIL-001` by authority, not by accepting candidate
  `7311bcad...`. That rejected speculative delta remains removed.

`LEAD_ACCEPTANCE v1 — M6` (2026-08-21):

- **Decision:** complete Milestone 6 on deterministic candidate
  `db48566aad88b0ca47f249fda48ce4aa1dffe55ad247977820aa0a7e6c255478`
  with Paseo dependency commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- **Direct LAN physical evidence:** the reviewed Release app paired on the real
  iPhone, rendered meetings, answered a meeting-scoped question, displayed a
  citation control, audibly played its bounded cited interval, and stopped
  playback by itself.
- **Reconnect physical evidence:** after controlled host loss and restoration,
  the app displayed `Connected · host state restored`, reopened the same
  meeting, and retained the previous durable question and answer.
- **Encrypted-relay physical evidence:** a fresh Paseo offer connected; the
  meeting list appeared; the same meeting reopened with complete ready
  transcript; earlier Direct LAN chat and new relay chat remained; a new
  meeting question returned a working response; and cited audio played.
- **Offline physical evidence:** with no host process or port `6777` listener,
  the app displayed `Host offline` and retained the known meeting list rather
  than a false empty state. A later controlled no-touch run also retained the
  same app PID and showed `Host offline`; offline detail retention is not an
  acceptance requirement.
- **Automated and build evidence:** the reviewed foundation passed the full 353
  tests, 297 focused tests, 58 isolation tests, four composition tests,
  typecheck, app build, signed wildcard-host preflight, and portable Paseo
  bundle verification. The bounded native-audio correction passed eight
  focused tests and a zero-warning physical Release build/install. After
  removing the rejected offline-detail delta, 51 app/surface tests, both package
  typechecks, stable candidate snapshot, and diff check passed.
- **Evidence limits and residual risks:** proof covers one physical iPhone and
  the accepted host, not a broader mobile matrix. Direct LAN uses authenticated
  `ws://` and is not encrypted against a LAN observer. The portable Paseo bundle
  adds about 75.3 MiB; loopback authorization trusts local processes; direct
  password secure-storage policy, CI enforcement, and branch protection remain
  unresolved. These are reported limits, not hidden M6 completion claims.
- **Final cleanup:** the temporary wildcard host was stopped, both temporary
  launch password keys were removed, and the signed host was reinstalled with
  `127.0.0.1:6777`. No host process or port `6777` listener remained; the Paseo
  submodule stayed clean; candidate digest remained `db48566a...`; and final
  diff check passed.
- **Status:** `COMPLETE`. Milestone 7 release readiness remains open.

### New-design implementation workstream

The project-owner directive dated 2026-08-23 makes `design/PRODUCT.md` the
authority for the new user experience outcome and user behavior. The remaining
`design/` artifacts are the supporting visual and interaction handoff. Where a
handoff artifact conflicts with `PRODUCT.md`, `PRODUCT.md` wins. The complete
44-file handoff is currently untracked and must be preserved byte-for-byte and
included in the implementation candidate. The pre-implementation handoff
digest is `28657cc28c33151f0a7ab5a9479abe5627c48954b4225e22026ebb4a4d923a4b`.

Observable outcome:

```text
one Record meeting entry
  -> focused, non-blocking proposed source setup
  -> route-independent recording and safe save/recovery state
  -> meaningful meeting library
  -> stable Transcript and Ask tasks
  -> inline validated evidence and bounded playback
  -> relay-first companion pairing and truthful offline recovery
```

Wide desktop keeps Library, Transcript, and Ask as independent contexts.
Tablet keeps the library plus one selected task. Phone uses list-to-detail and
one task at a time. Existing local-first storage, recording, transcription,
chat, citation, privilege, transport, and recovery authority must not move into
the renderer or presentation layer.

`PLAN_RECONCILIATION v1 — NEW-DESIGN-START` (2026-08-23):

- **plan_ref:** this plan remains the one active repository plan. Do not create
  another plan for the design implementation.
- **accepted_since_last:** Milestone 6 is accepted. Milestone 7 remains open.
- **code_changed_assumptions:** the accepted V1 implementation proves the
  product loop, but its current UI is no longer the accepted presentation. The
  new `design/PRODUCT.md` supersedes prior presentation requirements when they
  conflict; domain, security, storage, transport, and lifecycle authority stay
  unchanged.
- **absorbed_or_obsolete_frontiers:** the old separate Create meeting and Start
  recording UI, raw lifecycle/provider/request presentation, model button
  inventory, single-scroll Transcript/Ask detail, and Direct-LAN-first pairing
  are obsolete.
- **dependency_changes:** implement and accept the new design before Milestone
  7 release-readiness judgment. No post-MVP work moves into this frontier.
- **foundation_changes:** none below the app/presentation boundary unless the
  writer returns a decision-ready `DEPENDENCY_REQUEST` with evidence.
- **parallel_frontier:** none. One integrated writer owns the shared responsive
  shell, recording presentation, evidence state, companion presentation, and
  affected proof selectors.
- **next_frontier:** `ND-IMPLEMENTATION-R1`.
- **plan_updated:** yes.

`FOUNDATION_CHECK v1 — NEW-DESIGN` (2026-08-23):

- **state_owner:** the daemon-side meeting store and recording, transcription,
  chat, and companion contracts remain authoritative. The app owns only
  ephemeral route/task/selection state, user-facing state mapping, and visible
  citation playback state. Cached companion content is last-validated context,
  never current host truth.
- **lifecycle:** map existing recording and meeting lifecycle values to setup,
  active, paused, saving, saved, transcribing, ready, recoverable, and failed
  user states. Do not add a second lifecycle or persist renderer-owned copies.
- **cross_boundary_invariants:** one recording remains active; normal Stop is a
  safe save transition; source readiness remains explicitly proposed and
  non-blocking; stale transcript/chat/citation results cannot replace a newer
  meeting selection; a new citation stops prior bounded playback; offline
  interaction stays disabled until host revalidation; raw provider, request,
  daemon, and lifecycle internals are not primary content.
- **required_mechanisms:** pure presentation-state mapping; one width-driven
  phone/tablet/desktop layout model; the existing recording controls and client
  contracts; an app-owned citation evidence controller over stable meeting and
  segment IDs; the existing companion session and profile builders; responsive
  component and composition proof.
- **dependency_direction:** Expo/Electron composition -> Meetless presentation
  use cases -> existing client and recording ports. Presentation must not make
  meeting policy depend on React Native, Electron, WebSocket, or provider SDK
  types.
- **status:** `STABLE`. No contract, domain, store, native, plugin, client, or
  vendor change is authorized in `ND-IMPLEMENTATION-R1`.
- **evidence:** current recording start already creates the meeting atomically;
  current citation resolution already uses stable IDs and bounded audio; current
  companion sessions already revalidate before interaction. Baseline focused
  tests passed 41 files / 298 tests and typecheck passed before dispatch.

`LEAD_RULING v1 — ND-DISCOVERY-UX-PROOF` (2026-08-23):

- **decision:** revise the implementation contract and proceed.
- **playback:** `PRODUCT.md` wins over the handoff playbar. Do not add visible
  Pause, Stop, seek, or progress controls. Show only non-interactive resolving,
  playing, completed, or failed state and the authoritative range.
- **citation evidence:** use the reversible inline evidence card beside the
  answer and highlight the matching transcript segment when visible. Do not add
  a new side-panel navigation contract.
- **offline:** retain already validated meeting rows and selected detail as
  disabled context, clearly marked stale/offline. Never present it as current
  host truth.
- **title:** preserve the existing non-empty title requirement with no new
  default or rename policy.
- **source readiness:** render microphone and system audio as proposed and
  non-blocking. Do not claim a pre-start runtime readiness signal.
- **host identity:** use neutral connection language before validation. Preserve
  existing connection timing and trust authority.
- **assets:** preserve the supplied assets. Use documented system font fallbacks
  and do not fabricate the missing `design/build/icons.svg` or an unverified
  Berkeley Mono bundle.

`FRONTIER_BRIEF v1 — ND-IMPLEMENTATION-R1`:

- **outcome:** one integrated production candidate implements the observable
  new-design journey across Electron, web, and native-responsive surfaces while
  preserving all accepted runtime behavior.
- **depends_on:** accepted Milestones 1–6, the foundation check above, and the
  complete `design/` handoff.
- **write_scope:** `design/` (track unchanged),
  `packages/meeting-surface/`, `packages/meetless-app/`, affected UI composition
  proof under `scripts/` and `test/`, and root package configuration only when a
  proof command requires it. Exclude `vendor/`, `native/`, meeting contracts,
  domain, store, client, and plugin code.
- **stable_contract_refs:** `design/PRODUCT.md`, supporting design handoff,
  current product/architecture authority, and this ruling.
- **invariants:** the foundation invariants above; no fabricated readiness;
  no unapproved playback controls; no false offline truth; no new product scope.
- **acceptance:** behavior tests for every mapped state and action; accessibility
  semantics and keyboard-visible focus; width-tier and no-horizontal-overflow
  proof at the handoff matrix; fresh app build; focused tests and typecheck;
  existing recording/transcript/chat/citation composition proof updated for the
  one-entry flow; deterministic screenshots for desktop, tablet, and phone; no
  handoff artifact mutation; clean pinned vendor state.
- **reopen_when:** a required behavior cannot be implemented without changing a
  stable backend contract, product-open choice, privilege boundary, or accepted
  lifecycle.
- **candidate_required:** commit.

Review classification for the frozen candidate is `DEEP`,
`review_mode: EXPLORATORY`, lane `responsive-lifecycle-evidence-composition`.
Use one independent reviewer after Lead verifies the writer's proof. Any
accepted findings receive one correction batch and one `FAST` close-out.

`PLAN_RECONCILIATION v1 — ND-REVIEW-R1` (2026-08-23):

- **candidate:** `3a7a7a14c0d7af4813d4dd884f6d6130e9a26e2e`.
- **verdict:** `REOPEN`. Accept the complete exploratory finding set
  `ND-R1-001` through `ND-R1-009`.
- **correction_order:** restore the accepted native M1 proof and executable
  publication checks; add correctly paired responsive proof pages; make the
  composition proof drive the recording-owned meeting path; then correct
  transcription retry, playback settlement, phone list-position restoration,
  source-specific start recovery, and the Change-host warning.
- **contract_ruling:** transcription retry reuses the existing idempotent
  consent operation, whose transcription service schedules retryable failed
  transcripts. No new RPC or backend policy is authorized. Proposed source
  checks remain non-factual and nonblocking.
- **ownership:** one integrated correction writer owns the full accepted set.
  No parallel writer or discovery frontier is active.
- **acceptance:** a fresh correction commit, focused and composition checks,
  typechecks/builds, publishable M1 evidence with retained iOS proof plus
  desktop/tablet/phone screenshots, unchanged design digest, clean vendor state,
  and one `FAST` close-out against only the accepted finding set.
- **plan_updated:** yes. The dependency order and Milestone 7 boundary are
  unchanged.

`DEPENDENCY_HANDOFF v1 — ND-XCODE-BLOCKER` (2026-08-23):

- **correction_candidate:**
  `4b8e59b2bacb2843cdc383315d3aa79ab80119b5`; worktree and pinned vendor are
  clean, `design/` remains 44 files with SHA-256
  `28657cc28c33151f0a7ab5a9479abe5627c48954b4225e22026ebb4a4d923a4b`.
- **implemented_findings:** `ND-R1-001` through `ND-R1-009`. Focused proof
  passed 12 files / 81 tests; Meetless build, Expo web build, app typecheck,
  proof syntax, and diff check passed.
- **blocked_acceptance:** no current-candidate M1 publication exists. Two
  bounded `proof:m1` attempts and one isolated Expo Release diagnostic stopped
  after bundling at Xcode `Planning build` without a source or configuration
  error. Do not substitute web evidence for the required native proof.
- **diagnostic_evidence:** disposable iPhone 17 Pro / iOS 26.5 simulator
  `47D1CF38-C848-4765-AA93-3C127ADD3C5D`; retained log
  `/tmp/meetless-nd-xcode-diag-r1-47D1CF38-C848-4765-AA93-3C127ADD3C5D.log`
  and final tail with the `.log.final-200` suffix. The diagnostic-owned process
  groups were terminated; the simulator was uninstalled, shut down, and
  deleted; external Xcode processes were untouched.
- **ruling:** `XCODE_BLOCKER`. The same blocker has repeated three times. Stop
  retries until Xcode build planning health changes or an external Xcode
  diagnostic identifies the failing planner dependency. Resume with one
  bounded `proof:m1` run, then perform the planned `FAST` close-out.
- **status:** implementation candidate frozen; technical acceptance blocked.

### Milestone 7: V1 acceptance and release readiness

- Exercise the complete P0 path on the accepted desktop platform matrix.
- Exercise web/mobile companion behavior on real supported targets.
- Verify storage recovery, provider failure, and citation integrity.
- Record remaining platform and model-quality limitations.

### Post-MVP: cross-meeting Q&A and document folders

- Implement meeting and document indexing behind `KnowledgeIndex`.
- Watch only explicitly allowlisted folders; reindex changes and remove deleted
  sources.
- Expose bounded search/get tools to coding agents.
- Render meeting and document citations with source-specific navigation.

Acceptance boundary: one question combines a meeting segment and a document
chunk, both citations resolve, and deleting the document removes it from future
retrieval.

## Risks And Recovery

- **System audio is platform-specific.** A shared React UI does not prove
  capture support. Gate implementation on an OS-specific Zoom/Meet spike and do
  not advertise platforms that have not captured both sides.
- **Paseo coupling can import the wrong product.** Copying the full client SDK or
  session domain would spread agents/workspaces throughout meeting code. Keep
  meeting policy separate and reuse infrastructure only through measured seams.
- **Licensing can determine the adoption shape.** Paseo is predominantly AGPL;
  the audio package and third-party components have their own licenses. Stop
  bulk reuse until the intended distribution is compatible and recorded.
- **Audio loss is expensive.** Write incremental recoverable chunks owned by
  the daemon. Never overwrite the last known-good chunks during finalization.
- **MP3 finalization can fail after a successful meeting.** Preserve source
  chunks and expose retry; delete chunks only after the finalized file is
  readable and durably recorded in meeting state.
- **Coding agents can hallucinate citations.** Accept only known segment IDs in
  V1 and known chunk IDs in post-MVP document retrieval. Resolve display
  locations in application code.
- **Post-MVP broad filesystem access can exceed user intent.** Retrieval tools
  and document indexing are constrained to explicitly selected meetings/folders;
  document contents are read-only.
- **Companion clients depend on the host.** Make host-offline behavior explicit;
  do not introduce cloud sync silently to hide the limitation.
- **Upstream Paseo can move quickly.** Record the adopted revision and update
  strategy. Keep Meetless changes in owned modules so upstream updates have a
  visible conflict surface.

Recovery rules:

- Keep every milestone independently runnable at a real composition boundary.
- Preserve original recording chunks and meeting metadata before migrations or
  media conversion changes.
- Capability-gate new protocol surfaces so mixed app/daemon versions fail with
  an update message rather than a fallback path.
- If the selected Paseo adoption shape creates unacceptable coupling, return to
  the last accepted milestone and extract only the proven neutral seam; do not
  add compatibility layers that maintain two product domains.

## Progress

- [x] Consolidate V1 product scope and Paseo reuse direction into this active
  plan.
- [x] Promote stable V1 behavior into focused `docs/product/` documents.
- [x] Record the Paseo adoption, license, and upstream-update decision.
- [x] Inventory the pinned Paseo P0 package and file seams.
- [x] Run the microphone plus system-audio Zoom/Meet capture spike.
- [x] Complete Milestone 1: shell and meeting domain.
- [x] Complete Milestone 2: durable desktop recording.
- [x] Complete Milestone 3: transcription and citation playback.
- [x] Correct the post-M3 zero-chunk recording failure before M4 depends on a
  newly recorded meeting.
- [x] Restore physically pointer-interactive recording input in the accepted
  LaunchServices host and repository Electron chain before M4 begins.
- [x] Freshly rerun and accept the correlated post-M3 Electron recording Harness
  POC without weakening production identity, TCC, or accessibility.
- [x] Confirm the supported app completes a project-owner-observed fresh
  recording -> transcript -> audible cited-audio flow and open the M4
  dependency without promoting it to release-readiness evidence.
- [x] Complete Milestone 4: meeting sidebar and transcript reader.
- [x] Complete Milestone 5: chat with one meeting.
- [x] Complete Milestone 6: companion web/mobile experience.
- [ ] Implement and technically accept the `design/PRODUCT.md` new-design
  workstream.
- [ ] Complete Milestone 7: V1 acceptance and release readiness.
- [ ] Post-MVP: complete cross-meeting Q&A and document folders.

## Decisions

- 2026-08-16: V1 is personal and local-first; team collaboration and cloud sync
  are excluded.
- 2026-08-16: Desktop owns Zoom/Meet microphone plus system-audio recording;
  mobile is a reading and Q&A companion.
- 2026-08-16: Meetless reuses Paseo's runtime architecture and coding-agent
  integrations but owns a separate meeting/knowledge domain.
- 2026-08-16: Transcript segment IDs and document chunk IDs are citation
  authority; model-written timestamps and paths are not.
- 2026-08-16: Transcription runs automatically after recording; coding-agent
  interaction remains user initiated and provider selectable.
- 2026-08-16: The first desktop recording OS is macOS; other desktop recording
  targets remain unsupported until equivalent real-call evidence exists.
- 2026-08-16: Paseo and Meetless have independent Git histories. Meetless
  consumes `https://github.com/hoangnb24/paseo` as the complete `vendor/paseo`
  Git submodule pinned to
  `ee3420e80d93f7f0c875fcd45e816a5a9d06188f` (tag
  `meetless-v1-base-2026-08-16`); Meetless product code never lives in the
  Paseo repository.
- 2026-08-16: Milestone 1 composes Meetless as a trusted local plugin loaded by
  the isolated pinned Paseo daemon. The daemon's `plugins` server feature and
  the `meetless` catalog entry gate validated `meeting.create` and
  `meeting.list` contracts carried by Paseo's compatible
  `plugin.rpc.invoke.request`/`plugin.rpc.invoke.response` envelope. This is the
  explicit integration-adapter seam: it is not a second daemon and does not
  require Meetless product code or first-class meeting wire variants inside
  `vendor/paseo`.
- 2026-08-16: Meetless desktop startup must set its isolated daemon home,
  listen target, Electron user-data root, and product storage before importing
  or starting the Paseo runtime. Desktop lifecycle commands may act only on
  ownership discovered from that isolated home.
- 2026-08-16: One Meetless-owned Expo surface is authoritative across Electron,
  web, and iOS. Only the pinned Electron preload bridge grants desktop meeting
  creation; URL parameters cannot grant it. Web and iOS remain read-only, and
  the trusted plugin contributes daemon RPC handlers rather than a second
  product surface.
- 2026-08-16: A Meetless daemon stop is authorized only when the isolated PID
  lock agrees with the live supervisor identity, an exact ownership marker held
  open under the isolated `PASEO_HOME`, the pinned supervisor entrypoint, and a
  listener worker in that supervisor's process tree. Unsupported inspection
  fails closed.
- 2026-08-16: Distribution is open source compatible with Paseo's
  AGPL-3.0-or-later obligations; binary release remains gated on a complete
  third-party/native/model license and notice review.
- 2026-08-17: Milestone 2 recording state, chunk identity, finalization intent,
  and saved output identity have one daemon-side owner in the extended
  `MeetingStore`. The Swift helper produces source-labelled bytes; the renderer
  controls and observes but never owns the session.
- 2026-08-17: V1 recording controls use the pinned Electron-only local
  transport to a private Meetless plugin socket. Generic plugin RPC remains the
  companion meeting API and does not grant web/mobile system-audio recording.
- 2026-08-17: The frozen M2 permission host is the ad-hoc signed local
  `~/Applications/Meetless.app` bundle (`com.meetless.app`) launched through
  LaunchServices. It exclusively owns the desktop runtime ancestry used for TCC
  attribution; Paseo.app has no permission or responsible-application role.
  Full release signing, hardening, notarization, and packaging remain M7 work.
- 2026-08-17: An MP3 is published only through an atomic no-replace operation
  after readable staging and durable publish intent. Source chunks may be
  cleaned only after the exact output is readable and the `saved` transition is
  durably complete; finalization retry always reuses committed chunks.
- 2026-08-18: Milestone 3 uses only the official OpenAI audio transcription
  endpoint with `gpt-transcribe` and explicit `languages: ["en", "vi"]`; mixed
  code-switching is preserved without translation and no local speech provider
  is implemented.
- 2026-08-18: The signed native Meetless host is the only component allowed to
  read the OpenAI Keychain item and make the authenticated OpenAI request. The
  Node/Paseo daemon receives transcript/status data only; environment,
  persisted Paseo configuration, argv, renderer, and a plaintext-key broker are
  rejected credential paths.
- 2026-08-18: Meetless owns deterministic audio ranges and range-derived stable
  segment IDs. Provider text is segment payload, not identity or timing
  authority. `MeetingStore` owns checkpoints, retry/restart reconciliation,
  immutable publication, citation resolution, and meeting-ready transition.
- 2026-08-18: Cloud-processing disclosure is one-time and precedes automatic
  transcription. No Meetless duration cap is added; retries and acceptance
  traffic are bounded, and request/usage metadata is recorded when available.
- 2026-08-20: The project owner launched the supported Meetless host, completed
  a fresh recording, opened its transcript, and audibly played cited audio.
  This observation satisfies the post-M3 dependency for beginning M4. It does
  not claim an automated native-provider manifest or release readiness; the
  Harness `invalid` result is retained as a diagnostic caveat and does not
  supersede the accepted M3 evidence.
- 2026-08-20: Replace automatic summary/decision/action-item analysis with a
  simpler sequence: M4 adds a Paseo-inspired meeting sidebar and complete
  transcript reader; M5 adds provider-selectable chat scoped to the open
  meeting. Automatic derived artifacts and their accept/dismiss lifecycle are
  deferred. Cross-meeting/document retrieval, companion clients, and release
  readiness were moved after M5. The 2026-08-21 decision below supersedes that
  sequence.
- 2026-08-20: Meeting chat history is durable per meeting. Leaving the meeting
  or restarting the app must not discard its messages; reopening the meeting
  restores the thread for continuation.
- 2026-08-21: Cross-meeting Q&A and document-folder indexing are removed from
  V1 and deferred to post-MVP. Companion clients become M6 and V1 acceptance
  and release readiness become M7.
- 2026-08-21: V1 companion access supports both direct LAN pairing and Paseo's
  encrypted relay. M6 must prove the companion path through both transports.

Open decisions before affected implementation:

- Exact macOS hardware/version release matrix beyond the first proven host.
- Minimum release-quality threshold and remediation for the static-like
  distortion observed on both intelligible M2 production source clips. This is
  an M7 release decision; M2 makes no normal-quality claim.

Open post-MVP decisions:

- Supported document formats and exact source-location behavior for each.

## Validation

- **Plan proof:** inspect rendered Markdown, links, milestone dependency order,
  and agreement between product authority, scope, progress, and decisions.
- **Focused policy proof:** unit tests for meeting lifecycle transitions,
  collision-safe filenames, meeting-chat scoping and persistence, citation
  resolution, and companion access boundaries.
- **Adapter proof:** controlled fixtures for recording, MP3 finalization,
  transcription timing, retrieval updates, provider failure, and reconnect.
- 2026-08-19: M3 implementation and non-secret validation completed in commits
  `a32e343`, `31d871a`, `0f130ec`, and `6b697a9`; the earlier `invalid`
  Keychain/live-provider blocker was superseded by trusted-host correction
  `955633f` and final evidence commit `1f3ea3f`. The accepted live manifest at
  `test/evidence/m3/20260819T153402Z-live/` records bounded English 4/4,
  Vietnamese 6/7, and mixed 10/10 transcription, restart without another
  provider request, negative credential inspection, and audible citation
  playback. The final Expo-export rerun was killed by macOS memory pressure
  after the other checks passed; an earlier export at the accepted M3
  implementation boundary was green.
- **Milestone 2 invariant proof:** positive cases preserve valid chunks and
  publish a readable MP3; negative cases inject collisions, encoder failure,
  renderer exit, helper/daemon interruption, and a crash after publication but
  before `saved`. The collision target must remain byte-identical, premature
  cleanup must be rejected, and retry/reconciliation must use the original
  committed chunks.
- **Integration proof:** real app/client/daemon meeting creation; forced capture
  interruption and recovery; complete transcript reading; real Codex
  single-meeting chat restored after restart; citation-to-audio playback.
- **End-to-end proof:** Zoom/Meet both-side recording through transcript reading
  and cited single-meeting chat; paired web/mobile question and playback through
  the host daemon.
- **Repository-required checks:** M1 established `npm run check`,
  `npm run test:focused`, and `npm run validate:isolation`. Add or change
  milestone-specific checks only with the affected boundary; local command
  availability does not imply CI, hook, merge, or branch-protection
  enforcement.
- **Milestone 0 documentation proof:** `git diff --check`, local Markdown-link
  resolution, and targeted searches for stale open decisions or false capture
  completion.
- **Paseo fork sync proof:** upstream sync PR
  `https://github.com/hoangnb24/paseo/pull/2` preserved fork and upstream
  revision `16120ebff1918f5c22b9d018ac301be9b70c3ce9`, passed all required
  GitHub checks, and merged as
  `ee3420e80d93f7f0c875fcd45e816a5a9d06188f`; `git ls-remote` verifies both
  fork `main` and the peeled compatibility tag resolve to that commit.
- **Milestone 0 runtime proof:** the exact `ffprobe`, `ffmpeg astats`, and
  `shasum` commands and pass criteria in
  [`docs/macos-capture-spike.md`](../../macos-capture-spike.md). Levels alone do
  not replace phrase/listening or transcript evidence.
- **Milestone 1 proof:** `npm run check` passed typecheck, 12 test files / 40
  tests, the pinned Paseo and Meetless builds, and the Expo web export;
  `npm run test:focused` passed 11 files / 39 tests; and
  `npm run validate:isolation` passed 5 files / 24 positive and negative
  isolation, ownership, publication, and import-boundary tests. The atomic
  evidence manifest for run `20260816T162538200Z-e60998bb` is
  [`test/evidence/m1/20260816T162538200Z-e60998bb/manifest.json`](../../../test/evidence/m1/20260816T162538200Z-e60998bb/manifest.json),
  SHA-256
  `6264da3a635bfb6b54ac42e3e8f18ddb42ef40518a82ff82addd7e62e99ce72a`.
  Electron created meeting `72548faf-11ac-4720-b427-747ad190049a`; Chrome,
  including an attempted `?mode=desktop` escalation, and a disposable iOS 26.5
  iPhone 17 Pro simulator read that exact daemon-owned record without create
  controls. Candidate digest
  `66c23199763701cc15e72415d24f09bb4705a53e6e90663bab0bd5de250294b6`
  binds the source and eight evidence files.
- **Milestone 1 coexistence proof:** the accepted proof used isolated endpoint
  `127.0.0.1:52600`, an isolated runtime root, isolated server identity/store,
  isolated logs, and isolated Electron user-data. Before and after, production
  Paseo retained supervisor PID `31114`, daemon PID `31115`, start time
  `2026-08-15T04:49:39.700Z`, listener `127.0.0.1:6767`, PID-lock hash
  `58e7fb0ae0a8d6f1685ccbb14cc2c4c15190f338b83122c5495f4bfac8720051`,
  server-id hash
  `fcaa56cf7bdd348d2402a2683b8f7f5c23f74287fcfd665777685aadf7feae65`,
  and config hash
  `713b495637fa119fea3f54582301c298746a0ddefa5f757d11a60ba0ebf288c8`;
  only the expected PID-lock heartbeat mtime advanced. The disposable simulator,
  isolated runtime, listeners, and owned process groups were removed before the
  proof was atomically published.

## Result

The V1 product authority, separate-repository pinned-fork decision, P0 adoption
inventory, license limits, and evidence-bounded platform matrix are durable.
The maintained fork was synchronized through reviewed PR #2 and Meetless pins
its accepted commit through `vendor/paseo`; the two repositories retain
independent histories.
The accepted Google Meet session
`42943d6a-1e4a-475b-a0e2-b5692a28d6d5` records distinct microphone and system
audio plus a playable mixed MP3 on macOS 26.4 arm64. Milestone 0 is complete.
Milestone 1 is complete. Meetless now composes the pinned Paseo daemon through
an external trusted plugin, owns plain meeting lifecycle and atomic storage,
and presents one Meetless-only Expo product surface through Electron, web, and
iOS. Electron creates and lists meetings through the real daemon; connected web
and iOS companion surfaces read the same list. No Meetless product policy lives
inside `vendor/paseo`, and the pinned submodule remains clean.

Milestone 1 limits are explicit: mobile proof is an actual iOS 26.5 simulator
over host loopback, not a physical device or a LAN/relay pairing decision;
live stop-ownership inspection currently supports macOS and fails closed on
unsupported hosts; local validation has no checked-in hook or CI invocation,
and branch-protection enforcement is unverified. `npm install` reports 30
dependency vulnerabilities, largely in the pinned Paseo/Expo dependency tree;
breaking forced upgrades were not substituted for the accepted pin. CocoaPods
1.17.0 was installed globally through Homebrew at
`2026-08-16T22:23:32+07:00` to build the simulator proof. The project owner
accepted retaining that installation; it must not be removed as M1 cleanup.

Milestone 2 is complete against its documented functional boundary. The final
production Google Meet run captured separately audible system and microphone
phrases, published a readable collision-safe MP3, durably recorded saved state
before raw cleanup, and shut down the Meetless-owned runtime cleanly. Both
source-separated listening clips were intelligible but distorted/static-like;
that quality limitation is explicit evidence and remains an M7 release risk,
not a clean-audio claim.

Milestone 3 is complete against its documented bounded acceptance boundary.
The signed host transcribed the committed English, Vietnamese, and mixed
fixtures through the official OpenAI path without translation; durable ranges
and stable segment IDs survived restart; credential inspection was clean; and
a real citation click audibly played its authoritative interval. This proof is
not a long-meeting or release-readiness claim. The corrected
`POST-M3-ZERO-FIX` automated candidate now delays a failed start response until
conclusively empty inventory is durably failed while preserving valid
orphan/committed media as recoverable. The integrated correction candidate
through `db58b52` is mechanically accepted: focused lifecycle, inventory,
startup-order, composition, and pointer-geometry proofs pass, including
independent old-overlap and corrected hit-region assertions. The completed
post-M3 Harness improvement preserves the later Computer Use/WindowServer
attachment failure as baseline evidence, then replaces ambiguous UI preflights
with the accepted `1cbba679` POC capability. A fresh agent discovered and ran
the experimental renderer smoke and the identity-bound deterministic chain from
UI through socket/store, fixture helper and chunks, MP3, and ready fixture
transcription without owner intervention. Native proof remained truthfully
`incomplete` because the signed-host capability is invalid, and it performed no
fake substitution. The project owner subsequently launched the supported app,
completed a fresh recording, opened its transcript, and audibly played cited
audio. That owner-observed flow removes the stale post-M3 dependency blocker;
M4 may begin. The native Harness result remains an unresolved diagnostic caveat,
not a reversal of accepted M3 behavior or a release-readiness claim.

Milestone 4 is complete against its bounded acceptance boundary. The desktop
surface now uses a Paseo-inspired meeting sidebar/detail split, compact clients
use list/detail navigation with Back, and the selected Meetless meeting renders
explicit loading, empty, processing, failed, and complete ready transcript
states. Timestamp presses retain the M3 stable citation identity and bounded
audio path. The accepted installed-host generated-fixture proof selected the
target among a distractor, matched all three rendered segments exactly to
MeetingStore and daemon RPC order, and played/analyzed the expected third
interval. Durable evidence contains only its manifest and screenshot; exact
temporary roots were removed and the owner's runtime restored byte-for-byte.
This does not add or claim provider selection, coding-agent execution, chat,
durable chat history, cross-meeting retrieval, or document folders.
