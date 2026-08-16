# Recording

## Start And Control

A persistent desktop action starts a meeting with microphone and system audio
selected by default. A route-independent indicator shows elapsed time and keeps
pause and stop available.

The first recording host is macOS. Both sources must be captured by a
platform-specific adapter while remaining distinguishable at the capture
boundary. Shared Expo UI does not establish recording support on an operating
system.

## Preserve And Export

Capture writes recoverable chunks incrementally. A renderer crash, daemon
restart, or failed finalization must not discard every completed chunk.

Stop finalizes an MP3 under `~/Documents/meetings/` using
`HH-DD-Mm-YY.mp3`. A collision receives a distinct name; an existing recording
is never overwritten. Source chunks remain available until the MP3 is readable
and the saved recording state has been durably updated. Finalization can retry
without recording the meeting again.

## Transcription

A saved recording automatically becomes ordered transcript segments. Every
segment has a stable ID and millisecond audio range. Transcription failure is
retryable from saved audio.

Milestone 0 proves only that a real or controlled Zoom/Meet call can capture the
local microphone and remote system-audio sides. Recovery, MP3 finalization, and
transcription are later milestones and are not implied by that spike.
