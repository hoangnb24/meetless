# Meetless V1

Meetless is a personal, local-first meeting recorder and knowledge tool. One
person records Zoom or Google Meet on a desktop host, then uses an existing
coding agent such as Codex to analyze and query the result.

The V1 loop is:

```text
record a Zoom/Meet call
  -> preserve and export local audio
  -> transcribe into timed segments
  -> generate a cited summary, decisions, and proposed action items
  -> ask cited questions over meetings and selected document folders
  -> play the audio interval behind a meeting citation
```

Desktop owns recording and local processing. Web and mobile are companion
clients while the desktop daemon is reachable. They browse meetings, read
artifacts, ask questions, and play cited audio; they do not record system audio
in V1.

Meetless owns meetings, recordings, transcript segments, derived artifacts,
citations, and knowledge sources. Paseo coding projects, workspaces, agents,
timelines, and terminals are infrastructure or integration concerns, never
substitutes for those meeting-domain records. An agent run analyzes a meeting;
a meeting is not an agent or coding workspace.

V1 excludes team workspaces, cloud source-of-truth storage, calendar ingestion,
call-joining bots, task-system synchronization, speaker diarization as a release
gate, and mobile system-audio recording.
