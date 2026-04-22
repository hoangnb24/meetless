# Spike Findings: bd-1yz

## Question

Can the session bundle preserve incomplete recordings and the exact live transcript snapshot without overengineering storage?

## Verdict

YES

## Evidence

- The locked Phase 1 contract only needs local durability for one saved session loop plus incomplete recovery; it does not require search, sync, export, or post-processing infrastructure.
- The current approach already defines a file-backed bundle with `session.json`, `transcript.json`, `meeting.wav`, and `me.wav`, which is sufficient for browse-only history and read-only detail in later phases.
- The transcript requirement is specifically to save the exact live snapshot seen during recording, which aligns with persisting committed chunk state rather than inventing a second final-pass transcription artifact.

## Constraints

- Treat per-source raw audio files as the durable source of record.
- Persist session metadata early enough that an interrupted session can still reopen as incomplete.
- Snapshot the committed transcript timeline incrementally during recording or immediately after each committed-chunk update, not only at graceful Stop time.
- Include the timestamp-based default title in the saved metadata from Phase 1 so Phase 2 history does not need to backfill it later.

## Impact On Phase 1

- `bd-p23` should persist enough metadata before the end of a clean stop path to survive interruption.
- `bd-2rx` and `bd-p23` should share a clear handoff contract for the committed transcript timeline so the saved snapshot matches what the user saw.

## Sources

- /Users/themrb/Documents/1_projects/meetless/history/native-macos-meeting-recorder/CONTEXT.md
- /Users/themrb/Documents/1_projects/meetless/history/native-macos-meeting-recorder/approach.md
- /Users/themrb/Documents/1_projects/meetless/history/native-macos-meeting-recorder/phase-1-contract.md
