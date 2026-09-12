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

Stop saves local audio only. A saved recording without a transcript is a normal
completed state. The user selects **Transcribe** for each saved recording;
cloud disclosure and consent belong to that explicit action. Premium access,
previous consent, relaunch, and a quota reset never start upload or transcription
automatically.

In the first release, the transcription UI uses Premium and defers API-key
entry. Without Premium, offer purchase or restore in the recording context.
A successful purchase updates Premium automatically; the user then selects
**Transcribe** again. Do not resume the earlier request automatically.

Check that the remaining managed allowance covers the whole recording before
upload. If it does not, explain the limit, do not process a partial recording,
and keep the local audio for a later explicit attempt when allowance is
available. See [Meetless Premium](monetization.md) for access, future free BYOK
routing, and quota policy.

Transcription produces ordered segments, each with a stable ID and millisecond
audio range. Transcription failure is retryable from saved audio.

Milestone 0 proves only that a real or controlled Zoom/Meet call can capture the
local microphone and remote system-audio sides. Recovery, MP3 finalization, and
transcription are later milestones and are not implied by that spike.
