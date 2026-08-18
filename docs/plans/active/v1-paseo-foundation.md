# Execution Plan: Meetless V1 On Top Of Paseo

Date: 2026-08-16

## Status

Active

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
- **Status:** `FOUNDATION_REQUIRED`. Candidate `b0fa863` remains accepted for
  renderer failure-status propagation, but its production-recovery claim is
  rejected. Do not rerun the preserved session until this foundation is
  implemented and independently reviewed; each old launch can adopt another
  arbitrary prefix.

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

- Adapt Paseo speech components behind `TranscriptionProvider` without leaking
  voice-session or agent types into meeting policy.
- Persist ordered transcript segments with stable IDs and millisecond ranges.
- Add retryable processing state and a player that seeks by segment citation.

Acceptance boundary: a fixed audio fixture creates stable timed segments, and a
real citation click plays the expected spoken interval.

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
- [ ] Complete Milestone 2: durable desktop recording.
- [ ] Complete Milestone 3: transcription and citation playback.
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

Open decisions before affected implementation:

- Exact macOS hardware/version release matrix beyond the first proven host.
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
- **Repository-required checks:** define build, typecheck, lint, targeted test,
  and package/license checks after the Paseo adoption strategy establishes the
  repository toolchain. Do not claim them before those commands exist.
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
