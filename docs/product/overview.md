# Meetless V1

Meetless is a personal, local-first meeting recorder and knowledge tool. One
person records Zoom or Google Meet on a desktop host, then uses an existing
coding agent such as Codex to ask questions about the result.

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
indexing. Cross-meeting Q&A and document folders are post-MVP work.
