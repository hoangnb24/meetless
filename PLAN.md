# PLAN: Real-Time Local Transcription for Sequoia Capture

## Objective
Build a fully local, real-time transcription pipeline on top of the existing ScreenCaptureKit capture flow that:
- emits low-latency partial and finalized transcript events
- transcribes mic and system channels concurrently
- applies small local LLM cleanup to finalized segments only
- produces reproducible session artifacts (WAV + JSONL + manifest)

## Planning Policy (Evidence First)
This plan is hypothesis-driven until benchmark artifacts exist.

- `Validated` means measured in this repo with reproducible commands and saved results.
- `Assumed` means design hypothesis pending measurement.
- Any latency/CPU/memory claim without a benchmark artifact is non-authoritative.
- Model/backend decisions use benchmark outputs only, not blog/forum estimates.

## Hard Constraints
- Platform: macOS 15+ on Apple Silicon.
- Execution: fully local ASR + LLM (no network dependency).
- Interface: CLI-first, with signed `.app` bundle run path.
- Privacy: no audio leaves device.
- Language scope: English-only in v1.

## Real-Time Thread Contract (Non-Negotiable)

### Capture callback thread
Allowed:
- read incoming PCM
- write into preallocated lock-free transport slots
- timestamp and enqueue metadata

Not allowed:
- resampling
- VAD
- ASR inference
- LLM calls
- blocking I/O
- heap growth on hot path

### Worker threads
- Resampling, VAD, ASR, merge, LLM cleanup, disk output all run off callback thread.

## Current Baseline
Validated:
- Capture pipeline records stereo WAV (`L=mic`, `R=system`).
- Signed bundle run path works with TCC prompts.
- Sandboxed output behavior is understood and documented.

Assumed:
- Real-time transcription latency targets can be met on M1-class hardware.
- Dual-channel concurrent ASR remains stable over long sessions.

## Architecture

```text
SCK callback -> lock-free transport -> resampler -> VAD -> ASR workers (mic/system) -> segment merger -> LLM cleanup worker -> sinks
```

Detailed flow:
1. SCK emits PCM chunks for mic/system streams.
2. Callback enqueues fixed-size chunks to lock-free queues.
3. Worker resamples 48 kHz to 16 kHz mono per channel.
4. VAD opens/closes speech segments.
5. ASR workers emit partial/final per channel.
6. Merger aligns channel segments by PTS into a merged timeline.
7. LLM cleanup rewrites finalized text only.
8. Output writer persists JSONL + transcript + session manifest.

## Open Decision: ASR Backend
Candidates:
- `whisper-rs` (`whisper.cpp`)
- Moonshine v2 via ONNX Runtime (`ort`) integration path

Decision status:
- No backend is selected as final until Gate A and Gate B pass.

Potential blocker:
- Moonshine Rust integration maturity and runtime behavior on Sequoia remains an explicit risk until benchmarked.

## SLOs and Measurement Authority
Target SLOs:
- Partial transcript latency p95: <= 1.5 s
- Finalized segment latency p95: <= 2.5 s
- 30+ minute run without stalls or drops

Measurement authority:
- Only benchmark harness outputs in `artifacts/bench/` are authoritative.
- If measured SLOs differ from estimates, measured data wins.

## Benchmark Gates (Go/No-Go)

### Gate A: Model Latency/Quality Selection
Duration: Day 1-2

Compare candidate ASR backends on identical audio corpus and hardware tier.

Metrics:
- partial latency (p50/p95)
- final latency (p50/p95)
- WER (same evaluation set)
- CPU% (sustained)
- RSS memory

Pass thresholds (single-channel):
- p95 partial <= 1.5 s
- p95 final <= 2.5 s
- CPU <= 50% (M1 baseline)
- RSS <= 1.2 GB

Decision rule:
- Choose backend that meets thresholds with best latency margin.
- If neither meets thresholds, relax target to 2.0 s / 3.0 s with ADR justification.

### Gate B: Rust Integration Viability
Duration: Day 2-3

Build minimal Rust integration for selected backend.

Pass thresholds:
- end-to-end Rust inference <= 2x standalone backend runtime
- stable repeated inference (100+ runs) without crash/leak behavior

Decision rule:
- If selected backend fails integration threshold, fallback to alternate backend.

### Gate C: Dual-Channel Stress
Duration: Day 3-4

Run concurrent channel ASR for 5-10 minutes.

Pass thresholds (dual-channel):
- zero dropped audio chunks
- CPU <= 80% sustained (M1 baseline)
- RSS <= 2.5 GB
- no backlog growth (bounded queue depth)

Decision rule:
- If thresholds fail, enable `mixed` fallback mode and document hardware-tier limits.

### Gate D: Long-Session Stability
Duration: Day 4-5

Run 60-minute session with selected profile.

Pass thresholds:
- zero stalls
- memory growth <= 5%
- stable latency p95 drift <= 15%

## Resource Budgets
These are planning budgets, not validated limits.

Single-channel target budget:
- ASR + VAD + merge: <= 50% CPU, <= 1.2 GB RSS

Dual-channel target budget:
- ASR + VAD + merge + cleanup queue: <= 80% CPU, <= 2.5 GB RSS

LLM cleanup budget:
- async finalized-segment processing only
- no ASR-path blocking
- drop/skip policy when cleanup queue exceeds max depth

## CLI Surface (Planned)
Primary command:
- `recordit transcribe-live`

Core flags:
- `--duration-sec <u64>`
- `--out-wav <path>`
- `--out-jsonl <path>`
- `--out-manifest <path>`
- `--sample-rate <hz>`

ASR flags:
- `--asr-backend whisper-rs|moonshine`
- `--asr-model <path>`
- `--asr-language en`
- `--asr-threads <n>`
- `--asr-profile fast|balanced|quality`

VAD flags:
- `--vad-backend webrtc|silero`
- `--vad-threshold <f32>`
- `--vad-min-speech-ms <u32>`
- `--vad-min-silence-ms <u32>`

LLM flags:
- `--llm-cleanup`
- `--llm-endpoint <url>`
- `--llm-model <id>`
- `--llm-timeout-ms <u64>`
- `--llm-max-queue <usize>`

Channel flags:
- `--transcribe-channels separate|mixed` (default `separate`)
- `--speaker-labels mic,system`

## Data Contracts
`TranscriptEvent` (JSONL):
- `event_type`: `partial|final|llm_final`
- `channel`: `mic|system|merged`
- `segment_id`
- `start_ms`
- `end_ms`
- `text`
- `confidence` (if available)

`SessionManifest`:
- capture config
- backend/model config
- benchmark counters (latency, queue depth, drops)
- output paths
- run outcome (`success|degraded|failed`)

## Implementation Phases

### Phase 1: Streaming ASR Core
- Implement `transcribe-live` with partial/final event emission.
- Persist JSONL transcript events.
- Keep LLM cleanup disabled.
- Produce Gate A benchmark artifact.

Acceptance:
- terminal partial/final stream works
- JSONL replay reconstructs transcript
- Gate A report committed

### Phase 2: Dual-Channel Merge
- Independent mic/system ASR workers.
- PTS-based merge pipeline.
- Produce Gate C benchmark artifact.

Acceptance:
- channel-separated + merged outputs
- Gate C pass or documented mixed-mode fallback

### Phase 3: LLM Cleanup Worker
- Async cleanup queue for finalized segments.
- Non-blocking fallback when queue is full/unavailable.

Acceptance:
- ASR path unaffected by LLM latency
- `llm_final` events emitted when available

### Phase 4: RT Hardening
- Replace prototype transport with fixed-capacity lock-free ring.
- Remove callback-side heap churn.
- Add queue-depth/drop telemetry.

Acceptance:
- callback contract enforced
- Gate D stability report committed

### Phase 5: Packaging + Operator UX
- Integrate `transcribe-live` into Makefile run targets.
- Print absolute artifact paths in all run modes.
- Ensure sandbox path behavior is explicit.

Acceptance:
- one-command signed-bundle run with artifact discovery

## Risks and Mitigations
- Model latency misses SLO:
  - Mitigation: backend fallback + SLO adjustment ADR.
- Rust integration instability:
  - Mitigation: backend abstraction boundary and swap path.
- CPU saturation on older Apple Silicon:
  - Mitigation: `mixed` mode and lower profile defaults.
- Sandbox output confusion:
  - Mitigation: always print absolute output paths.

## Success Criteria
1. Meets SLOs with benchmark evidence.
2. Runs fully local with no cloud dependency.
3. Stable 30+ minute sessions on target hardware tier.
4. Reproducible artifacts (WAV, JSONL, manifest, benchmark CSV).
5. Clear fallback modes when hardware cannot sustain dual-channel real-time.

## Immediate Next Step
Implement Phase 1 with backend abstraction (`whisper-rs` first), VAD gating, JSONL event output, and benchmark harness that records p50/p95 latency, CPU, RSS, and drop counters.
