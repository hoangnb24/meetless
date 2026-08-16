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
not started.

### Milestone 1: compose the shell and meeting domain

- Bring up the Paseo-derived daemon, Electron shell, web app, and one mobile
  client without importing coding workspace screens as the Meetless product.
- Add plain meeting lifecycle types and focused use-case tests.
- Add new capability-gated `meeting.*` protocol messages and client methods.
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
- [ ] Complete Milestone 1: shell and meeting domain.
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
- 2026-08-16: Distribution is open source compatible with Paseo's
  AGPL-3.0-or-later obligations; binary release remains gated on a complete
  third-party/native/model license and notice review.

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

## Result

The V1 product authority, separate-repository pinned-fork decision, P0 adoption
inventory, license limits, and evidence-bounded platform matrix are durable.
The maintained fork was synchronized through reviewed PR #2 and Meetless pins
its accepted commit through `vendor/paseo`; the two repositories retain
independent histories.
The accepted Google Meet session
`42943d6a-1e4a-475b-a0e2-b5692a28d6d5` records distinct microphone and system
audio plus a playable mixed MP3 on macOS 26.4 arm64. Milestone 0 is complete.
Product code and Milestone 1 have not started.
