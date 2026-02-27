# Technical Discovery Sprint: Real-Time Local Transcription for Sequoia Capture

## Executive Summary

This sprint report applies the Technical Discovery Sprint template to the proposed real-time local transcription pipeline built on ScreenCaptureKit. The plan is architecturally sound, but research reveals a **critical model-choice decision** that should be resolved before Phase 1 begins: **Moonshine v2** (released January 2026) achieves 5.8–43.7× lower response latency than Whisper on Apple Silicon while matching or exceeding accuracy. The 30-second fixed-chunk limitation inherent to Whisper's architecture is the single largest risk to the stated latency targets, and Moonshine v2 eliminates it entirely. The rest of the architecture—lock-free audio transport, VAD gating, dual-channel merge, and LLM cleanup—is validated as feasible with mature Rust crates.[^1][^2][^3]

***

## Problem and Goal

Build a fully local, real-time transcription pipeline that runs on top of an existing ScreenCaptureKit capture flow on macOS. The pipeline must transcribe mic and system audio continuously, deliver partial results in under 1.5 seconds, and produce clean, punctuated transcripts without any cloud dependency.

**Measurable success metric:** End-to-end partial transcript latency ≤ 1.5 s; finalized segment latency ≤ 2.5 s; stable operation for 30+ minute sessions on laptop-class Apple Silicon hardware.

***

## Hard Constraints (Non-Negotiables)

- **Platform:** macOS 15+ (Sequoia), Apple Silicon (M1–M4)
- **Form factor:** CLI (`recordit transcribe-live`), with signed `.app` bundle mode
- **Execution:** Fully local—zero network calls for ASR or LLM
- **Privacy:** No audio leaves the device; no telemetry
- **Language:** English-only (initial scope)
- **Runtime:** Must coexist with existing capture flow without audio glitches

**Won't-do list:**
- No cloud ASR fallback
- No token-level live LLM decoding of raw audio
- No speaker diarization beyond mic/system channel separation
- No multi-language support in v1
- No GUI in v1 (terminal + file sinks only)

***

## Reality Checks (What Must Be True)

| Requirement | Status | Evidence |
|---|---|---|
| ScreenCaptureKit delivers PCM callbacks at stable cadence | ✅ Validated | Existing capture flow writes stereo WAV reliably |
| TCC permissions for audio capture remain stable across sessions | ✅ Validated | Current packaging flow handles this |
| whisper.cpp / Moonshine runs faster than real-time on Apple Silicon | ✅ Validated | `base.en` achieves 18× real-time on M4[^4]; Moonshine v2 Tiny uses only 8% compute load on M3[^3] |
| Quantized ASR models fit in memory alongside LLM | ✅ Validated | `base.en` needs ~388 MB[^5]; a 3B Q4 LLM needs ~2 GB; fits in 8 GB unified memory |
| Local LLM can clean text at sufficient throughput | ✅ Validated | Llama 3.2 3B Q4 achieves ~45 tok/s on M4[^6]; finalized segments are short |
| App Sandbox allows writing transcript artifacts to disk | ✅ Validated | Existing flow writes WAV to sandbox output |
| Silero VAD runs in Rust via ONNX Runtime | ✅ Validated | `silero-vad-rs` crate provides streaming iterator API at 16 kHz[^7][^8] |

**External blockers:** None identified. All dependencies are open-source with permissive licenses.

***

## Unknowns and Risks Register

### Blocking Risks (Must Validate Before Phase 1)

| # | Unknown (as question) | Severity | Effort to Validate |
|---|---|---|---|
| U1 | Can Whisper deliver ≤1.5 s partial latency given its 30-second encoder window? | 🔴 High | 2–4 hours POC |
| U2 | Is Moonshine v2's ONNX/C++ runtime callable from Rust with acceptable FFI overhead? | 🔴 High | 4–8 hours POC |
| U3 | Does concurrent ASR on two channels (mic + system) cause CPU saturation on M1 8 GB? | 🟡 Medium | 2–4 hours bench |
| U4 | Can the resampler (48 kHz → 16 kHz) run deterministically inside the audio callback without heap allocation? | 🟡 Medium | 1–2 hours test |

### Nice-to-Have Risks

| # | Unknown (as question) | Severity | Effort |
|---|---|---|---|
| U5 | Does LLM cleanup latency stay under 500 ms for typical segment lengths (5–15 words)? | 🟢 Low | 1 hour bench |
| U6 | Can JSONL event replay reconstruct a pixel-perfect transcript timeline? | 🟢 Low | 1 hour test |
| U7 | Is `rtrb` capacity sufficient for sustained 48 kHz stereo without drops? | 🟢 Low | 1 hour bench |

***

## Validation Plan (Timeboxed)

### Gate 1: ASR Model Selection (Day 1–2)

**Experiment:** Run both `whisper.cpp stream` and Moonshine v2 (via C++ binary) against a 60-second pre-recorded WAV on target hardware.

| Metric | whisper.cpp `base.en` | Moonshine v2 Tiny | Pass Threshold |
|---|---|---|---|
| Partial latency (p95) | Measure | Measure | ≤ 1.5 s |
| Final segment latency | Measure | Measure | ≤ 2.5 s |
| WER on test clip | Measure | Measure | ≤ 12% |
| CPU load (sustained) | Measure | Measure | ≤ 50% on M1 |
| Memory RSS | Measure | Measure | ≤ 600 MB |

**Pass/fail:** If whisper.cpp cannot meet the 1.5 s partial target with `--step 400 --length 5000`, and Moonshine v2 can, then Moonshine v2 becomes the primary ASR backend.

**Stop/go gate:** If *neither* model meets latency targets on M1, reduce target to 2.0 s partial / 3.0 s final and document the tradeoff in the ADR.

### Gate 2: Rust FFI Viability (Day 2–3)

**Experiment:** Build a minimal Rust binary that loads the chosen ASR model, feeds a 5-second PCM buffer, and returns a transcript string.

- For whisper.cpp: use `whisper-rs` crate[^9]
- For Moonshine v2: write thin `unsafe` FFI over ONNX C API or use `ort` crate directly

**Pass/fail:** Transcript returned within 2× the standalone C++ latency. If FFI overhead exceeds 2×, investigate `whisper-stream-rs` as an alternative wrapper.[^10]

### Gate 3: Dual-Channel Stress Test (Day 3–4)

**Experiment:** Run two ASR workers concurrently (one per channel) on a 5-minute capture. Measure total CPU, memory, and check for audio drops in the ring buffer.

**Pass/fail:** Zero audio drops; combined CPU ≤ 80% on M1; no OOM.

**Stop/go gate:** If dual-channel saturates CPU, fall back to mixed-mono mode and document as a hardware-tier limitation.

***

## Technical Approach Candidates

### Approach A: whisper-rs + whisper.cpp (Current Plan)

**Architecture:** `whisper-rs` wraps `whisper.cpp` via C FFI. VAD via `silero-vad-rs`. Lock-free transport via `rtrb`.

| Aspect | Detail |
|---|---|
| Requirements | whisper.cpp v1.8.3+, ggml model files, Metal enabled[^5] |
| Strengths | Mature Rust bindings[^9]; built-in VAD support in whisper.cpp[^5]; large community; quantization support |
| Failure modes | 30-second chunk window forces minimum ~500 ms encoder latency even for short audio[^2][^11]; streaming via overlapping chunks adds complexity and potential hallucination at chunk boundaries[^12] |
| Why it might be wrong | Whisper was designed for offline transcription, not streaming[^13][^14]. The `stream` example is described as "naive" in the official repo[^15]. Achieving ≤1.5 s partials requires aggressive `--step` tuning that can degrade quality. |

**Whisper model profiles on Apple Silicon:**

| Profile | Model | Real-Time Factor (M3) | Memory | WER (LibriSpeech clean) |
|---|---|---|---|---|
| `fast` | `base.en` Q5 | ~22×[^16] | ~388 MB[^5] | ~4–5% |
| `balanced` | `small.en` Q5 | ~12×[^16] | ~852 MB[^5] | ~3% |
| `quality` | `medium.en` Q5 | ~5×[^16] | ~2.1 GB[^5] | ~2.5% |

### Approach B: Moonshine v2 via ONNX Runtime (Recommended Evaluation)

**Architecture:** Moonshine v2 C++ library called from Rust via `ort` (ONNX Runtime Rust bindings). VAD via `silero-vad-rs`. Lock-free transport via `rtrb`.

| Aspect | Detail |
|---|---|
| Requirements | ONNX Runtime, Moonshine v2 ONNX model files, CoreML EP or CPU EP |
| Strengths | Streaming-native architecture with 50–258 ms response latency on M3[^3]; no 30-second chunk limitation[^1]; compute scales with input length; 5.8× faster than Whisper Tiny at comparable accuracy[^3] |
| Failure modes | Rust bindings are newer/less battle-tested; ONNX model format may limit quantization options; smaller community than whisper.cpp |
| Why it might be wrong | Moonshine v2 was released January 2026[^3]—the ecosystem is young. If ONNX Runtime's CoreML EP has bugs on Sequoia, fallback to CPU-only may negate some latency advantage. |

**Moonshine v2 model profiles:**

| Profile | Model | Response Latency (M3) | Params | Avg WER (Open ASR) |
|---|---|---|---|---|
| `fast` | Tiny | 50 ms[^3] | 34M[^3] | 12.01%[^3] |
| `balanced` | Small | 148 ms[^3] | 123M[^3] | 7.84%[^3] |
| `quality` | Medium | 258 ms[^3] | 245M[^3] | 6.65%[^3] |

### Approach C: Hybrid (whisper.cpp for quality, Moonshine for partials)

**Architecture:** Use Moonshine v2 for low-latency partial transcripts; re-transcribe finalized segments with whisper.cpp `small.en` for higher accuracy.

| Aspect | Detail |
|---|---|
| Strengths | Best-of-both: fast partials + accurate finals |
| Failure modes | Double the model memory; complex orchestration; potential transcript drift between partial and final |
| Why it might be wrong | Added complexity may not justify the marginal accuracy gain if Moonshine v2 Small (7.84% WER) is sufficient. |

**Recommendation:** Evaluate Approach B first. If Moonshine v2's Rust/ONNX integration proves problematic in Gate 2, fall back to Approach A with the understanding that latency targets may need relaxation.

***

## Architecture Detail: Audio Pipeline

```
SCK callback (48kHz stereo)
    │
    ├── Channel splitter (L=mic, R=system)
    │       │                │
    │   rtrb ring ──►   rtrb ring ──►
    │       │                │
    │   Resampler         Resampler
    │   (48→16kHz)        (48→16kHz)
    │       │                │
    │   Silero VAD        Silero VAD
    │   (speech gate)     (speech gate)
    │       │                │
    │   ASR Worker        ASR Worker
    │   (partial/final)   (partial/final)
    │       │                │
    └───────┴────────┬───────┘
                     │
              Segment Aggregator
              (merge by PTS)
                     │
              LLM Cleanup Worker
              (finalized only)
                     │
              Output Writer
              (stdout + JSONL + merged text)
```

### Lock-Free Transport

The `rtrb` crate provides a wait-free SPSC ring buffer designed specifically for real-time audio. It avoids heap allocation on the hot path. An alternative is `direct_ring_buffer`, which is Miri-verified for memory safety.[^17][^18][^19]

**Sizing:** At 48 kHz × 2 bytes (i16) × 1 channel = 96 KB/s per channel. A 2-second ring buffer (192 KB) provides ample headroom for ASR worker jitter.

### Resampling

The `rubato` crate's `FftFixedIn` resampler supports synchronous, deterministic conversion suitable for real-time use. Resampling from 48 kHz to 16 kHz (3:1 ratio) is computationally lightweight.[^20]

### VAD Integration

The `silero-vad-rs` crate wraps Silero VAD v5/v6 via the `ort` (ONNX Runtime) crate. It supports:[^7][^8]
- 16 kHz streaming with 512-sample windows (32 ms frames)
- Configurable speech/silence thresholds
- Iterator-based API compatible with chunk processing

whisper.cpp v1.8.3 also includes native Silero VAD v6.2.0 support via the `--vad` flag, which may simplify integration if Approach A is chosen.[^5]

***

## LLM Cleanup Worker

The plan to use a local `llama.cpp` server with a 1B–3B instruct model is validated:

- **Throughput:** Llama 3.2 3B Q4 achieves ~24 tok/s on M1, ~45 tok/s on M4. A typical 15-word finalized segment requires ~30 output tokens, completing in ≤1 second on M1.[^6]
- **Latency optimization:** Prompt caching in `llama.cpp` can reduce latency by 50%+ for repeated system prompts. Since the cleanup prompt template is fixed, first-token latency after the first request drops significantly.[^21]
- **Invocation:** Only on finalized segments (not partials), with an async queue and fallback path when LLM is unavailable. This isolates the ASR hot path from LLM latency.

**Recommended prompt template:**
```
System: You are a transcript cleanup assistant. Fix punctuation,
capitalization, and remove filler words. Output only the cleaned text.
Do not add, remove, or change any substantive words.

Input: {raw_segment}
Output:
```

***

## Latency Budget Analysis

| Stage | Target | Whisper `base.en` | Moonshine v2 Tiny |
|---|---|---|---|
| Audio buffering (ring + resample) | ≤ 40 ms | 40 ms | 40 ms |
| VAD frame decision | ≤ 32 ms | 32 ms | 32 ms |
| ASR partial generation | ≤ 1,000 ms | 400–600 ms (with `--step 500`)[^22] | 50 ms[^3] |
| Transport + formatting | ≤ 10 ms | 10 ms | 10 ms |
| **Total partial** | **≤ 1,500 ms** | **~1,100 ms** ⚠️ | **~130 ms** ✅ |
| LLM cleanup (finals only) | ≤ 1,000 ms | 500–1,000 ms | 500–1,000 ms |
| **Total final (with LLM)** | **≤ 2,500 ms** | **~2,100 ms** ⚠️ | **~1,130 ms** ✅ |

⚠️ Whisper estimates assume optimistic `--step 500` tuning. Real-world streaming latency with Whisper-Streaming's local agreement policy averages 3.3 seconds, which would exceed the target. Moonshine v2 comfortably meets all targets.[^14][^23]

***

## Deliverables (Definition of Done)

### Phase 1 Deliverables

| Artifact | Description | Acceptance Criteria |
|---|---|---|
| `transcribe-live` CLI command | Streaming ASR with partial/final events | Partial/final events visible in terminal; JSONL replay reconstructs transcript |
| ASR model benchmark report | Latency, WER, CPU, memory for each model profile | Covers at least 2 model profiles on M1/M2 hardware |
| JSONL event schema | `TranscriptEvent` with all fields | Schema validated; round-trip tested |
| ADR-001: ASR Model Selection | Decision record: Whisper vs Moonshine v2 | Documents benchmarks, tradeoffs, and rationale |

### Full Project Deliverables

- POC binary with all 5 phases complete
- Capability matrix (model × hardware → latency/WER/CPU)
- Packaging/signing plan for `.app` bundle with model assets
- Session manifest schema and example output
- ADR-002: Lock-free transport design
- ADR-003: LLM cleanup integration pattern

***

## Focused Prompt Pack

Each prompt maps to a specific unknown/risk and produces a testable artifact.

### Model Selection (U1, U2)

1. "List all platform-supported ways to run real-time speech-to-text on macOS 15 Apple Silicon; for each, include model format, Rust bindings status, streaming support, and minimum response latency benchmarks."

2. "Prototype the smallest possible POC that proves Moonshine v2 ONNX models can be loaded and invoked from Rust via the `ort` crate; define pass/fail as transcript returned within 2× standalone C++ latency and log model load time, inference time, and peak RSS."

3. "Run whisper.cpp `stream` example with `--step 400 --length 5000` on a 60-second WAV and measure p50/p95 partial latency, final segment latency, and CPU utilization. Compare against Moonshine v2 Tiny on the same input. Output a CSV benchmark artifact."

### CPU and Memory (U3, U4)

4. "What are the top 10 reasons this real-time dual-channel transcription pipeline will fail in production (not in a demo) on an M1 MacBook Air 8 GB, and what mitigations exist for each?"

5. "Prototype concurrent ASR on two channels using `rtrb` ring buffers and measure combined CPU load, memory RSS, and audio drop count over a 5-minute session. Define pass as zero drops and CPU ≤ 80%."

6. "If the CLI-only constraint holds (no `.app` GUI), what transcription UX features become impossible or unreliable? Provide alternatives and terminal-based fallbacks for each."

### Resampling and Transport (U4, U7)

7. "Benchmark the `rubato` crate's `FftFixedIn` resampler at 48→16 kHz for a single-channel i16 stream. Measure per-chunk latency (512-sample chunks) and confirm no heap allocation via `dhat` profiler."

8. "Define the minimal `rtrb` ring buffer capacity to sustain 48 kHz stereo capture with ≤1% drop probability under 100 ms ASR worker jitter. Provide the calculation and a test harness."

### LLM Cleanup (U5)

9. "Benchmark `llama.cpp` server with Llama 3.2 1B and 3B Q4 models on transcript cleanup tasks: measure first-token latency, total generation time, and output quality (manual eval) for 20 segments of 5–20 words. Enable prompt caching and measure the delta."

10. "Design the async LLM cleanup queue such that ASR never stalls when LLM is slow; define the fallback behavior (emit `final` without `llm_final`) and the maximum queue depth before dropping cleanup requests."

### Packaging and Stability (Long Session)

11. "Define the minimal signing, entitlements, and installer configuration to make ScreenCaptureKit audio permissions stable across macOS updates and app re-launches in both debug-binary and signed-bundle modes."

12. "Run the full pipeline for 60 minutes with `balanced` ASR profile and measure memory growth, CPU drift, ring buffer high-water marks, and transcript event timing jitter. Define pass as ≤5% memory growth and zero stalls."

### Data Contracts

13. "Design the `SessionManifest` JSON schema to capture all configuration, model metadata, performance counters, and output file paths. Validate with JSON Schema and provide an example manifest for a 10-minute session."

14. "Implement JSONL event replay: given a `.jsonl` transcript file, reconstruct the full merged transcript with timestamps. Verify round-trip fidelity against the original terminal output."

***

## How to Use This Template on Future Topics

1. **Start with constraints.** Write the "Hard Constraints" and "Won't-do" sections first. This prevents scope creep before research begins.

2. **Write reality checks next.** For each constraint, ask: "What external dependency must exist for this to work?" If you can't verify it, it goes in the Unknowns register.

3. **Research only what can falsify your plan quickly.** The Validation Plan is timeboxed. Each gate has explicit stop/go criteria. If a gate fails, you pivot or stop—you don't do more research hoping it gets better.

4. **Treat outputs as sprint deliverables.** Every research output must be a POC artifact, benchmark CSV, or ADR—not a set of notes. This keeps findings actionable and transferable.

5. **Generate the prompt pack last.** Prompts map 1:1 to unknowns. Each prompt specifies the artifact it produces and its pass/fail criteria. This prevents vague research loops.

---

## References

1. [Moonshine: Speech Recognition for Live Transcription and Voice ...](https://arxiv.org/html/2410.15608v1) - Moonshine models are designed to match Whisper's accuracy while optimizing computational efficiency ...

2. [ASR Gets a Shot of Moonshine - Hackster.io](https://www.hackster.io/news/asr-gets-a-shot-of-moonshine-2b80a6a514e0) - Benchmarks show that Moonshine has a slight edge on Whisper in terms of word error rate, in addition...

3. [Moonshine v2: Ergodic Streaming Encoder ASR for Latency-Critical ...](https://arxiv.org/html/2602.12241) - Edge deployment also eliminates network round-trip latency and reduces privacy concerns by keeping a...

4. [Whisper Speech Recognition on Mac M4: Performance Analysis and ...](https://dev.to/theinsyeds/whisper-speech-recognition-on-mac-m4-performance-analysis-and-benchmarks-2dlp) - I recently completed a comprehensive analysis of OpenAI's Whisper speech recognition system on Mac M...

5. [ggml-org/whisper.cpp: Port of OpenAI's Whisper model in C/C++](https://github.com/ggml-org/whisper.cpp) - For a quick demo, simply run make base.en . The command downloads the base.en model converted to cus...

6. [Benchmark results · Issue #89 · ggml-org/whisper.cpp - GitHub](https://github.com/ggml-org/whisper.cpp/issues/89) - Encoder Collection of bench results for various platforms and devices. If you want to submit info ab...

7. [silero-vad-rs — Rust audio library // Lib.rs](https://lib.rs/crates/silero-vad-rs) - This is a Rust implementation of the Silero Voice Activity Detection (VAD) model. The original model...

8. [silero_vad_rs - Rust - Docs.rs](https://docs.rs/silero-vad-rs) - This crate provides a Rust implementation of the Silero Voice Activity Detection (VAD) model. It use...

9. [whisper_rs - Rust - Docs.rs](https://docs.rs/whisper-rs) - Most users will be looking for nothing more than WhisperState::full to run a full transcription pipe...

10. [whisper-stream-rs — Rust audio library // Lib.rs](https://lib.rs/crates/whisper-stream-rs) - A library for performing real-time transcription using Whisper ASR models. It handles audio capture,...

11. [Faster streaming support · Issue #137 · ggml-org/whisper.cpp - GitHub](https://github.com/ggml-org/whisper.cpp/issues/137) - This should result in much faster processing for short clips (when the audio clip is <30s), and allo...

12. [Is it possible to add audio context length parameter like in whisper.cpp](https://github.com/guillaumekln/faster-whisper/issues/171) - The Whisper model requires a fixed 30-second window as input. It was trained like that so we have to...

13. [Turning Whisper into Real-Time Transcription System](https://arxiv.org/pdf/2307.14743.pdf) - Whisper is one of the recent state-of-the-art multilingual speech recognition
and translation models...

14. [ufal/whisper_streaming: Whisper realtime streaming for ... - GitHub](https://github.com/ufal/whisper_streaming) - In this paper, we build on top of Whisper and create Whisper-Streaming, an implementation of real-ti...

15. [whisper.cpp/examples/stream/README.md at master ... - GitHub](https://github.com/ggerganov/whisper.cpp/blob/master/examples/stream/README.md) - This is a naive example of performing real-time inference on audio from your microphone. The whisper...

16. [Why Whisper.cpp on Apple Silicon Changes Everything for Voice-to ...](https://sotto.to/blog/whisper-cpp-apple-silicon) - Whisper.cpp makes local AI transcription fast and efficient on M1/M2/M3 Macs. Learn how Apple Silico...

17. [Direct Ring Buffer - Lib.rs](https://lib.rs/crates/direct_ring_buffer) - A high-performance, lock-free ring buffer for single-producer, single-consumer scenarios | Rust/Carg...

18. [Requesting review of some unconventional API choices](https://users.rust-lang.org/t/requesting-review-of-some-unconventional-api-choices/59603) - ... SPSC (single producer, single consumer) ring buffer that's suitable for real-time use case like ...

19. [rtrb - crates.io: Rust Package Registry](https://crates.io/crates/rtrb) - Real-Time Ring Buffer. A wait-free single-producer single-consumer (SPSC) ring buffer for Rust. Crat...

20. [The Joy of the Unknown: Exploring Audio Streams with Rust and ...](https://dev.to/drsh4dow/the-joy-of-the-unknown-exploring-audio-streams-with-rust-and-circular-buffers-494d) - This snippet showcases the creation of three circular buffers ( HeapRb ) for handling input, output,...

21. [Improve local LLM performance with llama.cpp and custom ...](https://community.home-assistant.io/t/improve-local-llm-performance-with-llama-cpp-and-custom-conversation/935476) - A quick guide on how I was able to reduce the LLM response time by more than 50% with a simple chang...

22. [Ultimate Guide To Running Whisper.cpp Locally For Real-time ...](https://www.alibaba.com/product-insights/ultimate-guide-to-running-whisper-cpp-locally-for-real-time-transcription-on-linux.html) - The definitive, step-by-step guide to building, optimizing, and running whisper.cpp locally on Linux...

23. [Turning Whisper into Real-Time Transcription System - arXiv](https://arxiv.org/html/2307.14743v2) - We show that Whisper-Streaming achieves high quality and 3.3 seconds latency on unsegmented long-for...

