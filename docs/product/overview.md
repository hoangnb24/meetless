# Meetless V1

> **Current direction — 2026-09-18:** [Desktop Managed AI](desktop-managed-ai.md)
> supersedes the existing-agent and companion scope below for the Mac pivot.
> E1 policy is approved; E2 has bounded authority under ADR0008. The V1 text and
> observations below are retained history, not current provider requirements.

> **Current status — 2026-09-16:** V1 and Mac App Store development are paused
> pending the owner's final decision to shut down or pivot. This document keeps
> the accepted product intent and the bounded behavior already validated; it is
> not a release promise or authorization to continue development. The core
> provider-reuse path remains unresolved: the Apple-distributed build 1.0 (6)
> did not establish an actual Ask response through the user's existing provider.
> See [ADR0007](../decisions/0007-stop-v1-pending-product-direction.md).

Meetless is a personal, local-first meeting recorder and knowledge tool. One
person records Zoom or Google Meet on a desktop host, then uses an existing
coding agent such as Codex or Claude Code to ask questions about the result.

The V1 loop is:

```text
record a Zoom/Meet call
  -> preserve and export local audio
  -> transcribe into timed segments
  -> select a meeting and read its complete transcript
  -> chat with that meeting through an existing coding agent
  -> play the audio interval behind a meeting citation
```

Desktop owns recording and local processing. Web and mobile are companion
clients while the desktop daemon is reachable through direct LAN pairing or
Paseo's encrypted relay. They browse meetings, read transcripts, ask questions,
and play cited audio; they do not record system audio in V1.

When the desktop host is offline, companions show an explicit host-offline
state and do not replace a previously known meeting list with a misleading
empty state. V1 does not require opening or retaining meeting detail while the
host is disconnected, and the companion does not become an offline source of
meeting truth.

Meetless owns meetings, recordings, transcript segments, durable meeting chat
threads, and citations. Paseo coding projects, workspaces, agents, timelines,
and terminals are infrastructure or integration concerns, never
substitutes for those meeting-domain records. An agent answers questions about
a meeting; a meeting is not an agent or coding workspace.

V1 excludes team workspaces, cloud source-of-truth storage, calendar ingestion,
call-joining bots, task-system synchronization, speaker diarization as a release
gate, mobile system-audio recording, cross-meeting Q&A, and document-folder
indexing. Cross-meeting Q&A and document folders remain outside this paused V1
scope.

## Current acceptance boundary

The owner confirmed the following bounded TestFlight behavior on build 1.0 (4):
recording permissions and meeting recording worked, a monthly Sandbox purchase
was completed, and audio transcription completed. These results preserve the
recording, billing, and managed-transcription work as historical product
evidence; they do not establish App Review, public release, or the provider
reuse required by the V1 loop.

On build 1.0 (6), the Store app reached the existing meeting but the
chooser/bookmark attempt did not establish executable access to the existing
Codex installation, and no model launch or actual Ask response was accepted.
That is a failure of the attempted Store integration, not a proof that every
possible provider architecture is impossible. The product requirement remains
minimal-setup reuse of the user's existing Codex/Claude configuration and
account, without copying credentials or adding a second Meetless login. Further
proof or implementation is suspended by ADR0007.
