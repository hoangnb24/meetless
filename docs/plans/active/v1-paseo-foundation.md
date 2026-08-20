# Execution Plan: Meetless V1 On Top Of Paseo

Date: 2026-08-16

## Status

Active

Post-M3 Electron Harness POC: accepted after fresh rerun. The native/live-source
gate is incomplete, so M4 remains closed.

## Outcome

Deliver a personal, local-first Meetless V1 that keeps Paseo's cross-platform
client/daemon shape while adding a separate meeting knowledge domain.

The observable V1 workflow is:

```text
Record Zoom/Meet on desktop
  -> save a recoverable local MP3
  -> transcribe into timestamped segments
  -> ask an existing coding agent such as Codex for summary/action items
  -> ask questions over meetings and selected document folders
  -> cite every grounded answer
  -> click a meeting citation to play the supporting audio interval
```

Desktop is the recording host. Web and mobile are companion clients for
browsing meetings, reading generated artifacts, asking questions, and playing
cited audio while the host daemon is reachable.

## Product Authority

This plan records the product-owner decisions accepted on 2026-08-16:

- V1 is for one person, not a shared company workspace.
- The primary meeting source is Zoom/Google Meet.
- Meetless must have desktop, web, and mobile clients shaped like Paseo.
- Desktop recording captures microphone and system audio.
- The default audio export is under `~/Documents/meetings/` using the requested
  `HH-DD-Mm-YY.mp3` convention; collisions must never overwrite an existing
  recording.
- Existing Paseo coding-agent providers, including Codex, perform meeting
  analysis and question answering.
- Answers grounded in meetings or documents include resolvable citations.
- A meeting citation can seek playback to the supporting audio interval.
- User-selected document folders are additional local knowledge sources.
- Mobile is for reading and question answering, not V1 system-audio recording.
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
  and optional encrypted relay transport;
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
6. **Analyze with an existing agent.** The user selects Codex or another
   configured Paseo coding agent to generate a summary, decisions, and proposed
   action items from the transcript.
7. **Review grounded artifacts.** Missing owners or deadlines stay unspecified;
   generated claims carry transcript-segment citations rather than model-written
   timestamp strings.
8. **Ask about one meeting.** The user can ask a question scoped to the open
   meeting. A supported answer cites transcript segments; an unsupported answer
   says that the meeting does not contain enough evidence.
9. **Play evidence.** Clicking a citation opens the meeting player and seeks to
   a small interval around the cited segment.

### P1: personal knowledge across sources and devices

1. **Search meetings.** The user can ask across all or selected meetings with a
   time filter and receive citations to each supporting meeting segment.
2. **Add document folders.** The user can allowlist local folders. The daemon
   indexes supported files and updates or removes indexed content when source
   files change or disappear.
3. **Ask across meetings and documents.** Retrieval can combine transcript
   segments and document chunks. Meeting citations open audio; document
   citations identify and open the source file and location when available.
4. **Use companion clients.** Web/mobile clients can list meetings, read
   transcripts and artifacts, ask grounded questions, and stream cited audio
   through the connected daemon.
5. **Explain host availability.** When the personal daemon is offline, companion
   clients show that local knowledge is unavailable instead of displaying a
   misleading empty state.

## Scope

In scope:

- Personal, local-first storage and processing.
- Paseo-derived desktop, web, and mobile application shell and design system.
- A desktop recording path for Zoom/Meet microphone plus system audio.
- Platform-specific capture adapters behind one recording contract.
- Recoverable chunk recording and post-stop MP3 finalization.
- Meeting, recording, transcript, derived-artifact, knowledge-source, and
  citation models with explicit lifecycle states.
- Automatic transcription after recording.
- Existing Paseo coding-agent provider discovery and agent execution.
- Meeting-specific tools that give agents bounded retrieval rather than placing
  the entire knowledge base into one prompt.
- Summary, decisions, proposed action items, single-meeting Q&A, and citation
  playback.
- Multi-meeting/document retrieval and web/mobile companion access after the P0
  loop is proven.

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
  reconnect/snapshot patterns, host pairing, and optional relay transport.
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
  -> DerivedArtifact[]
  -> Citation[]

KnowledgeSource
  -> MeetingTranscript | DocumentFolder
  -> indexed chunks
  -> retrieval results with stable source locations
```

Minimum lifecycle model:

```text
Meeting:    draft -> recording -> processing -> ready -> archived
Recording:  recording -> finalizing -> saved
                     \-> interrupted -> recoverable | failed
Transcript: pending -> transcribing -> ready | failed
Artifact:   proposed -> accepted | dismissed
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
| Coding-agent providers vary while meeting analysis stays stable | Existing agent provider infrastructure plus a Meetless analysis adapter | Codex and a deterministic fake consume the same bounded meeting context | Analysis stops using coding agents |
| Meeting/document retrieval backends may evolve | `KnowledgeIndex` | Indexed fixtures return stable source IDs and locations | Retrieval stays a trivial in-memory lookup |

### Coding-agent integration

Do not map a meeting to a Paseo agent or workspace. The user starts an agent run
for an analysis task. Meetless supplies explicit tools such as:

```text
search_meetings(query, meeting_ids?, time_range?)
get_transcript_segments(segment_ids)
search_documents(query, source_ids?)
get_document_chunks(chunk_ids)
submit_meeting_artifact(meeting_id, artifact)
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
  transcription, citation playback, agent analysis, and Q&A remain later
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
- **Dependency:** M4 remains closed until the implementation is accepted and
  the handback states separately whether deterministic automation and the
  original fresh real recording/TCC gate have each been satisfied.

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
failure reporting with preserved-state diagnostics. M4 remains closed.

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
owned processes or run-state files. This closes the Harness-improvement rerun,
not the original native/physical/TCC/live-source recording gate; M4 stays
closed.

### Milestone 4: coding-agent analysis

- Reuse Paseo provider/model discovery and agent execution.
- Give the agent a bounded meeting-analysis task and retrieval tools.
- Validate structured summary, decision, and action-item output at the daemon
  boundary before persistence.
- Support proposed/accepted/dismissed artifact state.

Acceptance boundary: Codex analyzes a recorded fixture through the real
composition, every accepted factual item resolves to transcript evidence, and
missing owners/deadlines remain absent.

### Milestone 5: grounded Q&A and document folders

- Implement meeting and document indexing behind `KnowledgeIndex`.
- Watch only explicitly allowlisted folders; reindex changes and remove deleted
  sources.
- Expose bounded search/get tools to coding agents.
- Render meeting and document citations with source-specific navigation.

Acceptance boundary: one question combines a meeting segment and a document
chunk, both citations resolve, and deleting the document removes it from future
retrieval.

### Milestone 6: companion web/mobile experience

- Present meeting list/detail, transcript, artifacts, Q&A, and cited audio on
  web/mobile.
- Reuse host pairing/reconnect/relay behavior as accepted by the adoption
  decision.
- Make daemon-offline state explicit.

Acceptance boundary: a paired mobile client asks a question, receives a
grounded answer, and plays cited audio from the desktop host; disconnecting the
host produces the designed offline state.

### Milestone 7: V1 acceptance and release readiness

- Exercise the complete P0 path on the accepted desktop platform matrix.
- Exercise web/mobile companion behavior on real supported targets.
- Verify storage recovery, provider failure, index deletion, and citation
  integrity.
- Record remaining platform and model-quality limitations.

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
- **Coding agents can hallucinate citations.** Accept only known segment/chunk
  IDs and resolve display locations in application code.
- **Broad agent filesystem access can exceed user intent.** Retrieval tools and
  document indexing are constrained to explicitly selected meetings/folders;
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
- [ ] Complete Milestone 4: coding-agent analysis.
- [ ] Complete Milestone 5: grounded Q&A and document folders.
- [ ] Complete Milestone 6: companion web/mobile experience.
- [ ] Complete Milestone 7: V1 acceptance and release readiness.

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
  analysis remains user initiated and provider selectable.
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

Open decisions before affected implementation:

- Exact macOS hardware/version release matrix beyond the first proven host.
- Minimum release-quality threshold and remediation for the static-like
  distortion observed on both intelligible M2 production source clips. This is
  an M7 release decision; M2 makes no normal-quality claim.
- Supported document formats and exact source-location behavior for each.
- Whether remote companion access uses direct LAN pairing only or also Paseo's
  encrypted relay in V1.

## Validation

- **Plan proof:** inspect rendered Markdown, links, milestone dependency order,
  and agreement between product authority, scope, progress, and decisions.
- **Focused policy proof:** unit tests for meeting lifecycle transitions,
  collision-safe filenames, artifact validation, citation resolution, and
  allowlisted document paths.
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
  interruption and recovery; real Codex analysis; citation-to-audio playback.
- **End-to-end proof:** Zoom/Meet both-side recording through summary/action
  items/Q&A; paired web/mobile question and playback through the host daemon.
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
fake substitution. Therefore a fresh real recording and native M3 transcription
handoff are still required; M4 remains closed.
