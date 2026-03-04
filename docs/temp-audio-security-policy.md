# Temp Audio Security And Privacy Policy

Bead: `bd-2u94`

## Scope

This policy applies to temp/scratch WAV artifacts produced for live/representative runtime ASR work units.

## Security Rules

1. Temp cleanup must only delete regular files.
2. Symlink paths are never auto-deleted by cleanup logic.
3. Non-file paths (for example directories/devices) are never auto-deleted by cleanup logic.
4. Any cleanup-path metadata/read/delete failure defaults to retain-for-review behavior.

## Privacy And Retention Rules

`TempAudioPolicy` remains the operator contract:

| Policy | Success path | Failure path |
|---|---|---|
| `DeleteAlways` | delete temp audio if path is a safe regular file | delete temp audio if path is a safe regular file |
| `RetainOnFailure` | delete temp audio if path is a safe regular file | retain temp audio |
| `RetainAlways` | retain temp audio | retain temp audio |

Safety overrides contract intent when needed:
- If a temp path is a symlink or non-file path, cleanup retains it even under `DeleteAlways`.
- If metadata/delete operations fail unexpectedly, cleanup retains the path for investigation.

## Test Expectations

Coverage for this policy lives in `src/live_asr_pool.rs` tests and must include:
- normal success/failure retention semantics
- symlink temp-path safety behavior
- non-file temp-path safety behavior

Failures should include enough context (`segment_id`, temp-audio counters, and policy mode) to support remote triage.

## Worker-Local PCM Scratch Lifecycle (`bd-27aa`, `bd-32jo`)

Live PCM-window ASR requests now use a worker-local reusable scratch WAV path in
`src/bin/transcribe_live/asr_backend.rs`:

1. Each worker thread owns one deterministic scratch path under
   `tmp/recordit-live-asr-pcm/pid-<pid>/worker-<thread>.wav`.
2. Each PCM request overwrites that same path (no per-request random scratch-path churn).
3. The scratch target is validated before overwrite:
   - symlink targets are rejected
   - non-file targets are rejected
4. Cleanup semantics are policy-aligned and safety-first:
   - `DeleteAlways`: delete scratch on worker shutdown when the path is a safe regular file
   - `RetainOnFailure`: retain only when the most recent request failed
   - `RetainAlways`: retain on worker shutdown
   - safety overrides apply in all modes: unsafe targets (symlink/non-file) or metadata/write failures force retain-for-review
5. Telemetry interpretation across request modes:
   - `temp_audio_deleted` / `temp_audio_retained` in `LiveAsrPoolTelemetry` track path-backed temp-audio cleanup in `LiveAsrService`
   - `PcmWindow` worker-local scratch cleanup is executor-local and not counted in those two pool counters

Coverage for worker-local scratch behavior lives in
`src/bin/transcribe_live/asr_backend.rs` unit tests:
- normal overwrite/reuse path
- retry flow overwrite with policy-aligned retention/deletion behavior
- policy matrix behavior (`DeleteAlways`, `RetainOnFailure`, `RetainAlways`)
- symlink safety rejection
