use hound::{SampleFormat, WavReader};
use recordit::capture_api::{
    capture_telemetry_path_for_output, CaptureChunk, CaptureEvent, CaptureSink,
};
use recordit::live_asr_pool::{
    LiveAsrExecutor, LiveAsrJob, LiveAsrJobClass, LiveAsrJobResult, LiveAsrPoolConfig,
    LiveAsrPoolTelemetry, LiveAsrRequest, LiveAsrService, TempAudioPolicy,
};
use recordit::live_capture::{
    run_capture_session, run_streaming_capture_session,
    CallbackContractMode as LiveCaptureCallbackMode, LiveCaptureConfig,
    SampleRateMismatchPolicy as LiveCaptureSampleRateMismatchPolicy,
};
use recordit::live_stream_runtime::{
    BackpressureMode, BackpressureTransitionReason, LiveAsrJobClass as RuntimeAsrJobClass,
    LiveAsrJobSpec as RuntimeAsrJobSpec, LiveAsrResult, LiveRuntimePhase, LiveRuntimeSummary,
    LiveStreamCoordinator, RuntimeFinalizer, RuntimeOutputEvent, RuntimeOutputSink,
    StreamingSchedulerConfig, StreamingVadConfig, StreamingVadScheduler,
};
use recordit::storage_roots::{self, ManagedStorageDomain};
use screencapturekit::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fmt::{self, Display};
use std::fs::{self, File};
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::mpsc::{self, sync_channel, Receiver, RecvTimeoutError, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

mod artifacts;
mod asr_backend;
use asr_backend::*;
mod cleanup;
mod cli_parse;
mod contracts_models;
mod preflight;
mod reconciliation;
mod reporting;
mod runtime_events;
mod runtime_live_stream;
mod runtime_manifest_models;
mod runtime_representative;
mod transcript_flow;
use preflight::{
    print_model_doctor_report, print_preflight_report, run_model_doctor, run_preflight,
};

const PARTIAL_LATENCY_SLO_MS: f64 = 1_500.0;
const FINAL_LATENCY_SLO_MS: f64 = 2_500.0;
const OVERLAP_WINDOW_MS: u64 = 120;
const OUT_WAV_SEMANTICS: &str = "canonical session WAV artifact for the run";
const DEFAULT_CHUNK_WINDOW_MS: u64 = 2_000;
const DEFAULT_CHUNK_STRIDE_MS: u64 = 500;
const DEFAULT_CHUNK_QUEUE_CAP: usize = 4;
const DEFAULT_LIVE_ASR_WORKERS: usize = 2;
const JSONL_SYNC_EVERY_LINES: usize = 24;
const LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE: &str = "live_capture_interruption_recovered";
const LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE: &str = "live_capture_continuity_unverified";
const LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE: &str = "live_capture_transport_degraded";
const LIVE_CAPTURE_CALLBACK_CONTRACT_DEGRADED_CODE: &str =
    "live_capture_callback_contract_degraded";
const LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE: &str = "live_chunk_queue_drop_oldest";
const LIVE_CHUNK_QUEUE_BACKPRESSURE_SEVERE_CODE: &str = "live_chunk_queue_backpressure_severe";
const RECONCILIATION_APPLIED_CODE: &str = "reconciliation_applied_after_backpressure";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ModelChecksumCacheKey {
    canonical_path: PathBuf,
    file_len: u64,
    modified_unix_nanos: u128,
}

const LIVE_CAPTURE_TRANSPORT_SOURCES: [&str; 4] = [
    "slot_miss_drops",
    "fill_failures",
    "queue_full_drops",
    "recycle_failures",
];

const LIVE_CAPTURE_CALLBACK_SOURCES: [&str; 6] = [
    "missing_audio_buffer_list",
    "missing_first_audio_buffer",
    "missing_format_description",
    "missing_sample_rate",
    "non_float_pcm",
    "chunk_too_large",
];

const HELP_TEXT: &str = "\
transcribe-live

Define and validate the live transcription CLI contract for the next phase of recordit.

Migration guidance:
  For normal operator usage, prefer `recordit run --mode live` (or `recordit run --mode offline`).
  `transcribe-live` remains stable for legacy scripts, gates, and expert workflows.

Usage:
  transcribe-live [options]

Options:
  --duration-sec <seconds>        Capture duration in seconds (default: 10; with --live-stream, 0 means run until interrupted)
  --input-wav <path>              Runtime WAV path (offline: representative fixture path; live-stream: progressive capture scratch; default: artifacts/bench/corpus/gate_a/tts_phrase.wav)
  --out-wav <path>                Canonical session WAV artifact path (materialized on successful runtime completion; default: artifacts/transcribe-live.wav)
  --out-jsonl <path>              Output JSONL transcript path (default: artifacts/transcribe-live.jsonl)
  --out-manifest <path>           Output session manifest path (default: artifacts/transcribe-live.manifest.json)
  --sample-rate <hz>              Capture sample rate in Hz (default: 48000)
  --asr-backend <backend>         ASR backend: whispercpp | whisperkit | moonshine (default: whispercpp)
  --asr-model <path>              Local model path for the selected backend
  --asr-language <code>           Language code (default: en)
  --asr-threads <n>               ASR worker thread count (default: 4)
  --asr-profile <profile>         ASR profile: fast | balanced | quality (default: balanced)
  --vad-backend <backend>         VAD backend: webrtc | silero (default: silero)
  --vad-threshold <float>         VAD threshold in [0.0, 1.0] (default: 0.50)
  --vad-min-speech-ms <ms>        Minimum speech duration before emit (default: 250)
  --vad-min-silence-ms <ms>       Minimum silence duration before finalize (default: 500)
  --llm-cleanup                   Enable finalized-segment cleanup
  --llm-endpoint <url>            Local cleanup endpoint URL
  --llm-model <id>                Local cleanup model id
  --llm-timeout-ms <ms>           Cleanup timeout in milliseconds (default: 1000)
  --llm-max-queue <n>             Max queued cleanup requests (default: 32)
  --llm-retries <n>               Retry count for failed cleanup requests (default: 0)
  --live-chunked                  Select representative-chunked mode (runtime label remains live-chunked)
  --live-stream                   Select live-stream runtime entrypoint (cannot combine with --live-chunked)
  --chunk-window-ms <ms>          Near-live chunk window in milliseconds (default: 2000; requires --live-chunked)
  --chunk-stride-ms <ms>          Near-live chunk stride in milliseconds (default: 500; requires --live-chunked)
  --chunk-queue-cap <n>           Bounded near-live ASR work queue capacity (default: 4; requires --live-chunked)
  --live-asr-workers <n>          Dedicated live ASR worker pool concurrency (default: 2; live modes only)
  --keep-temp-audio               Retain live temp audio shards/probe WAVs for debug inspection
  --disable-adaptive-backpressure Kill-switch: pin backpressure behavior to normal mode (live modes only)
  --transcribe-channels <mode>    Channel mode: separate | mixed | mixed-fallback (default: separate)
  --speaker-labels <mic,system>   Comma-separated labels for the two channels (default: mic,system)
  --benchmark-runs <n>            Number of representative latency benchmark runs (default: 3)
  --model-doctor                  Run model/backend diagnostics and exit
  --replay-jsonl <path>           Replay transcript timeline from a prior JSONL artifact
  --preflight                     Run structured preflight diagnostics and write manifest
  -h, --help                      Show this help text

Runtime mode taxonomy:
  representative-offline          Default runtime mode (no live selector flags)
  representative-chunked          Selected by --live-chunked; runtime_mode remains live-chunked for artifact compatibility
  live-stream                     Implemented runtime entrypoint for dedicated live-stream execution

Examples:
  transcribe-live --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
  transcribe-live --asr-backend whisperkit --asr-model artifacts/bench/models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-tiny --transcribe-channels mixed
  transcribe-live --input-wav artifacts/bench/corpus/gate_a/tts_phrase.wav --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --llm-cleanup --llm-endpoint http://127.0.0.1:8080/v1/chat/completions --llm-model llama3.2:3b
  transcribe-live --live-chunked --chunk-window-ms 2000 --chunk-stride-ms 500 --chunk-queue-cap 4 --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
  transcribe-live --model-doctor --asr-backend whispercpp
  transcribe-live --replay-jsonl artifacts/transcribe-live.runtime.jsonl
  transcribe-live --preflight --asr-model models/ggml-base.en.bin
";

#[derive(Debug, Clone, Copy)]
enum AsrBackend {
    WhisperCpp,
    WhisperKit,
    Moonshine,
}

impl Display for AsrBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WhisperCpp => f.write_str("whispercpp"),
            Self::WhisperKit => f.write_str("whisperkit"),
            Self::Moonshine => f.write_str("moonshine"),
        }
    }
}

impl AsrBackend {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value {
            "whispercpp" | "whisper-rs" => Ok(Self::WhisperCpp),
            "whisperkit" => Ok(Self::WhisperKit),
            "moonshine" => Ok(Self::Moonshine),
            _ => Err(CliError::new(format!(
                "unsupported --asr-backend `{value}`; expected `whispercpp`, `whisperkit`, or `moonshine`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum AsrProfile {
    Fast,
    Balanced,
    Quality,
}

impl Display for AsrProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fast => f.write_str("fast"),
            Self::Balanced => f.write_str("balanced"),
            Self::Quality => f.write_str("quality"),
        }
    }
}

impl AsrProfile {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value {
            "fast" => Ok(Self::Fast),
            "balanced" => Ok(Self::Balanced),
            "quality" => Ok(Self::Quality),
            _ => Err(CliError::new(format!(
                "unsupported --asr-profile `{value}`; expected `fast`, `balanced`, or `quality`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum VadBackend {
    Webrtc,
    Silero,
}

impl Display for VadBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Webrtc => f.write_str("webrtc"),
            Self::Silero => f.write_str("silero"),
        }
    }
}

impl VadBackend {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value {
            "webrtc" => Ok(Self::Webrtc),
            "silero" => Ok(Self::Silero),
            _ => Err(CliError::new(format!(
                "unsupported --vad-backend `{value}`; expected `webrtc` or `silero`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelMode {
    Separate,
    Mixed,
    MixedFallback,
}

impl Display for ChannelMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Separate => f.write_str("separate"),
            Self::Mixed => f.write_str("mixed"),
            Self::MixedFallback => f.write_str("mixed-fallback"),
        }
    }
}

impl ChannelMode {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value {
            "separate" => Ok(Self::Separate),
            "mixed" => Ok(Self::Mixed),
            "mixed-fallback" => Ok(Self::MixedFallback),
            _ => Err(CliError::new(format!(
                "unsupported --transcribe-channels `{value}`; expected `separate`, `mixed`, or `mixed-fallback`"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
struct SpeakerLabels {
    mic: String,
    system: String,
}

impl Display for SpeakerLabels {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{},{}", self.mic, self.system)
    }
}

impl SpeakerLabels {
    fn parse(value: &str) -> Result<Self, CliError> {
        let mut parts = value.split(',').map(str::trim);
        let mic = parts
            .next()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| CliError::new("`--speaker-labels` requires two non-empty labels"))?;
        let system = parts
            .next()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| CliError::new("`--speaker-labels` requires two non-empty labels"))?;

        if parts.next().is_some() {
            return Err(CliError::new(
                "`--speaker-labels` accepts exactly two comma-separated labels",
            ));
        }

        Ok(Self {
            mic: mic.to_owned(),
            system: system.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct RuntimeModeCompatibility {
    runtime_mode: &'static str,
    taxonomy_mode: &'static str,
    selector: &'static str,
    status: &'static str,
    replay_jsonl_compat: &'static str,
    preflight_compat: &'static str,
    chunk_tuning_compat: &'static str,
}

const REPRESENTATIVE_OFFLINE_COMPATIBILITY: RuntimeModeCompatibility = RuntimeModeCompatibility {
    runtime_mode: "representative-offline",
    taxonomy_mode: "representative-offline",
    selector: "<default>",
    status: "implemented",
    replay_jsonl_compat: "compatible",
    preflight_compat: "compatible",
    chunk_tuning_compat: "forbidden",
};

const REPRESENTATIVE_CHUNKED_COMPATIBILITY: RuntimeModeCompatibility = RuntimeModeCompatibility {
    runtime_mode: "live-chunked",
    taxonomy_mode: "representative-chunked",
    selector: "--live-chunked",
    status: "implemented",
    replay_jsonl_compat: "incompatible",
    preflight_compat: "compatible",
    chunk_tuning_compat: "compatible",
};

const LIVE_STREAM_COMPATIBILITY: RuntimeModeCompatibility = RuntimeModeCompatibility {
    runtime_mode: "live-stream",
    taxonomy_mode: "live-stream",
    selector: "--live-stream",
    status: "implemented",
    replay_jsonl_compat: "incompatible",
    preflight_compat: "compatible",
    chunk_tuning_compat: "compatible",
};

#[cfg(test)]
fn runtime_mode_compatibility_matrix() -> &'static [RuntimeModeCompatibility; 3] {
    &[
        REPRESENTATIVE_OFFLINE_COMPATIBILITY,
        REPRESENTATIVE_CHUNKED_COMPATIBILITY,
        LIVE_STREAM_COMPATIBILITY,
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeExecutionBranch {
    RepresentativeOffline,
    RepresentativeChunked,
    LiveStream,
}

#[derive(Debug, Clone)]
struct TranscribeConfig {
    duration_sec: u64,
    input_wav: PathBuf,
    out_wav: PathBuf,
    out_jsonl: PathBuf,
    out_manifest: PathBuf,
    sample_rate_hz: u32,
    asr_backend: AsrBackend,
    asr_model: PathBuf,
    asr_language: String,
    asr_threads: usize,
    asr_profile: AsrProfile,
    vad_backend: VadBackend,
    vad_threshold: f32,
    vad_min_speech_ms: u32,
    vad_min_silence_ms: u32,
    llm_cleanup: bool,
    llm_endpoint: Option<String>,
    llm_model: Option<String>,
    llm_timeout_ms: u64,
    llm_max_queue: usize,
    llm_retries: usize,
    live_chunked: bool,
    live_stream: bool,
    chunk_window_ms: u64,
    chunk_stride_ms: u64,
    chunk_queue_cap: usize,
    live_asr_workers: usize,
    keep_temp_audio: bool,
    adaptive_backpressure_enabled: bool,
    channel_mode: ChannelMode,
    speaker_labels: SpeakerLabels,
    benchmark_runs: usize,
    model_doctor: bool,
    replay_jsonl: Option<PathBuf>,
    preflight: bool,
}

impl Default for TranscribeConfig {
    fn default() -> Self {
        Self {
            duration_sec: 10,
            input_wav: PathBuf::from("artifacts/bench/corpus/gate_a/tts_phrase.wav"),
            out_wav: PathBuf::from("artifacts/transcribe-live.wav"),
            out_jsonl: PathBuf::from("artifacts/transcribe-live.jsonl"),
            out_manifest: PathBuf::from("artifacts/transcribe-live.manifest.json"),
            sample_rate_hz: 48_000,
            asr_backend: AsrBackend::WhisperCpp,
            asr_model: PathBuf::new(),
            asr_language: "en".to_owned(),
            asr_threads: 4,
            asr_profile: AsrProfile::Balanced,
            vad_backend: VadBackend::Silero,
            vad_threshold: 0.50,
            vad_min_speech_ms: 250,
            vad_min_silence_ms: 500,
            llm_cleanup: false,
            llm_endpoint: None,
            llm_model: None,
            llm_timeout_ms: 1_000,
            llm_max_queue: 32,
            llm_retries: 0,
            live_chunked: false,
            live_stream: false,
            chunk_window_ms: DEFAULT_CHUNK_WINDOW_MS,
            chunk_stride_ms: DEFAULT_CHUNK_STRIDE_MS,
            chunk_queue_cap: DEFAULT_CHUNK_QUEUE_CAP,
            live_asr_workers: DEFAULT_LIVE_ASR_WORKERS,
            keep_temp_audio: false,
            adaptive_backpressure_enabled: true,
            channel_mode: ChannelMode::Separate,
            speaker_labels: SpeakerLabels {
                mic: "mic".to_owned(),
                system: "system".to_owned(),
            },
            benchmark_runs: 3,
            model_doctor: false,
            replay_jsonl: None,
            preflight: false,
        }
    }
}

impl TranscribeConfig {
    fn validate(&self) -> Result<(), CliError> {
        if self.duration_sec == 0 && !self.live_stream {
            return Err(CliError::new(
                "`--duration-sec` must be greater than zero unless `--live-stream` is enabled",
            ));
        }

        if self.input_wav.as_os_str().is_empty() {
            return Err(CliError::new("`--input-wav` cannot be empty"));
        }

        if self.sample_rate_hz == 0 {
            return Err(CliError::new("`--sample-rate` must be greater than zero"));
        }

        if self.asr_threads == 0 {
            return Err(CliError::new("`--asr-threads` must be greater than zero"));
        }

        if !self.vad_threshold.is_finite() || !(0.0..=1.0).contains(&self.vad_threshold) {
            return Err(CliError::new(
                "`--vad-threshold` must be a finite value in [0.0, 1.0]",
            ));
        }

        if self.vad_min_speech_ms == 0 {
            return Err(CliError::new(
                "`--vad-min-speech-ms` must be greater than zero",
            ));
        }

        if self.vad_min_silence_ms == 0 {
            return Err(CliError::new(
                "`--vad-min-silence-ms` must be greater than zero",
            ));
        }

        if self.llm_timeout_ms == 0 {
            return Err(CliError::new(
                "`--llm-timeout-ms` must be greater than zero",
            ));
        }

        if self.llm_max_queue == 0 {
            return Err(CliError::new("`--llm-max-queue` must be greater than zero"));
        }

        if self.chunk_window_ms == 0 {
            return Err(CliError::new(
                "`--chunk-window-ms` must be greater than zero",
            ));
        }

        if self.chunk_stride_ms == 0 {
            return Err(CliError::new(
                "`--chunk-stride-ms` must be greater than zero",
            ));
        }

        if self.chunk_stride_ms > self.chunk_window_ms {
            return Err(CliError::new(
                "`--chunk-stride-ms` must be less than or equal to `--chunk-window-ms`; keep the stride inside the rolling window",
            ));
        }

        if self.chunk_queue_cap == 0 {
            return Err(CliError::new(
                "`--chunk-queue-cap` must be greater than zero",
            ));
        }

        if self.live_asr_workers == 0 {
            return Err(CliError::new(
                "`--live-asr-workers` must be greater than zero",
            ));
        }

        if self.benchmark_runs == 0 {
            return Err(CliError::new(
                "`--benchmark-runs` must be greater than zero",
            ));
        }

        if self.llm_cleanup {
            if self.llm_endpoint.as_deref().unwrap_or("").is_empty() {
                return Err(CliError::new(
                    "`--llm-endpoint <url>` is required when `--llm-cleanup` is enabled",
                ));
            }
            if self.llm_model.as_deref().unwrap_or("").is_empty() {
                return Err(CliError::new(
                    "`--llm-model <id>` is required when `--llm-cleanup` is enabled",
                ));
            }
        }

        self.validate_runtime_mode_compatibility()?;

        if self.model_doctor && self.replay_jsonl.is_some() {
            return Err(CliError::new(
                "`--model-doctor` cannot be combined with `--replay-jsonl`; doctor validates runtime prerequisites while replay consumes existing artifacts",
            ));
        }

        if self.model_doctor && self.preflight {
            return Err(CliError::new(
                "`--model-doctor` cannot be combined with `--preflight`; run either diagnostics mode separately",
            ));
        }

        validate_output_path("--out-wav", &self.out_wav)?;
        validate_output_path("--out-jsonl", &self.out_jsonl)?;
        validate_output_path("--out-manifest", &self.out_manifest)?;

        Ok(())
    }

    fn active_runtime_mode_compatibility(&self) -> &'static RuntimeModeCompatibility {
        if self.live_stream {
            &LIVE_STREAM_COMPATIBILITY
        } else if self.live_chunked {
            &REPRESENTATIVE_CHUNKED_COMPATIBILITY
        } else {
            &REPRESENTATIVE_OFFLINE_COMPATIBILITY
        }
    }

    fn runtime_mode_label(&self) -> &'static str {
        self.active_runtime_mode_compatibility().runtime_mode
    }

    fn runtime_mode_taxonomy_label(&self) -> &'static str {
        self.active_runtime_mode_compatibility().taxonomy_mode
    }

    fn runtime_mode_selector_label(&self) -> &'static str {
        self.active_runtime_mode_compatibility().selector
    }

    fn runtime_mode_status_label(&self) -> &'static str {
        self.active_runtime_mode_compatibility().status
    }

    fn validate_runtime_mode_compatibility(&self) -> Result<(), CliError> {
        if self.live_stream && self.live_chunked {
            return Err(CliError::new(
                "`--live-stream` cannot be combined with `--live-chunked`; choose exactly one live runtime selector",
            ));
        }

        if !self.live_chunked
            && !self.live_stream
            && (self.chunk_window_ms != DEFAULT_CHUNK_WINDOW_MS
                || self.chunk_stride_ms != DEFAULT_CHUNK_STRIDE_MS
                || self.chunk_queue_cap != DEFAULT_CHUNK_QUEUE_CAP)
        {
            return Err(CliError::new(
                "`--chunk-window-ms`, `--chunk-stride-ms`, and `--chunk-queue-cap` require `--live-chunked` or `--live-stream`; omit them for representative offline runs",
            ));
        }

        if self.live_chunked && self.replay_jsonl.is_some() {
            return Err(CliError::new(
                "`--live-chunked` cannot be combined with `--replay-jsonl`; replay reads a completed artifact instead of configuring a live runtime",
            ));
        }
        if self.live_stream && self.replay_jsonl.is_some() {
            return Err(CliError::new(
                "`--live-stream` cannot be combined with `--replay-jsonl`; replay reads a completed artifact instead of configuring a live runtime",
            ));
        }
        if !self.live_chunked && !self.live_stream && !self.adaptive_backpressure_enabled {
            return Err(CliError::new(
                "`--disable-adaptive-backpressure` requires `--live-chunked` or `--live-stream`",
            ));
        }

        Ok(())
    }

    fn live_mode_summary_lines(&self) -> Vec<String> {
        let compatibility = self.active_runtime_mode_compatibility();
        let inactive_suffix = if self.live_chunked || self.live_stream {
            ""
        } else {
            " (inactive; enable with --live-chunked)"
        };
        vec![
            format!("  runtime_mode: {}", self.runtime_mode_label()),
            format!("  runtime_mode_taxonomy: {}", compatibility.taxonomy_mode),
            format!("  runtime_mode_selector: {}", compatibility.selector),
            format!("  runtime_mode_status: {}", compatibility.status),
            format!(
                "  runtime_mode_replay_jsonl: {}",
                compatibility.replay_jsonl_compat
            ),
            format!(
                "  runtime_mode_preflight: {}",
                compatibility.preflight_compat
            ),
            format!(
                "  runtime_mode_chunk_tuning: {}",
                compatibility.chunk_tuning_compat
            ),
            format!("  live_chunked_flag: {}", self.live_chunked),
            format!("  live_stream_flag: {}", self.live_stream),
            format!(
                "  chunk_window_ms: {}{}",
                self.chunk_window_ms, inactive_suffix
            ),
            format!(
                "  chunk_stride_ms: {}{}",
                self.chunk_stride_ms, inactive_suffix
            ),
            format!(
                "  chunk_queue_cap: {}{}",
                self.chunk_queue_cap, inactive_suffix
            ),
            format!(
                "  live_asr_workers: {}{}",
                self.live_asr_workers, inactive_suffix
            ),
            format!("  keep_temp_audio: {}", self.keep_temp_audio),
            format!(
                "  adaptive_backpressure: {}{}",
                if self.adaptive_backpressure_enabled {
                    "enabled"
                } else {
                    "disabled (kill-switch active)"
                },
                inactive_suffix
            ),
        ]
    }

    fn print_summary(&self, concise_only: bool) {
        println!("Startup banner");
        for line in build_startup_banner_lines(self) {
            println!("  {line}");
        }
        if concise_only {
            return;
        }

        println!();
        println!("Transcribe-live configuration");
        println!("  status: contract validated + runtime entrypoint enabled");
        println!("  duration_sec: {}", self.duration_sec);
        println!("  input_wav: {}", display_path(&self.input_wav));
        println!("  sample_rate_hz: {}", self.sample_rate_hz);
        println!("  out_wav: {}", display_path(&self.out_wav));
        println!("  out_jsonl: {}", display_path(&self.out_jsonl));
        println!("  out_manifest: {}", display_path(&self.out_manifest));
        println!("  asr_backend: {}", self.asr_backend);
        println!(
            "  asr_model: {}",
            if self.asr_model.as_os_str().is_empty() {
                "<auto-discover>".to_string()
            } else {
                display_path(&self.asr_model)
            }
        );
        println!("  asr_model_resolution: --asr-model > RECORDIT_ASR_MODEL > backend defaults");
        println!("  asr_language: {}", self.asr_language);
        println!("  asr_threads: {}", self.asr_threads);
        println!("  asr_profile: {}", self.asr_profile);
        println!("  vad_backend: {}", self.vad_backend);
        println!("  vad_threshold: {:.2}", self.vad_threshold);
        println!("  vad_min_speech_ms: {}", self.vad_min_speech_ms);
        println!("  vad_min_silence_ms: {}", self.vad_min_silence_ms);
        println!("  llm_cleanup: {}", self.llm_cleanup);
        println!(
            "  llm_endpoint: {}",
            self.llm_endpoint.as_deref().unwrap_or("<disabled>")
        );
        println!(
            "  llm_model: {}",
            self.llm_model.as_deref().unwrap_or("<disabled>")
        );
        println!("  llm_timeout_ms: {}", self.llm_timeout_ms);
        println!("  llm_max_queue: {}", self.llm_max_queue);
        println!("  llm_retries: {}", self.llm_retries);
        for line in self.live_mode_summary_lines() {
            println!("{line}");
        }
        println!("  transcribe_channels: {}", self.channel_mode);
        println!("  speaker_labels: {}", self.speaker_labels);
        println!("  benchmark_runs: {}", self.benchmark_runs);
        println!("  model_doctor: {}", self.model_doctor);
        println!(
            "  replay_jsonl: {}",
            self.replay_jsonl
                .as_ref()
                .map(|path| display_path(path))
                .unwrap_or_else(|| "<disabled>".to_string())
        );
        println!("  preflight: {}", self.preflight);
    }
}

#[derive(Debug, Clone, Copy)]
enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

impl Display for CheckStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pass => f.write_str("PASS"),
            Self::Warn => f.write_str("WARN"),
            Self::Fail => f.write_str("FAIL"),
        }
    }
}

#[derive(Debug, Clone)]
struct PreflightCheck {
    id: &'static str,
    status: CheckStatus,
    detail: String,
    remediation: Option<String>,
}

impl PreflightCheck {
    fn pass(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Pass,
            detail: detail.into(),
            remediation: None,
        }
    }

    fn warn(id: &'static str, detail: impl Into<String>, remediation: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Warn,
            detail: detail.into(),
            remediation: Some(remediation.into()),
        }
    }

    fn fail(id: &'static str, detail: impl Into<String>, remediation: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Fail,
            detail: detail.into(),
            remediation: Some(remediation.into()),
        }
    }
}

#[derive(Debug, Clone)]
struct PreflightReport {
    generated_at_utc: String,
    checks: Vec<PreflightCheck>,
}

impl PreflightReport {
    fn overall_status(&self) -> CheckStatus {
        if self
            .checks
            .iter()
            .any(|check| matches!(check.status, CheckStatus::Fail))
        {
            return CheckStatus::Fail;
        }
        if self
            .checks
            .iter()
            .any(|check| matches!(check.status, CheckStatus::Warn))
        {
            return CheckStatus::Warn;
        }
        CheckStatus::Pass
    }
}

#[derive(Debug)]
struct CliError {
    message: String,
}

impl CliError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

enum ParseOutcome {
    Help,
    Config(TranscribeConfig),
}

#[derive(Debug, Clone)]
struct VadBoundary {
    id: usize,
    start_ms: u64,
    end_ms: u64,
    source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChannelVadBoundary {
    channel: String,
    start_ms: u64,
    end_ms: u64,
    source: &'static str,
}

#[derive(Debug, Clone)]
struct IncrementalVadTracker {
    channel: String,
    sample_rate_hz: u32,
    threshold: f32,
    min_speech_samples: usize,
    min_silence_samples: usize,
    in_speech: bool,
    speech_run: usize,
    silence_run: usize,
    segment_start_idx: usize,
    boundaries: Vec<ChannelVadBoundary>,
}

impl IncrementalVadTracker {
    fn new(
        channel: impl Into<String>,
        sample_rate_hz: u32,
        threshold: f32,
        min_speech_ms: u32,
        min_silence_ms: u32,
    ) -> Self {
        Self {
            channel: channel.into(),
            sample_rate_hz,
            threshold,
            min_speech_samples: ((sample_rate_hz as u64 * min_speech_ms as u64) / 1_000).max(1)
                as usize,
            min_silence_samples: ((sample_rate_hz as u64 * min_silence_ms as u64) / 1_000).max(1)
                as usize,
            in_speech: false,
            speech_run: 0,
            silence_run: 0,
            segment_start_idx: 0,
            boundaries: Vec::new(),
        }
    }

    fn observe(&mut self, frame_idx: usize, level: f32) {
        let is_speech = level >= self.threshold;
        if is_speech {
            self.speech_run += 1;
            self.silence_run = 0;
            if !self.in_speech && self.speech_run >= self.min_speech_samples {
                self.in_speech = true;
                self.segment_start_idx = frame_idx + 1 - self.speech_run;
            }
            return;
        }

        self.speech_run = 0;
        if !self.in_speech {
            self.silence_run = 0;
            return;
        }

        self.silence_run += 1;
        if self.silence_run >= self.min_silence_samples {
            let end_frame_exclusive = frame_idx + 1 - self.silence_run;
            self.push_boundary(end_frame_exclusive, "energy_threshold");
            self.in_speech = false;
            self.silence_run = 0;
        }
    }

    fn finish(mut self, total_frames: usize) -> Vec<ChannelVadBoundary> {
        if self.in_speech {
            self.push_boundary(total_frames, "shutdown_flush");
        }
        self.boundaries
    }

    fn push_boundary(&mut self, end_frame_exclusive: usize, source: &'static str) {
        if end_frame_exclusive <= self.segment_start_idx {
            return;
        }
        self.boundaries.push(ChannelVadBoundary {
            channel: self.channel.clone(),
            start_ms: sample_to_ms(self.segment_start_idx as u64, self.sample_rate_hz),
            end_ms: sample_to_ms(end_frame_exclusive as u64, self.sample_rate_hz),
            source,
        });
    }
}

#[derive(Debug, Clone)]
struct LiveRunReport {
    generated_at_utc: String,
    backend_id: &'static str,
    resolved_model_path: PathBuf,
    resolved_model_source: String,
    channel_mode: ChannelMode,
    active_channel_mode: ChannelMode,
    transcript_text: String,
    channel_transcripts: Vec<ChannelTranscriptSummary>,
    vad_boundaries: Vec<VadBoundary>,
    events: Vec<TranscriptEvent>,
    degradation_events: Vec<ModeDegradationEvent>,
    trust_notices: Vec<TrustNotice>,
    lifecycle: LiveLifecycleTelemetry,
    reconciliation: ReconciliationMatrix,
    asr_worker_pool: LiveAsrPoolTelemetry,
    final_buffering: FinalBufferingTelemetry,
    chunk_queue: LiveChunkQueueTelemetry,
    cleanup_queue: CleanupQueueTelemetry,
    hot_path_diagnostics: HotPathDiagnostics,
    benchmark: BenchmarkSummary,
    benchmark_summary_csv: PathBuf,
    benchmark_runs_csv: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct HotPathDiagnostics {
    transport: TransportInputDiagnostics,
    scratch: ScratchLifecycleDiagnostics,
    backpressure: BackpressureDiagnostics,
    pump: PumpCadenceDiagnostics,
}

#[derive(Debug, Clone, Default)]
struct TransportInputDiagnostics {
    path_requests: usize,
    pcm_window_requests: usize,
}

#[derive(Debug, Clone, Default)]
struct ScratchLifecycleDiagnostics {
    worker_scratch_paths_upper_bound: usize,
    write_attempts_estimate: usize,
    reuse_overwrites_estimate: usize,
    retained_for_review_hint: bool,
}

#[derive(Debug, Clone, Default)]
struct ChannelPressureSnapshot {
    channel: String,
    partial_events: usize,
    stable_events: usize,
    processed_events: usize,
    pending_estimate: usize,
    dropped_oldest_estimate: usize,
}

#[derive(Debug, Clone)]
struct BackpressureDiagnostics {
    mode: BackpressureMode,
    transition_count: usize,
    last_transition_reason: Option<BackpressureTransitionReason>,
    pending_jobs: u64,
    pending_final_jobs: u64,
    channel_snapshots: Vec<ChannelPressureSnapshot>,
}

impl Default for BackpressureDiagnostics {
    fn default() -> Self {
        Self {
            mode: BackpressureMode::Normal,
            transition_count: 0,
            last_transition_reason: None,
            pending_jobs: 0,
            pending_final_jobs: 0,
            channel_snapshots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct PumpCadenceDiagnostics {
    chunk_decisions: u64,
    forced_decisions: u64,
    forced_capture_event_triggers: u64,
    forced_shutdown_triggers: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct FinalBufferingTelemetry {
    submit_window: usize,
    deferred_final_submissions: usize,
    max_pending_final_backlog: usize,
}

#[derive(Debug, Clone)]
struct ReconciliationTrigger {
    code: &'static str,
}

#[derive(Debug, Clone)]
struct ReconciliationMatrix {
    required: bool,
    applied: bool,
    triggers: Vec<ReconciliationTrigger>,
}

impl ReconciliationMatrix {
    fn none() -> Self {
        Self {
            required: false,
            applied: false,
            triggers: Vec::new(),
        }
    }

    fn trigger_codes_csv(&self) -> String {
        if self.triggers.is_empty() {
            return "<none>".to_string();
        }
        self.triggers
            .iter()
            .map(|trigger| trigger.code)
            .collect::<Vec<_>>()
            .join(",")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiveLifecyclePhase {
    Warmup,
    Active,
    Draining,
    Shutdown,
}

impl LiveLifecyclePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Warmup => "warmup",
            Self::Active => "active",
            Self::Draining => "draining",
            Self::Shutdown => "shutdown",
        }
    }

    fn ready_for_transcripts(self) -> bool {
        !matches!(self, Self::Warmup)
    }
}

impl Display for LiveLifecyclePhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
struct LiveLifecycleTransition {
    phase: LiveLifecyclePhase,
    entered_at_utc: String,
    detail: String,
}

#[derive(Debug, Clone)]
struct LiveLifecycleTelemetry {
    current_phase: LiveLifecyclePhase,
    ready_for_transcripts: bool,
    transitions: Vec<LiveLifecycleTransition>,
}

impl LiveLifecycleTelemetry {
    fn new() -> Self {
        Self {
            current_phase: LiveLifecyclePhase::Warmup,
            ready_for_transcripts: false,
            transitions: Vec::new(),
        }
    }

    fn transition(&mut self, phase: LiveLifecyclePhase, detail: impl Into<String>) {
        self.current_phase = phase;
        self.ready_for_transcripts = phase.ready_for_transcripts();
        self.transitions.push(LiveLifecycleTransition {
            phase,
            entered_at_utc: runtime_timestamp_utc(),
            detail: detail.into(),
        });
    }
}

#[derive(Debug, Clone)]
struct LiveChunkQueueTelemetry {
    enabled: bool,
    max_queue: usize,
    submitted: usize,
    enqueued: usize,
    dropped_oldest: usize,
    processed: usize,
    pending: usize,
    high_water: usize,
    drain_completed: bool,
    lag_sample_count: usize,
    lag_p50_ms: u64,
    lag_p95_ms: u64,
    lag_max_ms: u64,
}

impl LiveChunkQueueTelemetry {
    fn disabled(config: &TranscribeConfig) -> Self {
        Self {
            enabled: false,
            max_queue: config.chunk_queue_cap,
            submitted: 0,
            enqueued: 0,
            dropped_oldest: 0,
            processed: 0,
            pending: 0,
            high_water: 0,
            drain_completed: true,
            lag_sample_count: 0,
            lag_p50_ms: 0,
            lag_p95_ms: 0,
            lag_max_ms: 0,
        }
    }

    fn enabled(max_queue: usize) -> Self {
        Self {
            enabled: true,
            max_queue,
            submitted: 0,
            enqueued: 0,
            dropped_oldest: 0,
            processed: 0,
            pending: 0,
            high_water: 0,
            drain_completed: true,
            lag_sample_count: 0,
            lag_p50_ms: 0,
            lag_p95_ms: 0,
            lag_max_ms: 0,
        }
    }
}

fn update_chunk_lag_telemetry(telemetry: &mut LiveChunkQueueTelemetry, lag_samples_ms: &[u64]) {
    telemetry.lag_sample_count = lag_samples_ms.len();
    if lag_samples_ms.is_empty() {
        telemetry.lag_p50_ms = 0;
        telemetry.lag_p95_ms = 0;
        telemetry.lag_max_ms = 0;
        return;
    }
    let mut sorted = lag_samples_ms.to_vec();
    sorted.sort_unstable();
    telemetry.lag_p50_ms = percentile_nearest_rank_ms(&sorted, 50);
    telemetry.lag_p95_ms = percentile_nearest_rank_ms(&sorted, 95);
    telemetry.lag_max_ms = *sorted.last().unwrap_or(&0);
}

fn chunk_queue_backpressure_is_severe(telemetry: &LiveChunkQueueTelemetry) -> bool {
    if !telemetry.enabled || telemetry.dropped_oldest == 0 || telemetry.submitted == 0 {
        return false;
    }

    let sustained_full_pressure = telemetry.max_queue > 0
        && telemetry.high_water >= telemetry.max_queue
        && telemetry.dropped_oldest >= telemetry.max_queue;
    let elevated_drop_ratio = telemetry.dropped_oldest.saturating_mul(3) >= telemetry.submitted;

    sustained_full_pressure || elevated_drop_ratio
}

fn percentile_nearest_rank_ms(sorted_samples: &[u64], percentile: usize) -> u64 {
    if sorted_samples.is_empty() {
        return 0;
    }
    let rank = ((sorted_samples.len() * percentile).saturating_add(99)) / 100;
    let idx = rank.saturating_sub(1).min(sorted_samples.len() - 1);
    sorted_samples[idx]
}

#[derive(Debug, Clone)]
struct CleanupQueueTelemetry {
    enabled: bool,
    max_queue: usize,
    timeout_ms: u64,
    retries: usize,
    submitted: usize,
    enqueued: usize,
    dropped_queue_full: usize,
    processed: usize,
    succeeded: usize,
    timed_out: usize,
    failed: usize,
    retry_attempts: usize,
    pending: usize,
    drain_budget_ms: u64,
    drain_completed: bool,
}

impl CleanupQueueTelemetry {
    fn disabled(config: &TranscribeConfig) -> Self {
        Self {
            enabled: false,
            max_queue: config.llm_max_queue,
            timeout_ms: config.llm_timeout_ms,
            retries: config.llm_retries,
            submitted: 0,
            enqueued: 0,
            dropped_queue_full: 0,
            processed: 0,
            succeeded: 0,
            timed_out: 0,
            failed: 0,
            retry_attempts: 0,
            pending: 0,
            drain_budget_ms: 0,
            drain_completed: true,
        }
    }
}

#[derive(Debug, Clone)]
struct CleanupRequest {
    segment_id: String,
    channel: String,
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupTaskStatus {
    Succeeded,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone)]
struct CleanupTaskResult {
    request: CleanupRequest,
    status: CleanupTaskStatus,
    retry_attempts: usize,
    cleaned_text: Option<String>,
}

#[derive(Debug, Clone)]
struct CleanupClientConfig {
    endpoint: String,
    model: String,
    timeout_ms: u64,
    retries: usize,
}

#[derive(Debug, Clone)]
struct ResolvedModelPath {
    path: PathBuf,
    source: String,
}

#[derive(Debug, Clone)]
struct ModelChecksumInfo {
    sha256: String,
    status: String,
}

#[derive(Debug, Clone)]
struct CleanupRunResult {
    telemetry: CleanupQueueTelemetry,
    llm_events: Vec<TranscriptEvent>,
}

#[derive(Debug, Clone)]
struct CleanupAttemptOutcome {
    status: CleanupTaskStatus,
    cleaned_text: Option<String>,
}

#[derive(Debug, Clone)]
struct TranscriptEvent {
    event_type: &'static str,
    channel: String,
    segment_id: String,
    start_ms: u64,
    end_ms: u64,
    text: String,
    source_final_segment_id: Option<String>,
}

struct RuntimeJsonlStream {
    file: File,
    lines_written: usize,
}

impl RuntimeJsonlStream {
    fn open(path: &Path) -> Result<Self, CliError> {
        ensure_runtime_jsonl_parent(path)?;
        let file = File::create(path).map_err(|err| {
            CliError::new(format!(
                "failed to create JSONL file {}: {err}",
                display_path(path)
            ))
        })?;
        Ok(Self {
            file,
            lines_written: 0,
        })
    }

    fn write_line(&mut self, line: &str) -> Result<(), CliError> {
        writeln!(self.file, "{line}").map_err(io_to_cli)?;
        self.lines_written += 1;
        if self.lines_written % JSONL_SYNC_EVERY_LINES == 0 {
            self.file.sync_data().map_err(io_to_cli)?;
        }
        Ok(())
    }

    fn checkpoint(&mut self) -> Result<(), CliError> {
        self.file.sync_data().map_err(io_to_cli)
    }

    fn finalize(self) -> Result<(), CliError> {
        if self.lines_written > 0 {
            self.file.sync_data().map_err(io_to_cli)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalRenderMode {
    InteractiveTty,
    DeterministicNonTty,
}

impl TerminalRenderMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InteractiveTty => "interactive-tty",
            Self::DeterministicNonTty => "deterministic-non-tty",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalRenderAction {
    kind: TerminalRenderActionKind,
    line: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalRenderActionKind {
    PartialOverwrite,
    StableLine,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RollingChunkWindow {
    index: usize,
    start_ms: u64,
    end_ms: u64,
    overlap_prev_ms: u64,
}

#[derive(Debug, Clone)]
struct AsrWorkItem {
    class: AsrWorkClass,
    tick_index: usize,
    channel: String,
    segment_id: String,
    start_ms: u64,
    end_ms: u64,
    text: String,
    source_final_segment_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsrWorkClass {
    Partial,
    Final,
    Reconcile,
}

impl AsrWorkClass {
    fn priority_rank(self) -> u8 {
        match self {
            Self::Final => 0,
            Self::Reconcile => 1,
            Self::Partial => 2,
        }
    }
}

#[derive(Debug, Clone)]
struct LiveChunkBuildResult {
    events: Vec<TranscriptEvent>,
    telemetry: LiveChunkQueueTelemetry,
}

#[derive(Debug, Clone)]
struct BenchmarkSummary {
    run_count: usize,
    wall_ms_p50: f64,
    wall_ms_p95: f64,
    partial_slo_met: bool,
    final_slo_met: bool,
}

#[derive(Debug, Clone)]
struct ChannelInputPlan {
    role: &'static str,
    label: String,
    audio_path: PathBuf,
    is_temp_audio: bool,
}

#[derive(Debug, Clone)]
struct ModeDegradationEvent {
    code: &'static str,
    detail: String,
}

#[derive(Debug, Clone)]
struct TrustNotice {
    code: String,
    severity: String,
    cause: String,
    impact: String,
    guidance: String,
}

#[derive(Debug, Clone)]
struct ChannelInputPlanResult {
    inputs: Vec<ChannelInputPlan>,
    active_mode: ChannelMode,
    degradation_events: Vec<ModeDegradationEvent>,
}

#[derive(Debug, Clone)]
struct ChannelTranscriptSummary {
    role: &'static str,
    label: String,
    text: String,
}

#[derive(Debug, Clone)]
struct ChannelTranscriptionRun {
    summaries: Vec<ChannelTranscriptSummary>,
    asr_worker_pool: LiveAsrPoolTelemetry,
    final_buffering: FinalBufferingTelemetry,
}

struct LiveStreamIncrementalJsonlWriter {
    stream: RuntimeJsonlStream,
    backend_id: &'static str,
    channel_mode: ChannelMode,
    speaker_labels: SpeakerLabels,
    lifecycle_transition_index: usize,
}

impl LiveStreamIncrementalJsonlWriter {
    fn open(config: &TranscribeConfig) -> Result<Self, CliError> {
        Ok(Self {
            stream: RuntimeJsonlStream::open(&config.out_jsonl)?,
            backend_id: backend_id_for_asr_backend(config.asr_backend),
            channel_mode: config.channel_mode,
            speaker_labels: config.speaker_labels.clone(),
            lifecycle_transition_index: 0,
        })
    }

    fn emit_runtime_event(&mut self, event: &RuntimeOutputEvent) -> Result<(), CliError> {
        match event {
            RuntimeOutputEvent::Lifecycle { phase, detail, .. } => {
                let transition = LiveLifecycleTransition {
                    phase: runtime_phase_to_lifecycle_phase(*phase),
                    entered_at_utc: runtime_timestamp_utc(),
                    detail: detail.clone(),
                };
                self.stream.write_line(&jsonl_lifecycle_phase_line(
                    self.lifecycle_transition_index,
                    &transition,
                ))?;
                self.lifecycle_transition_index += 1;
                self.stream.checkpoint()?;
            }
            RuntimeOutputEvent::AsrCompleted { result, .. } => {
                let Some(event) = transcript_event_from_runtime_asr_result(
                    self.channel_mode,
                    &self.speaker_labels,
                    result,
                ) else {
                    return Ok(());
                };
                self.stream
                    .write_line(&jsonl_transcript_event_line(&event, self.backend_id, 0))?;
            }
            RuntimeOutputEvent::CaptureEvent { .. } | RuntimeOutputEvent::AsrQueued { .. } => {}
        }
        Ok(())
    }

    fn finalize(self) -> Result<(), CliError> {
        self.stream.finalize()
    }
}

struct CollectingRuntimeOutputSink {
    events: Vec<RuntimeOutputEvent>,
    incremental_jsonl: Option<LiveStreamIncrementalJsonlWriter>,
}

impl Default for CollectingRuntimeOutputSink {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            incremental_jsonl: None,
        }
    }
}

impl CollectingRuntimeOutputSink {
    fn with_incremental_jsonl(writer: LiveStreamIncrementalJsonlWriter) -> Self {
        Self {
            events: Vec::new(),
            incremental_jsonl: Some(writer),
        }
    }

    fn finalize_incremental_jsonl(&mut self) -> Result<(), CliError> {
        if let Some(writer) = self.incremental_jsonl.take() {
            writer.finalize()?;
        }
        Ok(())
    }
}

impl RuntimeOutputSink for CollectingRuntimeOutputSink {
    fn emit(&mut self, event: RuntimeOutputEvent) -> Result<(), String> {
        if let Some(writer) = self.incremental_jsonl.as_mut() {
            writer
                .emit_runtime_event(&event)
                .map_err(|err| err.to_string())?;
        }
        self.events.push(event);
        Ok(())
    }
}

#[derive(Debug, Default)]
struct CollectingRuntimeFinalizer {
    summary: Option<LiveRuntimeSummary>,
}

impl RuntimeFinalizer for CollectingRuntimeFinalizer {
    fn finalize(&mut self, summary: &LiveRuntimeSummary) -> Result<(), String> {
        self.summary = Some(summary.clone());
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct ReadableChannelTranscript {
    channel: String,
    text: String,
}

fn select_runtime_execution_branch(config: &TranscribeConfig) -> RuntimeExecutionBranch {
    if config.live_stream {
        RuntimeExecutionBranch::LiveStream
    } else if config.live_chunked {
        RuntimeExecutionBranch::RepresentativeChunked
    } else {
        RuntimeExecutionBranch::RepresentativeOffline
    }
}

fn run_runtime_pipeline(config: &TranscribeConfig) -> Result<LiveRunReport, CliError> {
    match select_runtime_execution_branch(config) {
        RuntimeExecutionBranch::RepresentativeOffline => {
            run_representative_offline_pipeline(config)
        }
        RuntimeExecutionBranch::RepresentativeChunked => {
            run_representative_chunked_pipeline(config)
        }
        RuntimeExecutionBranch::LiveStream => run_live_stream_pipeline(config),
    }
}

const fn backend_id_for_asr_backend(backend: AsrBackend) -> &'static str {
    match backend {
        AsrBackend::WhisperCpp => "whispercpp",
        AsrBackend::WhisperKit => "whisperkit",
        AsrBackend::Moonshine => "moonshine",
    }
}

fn run_representative_offline_pipeline(
    config: &TranscribeConfig,
) -> Result<LiveRunReport, CliError> {
    runtime_representative::run_representative_offline_pipeline(config)
}

fn run_representative_chunked_pipeline(
    config: &TranscribeConfig,
) -> Result<LiveRunReport, CliError> {
    runtime_representative::run_representative_chunked_pipeline(config)
}

fn run_live_stream_pipeline(config: &TranscribeConfig) -> Result<LiveRunReport, CliError> {
    runtime_live_stream::run_live_stream_pipeline(config)
}

#[cfg(test)]
fn live_stream_vad_thresholds_per_mille(vad_threshold: f32) -> (u16, u16) {
    runtime_live_stream::live_stream_vad_thresholds_per_mille(vad_threshold)
}

fn build_transcript_events(
    transcript_text: &str,
    vad_boundaries: &[VadBoundary],
    channel_label: &str,
    segment_key: &str,
    live_chunked: bool,
    chunk_window_ms: u64,
    chunk_stride_ms: u64,
) -> Vec<TranscriptEvent> {
    let start_ms = vad_boundaries.first().map(|v| v.start_ms).unwrap_or(0);
    let end_ms = vad_boundaries.last().map(|v| v.end_ms).unwrap_or(0);
    if live_chunked {
        return build_live_chunked_events(
            transcript_text,
            channel_label,
            segment_key,
            start_ms,
            end_ms,
            chunk_window_ms,
            chunk_stride_ms,
        );
    }

    let partial_end_ms = start_ms + ((end_ms.saturating_sub(start_ms)) / 2);
    let partial_text = partial_text(transcript_text);

    vec![
        TranscriptEvent {
            event_type: "partial",
            channel: channel_label.to_string(),
            segment_id: format!("{segment_key}-representative-0"),
            start_ms,
            end_ms: partial_end_ms,
            text: partial_text,
            source_final_segment_id: None,
        },
        TranscriptEvent {
            event_type: "final",
            channel: channel_label.to_string(),
            segment_id: format!("{segment_key}-representative-0"),
            start_ms,
            end_ms,
            text: transcript_text.to_string(),
            source_final_segment_id: None,
        },
    ]
}

fn build_live_chunked_events(
    transcript_text: &str,
    channel_label: &str,
    segment_key: &str,
    start_ms: u64,
    end_ms: u64,
    chunk_window_ms: u64,
    chunk_stride_ms: u64,
) -> Vec<TranscriptEvent> {
    let chunks = build_rolling_chunk_windows(start_ms, end_ms, chunk_window_ms, chunk_stride_ms);
    if chunks.is_empty() {
        return Vec::new();
    }

    let mut events = Vec::with_capacity(chunks.len() * 2);
    for chunk in &chunks {
        let segment_id = near_live_segment_id(segment_key, chunk);
        let final_text = chunk_scoped_text(transcript_text, chunk.index, chunks.len());
        let partial_end_ms = chunk.start_ms + ((chunk.end_ms.saturating_sub(chunk.start_ms)) / 2);

        events.push(TranscriptEvent {
            event_type: "partial",
            channel: channel_label.to_string(),
            segment_id: segment_id.clone(),
            start_ms: chunk.start_ms,
            end_ms: partial_end_ms,
            text: partial_text(&final_text),
            source_final_segment_id: None,
        });
        events.push(TranscriptEvent {
            event_type: "final",
            channel: channel_label.to_string(),
            segment_id,
            start_ms: chunk.start_ms,
            end_ms: chunk.end_ms,
            text: final_text,
            source_final_segment_id: None,
        });
    }

    events
}

fn build_live_chunked_events_with_queue(
    channel_transcripts: &[ChannelTranscriptSummary],
    vad_boundaries: &[VadBoundary],
    chunk_window_ms: u64,
    chunk_stride_ms: u64,
    chunk_queue_cap: usize,
) -> LiveChunkBuildResult {
    if vad_boundaries.is_empty() || channel_transcripts.is_empty() {
        return LiveChunkBuildResult {
            events: Vec::new(),
            telemetry: LiveChunkQueueTelemetry::enabled(chunk_queue_cap),
        };
    }

    let mut tasks = Vec::new();
    let ordered_boundaries = ordered_vad_boundaries_for_segments(vad_boundaries);
    let ordered_transcripts = ordered_channel_transcripts(channel_transcripts);
    let boundary_count = ordered_boundaries.len();
    for (stable_boundary_idx, boundary) in ordered_boundaries.iter().enumerate() {
        let chunks = build_rolling_chunk_windows(
            boundary.start_ms,
            boundary.end_ms,
            chunk_window_ms,
            chunk_stride_ms,
        );
        if chunks.is_empty() {
            continue;
        }
        let closure_tick_index = boundary_tick_index(boundary.end_ms, chunk_stride_ms);
        for transcript in &ordered_transcripts {
            let boundary_text =
                chunk_scoped_text(&transcript.text, stable_boundary_idx, boundary_count);
            let last_chunk_index = chunks.len().saturating_sub(1);
            for chunk in chunks.iter().take(last_chunk_index) {
                tasks.push(AsrWorkItem {
                    class: AsrWorkClass::Partial,
                    tick_index: boundary_tick_index(chunk.end_ms, chunk_stride_ms),
                    channel: transcript.label.clone(),
                    segment_id: near_live_partial_segment_id(
                        transcript.role,
                        stable_boundary_idx,
                        chunk,
                    ),
                    start_ms: chunk.start_ms,
                    end_ms: chunk.end_ms,
                    text: chunk_scoped_text(&boundary_text, chunk.index, chunks.len()),
                    source_final_segment_id: None,
                });
            }
            tasks.push(AsrWorkItem {
                class: AsrWorkClass::Final,
                tick_index: closure_tick_index,
                channel: transcript.label.clone(),
                segment_id: near_live_boundary_segment_id(
                    transcript.role,
                    stable_boundary_idx,
                    boundary.start_ms,
                    boundary.end_ms,
                ),
                start_ms: boundary.start_ms,
                end_ms: boundary.end_ms,
                text: boundary_text,
                source_final_segment_id: None,
            });
        }
    }
    tasks.sort_by(|a, b| {
        a.tick_index
            .cmp(&b.tick_index)
            .then_with(|| a.start_ms.cmp(&b.start_ms))
            .then_with(|| a.end_ms.cmp(&b.end_ms))
            .then_with(|| a.class.priority_rank().cmp(&b.class.priority_rank()))
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.segment_id.cmp(&b.segment_id))
            .then_with(|| a.source_final_segment_id.cmp(&b.source_final_segment_id))
            .then_with(|| a.text.cmp(&b.text))
    });

    run_live_chunk_queue(tasks, chunk_queue_cap, chunk_stride_ms)
}

fn boundary_tick_index(end_ms: u64, chunk_stride_ms: u64) -> usize {
    if chunk_stride_ms == 0 {
        return 0;
    }
    (end_ms / chunk_stride_ms) as usize
}

fn ordered_vad_boundaries_for_segments(vad_boundaries: &[VadBoundary]) -> Vec<VadBoundary> {
    let mut ordered = vad_boundaries.to_vec();
    ordered.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.end_ms.cmp(&b.end_ms))
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.id.cmp(&b.id))
    });
    ordered
}

fn ordered_channel_transcripts(
    channel_transcripts: &[ChannelTranscriptSummary],
) -> Vec<ChannelTranscriptSummary> {
    let mut ordered = channel_transcripts.to_vec();
    ordered.sort_by(|a, b| {
        channel_sort_key(a.role)
            .cmp(&channel_sort_key(b.role))
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.text.cmp(&b.text))
    });
    ordered
}

#[cfg(test)]
fn build_reconciliation_events(
    channel_transcripts: &[ChannelTranscriptSummary],
    vad_boundaries: &[VadBoundary],
) -> Vec<TranscriptEvent> {
    reconciliation::build_reconciliation_events(channel_transcripts, vad_boundaries)
}

fn build_targeted_reconciliation_events(
    channel_transcripts: &[ChannelTranscriptSummary],
    vad_boundaries: &[VadBoundary],
    live_events: &[TranscriptEvent],
    reconciliation: &ReconciliationMatrix,
) -> Vec<TranscriptEvent> {
    reconciliation::build_targeted_reconciliation_events(
        channel_transcripts,
        vad_boundaries,
        live_events,
        reconciliation,
    )
}

fn build_reconciliation_matrix(
    vad_boundaries: &[VadBoundary],
    degradation_events: &[ModeDegradationEvent],
) -> ReconciliationMatrix {
    reconciliation::build_reconciliation_matrix(vad_boundaries, degradation_events)
}

fn run_live_chunk_queue(
    tasks: Vec<AsrWorkItem>,
    chunk_queue_cap: usize,
    chunk_stride_ms: u64,
) -> LiveChunkBuildResult {
    let mut telemetry = LiveChunkQueueTelemetry::enabled(chunk_queue_cap);
    let mut events = Vec::with_capacity(tasks.len() * 2);
    let mut queue = VecDeque::new();
    let mut last_tick_index: Option<usize> = None;
    let mut lag_samples_ms = Vec::new();

    for task in tasks {
        telemetry.submitted += 1;
        if last_tick_index != Some(task.tick_index) {
            process_next_live_chunk_task(
                &mut queue,
                &mut events,
                &mut telemetry,
                task.tick_index,
                chunk_stride_ms,
                &mut lag_samples_ms,
            );
            last_tick_index = Some(task.tick_index);
        }
        enqueue_live_chunk_task(&mut queue, task, &mut telemetry);
    }
    let mut drain_tick_index = last_tick_index.unwrap_or(0);
    while !queue.is_empty() {
        drain_tick_index = drain_tick_index.saturating_add(1);
        process_next_live_chunk_task(
            &mut queue,
            &mut events,
            &mut telemetry,
            drain_tick_index,
            chunk_stride_ms,
            &mut lag_samples_ms,
        );
    }

    telemetry.pending = queue.len();
    telemetry.drain_completed = telemetry.pending == 0;
    update_chunk_lag_telemetry(&mut telemetry, &lag_samples_ms);
    LiveChunkBuildResult { events, telemetry }
}

fn enqueue_live_chunk_task(
    queue: &mut VecDeque<AsrWorkItem>,
    task: AsrWorkItem,
    telemetry: &mut LiveChunkQueueTelemetry,
) {
    if telemetry.max_queue == 0 {
        telemetry.dropped_oldest += 1;
        return;
    }
    if queue.len() >= telemetry.max_queue {
        let mut drop_idx = 0usize;
        let mut drop_rank = queue
            .front()
            .map(|item| item.class.priority_rank())
            .unwrap_or(0);
        for (idx, queued) in queue.iter().enumerate().skip(1) {
            let rank = queued.class.priority_rank();
            if rank > drop_rank {
                drop_rank = rank;
                drop_idx = idx;
            }
        }
        queue.remove(drop_idx);
        telemetry.dropped_oldest += 1;
    }
    queue.push_back(task);
    telemetry.enqueued += 1;
    telemetry.high_water = telemetry.high_water.max(queue.len());
}

fn process_next_live_chunk_task(
    queue: &mut VecDeque<AsrWorkItem>,
    events: &mut Vec<TranscriptEvent>,
    telemetry: &mut LiveChunkQueueTelemetry,
    processing_tick_index: usize,
    chunk_stride_ms: u64,
    lag_samples_ms: &mut Vec<u64>,
) {
    let Some(task) = queue.pop_front() else {
        return;
    };

    telemetry.processed += 1;
    let lag_ticks = processing_tick_index.saturating_sub(task.tick_index);
    lag_samples_ms.push((lag_ticks as u64).saturating_mul(chunk_stride_ms));
    events.extend(emit_asr_work_item_events(task));
}

fn emit_asr_work_item_events(task: AsrWorkItem) -> Vec<TranscriptEvent> {
    match task.class {
        AsrWorkClass::Final => {
            let partial_end_ms = task.start_ms + ((task.end_ms.saturating_sub(task.start_ms)) / 2);
            vec![
                TranscriptEvent {
                    event_type: "partial",
                    channel: task.channel.clone(),
                    segment_id: task.segment_id.clone(),
                    start_ms: task.start_ms,
                    end_ms: partial_end_ms,
                    text: partial_text(&task.text),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: task.channel,
                    segment_id: task.segment_id,
                    start_ms: task.start_ms,
                    end_ms: task.end_ms,
                    text: task.text,
                    source_final_segment_id: None,
                },
            ]
        }
        AsrWorkClass::Partial => {
            let partial_end_ms = task.start_ms + ((task.end_ms.saturating_sub(task.start_ms)) / 2);
            vec![TranscriptEvent {
                event_type: "partial",
                channel: task.channel,
                segment_id: task.segment_id,
                start_ms: task.start_ms,
                end_ms: partial_end_ms,
                text: partial_text(&task.text),
                source_final_segment_id: None,
            }]
        }
        AsrWorkClass::Reconcile => vec![TranscriptEvent {
            event_type: "reconciled_final",
            channel: task.channel,
            segment_id: task.segment_id,
            start_ms: task.start_ms,
            end_ms: task.end_ms,
            text: task.text,
            source_final_segment_id: task.source_final_segment_id,
        }],
    }
}

fn build_rolling_chunk_windows(
    start_ms: u64,
    end_ms: u64,
    window_ms: u64,
    stride_ms: u64,
) -> Vec<RollingChunkWindow> {
    if end_ms <= start_ms || window_ms == 0 || stride_ms == 0 {
        return Vec::new();
    }

    let span_ms = end_ms - start_ms;
    let effective_window_ms = window_ms.min(span_ms);
    let last_start_ms = end_ms.saturating_sub(effective_window_ms);
    let mut chunk_starts = Vec::new();
    let mut next_start_ms = start_ms;
    while next_start_ms < last_start_ms {
        chunk_starts.push(next_start_ms);
        next_start_ms = next_start_ms.saturating_add(stride_ms);
    }
    chunk_starts.push(last_start_ms);
    chunk_starts.sort_unstable();
    chunk_starts.dedup();

    let mut previous_end_ms: Option<u64> = None;
    chunk_starts
        .into_iter()
        .enumerate()
        .map(|(index, chunk_start_ms)| {
            let chunk_end_ms = chunk_start_ms
                .saturating_add(effective_window_ms)
                .min(end_ms);
            let overlap_prev_ms = previous_end_ms
                .map(|prev_end_ms| prev_end_ms.saturating_sub(chunk_start_ms))
                .unwrap_or(0);
            previous_end_ms = Some(chunk_end_ms);
            RollingChunkWindow {
                index,
                start_ms: chunk_start_ms,
                end_ms: chunk_end_ms,
                overlap_prev_ms,
            }
        })
        .collect()
}

fn near_live_segment_id(segment_key: &str, chunk: &RollingChunkWindow) -> String {
    format!(
        "{segment_key}-chunk-{index:04}-{start_ms}-{end_ms}",
        index = chunk.index,
        start_ms = chunk.start_ms,
        end_ms = chunk.end_ms
    )
}

fn near_live_partial_segment_id(
    segment_key: &str,
    boundary_idx: usize,
    chunk: &RollingChunkWindow,
) -> String {
    format!(
        "{segment_key}-segment-{boundary_idx:04}-partial-{index:04}-{start_ms}-{end_ms}",
        index = chunk.index,
        start_ms = chunk.start_ms,
        end_ms = chunk.end_ms
    )
}

fn near_live_boundary_segment_id(
    segment_key: &str,
    boundary_idx: usize,
    start_ms: u64,
    end_ms: u64,
) -> String {
    format!(
        "{segment_key}-segment-{index:04}-{start_ms}-{end_ms}",
        index = boundary_idx,
        start_ms = start_ms,
        end_ms = end_ms
    )
}

fn chunk_scoped_text(transcript_text: &str, chunk_index: usize, chunk_count: usize) -> String {
    let trimmed = transcript_text.trim();
    if trimmed.is_empty() || chunk_count <= 1 {
        return trimmed.to_string();
    }

    let words = trimmed.split_whitespace().collect::<Vec<_>>();
    if words.len() <= 1 {
        return trimmed.to_string();
    }

    let start = (chunk_index * words.len()) / chunk_count;
    let mut end = ((chunk_index + 1) * words.len()) / chunk_count;
    if end <= start {
        end = (start + 1).min(words.len());
    }
    words[start..end].join(" ")
}

fn merge_transcript_events(events: Vec<TranscriptEvent>) -> Vec<TranscriptEvent> {
    transcript_flow::merge_transcript_events(events)
}

fn reconstruct_transcript(events: &[TranscriptEvent]) -> String {
    transcript_flow::reconstruct_transcript(events)
}

fn reconstruct_transcript_per_channel(
    events: &[TranscriptEvent],
) -> Vec<ReadableChannelTranscript> {
    transcript_flow::reconstruct_transcript_per_channel(events)
}

fn final_events_for_display<'a>(events: &'a [TranscriptEvent]) -> Vec<&'a TranscriptEvent> {
    transcript_flow::final_events_for_display(events)
}

fn terminal_render_mode() -> TerminalRenderMode {
    transcript_flow::terminal_render_mode()
}

fn format_stable_transcript_line(event: &TranscriptEvent) -> Option<String> {
    transcript_flow::format_stable_transcript_line(event)
}

fn format_partial_transcript_line(event: &TranscriptEvent) -> Option<String> {
    transcript_flow::format_partial_transcript_line(event)
}

fn is_stable_terminal_event(event_type: &str) -> bool {
    transcript_flow::is_stable_terminal_event(event_type)
}

fn build_terminal_render_actions(
    events: &[TranscriptEvent],
    mode: TerminalRenderMode,
) -> Vec<TerminalRenderAction> {
    transcript_flow::build_terminal_render_actions(events, mode)
}

#[cfg(test)]
fn live_terminal_render_actions(
    config: &TranscribeConfig,
    events: &[TranscriptEvent],
    mode: TerminalRenderMode,
) -> Vec<TerminalRenderAction> {
    transcript_flow::live_terminal_render_actions(config, events, mode)
}

fn maybe_emit_live_terminal_stream(config: &TranscribeConfig, events: &[TranscriptEvent]) {
    transcript_flow::maybe_emit_live_terminal_stream(config, events)
}

fn build_trust_notices(
    requested_mode: ChannelMode,
    active_mode: ChannelMode,
    degradation_events: &[ModeDegradationEvent],
    cleanup_queue: &CleanupQueueTelemetry,
    chunk_queue: &LiveChunkQueueTelemetry,
) -> Vec<TrustNotice> {
    transcript_flow::build_trust_notices(
        requested_mode,
        active_mode,
        degradation_events,
        cleanup_queue,
        chunk_queue,
    )
}

fn run_cleanup_queue(config: &TranscribeConfig, events: &[TranscriptEvent]) -> CleanupRunResult {
    cleanup::run_cleanup_queue(config, events)
}

#[cfg(test)]
fn run_cleanup_queue_with<F>(
    config: &TranscribeConfig,
    events: &[TranscriptEvent],
    invoke_cleanup: F,
) -> CleanupRunResult
where
    F: Fn(&CleanupClientConfig, &CleanupRequest) -> CleanupAttemptOutcome + Send + Sync + 'static,
{
    cleanup::run_cleanup_queue_with(config, events, invoke_cleanup)
}

#[cfg(test)]
fn cleanup_content_from_response(stdout: &str) -> Option<String> {
    cleanup::cleanup_content_from_response(stdout)
}

fn benchmark_track(channel_mode: ChannelMode) -> &'static str {
    match channel_mode {
        ChannelMode::Separate => "transcribe-live-dual-channel",
        ChannelMode::Mixed => "transcribe-live-single-channel",
        ChannelMode::MixedFallback => "transcribe-live-dual-channel",
    }
}

fn channel_sort_key(role: &str) -> u8 {
    match role {
        "mic" => 0,
        "system" => 1,
        _ => 2,
    }
}

fn partial_text(full_text: &str) -> String {
    let words: Vec<&str> = full_text.split_whitespace().collect();
    if words.len() <= 2 {
        return full_text.to_string();
    }
    words[..(words.len() / 2).max(1)].join(" ")
}

fn write_benchmark_artifact(
    stamp: &str,
    backend_id: &str,
    artifact_track: &str,
    wall_ms_runs: &[f64],
    fallback_root: Option<&Path>,
) -> Result<(PathBuf, PathBuf, BenchmarkSummary), CliError> {
    if wall_ms_runs.is_empty() {
        return Err(CliError::new(
            "cannot write benchmark artifact with zero runs",
        ));
    }

    let mut candidate_roots = Vec::<PathBuf>::new();
    if let Ok(current_dir) = env::current_dir() {
        candidate_roots.push(current_dir);
    } else {
        candidate_roots.push(PathBuf::from("."));
    }
    if let Some(root) = fallback_root {
        let fallback = root.to_path_buf();
        if !candidate_roots
            .iter()
            .any(|candidate| candidate == &fallback)
        {
            candidate_roots.push(fallback);
        }
    }

    let mut failures = Vec::<String>::new();
    for candidate_root in &candidate_roots {
        match write_benchmark_artifact_in_root(
            candidate_root,
            stamp,
            backend_id,
            artifact_track,
            wall_ms_runs,
        ) {
            Ok(written) => {
                if !failures.is_empty() {
                    eprintln!(
                        "warning: benchmark artifacts fell back to {} after write failure(s): {}",
                        candidate_root.display(),
                        failures.join(" | ")
                    );
                }
                return Ok(written);
            }
            Err(err) => failures.push(err.to_string()),
        }
    }

    Err(CliError::new(format!(
        "failed to write benchmark artifacts in all candidate roots: {}",
        failures.join(" | ")
    )))
}

fn write_benchmark_artifact_in_root(
    root: &Path,
    stamp: &str,
    backend_id: &str,
    artifact_track: &str,
    wall_ms_runs: &[f64],
) -> Result<(PathBuf, PathBuf, BenchmarkSummary), CliError> {
    let run_dir = root
        .join("artifacts")
        .join("bench")
        .join(artifact_track)
        .join(stamp);
    fs::create_dir_all(&run_dir).map_err(|err| {
        CliError::new(format!(
            "failed to create benchmark artifact directory {}: {err}",
            run_dir.display()
        ))
    })?;

    let summary_csv = run_dir.join("summary.csv");
    let runs_csv = run_dir.join("runs.csv");
    let wall_ms_p50 = percentile_f64(wall_ms_runs, 0.50);
    let wall_ms_p95 = percentile_f64(wall_ms_runs, 0.95);
    let partial_slo_met = wall_ms_p95 <= PARTIAL_LATENCY_SLO_MS;
    let final_slo_met = wall_ms_p95 <= FINAL_LATENCY_SLO_MS;

    let mut summary_file = File::create(&summary_csv).map_err(|err| {
        CliError::new(format!(
            "failed to create benchmark summary {}: {err}",
            summary_csv.display()
        ))
    })?;
    writeln!(summary_file, "key,value").map_err(io_to_cli)?;
    writeln!(summary_file, "backend_id,{backend_id}").map_err(io_to_cli)?;
    writeln!(summary_file, "artifact_track,{artifact_track}").map_err(io_to_cli)?;
    writeln!(summary_file, "run_count,{}", wall_ms_runs.len()).map_err(io_to_cli)?;
    writeln!(summary_file, "wall_ms_p50,{wall_ms_p50:.6}").map_err(io_to_cli)?;
    writeln!(summary_file, "wall_ms_p95,{wall_ms_p95:.6}").map_err(io_to_cli)?;
    writeln!(
        summary_file,
        "partial_slo_target_ms,{PARTIAL_LATENCY_SLO_MS:.0}"
    )
    .map_err(io_to_cli)?;
    writeln!(
        summary_file,
        "final_slo_target_ms,{FINAL_LATENCY_SLO_MS:.0}"
    )
    .map_err(io_to_cli)?;
    writeln!(summary_file, "partial_slo_met,{partial_slo_met}").map_err(io_to_cli)?;
    writeln!(summary_file, "final_slo_met,{final_slo_met}").map_err(io_to_cli)?;

    let mut runs_file = File::create(&runs_csv).map_err(|err| {
        CliError::new(format!(
            "failed to create benchmark runs {}: {err}",
            runs_csv.display()
        ))
    })?;
    writeln!(runs_file, "run_index,wall_ms").map_err(io_to_cli)?;
    for (idx, wall_ms) in wall_ms_runs.iter().enumerate() {
        writeln!(runs_file, "{idx},{wall_ms:.6}").map_err(io_to_cli)?;
    }

    Ok((
        summary_csv,
        runs_csv,
        BenchmarkSummary {
            run_count: wall_ms_runs.len(),
            wall_ms_p50,
            wall_ms_p95,
            partial_slo_met,
            final_slo_met,
        },
    ))
}

fn percentile_f64(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((sorted.len() - 1) as f64 * quantile).round() as usize;
    sorted[index]
}

fn model_checksum_info(resolved_model: Option<&ResolvedModelPath>) -> ModelChecksumInfo {
    let Some(model) = resolved_model else {
        return ModelChecksumInfo {
            sha256: "<unavailable>".to_string(),
            status: "unavailable_unresolved".to_string(),
        };
    };

    if model.path.is_dir() {
        return ModelChecksumInfo {
            sha256: "<unavailable>".to_string(),
            status: "unavailable_directory".to_string(),
        };
    }

    if !model.path.is_file() {
        return ModelChecksumInfo {
            sha256: "<unavailable>".to_string(),
            status: "unavailable_not_file".to_string(),
        };
    }

    match sha256_file_hex(&model.path) {
        Ok(sha256) => ModelChecksumInfo {
            sha256,
            status: "available".to_string(),
        },
        Err(_) => ModelChecksumInfo {
            sha256: "<unavailable>".to_string(),
            status: "unavailable_checksum_error".to_string(),
        },
    }
}

fn checksum_cache_key(path: &Path) -> Option<ModelChecksumCacheKey> {
    let metadata = fs::metadata(path).ok()?;
    let modified_unix_nanos = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Some(ModelChecksumCacheKey {
        canonical_path,
        file_len: metadata.len(),
        modified_unix_nanos,
    })
}

fn model_checksum_cache() -> &'static Mutex<HashMap<ModelChecksumCacheKey, String>> {
    static CACHE: OnceLock<Mutex<HashMap<ModelChecksumCacheKey, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sha256_file_hex_uncached(path: &Path) -> Result<String, CliError> {
    let mut file = File::open(path).map_err(|err| {
        CliError::new(format!(
            "failed to open model for checksum {}: {err}",
            display_path(path)
        ))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer).map_err(|err| {
            CliError::new(format!(
                "failed reading model for checksum {}: {err}",
                display_path(path)
            ))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_file_hex(path: &Path) -> Result<String, CliError> {
    if let Some(cache_key) = checksum_cache_key(path) {
        if let Ok(cache) = model_checksum_cache().lock() {
            if let Some(cached) = cache.get(&cache_key) {
                return Ok(cached.clone());
            }
        }
        let digest = sha256_file_hex_uncached(path)?;
        if let Ok(mut cache) = model_checksum_cache().lock() {
            cache.insert(cache_key, digest.clone());
        }
        return Ok(digest);
    }

    sha256_file_hex_uncached(path)
}

fn prepare_runtime_input_wav(config: &TranscribeConfig) -> Result<(), CliError> {
    if config.live_chunked || config.live_stream {
        run_live_capture_session(config)
    } else {
        prepare_input_wav(&config.input_wav)
    }
}

fn input_wav_semantics(config: &TranscribeConfig) -> &'static str {
    if config.live_stream {
        "progressive live capture scratch artifact (materialized into canonical out_wav on success)"
    } else if config.live_chunked {
        "representative live scratch artifact mirrored from canonical out_wav after capture"
    } else {
        "representative offline fixture input path"
    }
}

fn live_capture_output_path(config: &TranscribeConfig) -> &Path {
    if config.live_stream {
        &config.input_wav
    } else {
        &config.out_wav
    }
}

fn live_capture_materialization_paths(config: &TranscribeConfig) -> (&Path, &Path) {
    if config.live_stream {
        (&config.input_wav, &config.out_wav)
    } else {
        (&config.out_wav, &config.input_wav)
    }
}

fn run_live_capture_session(config: &TranscribeConfig) -> Result<(), CliError> {
    let capture_output = live_capture_output_path(config).to_path_buf();
    let live_capture_config = LiveCaptureConfig {
        duration_secs: config.duration_sec,
        output: capture_output.clone(),
        target_rate_hz: config.sample_rate_hz,
        mismatch_policy: LiveCaptureSampleRateMismatchPolicy::AdaptStreamRate,
        callback_contract_mode: LiveCaptureCallbackMode::Warn,
        stop_request_path: None,
    };
    run_capture_session(&live_capture_config)
        .map_err(|err| CliError::new(format!("live capture session failed: {err}")))?;
    ensure_live_capture_output_exists(&capture_output)?;
    if config.live_stream {
        return Ok(());
    }
    let (materialize_from, materialize_to) = live_capture_materialization_paths(config);
    materialize_out_wav(materialize_from, materialize_to)
}

fn ensure_live_capture_output_exists(path: &Path) -> Result<(), CliError> {
    if !path.is_file() {
        return Err(CliError::new(format!(
            "live capture session completed but output WAV was not materialized at {}",
            display_path(path)
        )));
    }
    Ok(())
}

fn collect_live_capture_continuity_events(config: &TranscribeConfig) -> Vec<ModeDegradationEvent> {
    if !(config.live_chunked || config.live_stream) {
        return Vec::new();
    }

    let telemetry_path = live_capture_telemetry_path_candidates(config)
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| live_capture_telemetry_path(&config.out_wav));
    match load_live_capture_telemetry_signals(&telemetry_path) {
        Ok(signals) => {
            let mut events = Vec::new();
            if signals.restart_count > 0 {
                events.push(ModeDegradationEvent {
                    code: LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE,
                    detail: format!(
                        "near-live capture recovered from {} stream interruption restart(s) under bounded restart policy; continuity may include restart gaps (telemetry={})",
                        signals.restart_count,
                        display_path(&telemetry_path)
                    ),
                });
            }
            if !signals.transport_sources.is_empty() {
                events.push(ModeDegradationEvent {
                    code: LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE,
                    detail: format!(
                        "near-live capture transport reported degradation source(s): {} (telemetry={})",
                        signals.transport_sources.join(","),
                        display_path(&telemetry_path)
                    ),
                });
            }
            if !signals.callback_sources.is_empty() {
                events.push(ModeDegradationEvent {
                    code: LIVE_CAPTURE_CALLBACK_CONTRACT_DEGRADED_CODE,
                    detail: format!(
                        "near-live capture callback contract violations detected: {} (telemetry={})",
                        signals.callback_sources.join(","),
                        display_path(&telemetry_path)
                    ),
                });
            }
            events
        }
        Err(err) => vec![ModeDegradationEvent {
            code: LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE,
            detail: format!(
                "near-live continuity status could not be verified: {} (telemetry={})",
                err,
                display_path(&telemetry_path)
            ),
        }],
    }
}

struct LiveCaptureTelemetrySignals {
    restart_count: u64,
    transport_sources: Vec<&'static str>,
    callback_sources: Vec<&'static str>,
}

fn live_capture_telemetry_path(output_wav: &Path) -> PathBuf {
    capture_telemetry_path_for_output(output_wav)
}

fn live_capture_telemetry_path_candidates(config: &TranscribeConfig) -> Vec<PathBuf> {
    let mut candidates = vec![live_capture_telemetry_path(&config.out_wav)];
    if absolutize_candidate(config.input_wav.clone())
        != absolutize_candidate(config.out_wav.clone())
    {
        candidates.push(live_capture_telemetry_path(&config.input_wav));
    }
    candidates
}

fn load_live_capture_telemetry_signals(
    telemetry_path: &Path,
) -> Result<LiveCaptureTelemetrySignals, CliError> {
    let payload = fs::read_to_string(telemetry_path).map_err(|err| {
        CliError::new(format!(
            "failed to read live capture telemetry {}: {err}",
            display_path(telemetry_path)
        ))
    })?;
    let parsed_payload: serde_json::Value = serde_json::from_str(&payload).map_err(|err| {
        CliError::new(format!(
            "failed to parse live capture telemetry {} as json: {err}",
            display_path(telemetry_path)
        ))
    })?;
    let restart_count = parsed_payload
        .get("restart_count")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            CliError::new(format!(
                "live capture telemetry {} is missing `restart_count`",
                display_path(telemetry_path)
            ))
        })?;
    let source_values = json_string_field_values(&parsed_payload, "source");

    let transport_sources = LIVE_CAPTURE_TRANSPORT_SOURCES
        .iter()
        .copied()
        .filter(|source| source_values.contains(*source))
        .collect::<Vec<_>>();
    let callback_sources = LIVE_CAPTURE_CALLBACK_SOURCES
        .iter()
        .copied()
        .filter(|source| source_values.contains(*source))
        .collect::<Vec<_>>();

    Ok(LiveCaptureTelemetrySignals {
        restart_count,
        transport_sources,
        callback_sources,
    })
}

fn find_first_json_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(serde_json::Value::as_str) {
                return Some(found.to_string());
            }
            object
                .values()
                .find_map(|nested| find_first_json_string_field(nested, key))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|nested| find_first_json_string_field(nested, key)),
        _ => None,
    }
}

fn collect_json_string_field_values(
    value: &serde_json::Value,
    key: &str,
    values: &mut BTreeSet<String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(serde_json::Value::as_str) {
                values.insert(found.to_string());
            }
            for nested in object.values() {
                collect_json_string_field_values(nested, key, values);
            }
        }
        serde_json::Value::Array(items) => {
            for nested in items {
                collect_json_string_field_values(nested, key, values);
            }
        }
        _ => {}
    }
}

fn json_string_field_values(value: &serde_json::Value, key: &str) -> BTreeSet<String> {
    let mut values = BTreeSet::new();
    collect_json_string_field_values(value, key, &mut values);
    values
}

fn prepare_input_wav(path: &Path) -> Result<(), CliError> {
    if !path.exists() {
        synthesize_input_wav(path)?;
    }
    if !path.is_file() {
        return Err(CliError::new(format!(
            "representative input WAV is not a file: {}",
            display_path(path)
        )));
    }
    Ok(())
}

fn materialize_out_wav(input_wav: &Path, out_wav: &Path) -> Result<(), CliError> {
    let same_output = match (fs::canonicalize(input_wav), fs::canonicalize(out_wav)) {
        (Ok(lhs), Ok(rhs)) => lhs == rhs,
        _ => {
            absolutize_candidate(input_wav.to_path_buf())
                == absolutize_candidate(out_wav.to_path_buf())
        }
    };
    if same_output {
        return Ok(());
    }

    if let Some(parent) = out_wav.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create out-wav directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    fs::copy(input_wav, out_wav).map_err(|err| {
        CliError::new(format!(
            "failed to materialize canonical out-wav {} from input {}: {err}",
            display_path(out_wav),
            display_path(input_wav)
        ))
    })?;
    Ok(())
}

fn synthesize_input_wav(path: &Path) -> Result<(), CliError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create representative input directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    let bundled_fixture = PathBuf::from("/opt/homebrew/opt/whisper-cpp/share/whisper-cpp/jfk.wav");
    if bundled_fixture.exists() {
        fs::copy(&bundled_fixture, path).map_err(|err| {
            CliError::new(format!(
                "failed to copy representative fixture {} -> {}: {err}",
                bundled_fixture.display(),
                display_path(path)
            ))
        })?;
        return Ok(());
    }

    let temp_aiff = path.with_extension("aiff");
    let say_status = Command::new("say")
        .args([
            "-o",
            &temp_aiff.to_string_lossy(),
            "recordit representative transcription sample",
        ])
        .status()
        .map_err(|err| CliError::new(format!("failed to execute `say`: {err}")))?;
    if !say_status.success() {
        return Err(CliError::new(format!(
            "`say` exited with status {} while generating representative audio",
            say_status
        )));
    }

    let convert_status = Command::new("afconvert")
        .args([
            "-f",
            "WAVE",
            "-d",
            "LEI16@16000",
            &temp_aiff.to_string_lossy(),
            &path.to_string_lossy(),
        ])
        .status()
        .map_err(|err| CliError::new(format!("failed to execute `afconvert`: {err}")))?;
    let _ = fs::remove_file(&temp_aiff);
    if !convert_status.success() {
        return Err(CliError::new(format!(
            "`afconvert` exited with status {} while converting representative audio",
            convert_status
        )));
    }

    Ok(())
}

fn detect_vad_boundaries_from_wav(
    wav_path: &Path,
    threshold: f32,
    min_speech_ms: u32,
    min_silence_ms: u32,
) -> Result<Vec<VadBoundary>, CliError> {
    let mut reader = WavReader::open(wav_path).map_err(|err| {
        CliError::new(format!(
            "failed to open representative WAV {}: {err}",
            display_path(wav_path)
        ))
    })?;
    let spec = reader.spec();
    if spec.channels == 0 {
        return Err(CliError::new(format!(
            "WAV has invalid channel count: {}",
            display_path(wav_path)
        )));
    }

    let mut normalized_samples = Vec::new();
    match spec.sample_format {
        SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                normalized_samples.push(
                    sample.map_err(|err| {
                        CliError::new(format!("failed to read float sample: {err}"))
                    })?,
                );
            }
        }
        SampleFormat::Int => {
            if spec.bits_per_sample <= 16 {
                for sample in reader.samples::<i16>() {
                    let value = sample.map_err(|err| {
                        CliError::new(format!("failed to read i16 sample: {err}"))
                    })?;
                    normalized_samples.push(value as f32 / i16::MAX as f32);
                }
            } else {
                let denom = (1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
                for sample in reader.samples::<i32>() {
                    let value = sample.map_err(|err| {
                        CliError::new(format!("failed to read i32 sample: {err}"))
                    })?;
                    normalized_samples.push((value as f32 / denom).clamp(-1.0, 1.0));
                }
            }
        }
    }

    let channels = spec.channels as usize;
    let mut per_channel_levels = (0..channels)
        .map(|idx| {
            (
                vad_channel_label_for_index(idx, channels),
                Vec::with_capacity(normalized_samples.len() / channels + 1),
            )
        })
        .collect::<Vec<_>>();
    for frame in normalized_samples.chunks(channels) {
        for (idx, sample) in frame.iter().enumerate() {
            if let Some((_, levels)) = per_channel_levels.get_mut(idx) {
                levels.push(sample.abs().clamp(0.0, 1.0));
            }
        }
    }

    let total_frames = per_channel_levels
        .first()
        .map(|(_, levels)| levels.len())
        .unwrap_or(0);
    let channel_boundaries = detect_per_channel_vad_boundaries(
        &per_channel_levels,
        spec.sample_rate,
        threshold,
        min_speech_ms,
        min_silence_ms,
    );
    Ok(merge_channel_vad_boundaries(
        &channel_boundaries,
        spec.sample_rate,
        total_frames,
    ))
}

#[cfg(test)]
fn detect_vad_boundaries(
    frame_levels: &[f32],
    sample_rate_hz: u32,
    threshold: f32,
    min_speech_ms: u32,
    min_silence_ms: u32,
) -> Vec<VadBoundary> {
    if frame_levels.is_empty() || sample_rate_hz == 0 {
        return Vec::new();
    }

    let channel_boundaries = detect_per_channel_vad_boundaries(
        &[("merged".to_string(), frame_levels.to_vec())],
        sample_rate_hz,
        threshold,
        min_speech_ms,
        min_silence_ms,
    );
    merge_channel_vad_boundaries(&channel_boundaries, sample_rate_hz, frame_levels.len())
}

fn vad_channel_label_for_index(channel_index: usize, channel_count: usize) -> String {
    if channel_count == 2 {
        return if channel_index == 0 {
            "mic".to_string()
        } else {
            "system".to_string()
        };
    }
    format!("ch{channel_index}")
}

fn detect_per_channel_vad_boundaries(
    channel_levels: &[(String, Vec<f32>)],
    sample_rate_hz: u32,
    threshold: f32,
    min_speech_ms: u32,
    min_silence_ms: u32,
) -> Vec<ChannelVadBoundary> {
    if sample_rate_hz == 0 {
        return Vec::new();
    }
    let mut boundaries = Vec::new();
    for (channel, levels) in channel_levels {
        let mut tracker = IncrementalVadTracker::new(
            channel.clone(),
            sample_rate_hz,
            threshold,
            min_speech_ms,
            min_silence_ms,
        );
        for (idx, level) in levels.iter().copied().enumerate() {
            tracker.observe(idx, level);
        }
        boundaries.extend(tracker.finish(levels.len()));
    }
    boundaries.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.end_ms.cmp(&b.end_ms))
            .then_with(|| a.channel.cmp(&b.channel))
    });
    boundaries
}

fn merge_channel_vad_boundaries(
    channel_boundaries: &[ChannelVadBoundary],
    sample_rate_hz: u32,
    total_frames: usize,
) -> Vec<VadBoundary> {
    if total_frames == 0 || sample_rate_hz == 0 {
        return Vec::new();
    }
    if channel_boundaries.is_empty() {
        return vec![VadBoundary {
            id: 0,
            start_ms: 0,
            end_ms: sample_to_ms(total_frames as u64, sample_rate_hz),
            source: "fallback_full_audio",
        }];
    }

    let mut merged = Vec::new();
    let mut current_start_ms = channel_boundaries[0].start_ms;
    let mut current_end_ms = channel_boundaries[0].end_ms;
    let mut current_source = channel_boundaries[0].source;
    for boundary in channel_boundaries.iter().skip(1) {
        if boundary.start_ms <= current_end_ms {
            current_end_ms = current_end_ms.max(boundary.end_ms);
            if boundary.source == "shutdown_flush" {
                current_source = "shutdown_flush";
            }
        } else {
            merged.push(VadBoundary {
                id: merged.len(),
                start_ms: current_start_ms,
                end_ms: current_end_ms,
                source: current_source,
            });
            current_start_ms = boundary.start_ms;
            current_end_ms = boundary.end_ms;
            current_source = boundary.source;
        }
    }
    merged.push(VadBoundary {
        id: merged.len(),
        start_ms: current_start_ms,
        end_ms: current_end_ms,
        source: current_source,
    });
    merged
}

fn sample_to_ms(sample_idx: u64, sample_rate_hz: u32) -> u64 {
    sample_idx.saturating_mul(1_000) / sample_rate_hz.max(1) as u64
}

fn ms_to_sample_index(ms: u64, sample_rate_hz: u32) -> usize {
    if sample_rate_hz == 0 {
        return 0;
    }
    ((ms as u128 * sample_rate_hz as u128 + 500) / 1_000) as usize
}

fn runtime_job_class_to_pool_job_class(class: RuntimeAsrJobClass) -> LiveAsrJobClass {
    runtime_events::runtime_job_class_to_pool_job_class(class)
}

fn runtime_channel_role(channel: &str) -> &'static str {
    runtime_events::runtime_channel_role(channel)
}

fn runtime_channel_label(
    channel_mode: ChannelMode,
    speaker_labels: &SpeakerLabels,
    channel: &str,
) -> String {
    runtime_events::runtime_channel_label(channel_mode, speaker_labels, channel)
}

fn write_runtime_job_wav(
    path: &Path,
    sample_rate_hz: u32,
    samples: &[f32],
) -> Result<(), CliError> {
    runtime_events::write_runtime_job_wav(path, sample_rate_hz, samples)
}

fn runtime_phase_to_lifecycle_phase(phase: LiveRuntimePhase) -> LiveLifecyclePhase {
    runtime_events::runtime_phase_to_lifecycle_phase(phase)
}

fn lifecycle_from_runtime_output_events(events: &[RuntimeOutputEvent]) -> LiveLifecycleTelemetry {
    runtime_events::lifecycle_from_runtime_output_events(events)
}

fn transcript_events_from_runtime_output_events(
    config: &TranscribeConfig,
    events: &[RuntimeOutputEvent],
) -> Vec<TranscriptEvent> {
    runtime_events::transcript_events_from_runtime_output_events(config, events)
}

fn transcript_event_from_runtime_asr_result(
    channel_mode: ChannelMode,
    speaker_labels: &SpeakerLabels,
    result: &LiveAsrResult,
) -> Option<TranscriptEvent> {
    runtime_events::transcript_event_from_runtime_asr_result(channel_mode, speaker_labels, result)
}

fn vad_boundaries_from_runtime_output_events(events: &[RuntimeOutputEvent]) -> Vec<VadBoundary> {
    runtime_events::vad_boundaries_from_runtime_output_events(events)
}

fn fallback_vad_boundaries_from_events(events: &[TranscriptEvent]) -> Vec<VadBoundary> {
    runtime_events::fallback_vad_boundaries_from_events(events)
}

fn merge_live_transcript_events_for_display(events: Vec<TranscriptEvent>) -> Vec<TranscriptEvent> {
    runtime_events::merge_live_transcript_events_for_display(events)
}

fn live_stream_chunk_queue_telemetry(
    config: &TranscribeConfig,
    runtime_summary: &LiveRuntimeSummary,
    asr_worker_pool: &LiveAsrPoolTelemetry,
) -> LiveChunkQueueTelemetry {
    runtime_events::live_stream_chunk_queue_telemetry(config, runtime_summary, asr_worker_pool)
}

fn channel_transcript_summaries_from_events(
    config: &TranscribeConfig,
    events: &[TranscriptEvent],
) -> Vec<ChannelTranscriptSummary> {
    runtime_events::channel_transcript_summaries_from_events(config, events)
}

fn active_channel_mode_from_transcripts(
    config: &TranscribeConfig,
    channel_transcripts: &[ChannelTranscriptSummary],
) -> ChannelMode {
    runtime_events::active_channel_mode_from_transcripts(config, channel_transcripts)
}

#[derive(Debug, Clone, Copy, Default)]
struct FirstEmitTiming {
    first_any_end_ms: Option<u64>,
    first_partial_end_ms: Option<u64>,
    first_final_end_ms: Option<u64>,
    first_stable_end_ms: Option<u64>,
}

fn first_emit_timing(events: &[TranscriptEvent]) -> FirstEmitTiming {
    let mut timing = FirstEmitTiming::default();
    for event in events {
        let end_ms = event.end_ms;
        if timing.first_any_end_ms.is_none() {
            timing.first_any_end_ms = Some(end_ms);
        }
        if event.event_type == "partial" && timing.first_partial_end_ms.is_none() {
            timing.first_partial_end_ms = Some(end_ms);
        }
        if event.event_type == "final" && timing.first_final_end_ms.is_none() {
            timing.first_final_end_ms = Some(end_ms);
        }
        if is_stable_terminal_event(event.event_type) && timing.first_stable_end_ms.is_none() {
            timing.first_stable_end_ms = Some(end_ms);
        }
        if timing.first_any_end_ms.is_some()
            && timing.first_partial_end_ms.is_some()
            && timing.first_final_end_ms.is_some()
            && timing.first_stable_end_ms.is_some()
        {
            break;
        }
    }
    timing
}

fn stable_terminal_summary_lines(events: &[TranscriptEvent]) -> Vec<String> {
    reporting::stable_terminal_summary_lines(events)
}

fn transcript_event_count(events: &[TranscriptEvent], event_type: &str) -> usize {
    reporting::transcript_event_count(events, event_type)
}

fn distributed_bucket(total: usize, buckets: usize, index: usize) -> usize {
    if buckets == 0 {
        return 0;
    }
    let base = total / buckets;
    let remainder = total % buckets;
    base + usize::from(index < remainder)
}

fn build_channel_pressure_snapshots(
    events: &[TranscriptEvent],
    channel_transcripts: &[ChannelTranscriptSummary],
    chunk_queue: &LiveChunkQueueTelemetry,
) -> Vec<ChannelPressureSnapshot> {
    let mut channel_set = BTreeSet::new();
    for event in events {
        channel_set.insert(event.channel.clone());
    }
    for channel in channel_transcripts {
        channel_set.insert(channel.label.clone());
    }
    let channels = channel_set.into_iter().collect::<Vec<_>>();
    if channels.is_empty() {
        return Vec::new();
    }

    let mut partial_counts = HashMap::<String, usize>::new();
    let mut stable_counts = HashMap::<String, usize>::new();
    for event in events {
        if event.event_type == "partial" {
            *partial_counts.entry(event.channel.clone()).or_default() += 1;
        }
        if is_stable_terminal_event(event.event_type) {
            *stable_counts.entry(event.channel.clone()).or_default() += 1;
        }
    }

    let channel_count = channels.len();
    channels
        .into_iter()
        .enumerate()
        .map(|(index, channel)| {
            let partial_events = partial_counts.get(&channel).copied().unwrap_or(0);
            let stable_events = stable_counts.get(&channel).copied().unwrap_or(0);
            ChannelPressureSnapshot {
                channel,
                partial_events,
                stable_events,
                processed_events: partial_events + stable_events,
                pending_estimate: distributed_bucket(chunk_queue.pending, channel_count, index),
                dropped_oldest_estimate: distributed_bucket(
                    chunk_queue.dropped_oldest,
                    channel_count,
                    index,
                ),
            }
        })
        .collect()
}

fn build_hot_path_diagnostics(
    config: &TranscribeConfig,
    events: &[TranscriptEvent],
    channel_transcripts: &[ChannelTranscriptSummary],
    chunk_queue: &LiveChunkQueueTelemetry,
    runtime_summary: &LiveRuntimeSummary,
    asr_worker_pool: &LiveAsrPoolTelemetry,
) -> HotPathDiagnostics {
    let write_attempts_estimate = asr_worker_pool
        .processed
        .saturating_add(asr_worker_pool.retry_attempts);
    let worker_scratch_paths_upper_bound = config.live_asr_workers.max(1);
    let reuse_overwrites_estimate =
        write_attempts_estimate.saturating_sub(worker_scratch_paths_upper_bound);
    let forced_capture_event_triggers = runtime_summary.capture_events_seen;
    let forced_shutdown_triggers = 4;
    let forced_decisions = forced_capture_event_triggers.saturating_add(forced_shutdown_triggers);
    HotPathDiagnostics {
        transport: TransportInputDiagnostics {
            // live-stream request path is now in-memory PCM windows only.
            path_requests: 0,
            pcm_window_requests: asr_worker_pool.submitted,
        },
        scratch: ScratchLifecycleDiagnostics {
            worker_scratch_paths_upper_bound,
            write_attempts_estimate,
            reuse_overwrites_estimate,
            retained_for_review_hint: asr_worker_pool.failed > 0,
        },
        backpressure: BackpressureDiagnostics {
            mode: runtime_summary.backpressure_mode,
            transition_count: runtime_summary.backpressure_transitions.len(),
            last_transition_reason: runtime_summary
                .backpressure_transitions
                .last()
                .map(|transition| transition.reason),
            pending_jobs: runtime_summary.pending_jobs,
            pending_final_jobs: runtime_summary.pending_final_jobs,
            channel_snapshots: build_channel_pressure_snapshots(
                events,
                channel_transcripts,
                chunk_queue,
            ),
        },
        pump: PumpCadenceDiagnostics {
            chunk_decisions: runtime_summary.capture_chunks_seen,
            forced_decisions,
            forced_capture_event_triggers,
            forced_shutdown_triggers,
        },
    }
}

fn build_startup_banner_lines(config: &TranscribeConfig) -> Vec<String> {
    vec![
        format!("runtime_mode={}", config.runtime_mode_label()),
        format!(
            "runtime_mode_taxonomy={}",
            config.runtime_mode_taxonomy_label()
        ),
        format!(
            "runtime_mode_selector={}",
            config.runtime_mode_selector_label()
        ),
        format!("runtime_mode_status={}", config.runtime_mode_status_label()),
        format!("channel_mode_requested={}", config.channel_mode),
        format!("duration_sec={}", config.duration_sec),
        format!("input_wav={}", display_path(&config.input_wav)),
        format!(
            "artifacts=out_wav:{} out_jsonl:{} out_manifest:{}",
            display_path(&config.out_wav),
            display_path(&config.out_jsonl),
            display_path(&config.out_manifest),
        ),
    ]
}

fn session_status(report: &LiveRunReport) -> &'static str {
    reporting::session_status(report)
}

fn top_codes<I>(codes: I, limit: usize) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    reporting::top_codes(codes, limit)
}

fn print_live_report(config: &TranscribeConfig, report: &LiveRunReport, concise_only: bool) {
    reporting::print_live_report(config, report, concise_only)
}

fn emit_latest_lifecycle_transition_jsonl(
    stream: &mut RuntimeJsonlStream,
    lifecycle: &LiveLifecycleTelemetry,
) -> Result<(), CliError> {
    artifacts::emit_latest_lifecycle_transition_jsonl(stream, lifecycle)
}

fn ensure_runtime_jsonl_parent(path: &Path) -> Result<(), CliError> {
    artifacts::ensure_runtime_jsonl_parent(path)
}

fn jsonl_vad_boundary_line(boundary: &VadBoundary, config: &TranscribeConfig) -> String {
    artifacts::jsonl_vad_boundary_line(boundary, config)
}

fn jsonl_transcript_event_line(
    event: &TranscriptEvent,
    backend_id: &str,
    vad_boundary_count: usize,
) -> String {
    artifacts::jsonl_transcript_event_line(event, backend_id, vad_boundary_count)
}

fn jsonl_mode_degradation_line(
    requested_mode: ChannelMode,
    active_mode: ChannelMode,
    degradation: &ModeDegradationEvent,
) -> String {
    artifacts::jsonl_mode_degradation_line(requested_mode, active_mode, degradation)
}

fn jsonl_trust_notice_line(notice: &TrustNotice) -> String {
    artifacts::jsonl_trust_notice_line(notice)
}

fn jsonl_lifecycle_phase_line(index: usize, transition: &LiveLifecycleTransition) -> String {
    artifacts::jsonl_lifecycle_phase_line(index, transition)
}

fn jsonl_reconciliation_matrix_line(reconciliation: &ReconciliationMatrix) -> String {
    artifacts::jsonl_reconciliation_matrix_line(reconciliation)
}

fn jsonl_asr_worker_pool_line(asr_worker_pool: &LiveAsrPoolTelemetry) -> String {
    artifacts::jsonl_asr_worker_pool_line(asr_worker_pool)
}

fn jsonl_chunk_queue_line(chunk_queue: &LiveChunkQueueTelemetry) -> String {
    artifacts::jsonl_chunk_queue_line(chunk_queue)
}

fn jsonl_cleanup_queue_line(cleanup_queue: &CleanupQueueTelemetry) -> String {
    artifacts::jsonl_cleanup_queue_line(cleanup_queue)
}

fn write_runtime_jsonl(config: &TranscribeConfig, report: &LiveRunReport) -> Result<(), CliError> {
    artifacts::write_runtime_jsonl(config, report)
}

fn write_runtime_manifest(
    config: &TranscribeConfig,
    report: &LiveRunReport,
) -> Result<(), CliError> {
    artifacts::write_runtime_manifest(config, report)
}

fn replay_timeline(path: &Path) -> Result<(), CliError> {
    let content = fs::read_to_string(path).map_err(|err| {
        CliError::new(format!(
            "failed to read replay JSONL {}: {err}",
            display_path(path)
        ))
    })?;

    let mut events = Vec::new();
    let mut trust_notices = Vec::new();
    for (line_no, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(notice) = parse_replay_trust_notice(trimmed, line_no + 1)? {
            trust_notices.push(notice);
            continue;
        }
        if let Some(event) = parse_replay_transcript_event(trimmed, line_no + 1)? {
            events.push(event);
        }
    }

    let events = merge_transcript_events(events);

    println!("Replay timeline");
    println!("  source_jsonl: {}", display_path(path));
    println!("  events: {}", events.len());
    for event in &events {
        println!(
            "  {} channel={} [{}-{}ms] {}",
            event.event_type, event.channel, event.start_ms, event.end_ms, event.text
        );
    }
    println!("  trust_notices: {}", trust_notices.len());
    for notice in &trust_notices {
        println!(
            "    - [{}] {} | impact={} | next={}",
            notice.severity, notice.cause, notice.impact, notice.guidance
        );
    }

    let reconstructed = reconstruct_transcript(&events);
    let per_channel = reconstruct_transcript_per_channel(&events);
    println!();
    println!("Readable transcript (default merged format)");
    for line in reconstructed.lines() {
        println!("  {line}");
    }
    println!();
    println!("Readable transcript (per-channel defaults)");
    for channel in &per_channel {
        println!("  [{}]", channel.channel);
        for line in channel.text.lines() {
            println!("    {line}");
        }
    }
    Ok(())
}

const REPLAY_JSONL_MAX_LINE_BYTES: usize = 1_048_576;
const REPLAY_TRANSCRIPT_TEXT_MAX_BYTES: usize = 262_144;

fn replay_line_error(line_no: usize, category: &str, detail: impl AsRef<str>) -> CliError {
    CliError::new(format!(
        "invalid replay line {line_no} [{category}]: {}",
        detail.as_ref()
    ))
}

fn ensure_replay_line_within_bounds(line: &str, line_no: usize) -> Result<(), CliError> {
    let byte_len = line.len();
    if byte_len > REPLAY_JSONL_MAX_LINE_BYTES {
        return Err(replay_line_error(
            line_no,
            "line_too_large",
            format!("line has {byte_len} bytes; max allowed is {REPLAY_JSONL_MAX_LINE_BYTES}"),
        ));
    }
    Ok(())
}

fn replay_parse_reason_category(err: &str) -> &'static str {
    if err.starts_with("invalid json line") {
        "json_decode"
    } else if err.contains("payload mismatch") {
        "payload_mismatch"
    } else if err.contains("unknown event_type") {
        "unknown_event_type"
    } else {
        "parse_error"
    }
}

#[derive(serde::Deserialize)]
struct ReplayEventTypeProbe {
    event_type: Option<String>,
}

fn replay_event_type(line: &str, line_no: usize) -> Result<Option<String>, CliError> {
    let parsed: ReplayEventTypeProbe = serde_json::from_str(line).map_err(|err| {
        let err_text = format!("invalid json line: {err}");
        replay_line_error(line_no, replay_parse_reason_category(&err_text), err_text)
    })?;
    Ok(parsed.event_type)
}

fn parse_replay_transcript_event(
    line: &str,
    line_no: usize,
) -> Result<Option<TranscriptEvent>, CliError> {
    ensure_replay_line_within_bounds(line, line_no)?;
    let Some(event_type) = replay_event_type(line, line_no)? else {
        return Ok(None);
    };
    if !contracts_models::runtime_jsonl::TRANSCRIPT_EVENT_TYPES.contains(&event_type.as_str()) {
        return Ok(None);
    }

    let parsed =
        contracts_models::runtime_jsonl::parse_runtime_jsonl_event_line(line).map_err(|err| {
            let err_text = err.to_string();
            replay_line_error(line_no, replay_parse_reason_category(&err_text), err_text)
        })?;
    let (event_name, payload) = match parsed {
        contracts_models::runtime_jsonl::RuntimeJsonlEvent::Partial(payload) => {
            ("partial", payload)
        }
        contracts_models::runtime_jsonl::RuntimeJsonlEvent::Final(payload) => ("final", payload),
        contracts_models::runtime_jsonl::RuntimeJsonlEvent::LlmFinal(payload) => {
            ("llm_final", payload)
        }
        contracts_models::runtime_jsonl::RuntimeJsonlEvent::ReconciledFinal(payload) => {
            ("reconciled_final", payload)
        }
        _ => {
            return Err(CliError::new(format!(
                "invalid replay line {line_no}: event_type `{event_type}` decoded as non-transcript variant"
            )));
        }
    };
    if payload.text.len() > REPLAY_TRANSCRIPT_TEXT_MAX_BYTES {
        return Err(replay_line_error(
            line_no,
            "text_too_large",
            format!(
                "transcript text has {} bytes; max allowed is {REPLAY_TRANSCRIPT_TEXT_MAX_BYTES}",
                payload.text.len()
            ),
        ));
    }
    Ok(Some(TranscriptEvent {
        event_type: event_name,
        channel: payload.channel,
        segment_id: payload.segment_id,
        start_ms: payload.start_ms,
        end_ms: payload.end_ms,
        text: payload.text,
        source_final_segment_id: payload.source_final_segment_id,
    }))
}

fn parse_replay_trust_notice(line: &str, line_no: usize) -> Result<Option<TrustNotice>, CliError> {
    ensure_replay_line_within_bounds(line, line_no)?;
    let Some(event_type) = replay_event_type(line, line_no)? else {
        return Ok(None);
    };
    if event_type != contracts_models::runtime_jsonl::EVENT_TYPE_TRUST_NOTICE {
        return Ok(None);
    }
    let parsed =
        contracts_models::runtime_jsonl::parse_runtime_jsonl_event_line(line).map_err(|err| {
            let err_text = err.to_string();
            replay_line_error(line_no, replay_parse_reason_category(&err_text), err_text)
        })?;
    let contracts_models::runtime_jsonl::RuntimeJsonlEvent::TrustNotice(notice) = parsed else {
        return Err(replay_line_error(
            line_no,
            "variant_mismatch",
            "trust_notice event decoded as a non-trust variant",
        ));
    };
    Ok(Some(TrustNotice {
        code: notice.code,
        severity: notice.severity,
        cause: notice.cause,
        impact: notice.impact,
        guidance: notice.guidance,
    }))
}

#[allow(dead_code)]
pub(crate) fn main() -> ExitCode {
    run_with_parse_outcome(parse_args())
}

#[allow(dead_code)]
pub(crate) fn run_with_args(args: impl Iterator<Item = String>) -> ExitCode {
    run_with_args_in_operator_mode(args, false)
}

#[allow(dead_code)]
pub(crate) fn run_with_args_in_operator_mode(
    args: impl Iterator<Item = String>,
    concise_operator_mode: bool,
) -> ExitCode {
    run_with_parse_outcome_with_render_mode(parse_args_from(args), concise_operator_mode)
}

fn print_failed_status_hint(remediation_hint: &str) {
    eprintln!("run_status=failed");
    eprintln!("remediation_hint={remediation_hint}");
}

fn run_with_parse_outcome(parse_outcome: Result<ParseOutcome, CliError>) -> ExitCode {
    run_with_parse_outcome_with_render_mode(parse_outcome, false)
}

fn run_with_parse_outcome_with_render_mode(
    parse_outcome: Result<ParseOutcome, CliError>,
    concise_operator_mode: bool,
) -> ExitCode {
    match parse_outcome {
        Ok(ParseOutcome::Help) => {
            println!("{HELP_TEXT}");
            ExitCode::SUCCESS
        }
        Ok(ParseOutcome::Config(config)) => {
            if config.preflight {
                match run_preflight(&config) {
                    Ok(report) => {
                        print_preflight_report(&report);
                        if let Err(err) = write_preflight_manifest(&config, &report) {
                            eprintln!("error: failed writing preflight manifest: {err}");
                            print_failed_status_hint(
                                "verify the manifest output path is writable, then rerun `recordit preflight --mode live`.",
                            );
                            return ExitCode::from(2);
                        }
                        match report.overall_status() {
                            CheckStatus::Fail => ExitCode::from(2),
                            _ => ExitCode::SUCCESS,
                        }
                    }
                    Err(err) => {
                        eprintln!("error: preflight failed unexpectedly: {err}");
                        print_failed_status_hint(
                            "rerun `recordit preflight --mode live` to inspect prerequisite failures and remediation columns.",
                        );
                        ExitCode::from(2)
                    }
                }
            } else {
                if config.model_doctor {
                    match run_model_doctor(&config) {
                        Ok(report) => {
                            print_model_doctor_report(&report);
                            return match report.overall_status() {
                                CheckStatus::Fail => ExitCode::from(2),
                                _ => ExitCode::SUCCESS,
                            };
                        }
                        Err(err) => {
                            eprintln!("error: model doctor failed unexpectedly: {err}");
                            print_failed_status_hint(
                                "run `recordit doctor --format json` and verify `--model` or `RECORDIT_ASR_MODEL`.",
                            );
                            return ExitCode::from(2);
                        }
                    }
                }

                if let Some(replay_path) = &config.replay_jsonl {
                    match replay_timeline(replay_path) {
                        Ok(()) => return ExitCode::SUCCESS,
                        Err(err) => {
                            eprintln!("error: replay failed: {err}");
                            print_failed_status_hint(
                                "verify the replay JSONL path exists and rerun `recordit replay --jsonl <path>`.",
                            );
                            return ExitCode::from(2);
                        }
                    }
                }

                config.print_summary(concise_operator_mode);
                match run_runtime_pipeline(&config) {
                    Ok(run_report) => {
                        print_live_report(&config, &run_report, concise_operator_mode);
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("error: runtime execution failed: {err}");
                        print_failed_status_hint(
                            "rerun `recordit preflight --mode live` and inspect the manifest trust/degradation fields for the next action.",
                        );
                        ExitCode::from(2)
                    }
                }
            }
        }
        Err(err) => {
            eprintln!("error: {err}");
            eprintln!();
            eprintln!("Run `transcribe-live --help` to see the supported contract.");
            eprintln!("For the canonical operator path, use `recordit run --mode live`.");
            print_failed_status_hint(
                "run `recordit --help` or `recordit run --mode live` for the canonical operator path.",
            );
            ExitCode::from(2)
        }
    }
}

#[allow(dead_code)]
fn parse_args() -> Result<ParseOutcome, CliError> {
    cli_parse::parse_args()
}

#[allow(dead_code)]
fn parse_args_from(args: impl Iterator<Item = String>) -> Result<ParseOutcome, CliError> {
    cli_parse::parse_args_from(args)
}

fn validate_output_path(flag: &str, path: &Path) -> Result<(), CliError> {
    if path.as_os_str().is_empty() {
        return Err(CliError::new(format!("`{flag}` cannot be empty")));
    }

    if let Some(parent) = path.parent() {
        if parent.exists() && !parent.is_dir() {
            return Err(CliError::new(format!(
                "`{flag}` points into `{}` but that parent exists and is not a directory",
                parent.display()
            )));
        }
    }

    if storage_roots::app_managed_storage_policy_enabled() {
        let roots = storage_roots::resolve_canonical_storage_roots().map_err(|err| {
            CliError::new(format!(
                "failed to resolve canonical app-managed storage roots: {err}"
            ))
        })?;
        if matches!(flag, "--out-wav" | "--out-jsonl" | "--out-manifest") {
            storage_roots::validate_app_managed_write_path(
                path,
                ManagedStorageDomain::Sessions,
                &roots,
            )
            .map_err(|err| CliError::new(format!("`{flag}` violates storage policy: {err}")))?;
        }
    }

    Ok(())
}

fn display_path(path: &Path) -> String {
    if path.is_absolute() {
        return path.display().to_string();
    }

    match env::current_dir() {
        Ok(cwd) => cwd.join(path).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

fn write_preflight_manifest(
    config: &TranscribeConfig,
    report: &PreflightReport,
) -> Result<(), CliError> {
    artifacts::write_preflight_manifest(config, report)
}

fn io_to_cli(err: std::io::Error) -> CliError {
    CliError::new(format!("manifest write error: {err}"))
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn clean_field(value: &str) -> String {
    value
        .replace('\t', " ")
        .replace('\n', " ")
        .replace('\r', " ")
}

fn runtime_timestamp_utc() -> String {
    command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]).unwrap_or_else(|_| "unknown".to_string())
}

fn command_stdout(program: &str, args: &[&str]) -> Result<String, CliError> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| CliError::new(format!("failed to execute `{program}`: {err}")))?;
    if !output.status.success() {
        return Err(CliError::new(format!(
            "`{program}` exited with status {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::contracts_models::runtime_jsonl;
    use super::reporting::{
        build_live_close_summary_lines, remediation_hints_csv, runtime_failure_breadcrumbs,
        top_remediation_hints,
    };
    use super::{
        build_hot_path_diagnostics, build_live_chunked_events_with_queue,
        build_reconciliation_events, build_reconciliation_matrix, build_rolling_chunk_windows,
        build_startup_banner_lines, build_targeted_reconciliation_events,
        build_terminal_render_actions, build_transcript_events, build_trust_notices,
        bundled_backend_program_from_exe, chunk_queue_backpressure_is_severe,
        collect_live_capture_continuity_events, detect_per_channel_vad_boundaries,
        detect_vad_boundaries, emit_latest_lifecycle_transition_jsonl, input_wav_semantics,
        live_capture_materialization_paths, live_capture_output_path,
        live_capture_telemetry_path_candidates, live_stream_chunk_queue_telemetry,
        live_stream_vad_thresholds_per_mille, live_terminal_render_actions, materialize_out_wav,
        merge_channel_vad_boundaries, merge_transcript_events, model_checksum_info,
        parse_args_from, parse_replay_transcript_event, parse_replay_trust_notice,
        reconstruct_transcript, reconstruct_transcript_per_channel, replay_timeline,
        resolve_backend_program, resolve_model_path, run_cleanup_queue_with, run_live_chunk_queue,
        run_streaming_capture_session, runtime_mode_compatibility_matrix,
        select_runtime_execution_branch, transcript_events_from_runtime_output_events,
        validate_model_path_for_backend, validate_output_path, write_preflight_manifest,
        write_runtime_jsonl,
        write_runtime_manifest, AsrBackend, AsrWorkClass, AsrWorkItem, BenchmarkSummary,
        CaptureChunk, CaptureEvent, CaptureSink, ChannelMode, ChannelVadBoundary, CheckStatus,
        CleanupAttemptOutcome, CleanupQueueTelemetry, CleanupTaskStatus,
        CollectingRuntimeOutputSink, FinalBufferingTelemetry, HotPathDiagnostics,
        IncrementalVadTracker, LiveAsrExecutor, LiveAsrJob, LiveAsrJobClass, LiveAsrPoolConfig,
        LiveAsrPoolTelemetry, LiveAsrRequest, LiveCaptureCallbackMode, LiveCaptureConfig,
        LiveCaptureSampleRateMismatchPolicy, LiveChunkQueueTelemetry, LiveLifecyclePhase,
        LiveLifecycleTelemetry, LiveRunReport, ModeDegradationEvent, ParseOutcome, PreflightCheck,
        PreflightReport, ReconciliationMatrix, ResolvedModelPath, RuntimeExecutionBranch,
        RuntimeJsonlStream, RuntimeOutputSink, TempAudioPolicy, TerminalRenderActionKind,
        TerminalRenderMode, TranscribeConfig, TranscriptEvent, VadBoundary, HELP_TEXT,
        LIVE_CAPTURE_CALLBACK_CONTRACT_DEGRADED_CODE, LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE,
        LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE, LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE,
        LIVE_CHUNK_QUEUE_BACKPRESSURE_SEVERE_CODE, LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE,
        RECONCILIATION_APPLIED_CODE, REPLAY_JSONL_MAX_LINE_BYTES, REPLAY_TRANSCRIPT_TEXT_MAX_BYTES,
    };
    use hound::{SampleFormat, WavSpec, WavWriter};
    use recordit::live_stream_runtime::{
        BackpressureMode, BackpressureTransition, BackpressureTransitionReason,
        LiveAsrJobClass as RuntimeAsrJobClass, LiveAsrJobSpec as RuntimeAsrJobSpec,
        LiveAsrResult as RuntimeAsrResult, LiveRuntimePhase, LiveRuntimeSummary,
        RuntimeOutputEvent,
    };
    use recordit::storage_roots;
    use serde_json::Value;
    use std::env;
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct MockLiveAsrExecutor {
        prewarm_calls: AtomicUsize,
        transcribe_calls: AtomicUsize,
        sleep_ms: u64,
    }

    impl LiveAsrExecutor for MockLiveAsrExecutor {
        fn prewarm(&self) -> Result<(), String> {
            self.prewarm_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn transcribe(&self, request: &LiveAsrRequest) -> Result<String, String> {
            self.transcribe_calls.fetch_add(1, Ordering::Relaxed);
            let audio_path = request
                .audio_input
                .as_path()
                .ok_or_else(|| "mock executor requires path-backed input".to_string())?;
            if self.sleep_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.sleep_ms));
            }
            Ok(format!("ok:{}", audio_path.display()))
        }
    }

    struct NoopCaptureSink;

    impl CaptureSink for NoopCaptureSink {
        fn on_chunk(&mut self, _chunk: CaptureChunk) -> Result<(), String> {
            Ok(())
        }

        fn on_event(&mut self, _event: CaptureEvent) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn asr_backend_parse_accepts_current_and_legacy_labels() {
        assert!(matches!(
            AsrBackend::parse("whispercpp").unwrap(),
            AsrBackend::WhisperCpp
        ));
        assert!(matches!(
            AsrBackend::parse("whisper-rs").unwrap(),
            AsrBackend::WhisperCpp
        ));
        assert!(matches!(
            AsrBackend::parse("whisperkit").unwrap(),
            AsrBackend::WhisperKit
        ));
        assert!(matches!(
            AsrBackend::parse("moonshine").unwrap(),
            AsrBackend::Moonshine
        ));
    }

    #[test]
    fn channel_mode_parse_accepts_mixed_fallback() {
        assert!(matches!(
            ChannelMode::parse("mixed-fallback").unwrap(),
            ChannelMode::MixedFallback
        ));
    }

    #[test]
    fn help_text_documents_live_chunk_contract_flags() {
        assert!(HELP_TEXT.contains("--live-chunked"));
        assert!(HELP_TEXT.contains("--live-stream"));
        assert!(HELP_TEXT.contains("--chunk-window-ms"));
        assert!(HELP_TEXT.contains("--chunk-stride-ms"));
        assert!(HELP_TEXT.contains("--chunk-queue-cap"));
        assert!(HELP_TEXT.contains("--live-asr-workers"));
        assert!(HELP_TEXT.contains("--keep-temp-audio"));
        assert!(HELP_TEXT.contains("--disable-adaptive-backpressure"));
    }

    #[test]
    fn help_text_documents_runtime_mode_taxonomy() {
        assert!(HELP_TEXT.contains("Runtime mode taxonomy"));
        assert!(HELP_TEXT.contains("representative-offline"));
        assert!(HELP_TEXT.contains("representative-chunked"));
        assert!(HELP_TEXT.contains("live-stream"));
    }

    #[test]
    fn help_text_includes_recordit_migration_guidance() {
        assert!(HELP_TEXT.contains("Migration guidance"));
        assert!(HELP_TEXT.contains("recordit run --mode live"));
        assert!(HELP_TEXT.contains("transcribe-live` remains stable"));
    }

    #[test]
    fn runtime_mode_compatibility_matrix_includes_live_stream_implemented_row() {
        let matrix = runtime_mode_compatibility_matrix();
        assert_eq!(matrix.len(), 3);
        assert!(matrix
            .iter()
            .any(|row| row.taxonomy_mode == "live-stream" && row.status == "implemented"));
    }

    #[test]
    fn runtime_execution_branch_defaults_to_representative_offline() {
        let config = TranscribeConfig::default();
        assert_eq!(
            select_runtime_execution_branch(&config),
            RuntimeExecutionBranch::RepresentativeOffline
        );
    }

    #[test]
    fn runtime_execution_branch_selects_representative_chunked_when_enabled() {
        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        assert_eq!(
            select_runtime_execution_branch(&config),
            RuntimeExecutionBranch::RepresentativeChunked
        );
    }

    #[test]
    fn runtime_execution_branch_prefers_live_stream_over_chunked() {
        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        config.live_stream = true;
        assert_eq!(
            select_runtime_execution_branch(&config),
            RuntimeExecutionBranch::LiveStream
        );
    }

    #[test]
    fn live_stream_vad_threshold_mapping_stays_in_scheduler_calibrated_range() {
        assert_eq!(live_stream_vad_thresholds_per_mille(0.50), (40, 20));
        assert_eq!(live_stream_vad_thresholds_per_mille(0.25), (20, 10));
        assert_eq!(live_stream_vad_thresholds_per_mille(1.00), (80, 40));
        assert_eq!(live_stream_vad_thresholds_per_mille(0.0), (1, 1));
    }

    #[test]
    fn parse_rejects_chunk_overrides_without_live_chunked() {
        let args = vec![
            "--chunk-window-ms".to_string(),
            "5000".to_string(),
            "--asr-model".to_string(),
            "artifacts/bench/models/whispercpp/ggml-tiny.en.bin".to_string(),
        ];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("require `--live-chunked` or `--live-stream`")),
        }
    }

    #[test]
    fn parse_rejects_live_chunked_with_replay() {
        let args = vec![
            "--live-chunked".to_string(),
            "--replay-jsonl".to_string(),
            "artifacts/transcribe-live.runtime.jsonl".to_string(),
        ];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("cannot be combined with `--replay-jsonl`")),
        }
    }

    #[test]
    fn parse_rejects_live_stream_with_replay() {
        let args = vec![
            "--live-stream".to_string(),
            "--replay-jsonl".to_string(),
            "artifacts/transcribe-live.runtime.jsonl".to_string(),
        ];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("cannot be combined with `--replay-jsonl`")),
        }
    }

    #[test]
    fn parse_accepts_live_stream_with_preflight() {
        let args = vec!["--live-stream".to_string(), "--preflight".to_string()];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config"),
            ParseOutcome::Config(config) => {
                assert!(config.preflight);
                assert!(config.live_stream);
                assert_eq!(config.runtime_mode_label(), "live-stream");
                assert_eq!(config.runtime_mode_selector_label(), "--live-stream");
            }
        }
    }

    #[test]
    fn parse_accepts_live_chunked_with_preflight() {
        let args = vec!["--live-chunked".to_string(), "--preflight".to_string()];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config"),
            ParseOutcome::Config(config) => {
                assert!(config.preflight);
                assert!(config.live_chunked);
                assert_eq!(config.runtime_mode_label(), "live-chunked");
                assert_eq!(config.runtime_mode_selector_label(), "--live-chunked");
            }
        }
    }

    #[test]
    fn runtime_mode_compatibility_matrix_marks_live_selectors_preflight_compatible() {
        let matrix = runtime_mode_compatibility_matrix();
        assert!(matrix
            .iter()
            .any(|row| row.selector == "--live-stream" && row.preflight_compat == "compatible"));
        assert!(matrix
            .iter()
            .any(|row| row.selector == "--live-chunked" && row.preflight_compat == "compatible"));
    }

    #[test]
    fn parse_rejects_live_stream_with_live_chunked() {
        let args = vec!["--live-stream".to_string(), "--live-chunked".to_string()];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("cannot be combined with `--live-chunked`")),
        }
    }

    #[test]
    fn parse_accepts_live_stream_runtime_entrypoint() {
        let args = vec!["--live-stream".to_string()];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_stream);
                assert_eq!(config.runtime_mode_label(), "live-stream");
                assert_eq!(config.runtime_mode_taxonomy_label(), "live-stream");
                assert_eq!(config.runtime_mode_selector_label(), "--live-stream");
                assert_eq!(config.runtime_mode_status_label(), "implemented");
            }
        }
    }

    #[test]
    fn parse_accepts_model_doctor_with_live_stream() {
        let args = vec!["--live-stream".to_string(), "--model-doctor".to_string()];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_stream);
                assert!(config.model_doctor);
                assert_eq!(config.runtime_mode_label(), "live-stream");
                assert_eq!(config.runtime_mode_selector_label(), "--live-stream");
            }
        }
    }

    #[test]
    fn parse_accepts_live_stream_chunk_tuning_values() {
        let args = vec![
            "--live-stream".to_string(),
            "--chunk-window-ms".to_string(),
            "5000".to_string(),
            "--chunk-stride-ms".to_string(),
            "1500".to_string(),
            "--chunk-queue-cap".to_string(),
            "8".to_string(),
        ];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_stream);
                assert_eq!(config.chunk_window_ms, 5000);
                assert_eq!(config.chunk_stride_ms, 1500);
                assert_eq!(config.chunk_queue_cap, 8);
            }
        }
    }

    #[test]
    fn parse_accepts_live_worker_pool_tuning_flags() {
        let args = vec![
            "--live-stream".to_string(),
            "--live-asr-workers".to_string(),
            "3".to_string(),
            "--keep-temp-audio".to_string(),
        ];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_stream);
                assert_eq!(config.live_asr_workers, 3);
                assert!(config.keep_temp_audio);
            }
        }
    }

    #[test]
    fn parse_accepts_live_kill_switch_flag() {
        let args = vec![
            "--live-stream".to_string(),
            "--disable-adaptive-backpressure".to_string(),
        ];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_stream);
                assert!(!config.adaptive_backpressure_enabled);
            }
        }
    }

    #[test]
    fn parse_rejects_kill_switch_without_live_mode() {
        let args = vec!["--disable-adaptive-backpressure".to_string()];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("requires `--live-chunked` or `--live-stream`")),
        }
    }

    #[test]
    fn parse_accepts_live_chunked_contract_values() {
        let args = vec!["--live-chunked".to_string()];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_chunked);
                assert_eq!(config.chunk_window_ms, 2000);
                assert_eq!(config.chunk_stride_ms, 500);
                assert_eq!(config.chunk_queue_cap, 4);
                assert_eq!(config.runtime_mode_label(), "live-chunked");
                assert_eq!(
                    config.runtime_mode_taxonomy_label(),
                    "representative-chunked"
                );
                assert_eq!(config.runtime_mode_selector_label(), "--live-chunked");
            }
        }
    }

    #[test]
    fn parse_defaults_to_representative_offline_taxonomy() {
        match parse_args_from(Vec::<String>::new().into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert_eq!(config.runtime_mode_label(), "representative-offline");
                assert_eq!(
                    config.runtime_mode_taxonomy_label(),
                    "representative-offline"
                );
                assert_eq!(config.runtime_mode_selector_label(), "<default>");
            }
        }
    }

    #[test]
    fn rolling_chunk_scheduler_uses_2s_window_and_0_5s_stride() {
        let windows = build_rolling_chunk_windows(0, 5_000, 2_000, 500);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(
            observed,
            vec![
                (0, 2_000, 0),
                (500, 2_500, 1_500),
                (1_000, 3_000, 1_500),
                (1_500, 3_500, 1_500),
                (2_000, 4_000, 1_500),
                (2_500, 4_500, 1_500),
                (3_000, 5_000, 1_500),
            ]
        );
    }

    #[test]
    fn rolling_chunk_scheduler_aligns_last_window_to_session_end() {
        let windows = build_rolling_chunk_windows(0, 2_300, 2_000, 500);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(observed, vec![(0, 2_000, 0), (300, 2_300, 1_700)]);
    }

    #[test]
    fn rolling_chunk_scheduler_handles_short_sessions_with_single_window() {
        let windows = build_rolling_chunk_windows(0, 1_200, 2_000, 500);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(observed, vec![(0, 1_200, 0)]);
    }

    #[test]
    fn live_chunked_events_use_deterministic_chunk_segment_ids() {
        let vad_boundaries = vec![VadBoundary {
            id: 0,
            start_ms: 0,
            end_ms: 10_000,
            source: "energy_threshold",
        }];

        let events = build_transcript_events(
            "alpha beta gamma delta epsilon zeta eta theta",
            &vad_boundaries,
            "mic",
            "mic",
            true,
            2_000,
            500,
        );
        let finals = events
            .iter()
            .filter(|event| event.event_type == "final")
            .collect::<Vec<_>>();

        assert_eq!(finals.len(), 17);
        assert_eq!(finals[0].segment_id, "mic-chunk-0000-0-2000");
        assert_eq!(finals[0].start_ms, 0);
        assert_eq!(finals[0].end_ms, 2_000);
        assert_eq!(finals[1].segment_id, "mic-chunk-0001-500-2500");
        assert_eq!(finals[16].segment_id, "mic-chunk-0016-8000-10000");
    }

    #[test]
    fn parse_rejects_model_doctor_with_replay() {
        let args = vec![
            "--model-doctor".to_string(),
            "--replay-jsonl".to_string(),
            "artifacts/transcribe-live.runtime.jsonl".to_string(),
        ];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("`--model-doctor` cannot be combined with `--replay-jsonl`")),
        }
    }

    #[test]
    fn parse_rejects_model_doctor_with_preflight() {
        let args = vec!["--model-doctor".to_string(), "--preflight".to_string()];
        match parse_args_from(args.into_iter()) {
            Ok(_) => panic!("expected parse failure"),
            Err(err) => assert!(err
                .to_string()
                .contains("`--model-doctor` cannot be combined with `--preflight`")),
        }
    }

    #[test]
    fn cleanup_content_parser_accepts_whitespace_after_colon() {
        let payload = "{\"choices\":[{\"message\":{\"content\": \"cleaned local segment\"}}]}";
        let parsed = super::cleanup_content_from_response(payload);
        assert_eq!(parsed.as_deref(), Some("cleaned local segment"));
    }

    #[test]
    fn trust_notice_parser_reads_replay_context() {
        let line = "{\"event_type\":\"trust_notice\",\"channel\":\"control\",\"code\":\"mode_degradation\",\"severity\":\"warn\",\"cause\":\"requested mixed-fallback but input had 1 channel\",\"impact\":\"channel attribution reduced\",\"guidance\":\"use stereo input\"}";
        let notice = parse_replay_trust_notice(line, 1).unwrap().unwrap();
        assert_eq!(notice.code, "mode_degradation");
        assert_eq!(notice.severity, "warn");
        assert_eq!(notice.impact, "channel attribution reduced");
    }

    #[test]
    fn replay_parser_preserves_source_lineage_for_reconciled_events() {
        let line = "{\"event_type\":\"reconciled_final\",\"channel\":\"mic\",\"segment_id\":\"mic-reconciled-0\",\"source_final_segment_id\":\"mic-chunk-0000\",\"start_ms\":0,\"end_ms\":2000,\"text\":\"hello\"}";
        let parsed = parse_replay_transcript_event(line, 1).unwrap().unwrap();
        assert_eq!(parsed.event_type, "reconciled_final");
        assert_eq!(
            parsed.source_final_segment_id.as_deref(),
            Some("mic-chunk-0000")
        );
    }

    #[test]
    fn replay_parser_ignores_non_transcript_control_events() {
        let line = "{\"event_type\":\"chunk_queue\",\"channel\":\"control\",\"submitted\":4}";
        let parsed = parse_replay_transcript_event(line, 1).unwrap();
        assert!(parsed.is_none());
    }

    #[test]
    fn replay_parser_reports_transcript_payload_mismatch_with_line_context() {
        let line =
            "{\"event_type\":\"partial\",\"channel\":\"mic\",\"segment_id\":\"mic-chunk-0000\"}";
        let err = parse_replay_transcript_event(line, 42).unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("invalid replay line 42"));
        assert!(rendered.contains("[payload_mismatch]"));
        assert!(rendered.contains("event_type `partial` payload mismatch"));
        assert!(rendered.contains("missing field"));
    }

    #[test]
    fn replay_parser_reports_trust_notice_payload_mismatch_with_line_context() {
        let line = "{\"event_type\":\"trust_notice\",\"channel\":\"control\",\"code\":\"mode_degradation\"}";
        let err = parse_replay_trust_notice(line, 7).unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("invalid replay line 7"));
        assert!(rendered.contains("[payload_mismatch]"));
        assert!(rendered.contains("event_type `trust_notice` payload mismatch"));
    }

    #[test]
    fn replay_parser_rejects_oversized_line_with_reason_category() {
        let oversized = "x".repeat(REPLAY_JSONL_MAX_LINE_BYTES + 1);
        let line = format!(
            "{{\"event_type\":\"partial\",\"segment_id\":\"s\",\"start_ms\":0,\"end_ms\":1,\"text\":\"{oversized}\"}}"
        );
        let err = parse_replay_transcript_event(&line, 9).unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("invalid replay line 9"));
        assert!(rendered.contains("[line_too_large]"));
    }

    #[test]
    fn replay_parser_rejects_oversized_transcript_text_with_reason_category() {
        let oversized_text = "x".repeat(REPLAY_TRANSCRIPT_TEXT_MAX_BYTES + 1);
        let line = format!(
            "{{\"event_type\":\"partial\",\"segment_id\":\"s\",\"start_ms\":0,\"end_ms\":1,\"text\":\"{oversized_text}\"}}"
        );
        let err = parse_replay_transcript_event(&line, 11).unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("invalid replay line 11"));
        assert!(rendered.contains("[text_too_large]"));
    }

    #[test]
    fn trust_notice_builder_emits_mode_and_cleanup_notices() {
        let config = TranscribeConfig::default();
        let mut cleanup = CleanupQueueTelemetry::disabled(&config);
        let chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        cleanup.enabled = true;
        cleanup.dropped_queue_full = 1;
        cleanup.failed = 1;
        cleanup.pending = 1;
        cleanup.drain_completed = false;

        let notices = build_trust_notices(
            ChannelMode::MixedFallback,
            ChannelMode::Mixed,
            &[ModeDegradationEvent {
                code: "fallback_to_mixed",
                detail: "requested mixed-fallback but input had 1 channel".to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );

        assert!(notices
            .iter()
            .any(|notice| notice.code == "mode_degradation"));
        assert!(notices
            .iter()
            .any(|notice| notice.code == "cleanup_queue_drop"));
        assert!(notices
            .iter()
            .any(|notice| notice.code == "cleanup_processing_failure"));
        assert!(notices
            .iter()
            .any(|notice| notice.code == "cleanup_drain_incomplete"));
    }

    #[test]
    fn trust_notice_builder_emits_continuity_notice_for_recovered_interruptions() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: "live_capture_interruption_recovered",
                detail: "near-live capture recovered from 2 stream interruption restart(s)"
                    .to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );

        assert!(notices
            .iter()
            .any(|notice| notice.code == "continuity_recovered_with_gaps"));
    }

    #[test]
    fn trust_notice_builder_emits_continuity_unverified_notice_with_guidance() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE,
                detail: "continuity telemetry unavailable for this session".to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );

        let notice = notices
            .iter()
            .find(|notice| notice.code == "continuity_unverified")
            .expect("expected continuity_unverified trust notice");
        assert_eq!(notice.severity, "warn");
        assert!(notice
            .guidance
            .contains("Ensure capture telemetry is writable/readable"));
    }

    #[test]
    fn trust_notice_builder_emits_capture_transport_degraded_notice() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE,
                detail:
                    "near-live capture transport reported degradation source(s): queue_full_drops"
                        .to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );

        let notice = notices
            .iter()
            .find(|notice| notice.code == "capture_transport_degraded")
            .expect("expected capture_transport_degraded trust notice");
        assert_eq!(notice.severity, "warn");
        assert!(notice.impact.contains("transport"));
    }

    #[test]
    fn trust_notice_builder_emits_chunk_queue_backpressure_notice() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let mut chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        chunk_queue.enabled = true;
        chunk_queue.max_queue = 2;
        chunk_queue.dropped_oldest = 2;
        chunk_queue.submitted = 6;
        chunk_queue.processed = 4;
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE,
                detail: "near-live ASR chunk queue dropped 2 oldest task(s) under pressure"
                    .to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );
        let notice = notices
            .iter()
            .find(|notice| notice.code == "chunk_queue_backpressure")
            .expect("expected chunk_queue_backpressure trust notice");
        assert_eq!(notice.severity, "warn");
        assert!(notice.guidance.contains("--chunk-queue-cap"));
    }

    #[test]
    fn trust_notice_builder_emits_severe_chunk_queue_backpressure_notice() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let mut chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        chunk_queue.enabled = true;
        chunk_queue.max_queue = 2;
        chunk_queue.submitted = 6;
        chunk_queue.dropped_oldest = 3;
        chunk_queue.high_water = 2;
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: LIVE_CHUNK_QUEUE_BACKPRESSURE_SEVERE_CODE,
                detail: "near-live ASR queue entered severe backpressure".to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );
        let severe = notices
            .iter()
            .find(|notice| notice.code == "chunk_queue_backpressure_severe")
            .expect("expected severe queue backpressure notice");
        assert_eq!(severe.severity, "error");
    }

    #[test]
    fn chunk_queue_backpressure_severity_thresholds_detect_persistent_pressure() {
        let mut mild = LiveChunkQueueTelemetry::enabled(4);
        mild.submitted = 10;
        mild.dropped_oldest = 2;
        mild.high_water = 3;
        assert!(!chunk_queue_backpressure_is_severe(&mild));

        let mut severe = LiveChunkQueueTelemetry::enabled(4);
        severe.submitted = 9;
        severe.dropped_oldest = 3;
        severe.high_water = 4;
        assert!(chunk_queue_backpressure_is_severe(&severe));
    }

    #[test]
    fn chunk_queue_backpressure_is_severe_trips_on_drop_ratio_without_full_queue() {
        let mut ratio_only = LiveChunkQueueTelemetry::enabled(10);
        ratio_only.submitted = 9;
        ratio_only.dropped_oldest = 3;
        ratio_only.high_water = 4;

        assert!(chunk_queue_backpressure_is_severe(&ratio_only));
    }

    #[test]
    fn trust_notice_builder_emits_reconciliation_notice() {
        let config = TranscribeConfig::default();
        let cleanup = CleanupQueueTelemetry::disabled(&config);
        let chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        let notices = build_trust_notices(
            ChannelMode::Separate,
            ChannelMode::Separate,
            &[ModeDegradationEvent {
                code: RECONCILIATION_APPLIED_CODE,
                detail: "post-session reconciliation emitted reconciled_final events".to_string(),
            }],
            &cleanup,
            &chunk_queue,
        );
        let notice = notices
            .iter()
            .find(|notice| notice.code == "reconciliation_applied")
            .expect("expected reconciliation_applied trust notice");
        assert_eq!(notice.severity, "warn");
        assert!(notice.impact.contains("canonical completeness"));
        assert!(notice.guidance.contains("reconciled_final"));
        assert!(notice.guidance.contains("reconciliation_matrix"));
    }

    #[test]
    fn reconciliation_matrix_triggers_on_queue_drop_continuity_and_shutdown_flush() {
        let matrix = build_reconciliation_matrix(
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 2_000,
                source: "shutdown_flush",
            }],
            &[
                ModeDegradationEvent {
                    code: LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE,
                    detail: "dropped oldest chunk work under pressure".to_string(),
                },
                ModeDegradationEvent {
                    code: LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE,
                    detail: "capture recovered with restart gaps".to_string(),
                },
            ],
        );

        assert!(matrix.required);
        let codes = matrix
            .triggers
            .iter()
            .map(|trigger| trigger.code)
            .collect::<Vec<_>>();
        assert!(codes.contains(&"chunk_queue_drop_oldest"));
        assert!(codes.contains(&"continuity_recovered_with_gaps"));
        assert!(codes.contains(&"shutdown_flush_boundary"));
    }

    #[test]
    fn reconciliation_matrix_is_not_required_without_triggers() {
        let matrix = build_reconciliation_matrix(
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 2_000,
                source: "energy_threshold",
            }],
            &[],
        );

        assert!(!matrix.required);
        assert!(matrix.triggers.is_empty());
    }

    #[test]
    fn reconciliation_matrix_triggers_on_capture_transport_and_callback_degradation() {
        let matrix = build_reconciliation_matrix(
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 2_000,
                source: "energy_threshold",
            }],
            &[
                ModeDegradationEvent {
                    code: LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE,
                    detail: "queue pressure".to_string(),
                },
                ModeDegradationEvent {
                    code: LIVE_CAPTURE_CALLBACK_CONTRACT_DEGRADED_CODE,
                    detail: "callback violations".to_string(),
                },
            ],
        );
        let codes = matrix
            .triggers
            .iter()
            .map(|trigger| trigger.code)
            .collect::<Vec<_>>();
        assert!(codes.contains(&"capture_transport_degraded"));
        assert!(codes.contains(&"capture_callback_contract_degraded"));
    }

    #[test]
    fn live_chunk_queue_drops_oldest_queued_tasks_under_pressure() {
        let result = run_live_chunk_queue(
            vec![
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "s0-mic".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "a".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "system".to_string(),
                    segment_id: "s0-system".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "b".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "mic".to_string(),
                    segment_id: "s1-mic".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "c".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "system".to_string(),
                    segment_id: "s1-system".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "d".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 2,
                    channel: "mic".to_string(),
                    segment_id: "s2-mic".to_string(),
                    start_ms: 2_000,
                    end_ms: 6_000,
                    text: "e".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 2,
                    channel: "system".to_string(),
                    segment_id: "s2-system".to_string(),
                    start_ms: 2_000,
                    end_ms: 6_000,
                    text: "f".to_string(),
                    source_final_segment_id: None,
                },
            ],
            2,
            1_000,
        );

        assert_eq!(result.telemetry.submitted, 6);
        assert_eq!(result.telemetry.dropped_oldest, 2);
        assert_eq!(result.telemetry.processed, 4);
        assert_eq!(result.telemetry.max_queue, 2);
        assert_eq!(result.telemetry.high_water, 2);
        assert!(result.telemetry.drain_completed);
        assert_eq!(result.telemetry.lag_sample_count, 4);
        assert_eq!(result.telemetry.lag_p50_ms, 1_000);
        assert_eq!(result.telemetry.lag_p95_ms, 2_000);
        assert_eq!(result.telemetry.lag_max_ms, 2_000);
        let final_ids = result
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .map(|event| event.segment_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            final_ids,
            vec![
                "s0-mic".to_string(),
                "s1-mic".to_string(),
                "s2-mic".to_string(),
                "s2-system".to_string(),
            ]
        );
    }

    #[test]
    fn asr_work_priority_drops_lower_classes_before_final_integrity_work() {
        let result = run_live_chunk_queue(
            vec![
                AsrWorkItem {
                    class: AsrWorkClass::Partial,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "partial-a".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "preview-a".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "final-a".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "final-a".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Reconcile,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "reconcile-a".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "reconciled-a".to_string(),
                    source_final_segment_id: Some("final-a".to_string()),
                },
                AsrWorkItem {
                    class: AsrWorkClass::Partial,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "partial-b".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "preview-b".to_string(),
                    source_final_segment_id: None,
                },
            ],
            2,
            1_000,
        );

        assert_eq!(result.telemetry.submitted, 4);
        assert_eq!(result.telemetry.dropped_oldest, 2);

        let emitted_ids = result
            .events
            .iter()
            .map(|event| event.segment_id.clone())
            .collect::<Vec<_>>();
        assert!(emitted_ids.contains(&"final-a".to_string()));
        assert!(emitted_ids.contains(&"partial-b".to_string()));
        assert!(!emitted_ids.contains(&"partial-a".to_string()));
        assert!(!emitted_ids.contains(&"reconcile-a".to_string()));

        let final_events = result
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .map(|event| event.segment_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(final_events, vec!["final-a".to_string()]);
    }

    #[test]
    fn live_chunk_scheduler_emits_one_final_per_vad_boundary() {
        let result = build_live_chunked_events_with_queue(
            &[
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "alpha beta gamma delta epsilon zeta".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "one two three four five six".to_string(),
                },
            ],
            &[
                VadBoundary {
                    id: 0,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
                VadBoundary {
                    id: 1,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "shutdown_flush",
                },
            ],
            2_000,
            1_000,
            8,
        );

        let finals = result
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .collect::<Vec<_>>();
        assert_eq!(finals.len(), 4);
        assert_eq!(finals[0].segment_id, "mic-segment-0000-0-1200");
        assert_eq!(finals[1].segment_id, "system-segment-0000-0-1200");
        assert_eq!(finals[2].segment_id, "mic-segment-0001-1700-2800");
        assert_eq!(finals[3].segment_id, "system-segment-0001-1700-2800");
        assert_eq!(result.telemetry.submitted, 4);
        assert_eq!(result.telemetry.processed, 4);
    }

    #[test]
    fn live_chunk_scheduler_canonicalizes_boundary_and_channel_order_for_ids() {
        let shuffled = build_live_chunked_events_with_queue(
            &[
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "one two three four".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "alpha beta gamma delta".to_string(),
                },
            ],
            &[
                VadBoundary {
                    id: 9,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "shutdown_flush",
                },
                VadBoundary {
                    id: 1,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
            ],
            2_000,
            500,
            8,
        );

        let canonical = build_live_chunked_events_with_queue(
            &[
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "alpha beta gamma delta".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "one two three four".to_string(),
                },
            ],
            &[
                VadBoundary {
                    id: 1,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
                VadBoundary {
                    id: 9,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "shutdown_flush",
                },
            ],
            2_000,
            500,
            8,
        );

        let final_ids = shuffled
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .map(|event| event.segment_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            final_ids,
            vec![
                "mic-segment-0000-0-1200".to_string(),
                "system-segment-0000-0-1200".to_string(),
                "mic-segment-0001-1700-2800".to_string(),
                "system-segment-0001-1700-2800".to_string(),
            ]
        );
        let shuffled_timeline = shuffled
            .events
            .iter()
            .map(|event| {
                (
                    event.event_type,
                    event.channel.clone(),
                    event.segment_id.clone(),
                    event.start_ms,
                    event.end_ms,
                    event.text.clone(),
                    event.source_final_segment_id.clone(),
                )
            })
            .collect::<Vec<_>>();
        let canonical_timeline = canonical
            .events
            .iter()
            .map(|event| {
                (
                    event.event_type,
                    event.channel.clone(),
                    event.segment_id.clone(),
                    event.start_ms,
                    event.end_ms,
                    event.text.clone(),
                    event.source_final_segment_id.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(shuffled_timeline, canonical_timeline);
    }

    #[test]
    fn live_chunk_scheduler_emits_stride_partial_windows_before_boundary_close() {
        let result = build_live_chunked_events_with_queue(
            &[super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "alpha beta gamma delta epsilon zeta eta theta".to_string(),
            }],
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 2_600,
                source: "energy_threshold",
            }],
            2_000,
            500,
            8,
        );

        let finals = result
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .collect::<Vec<_>>();
        let partial_ids = result
            .events
            .iter()
            .filter(|event| event.event_type == "partial")
            .map(|event| event.segment_id.clone())
            .collect::<Vec<_>>();

        assert_eq!(finals.len(), 1);
        assert_eq!(finals[0].segment_id, "mic-segment-0000-0-2600");
        assert!(partial_ids
            .iter()
            .any(|id| id == "mic-segment-0000-partial-0000-0-2000"));
        assert!(partial_ids
            .iter()
            .any(|id| id == "mic-segment-0000-partial-0001-500-2500"));
        assert!(partial_ids.iter().any(|id| id == "mic-segment-0000-0-2600"));
    }

    #[test]
    fn live_chunk_scheduler_normalizes_unsorted_boundary_ids_for_deterministic_segment_ids() {
        let result = build_live_chunked_events_with_queue(
            &[super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "alpha beta gamma delta epsilon".to_string(),
            }],
            &[
                VadBoundary {
                    id: 7,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "shutdown_flush",
                },
                VadBoundary {
                    id: 2,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
            ],
            2_000,
            1_000,
            8,
        );

        let finals = result
            .events
            .iter()
            .filter(|event| event.event_type == "final")
            .collect::<Vec<_>>();
        assert_eq!(finals.len(), 2);
        assert_eq!(finals[0].start_ms, 0);
        assert_eq!(finals[0].end_ms, 1_200);
        assert_eq!(finals[0].segment_id, "mic-segment-0000-0-1200");
        assert_eq!(finals[1].start_ms, 1_700);
        assert_eq!(finals[1].end_ms, 2_800);
        assert_eq!(finals[1].segment_id, "mic-segment-0001-1700-2800");
    }

    #[test]
    fn continuity_events_use_capture_restart_count_when_available() {
        let temp_dir = write_temp_dir("recordit-live-continuity-recovered");
        let input_wav = temp_dir.join("capture.wav");
        File::create(&input_wav).unwrap();
        let telemetry_path = temp_dir.join("capture.telemetry.json");
        fs::write(&telemetry_path, "{\"restart_count\":2}").unwrap();

        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        config.input_wav = input_wav.clone();

        let events = collect_live_capture_continuity_events(&config);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, "live_capture_interruption_recovered");
        assert!(events[0]
            .detail
            .contains("2 stream interruption restart(s)"));

        let _ = fs::remove_file(input_wav);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn continuity_events_warn_when_capture_telemetry_missing() {
        let temp_dir = write_temp_dir("recordit-live-continuity-missing");
        let input_wav = temp_dir.join("capture.wav");
        File::create(&input_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        config.input_wav = input_wav.clone();

        let events = collect_live_capture_continuity_events(&config);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, "live_capture_continuity_unverified");
        assert!(events[0].detail.contains("could not be verified"));

        let _ = fs::remove_file(input_wav);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn continuity_events_include_transport_and_callback_signals() {
        let temp_dir = write_temp_dir("recordit-live-continuity-degradation-sources");
        let input_wav = temp_dir.join("capture.wav");
        File::create(&input_wav).unwrap();
        let telemetry_path = temp_dir.join("capture.telemetry.json");
        fs::write(
            &telemetry_path,
            concat!(
                "{\n",
                "  \"restart_count\": 0,\n",
                "  \"degradation_events\": [\n",
                "    {\"source\":\"queue_full_drops\",\"count\":2},\n",
                "    {\"source\":\"missing_format_description\",\"count\":1}\n",
                "  ]\n",
                "}\n"
            ),
        )
        .unwrap();

        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        config.input_wav = input_wav.clone();

        let events = collect_live_capture_continuity_events(&config);
        let codes = events.iter().map(|event| event.code).collect::<Vec<_>>();
        assert!(codes.contains(&LIVE_CAPTURE_TRANSPORT_DEGRADED_CODE));
        assert!(codes.contains(&LIVE_CAPTURE_CALLBACK_CONTRACT_DEGRADED_CODE));
        assert!(!codes.contains(&LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE));

        let _ = fs::remove_file(input_wav);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn continuity_events_apply_to_live_stream_mode_without_live_chunked_flag() {
        let temp_dir = write_temp_dir("recordit-live-stream-continuity-sources");
        let input_wav = temp_dir.join("capture.wav");
        File::create(&input_wav).unwrap();
        let telemetry_path = temp_dir.join("capture.telemetry.json");
        fs::write(&telemetry_path, "{\"restart_count\":1}").unwrap();

        let mut config = TranscribeConfig::default();
        config.live_stream = true;
        config.input_wav = input_wav.clone();

        let events = collect_live_capture_continuity_events(&config);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE);
        assert!(events[0].detail.contains("restart(s)"));

        let _ = fs::remove_file(input_wav);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_output_events_convert_to_live_transcript_contract_events() {
        let config = TranscribeConfig::default();
        let runtime_events = vec![
            RuntimeOutputEvent::AsrCompleted {
                emit_seq: 1,
                result: RuntimeAsrResult {
                    job: RuntimeAsrJobSpec {
                        emit_seq: 1,
                        job_class: RuntimeAsrJobClass::Partial,
                        channel: "microphone".to_string(),
                        segment_id: "seg-a".to_string(),
                        segment_ord: 1,
                        window_ord: 1,
                        start_ms: 0,
                        end_ms: 500,
                    },
                    transcript_text: "partial text".to_string(),
                },
            },
            RuntimeOutputEvent::AsrCompleted {
                emit_seq: 2,
                result: RuntimeAsrResult {
                    job: RuntimeAsrJobSpec {
                        emit_seq: 2,
                        job_class: RuntimeAsrJobClass::Final,
                        channel: "system-audio".to_string(),
                        segment_id: "seg-b".to_string(),
                        segment_ord: 2,
                        window_ord: 2,
                        start_ms: 500,
                        end_ms: 1_000,
                    },
                    transcript_text: "final text".to_string(),
                },
            },
            RuntimeOutputEvent::AsrCompleted {
                emit_seq: 3,
                result: RuntimeAsrResult {
                    job: RuntimeAsrJobSpec {
                        emit_seq: 3,
                        job_class: RuntimeAsrJobClass::Reconcile,
                        channel: "microphone".to_string(),
                        segment_id: "seg-c".to_string(),
                        segment_ord: 3,
                        window_ord: 3,
                        start_ms: 1_000,
                        end_ms: 1_400,
                    },
                    transcript_text: "reconciled text".to_string(),
                },
            },
        ];

        let events = transcript_events_from_runtime_output_events(&config, &runtime_events);
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].event_type, "partial");
        assert_eq!(events[0].channel, config.speaker_labels.mic);
        assert_eq!(events[1].event_type, "partial");
        assert_eq!(events[1].channel, config.speaker_labels.system);
        assert_eq!(events[1].segment_id, "seg-b");
        assert_eq!(events[1].start_ms, 500);
        assert_eq!(events[1].end_ms, 750);
        assert_eq!(events[1].text, "final text");
        assert_eq!(events[2].event_type, "final");
        assert_eq!(events[2].channel, config.speaker_labels.system);
        assert_eq!(events[3].event_type, "reconciled_final");
        assert_eq!(events[3].segment_id, "seg-c-reconciled");
        assert_eq!(events[3].source_final_segment_id.as_deref(), Some("seg-c"));
    }

    #[test]
    fn live_stream_chunk_queue_telemetry_maps_runtime_and_pool_counts() {
        let mut config = TranscribeConfig::default();
        config.live_stream = true;
        config.chunk_queue_cap = 3;

        let runtime_summary = LiveRuntimeSummary {
            final_phase: LiveRuntimePhase::Shutdown,
            ready_for_transcripts: true,
            transition_count: 4,
            capture_chunks_seen: 20,
            capture_events_seen: 2,
            asr_jobs_queued: 7,
            asr_results_emitted: 6,
            pending_jobs: 0,
            pending_final_jobs: 0,
            shutdown_abandoned_jobs: 0,
            shutdown_abandoned_final_jobs: 0,
            backpressure_mode: BackpressureMode::Normal,
            backpressure_transitions: Vec::new(),
        };
        let pool = LiveAsrPoolTelemetry {
            prewarm_ok: true,
            submitted: 7,
            enqueued: 6,
            dropped_queue_full: 1,
            processed: 6,
            succeeded: 6,
            failed: 1,
            retry_attempts: 0,
            temp_audio_deleted: 0,
            temp_audio_retained: 0,
        };

        let telemetry = live_stream_chunk_queue_telemetry(&config, &runtime_summary, &pool);
        assert!(telemetry.enabled);
        assert_eq!(telemetry.max_queue, 3);
        assert_eq!(telemetry.submitted, 7);
        assert_eq!(telemetry.enqueued, 6);
        assert_eq!(telemetry.dropped_oldest, 1);
        assert_eq!(telemetry.processed, 6);
        assert_eq!(telemetry.pending, 0);
        assert!(telemetry.drain_completed);
    }

    #[test]
    fn continuity_telemetry_candidates_prefer_out_wav_with_input_fallback() {
        let mut config = TranscribeConfig::default();
        config.live_chunked = true;
        config.input_wav = PathBuf::from("artifacts/live-input.wav");
        config.out_wav = PathBuf::from("artifacts/live-output.wav");

        let candidates = live_capture_telemetry_path_candidates(&config);
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0]
            .to_string_lossy()
            .ends_with("artifacts/live-output.telemetry.json"));
        assert!(candidates[1]
            .to_string_lossy()
            .ends_with("artifacts/live-input.telemetry.json"));
    }

    #[test]
    fn incremental_vad_tracker_requires_min_speech_before_opening_segment() {
        let mut tracker = IncrementalVadTracker::new("mic", 10, 0.5, 200, 200);
        let levels = [0.8, 0.2, 0.7, 0.8, 0.1, 0.1];
        for (idx, level) in levels.into_iter().enumerate() {
            tracker.observe(idx, level);
        }
        let boundaries = tracker.finish(levels.len());
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].channel, "mic");
        assert_eq!(boundaries[0].start_ms, 200);
        assert_eq!(boundaries[0].end_ms, 400);
    }

    #[test]
    fn incremental_vad_tracker_marks_open_tail_with_shutdown_flush_source() {
        let mut tracker = IncrementalVadTracker::new("mic", 10, 0.5, 200, 200);
        let levels = [0.8, 0.8, 0.7, 0.7];
        for (idx, level) in levels.into_iter().enumerate() {
            tracker.observe(idx, level);
        }
        let boundaries = tracker.finish(levels.len());
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].channel, "mic");
        assert_eq!(boundaries[0].start_ms, 0);
        assert_eq!(boundaries[0].end_ms, 400);
        assert_eq!(boundaries[0].source, "shutdown_flush");
    }

    #[test]
    fn per_channel_vad_boundaries_track_channels_independently() {
        let boundaries = detect_per_channel_vad_boundaries(
            &[
                ("mic".to_string(), vec![0.7, 0.8, 0.1, 0.1, 0.0, 0.0]),
                ("system".to_string(), vec![0.0, 0.0, 0.6, 0.7, 0.1, 0.1]),
            ],
            10,
            0.5,
            200,
            200,
        );
        assert_eq!(boundaries.len(), 2);
        assert_eq!(boundaries[0].channel, "mic");
        assert_eq!(boundaries[0].start_ms, 0);
        assert_eq!(boundaries[0].end_ms, 200);
        assert_eq!(boundaries[1].channel, "system");
        assert_eq!(boundaries[1].start_ms, 200);
        assert_eq!(boundaries[1].end_ms, 400);
    }

    #[test]
    fn merge_channel_vad_boundaries_merges_overlaps_and_promotes_shutdown_flush_source() {
        let merged = merge_channel_vad_boundaries(
            &[
                ChannelVadBoundary {
                    channel: "mic".to_string(),
                    start_ms: 100,
                    end_ms: 400,
                    source: "energy_threshold",
                },
                ChannelVadBoundary {
                    channel: "system".to_string(),
                    start_ms: 250,
                    end_ms: 500,
                    source: "shutdown_flush",
                },
                ChannelVadBoundary {
                    channel: "mic".to_string(),
                    start_ms: 700,
                    end_ms: 900,
                    source: "energy_threshold",
                },
                ChannelVadBoundary {
                    channel: "system".to_string(),
                    start_ms: 850,
                    end_ms: 1_000,
                    source: "energy_threshold",
                },
            ],
            1_000,
            2_000,
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, 0);
        assert_eq!(merged[0].start_ms, 100);
        assert_eq!(merged[0].end_ms, 500);
        assert_eq!(merged[0].source, "shutdown_flush");
        assert_eq!(merged[1].id, 1);
        assert_eq!(merged[1].start_ms, 700);
        assert_eq!(merged[1].end_ms, 1_000);
        assert_eq!(merged[1].source, "energy_threshold");
    }

    #[test]
    fn vad_detector_emits_boundary_for_energy_region() {
        let mut levels = vec![0.0; 2_000];
        for level in &mut levels[400..1_200] {
            *level = 0.9;
        }

        let boundaries = detect_vad_boundaries(&levels, 1_000, 0.5, 100, 100);
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].start_ms, 400);
        assert_eq!(boundaries[0].end_ms, 1_200);
        assert_eq!(boundaries[0].source, "energy_threshold");
    }

    #[test]
    fn vad_detector_marks_trailing_speech_with_shutdown_flush_source() {
        let boundaries = detect_vad_boundaries(&vec![0.9; 500], 1_000, 0.5, 100, 100);
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].start_ms, 0);
        assert_eq!(boundaries[0].end_ms, 500);
        assert_eq!(boundaries[0].source, "shutdown_flush");
    }

    #[test]
    fn vad_detector_falls_back_when_no_speech_crosses_threshold() {
        let boundaries = detect_vad_boundaries(&vec![0.01; 500], 1_000, 0.5, 100, 100);
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].start_ms, 0);
        assert_eq!(boundaries[0].end_ms, 500);
        assert_eq!(boundaries[0].source, "fallback_full_audio");
    }

    #[test]
    fn merged_events_sort_deterministically_and_keep_partial_before_final() {
        let events = vec![
            TranscriptEvent {
                event_type: "final",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "sys-final".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "partial",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "mic-partial".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "partial",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "sys-partial".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "mic-final".to_string(),
                source_final_segment_id: None,
            },
        ];
        let ordered = merge_transcript_events(events);
        let ordered_tuples: Vec<(&str, &str)> = ordered
            .iter()
            .map(|event| (event.event_type, event.channel.as_str()))
            .collect();
        assert_eq!(
            ordered_tuples,
            vec![
                ("partial", "mic"),
                ("partial", "system"),
                ("final", "mic"),
                ("final", "system"),
            ]
        );
    }

    #[test]
    fn tty_terminal_render_actions_overwrite_partials_before_stable_lines() {
        let actions = build_terminal_render_actions(
            &[
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-segment-0000".to_string(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-segment-0000".to_string(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: "mic".to_string(),
                    segment_id: "mic-segment-0000".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello world".to_string(),
                    source_final_segment_id: None,
                },
            ],
            TerminalRenderMode::InteractiveTty,
        );

        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].kind, TerminalRenderActionKind::PartialOverwrite);
        assert_eq!(actions[0].line, "[00:00.000-00:00.500] mic ~ hello");
        assert_eq!(actions[1].kind, TerminalRenderActionKind::StableLine);
        assert_eq!(actions[1].line, "[00:00.000-00:01.000] mic: hello world");
    }

    #[test]
    fn non_tty_terminal_render_actions_skip_partials_and_keep_stable_order() {
        let actions = build_terminal_render_actions(
            &merge_transcript_events(vec![
                TranscriptEvent {
                    event_type: "llm_final",
                    channel: "mic".to_string(),
                    segment_id: "mic-0-llm".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello there".to_string(),
                    source_final_segment_id: Some("mic-0".to_string()),
                },
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "reconciled_final",
                    channel: "system".to_string(),
                    segment_id: "system-0-reconciled".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "world reconciled".to_string(),
                    source_final_segment_id: Some("system-0".to_string()),
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello world".to_string(),
                    source_final_segment_id: None,
                },
            ]),
            TerminalRenderMode::DeterministicNonTty,
        );

        let stable_lines = actions
            .iter()
            .map(|action| (action.kind, action.line.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            stable_lines,
            vec![
                (
                    TerminalRenderActionKind::StableLine,
                    "[00:00.000-00:01.000] mic: hello world",
                ),
                (
                    TerminalRenderActionKind::StableLine,
                    "[00:00.000-00:01.000] system: world reconciled [reconciled_final]",
                ),
                (
                    TerminalRenderActionKind::StableLine,
                    "[00:00.000-00:01.000] mic: hello there [llm_final]",
                ),
            ]
        );
    }

    #[test]
    fn live_terminal_render_actions_emit_non_tty_stable_fallback_for_live_mode() {
        let mut config = TranscribeConfig::default();
        config.live_chunked = true;

        let actions = live_terminal_render_actions(
            &config,
            &merge_transcript_events(vec![
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello world".to_string(),
                    source_final_segment_id: None,
                },
            ]),
            TerminalRenderMode::DeterministicNonTty,
        );

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, TerminalRenderActionKind::StableLine);
        assert_eq!(actions[0].line, "[00:00.000-00:01.000] mic: hello world");
    }

    #[test]
    fn live_terminal_render_actions_skip_non_live_modes() {
        let config = TranscribeConfig::default();
        let actions = live_terminal_render_actions(
            &config,
            &[TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 1_000,
                text: "hello world".to_string(),
                source_final_segment_id: None,
            }],
            TerminalRenderMode::DeterministicNonTty,
        );
        assert!(actions.is_empty());
    }

    #[test]
    fn live_close_summary_lines_use_contract_field_order() {
        let mut config = TranscribeConfig::default();
        config.duration_sec = 42;
        config.out_wav = PathBuf::from("artifacts/run.wav");
        config.out_jsonl = PathBuf::from("artifacts/run.jsonl");
        config.out_manifest = PathBuf::from("artifacts/run.manifest.json");

        let report = LiveRunReport {
            generated_at_utc: "2026-03-01T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: PathBuf::from("models/test.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 1_000,
                source: "energy_threshold",
            }],
            events: vec![
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                final_event("mic-0", "mic", "hello world"),
                TranscriptEvent {
                    event_type: "reconciled_final",
                    channel: "mic".to_string(),
                    segment_id: "mic-0-reconciled".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello world".to_string(),
                    source_final_segment_id: Some("mic-0".to_string()),
                },
            ],
            degradation_events: vec![ModeDegradationEvent {
                code: "queue_pressure",
                detail: "drop-oldest path".to_string(),
            }],
            trust_notices: vec![super::TrustNotice {
                code: "chunk_queue_backpressure".to_string(),
                severity: "warn".to_string(),
                cause: "queue pressure".to_string(),
                impact: "latency".to_string(),
                guidance: "raise cap".to_string(),
            }],
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry {
                prewarm_ok: true,
                submitted: 3,
                enqueued: 2,
                dropped_queue_full: 1,
                processed: 2,
                succeeded: 1,
                failed: 2,
                retry_attempts: 0,
                temp_audio_deleted: 1,
                temp_audio_retained: 1,
            },
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue: LiveChunkQueueTelemetry::disabled(&config),
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: PathBuf::from("artifacts/summary.csv"),
            benchmark_runs_csv: PathBuf::from("artifacts/runs.csv"),
        };

        let lines = build_live_close_summary_lines(&config, &report);
        let field_order = lines
            .iter()
            .map(|line| line.split('=').next().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(
            field_order,
            vec![
                "session_status",
                "duration_sec",
                "channel_mode_requested",
                "channel_mode_active",
                "transcript_events",
                "chunk_queue",
                "chunk_lag",
                "trust_notices",
                "degradation_events",
                "cleanup_queue",
                "diagnostics_transport",
                "diagnostics_scratch",
                "diagnostics_backpressure",
                "diagnostics_pump",
                "artifacts",
            ]
        );
        assert!(lines[0].contains("degraded"));
    }

    #[test]
    fn hot_path_diagnostics_builder_covers_all_control_surfaces() {
        let mut config = TranscribeConfig::default();
        config.live_stream = true;
        config.live_asr_workers = 2;

        let events = vec![
            TranscriptEvent {
                event_type: "partial",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 200,
                text: "hel".to_string(),
                source_final_segment_id: None,
            },
            final_event("mic-0", "mic", "hello"),
            final_event("sys-0", "system", "world"),
        ];
        let channel_transcripts = vec![
            super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            },
            super::ChannelTranscriptSummary {
                role: "system",
                label: "system".to_string(),
                text: "world".to_string(),
            },
        ];
        let chunk_queue = LiveChunkQueueTelemetry {
            enabled: true,
            max_queue: 4,
            submitted: 10,
            enqueued: 10,
            dropped_oldest: 3,
            processed: 8,
            pending: 2,
            high_water: 4,
            drain_completed: false,
            lag_sample_count: 0,
            lag_p50_ms: 0,
            lag_p95_ms: 0,
            lag_max_ms: 0,
        };
        let runtime_summary = LiveRuntimeSummary {
            final_phase: LiveRuntimePhase::Shutdown,
            ready_for_transcripts: true,
            transition_count: 4,
            capture_chunks_seen: 20,
            capture_events_seen: 3,
            asr_jobs_queued: 10,
            asr_results_emitted: 8,
            pending_jobs: 2,
            pending_final_jobs: 1,
            shutdown_abandoned_jobs: 0,
            shutdown_abandoned_final_jobs: 0,
            backpressure_mode: BackpressureMode::Pressure,
            backpressure_transitions: vec![BackpressureTransition {
                from_mode: BackpressureMode::Normal,
                to_mode: BackpressureMode::Pressure,
                observed_at_ms: 4_000,
                reason: BackpressureTransitionReason::PendingJobsSustained,
                detail: "entered pressure mode".to_string(),
            }],
        };
        let asr_worker_pool = LiveAsrPoolTelemetry {
            prewarm_ok: true,
            submitted: 10,
            enqueued: 10,
            dropped_queue_full: 2,
            processed: 8,
            succeeded: 7,
            failed: 1,
            retry_attempts: 2,
            temp_audio_retained: 0,
            temp_audio_deleted: 0,
        };

        let diagnostics = build_hot_path_diagnostics(
            &config,
            &events,
            &channel_transcripts,
            &chunk_queue,
            &runtime_summary,
            &asr_worker_pool,
        );

        assert_eq!(diagnostics.transport.path_requests, 0);
        assert_eq!(diagnostics.transport.pcm_window_requests, 10);
        assert_eq!(diagnostics.scratch.worker_scratch_paths_upper_bound, 2);
        assert_eq!(diagnostics.scratch.write_attempts_estimate, 10);
        assert_eq!(diagnostics.scratch.reuse_overwrites_estimate, 8);
        assert!(diagnostics.scratch.retained_for_review_hint);
        assert_eq!(diagnostics.backpressure.mode, BackpressureMode::Pressure);
        assert_eq!(diagnostics.backpressure.transition_count, 1);
        assert_eq!(
            diagnostics.backpressure.last_transition_reason,
            Some(BackpressureTransitionReason::PendingJobsSustained)
        );
        assert_eq!(diagnostics.backpressure.pending_jobs, 2);
        assert_eq!(diagnostics.backpressure.pending_final_jobs, 1);
        assert_eq!(diagnostics.backpressure.channel_snapshots.len(), 2);
        assert_eq!(
            diagnostics
                .backpressure
                .channel_snapshots
                .iter()
                .map(|snapshot| snapshot.pending_estimate)
                .sum::<usize>(),
            2
        );
        assert_eq!(diagnostics.pump.chunk_decisions, 20);
        assert_eq!(diagnostics.pump.forced_capture_event_triggers, 3);
        assert_eq!(diagnostics.pump.forced_shutdown_triggers, 4);
        assert_eq!(diagnostics.pump.forced_decisions, 7);
    }

    #[test]
    fn runtime_failure_breadcrumbs_include_artifact_paths_and_hot_path_counters() {
        let mut config = TranscribeConfig::default();
        config.out_wav = PathBuf::from("artifacts/test.session.wav");
        config.out_jsonl = PathBuf::from("artifacts/test.runtime.jsonl");
        config.out_manifest = PathBuf::from("artifacts/test.runtime.manifest.json");
        let report = LiveRunReport {
            generated_at_utc: "2026-03-01T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: PathBuf::from("models/test.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 1_000,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello")],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry::default(),
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue: LiveChunkQueueTelemetry::disabled(&config),
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics {
                transport: super::TransportInputDiagnostics {
                    path_requests: 0,
                    pcm_window_requests: 4,
                },
                scratch: super::ScratchLifecycleDiagnostics {
                    worker_scratch_paths_upper_bound: 2,
                    write_attempts_estimate: 4,
                    reuse_overwrites_estimate: 2,
                    retained_for_review_hint: false,
                },
                backpressure: super::BackpressureDiagnostics {
                    mode: BackpressureMode::Pressure,
                    transition_count: 1,
                    last_transition_reason: Some(
                        BackpressureTransitionReason::PendingJobsSustained,
                    ),
                    pending_jobs: 0,
                    pending_final_jobs: 0,
                    channel_snapshots: Vec::new(),
                },
                pump: super::PumpCadenceDiagnostics {
                    chunk_decisions: 10,
                    forced_decisions: 6,
                    forced_capture_event_triggers: 2,
                    forced_shutdown_triggers: 4,
                },
            },
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: PathBuf::from("artifacts/summary.csv"),
            benchmark_runs_csv: PathBuf::from("artifacts/runs.csv"),
        };

        let breadcrumbs = runtime_failure_breadcrumbs(&config, &report);
        assert!(
            breadcrumbs.contains("artifacts/test.runtime.jsonl"),
            "expected JSONL path in breadcrumbs: {breadcrumbs}"
        );
        assert!(
            breadcrumbs.contains("pcm_window:4"),
            "expected transport counters in breadcrumbs: {breadcrumbs}"
        );
        assert!(
            breadcrumbs.contains("mode:pressure"),
            "expected backpressure mode in breadcrumbs: {breadcrumbs}"
        );
        assert!(
            breadcrumbs.contains("forced_decisions:6"),
            "expected pump counters in breadcrumbs: {breadcrumbs}"
        );
    }

    #[test]
    fn startup_banner_lines_use_contract_field_order() {
        let mut config = TranscribeConfig::default();
        config.live_stream = true;
        config.duration_sec = 42;
        config.input_wav = PathBuf::from("artifacts/live.input.wav");
        config.out_wav = PathBuf::from("artifacts/run.wav");
        config.out_jsonl = PathBuf::from("artifacts/run.jsonl");
        config.out_manifest = PathBuf::from("artifacts/run.manifest.json");

        let lines = build_startup_banner_lines(&config);
        let field_order = lines
            .iter()
            .map(|line| line.split('=').next().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(
            field_order,
            vec![
                "runtime_mode",
                "runtime_mode_taxonomy",
                "runtime_mode_selector",
                "runtime_mode_status",
                "channel_mode_requested",
                "duration_sec",
                "input_wav",
                "artifacts",
            ]
        );
        assert_eq!(lines[0], "runtime_mode=live-stream");
        assert_eq!(lines[3], "runtime_mode_status=implemented");
        assert!(lines[7].starts_with("artifacts=out_wav:"));
        assert!(lines[7].contains(" out_jsonl:"));
        assert!(lines[7].contains(" out_manifest:"));
        assert!(lines[7].contains("run.wav"));
        assert!(lines[7].contains("run.jsonl"));
        assert!(lines[7].contains("run.manifest.json"));
    }

    #[test]
    fn remediation_hints_are_deterministic_and_deduplicated() {
        let config = TranscribeConfig::default();
        let report = LiveRunReport {
            generated_at_utc: "2026-03-01T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: PathBuf::from("models/test.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 1_000,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello world")],
            degradation_events: vec![ModeDegradationEvent {
                code: "queue_pressure",
                detail: "drop-oldest path".to_string(),
            }],
            trust_notices: vec![
                super::TrustNotice {
                    code: "chunk_queue_backpressure".to_string(),
                    severity: "warn".to_string(),
                    cause: "queue pressure".to_string(),
                    impact: "latency".to_string(),
                    guidance: "raise cap".to_string(),
                },
                super::TrustNotice {
                    code: "cleanup_queue_timeout".to_string(),
                    severity: "warn".to_string(),
                    cause: "cleanup timeout".to_string(),
                    impact: "post-processing lag".to_string(),
                    guidance: "raise cap".to_string(),
                },
                super::TrustNotice {
                    code: "capture_restart".to_string(),
                    severity: "warn".to_string(),
                    cause: "capture interruption".to_string(),
                    impact: "continuity risk".to_string(),
                    guidance: "inspect the runtime manifest trust section".to_string(),
                },
            ],
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry {
                prewarm_ok: true,
                submitted: 1,
                enqueued: 1,
                dropped_queue_full: 0,
                processed: 1,
                succeeded: 1,
                failed: 0,
                retry_attempts: 0,
                temp_audio_deleted: 1,
                temp_audio_retained: 0,
            },
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue: LiveChunkQueueTelemetry::disabled(&config),
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: PathBuf::from("artifacts/summary.csv"),
            benchmark_runs_csv: PathBuf::from("artifacts/runs.csv"),
        };

        let hints = top_remediation_hints(&report, 3);
        assert_eq!(
            hints,
            vec![
                "inspect the runtime manifest trust section".to_string(),
                "raise cap".to_string(),
            ]
        );
        assert_eq!(
            remediation_hints_csv(&hints),
            "inspect the runtime manifest trust section | raise cap"
        );
    }

    #[test]
    fn reconstructed_transcript_prefers_reconciled_final_events_when_present() {
        let events = vec![
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-chunk-0000".to_string(),
                start_ms: 0,
                end_ms: 2_000,
                text: "incomplete".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "reconciled_final",
                channel: "mic".to_string(),
                segment_id: "mic-reconciled".to_string(),
                start_ms: 0,
                end_ms: 2_000,
                text: "complete transcript".to_string(),
                source_final_segment_id: None,
            },
        ];
        let transcript = reconstruct_transcript(&events);
        assert!(transcript.contains("complete transcript"));
        assert!(!transcript.contains("incomplete"));
    }

    #[test]
    fn backlog_drop_scenarios_emit_reconciled_final_events() {
        let live = run_live_chunk_queue(
            vec![
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "mic-live-0".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "system".to_string(),
                    segment_id: "system-0".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "system-live-0".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "mic".to_string(),
                    segment_id: "mic-1".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "mic-live-1".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "system".to_string(),
                    segment_id: "system-1".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "system-live-1".to_string(),
                    source_final_segment_id: None,
                },
            ],
            1,
            1_000,
        );
        assert!(live.telemetry.dropped_oldest > 0);

        let reconciliation = build_reconciliation_events(
            &[
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "mic complete transcript".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "system complete transcript".to_string(),
                },
            ],
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 5_000,
                source: "energy_threshold",
            }],
        );

        assert!(!reconciliation.is_empty());
        assert!(reconciliation
            .iter()
            .all(|event| event.event_type == "reconciled_final"));
        assert!(reconciliation
            .iter()
            .all(|event| event.segment_id.ends_with("-reconciled")));
    }

    #[test]
    fn reconciliation_events_include_source_final_segment_lineage() {
        let events = build_reconciliation_events(
            &[super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "mic complete transcript".to_string(),
            }],
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 5_000,
                source: "energy_threshold",
            }],
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "reconciled_final");
        assert_eq!(
            events[0].source_final_segment_id.as_deref(),
            Some("mic-representative-0")
        );
    }

    #[test]
    fn targeted_reconciliation_limits_output_to_shutdown_flush_boundaries() {
        let events = build_targeted_reconciliation_events(
            &[super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "alpha beta gamma delta epsilon".to_string(),
            }],
            &[
                VadBoundary {
                    id: 2,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
                VadBoundary {
                    id: 7,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "shutdown_flush",
                },
            ],
            &[TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-segment-0000-0-1200".to_string(),
                start_ms: 0,
                end_ms: 1_200,
                text: "alpha beta".to_string(),
                source_final_segment_id: None,
            }],
            &ReconciliationMatrix {
                required: true,
                applied: false,
                triggers: vec![super::ReconciliationTrigger {
                    code: "shutdown_flush_boundary",
                }],
            },
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "reconciled_final");
        assert_eq!(events[0].start_ms, 1_700);
        assert_eq!(events[0].end_ms, 2_800);
        assert_eq!(
            events[0].source_final_segment_id.as_deref(),
            Some("mic-segment-0001-1700-2800")
        );
    }

    #[test]
    fn targeted_reconciliation_prefers_missing_final_boundaries_under_queue_drop() {
        let events = build_targeted_reconciliation_events(
            &[
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "mic alpha beta gamma delta".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "system alpha beta gamma delta".to_string(),
                },
            ],
            &[
                VadBoundary {
                    id: 0,
                    start_ms: 0,
                    end_ms: 1_200,
                    source: "energy_threshold",
                },
                VadBoundary {
                    id: 1,
                    start_ms: 1_700,
                    end_ms: 2_800,
                    source: "energy_threshold",
                },
            ],
            &[
                TranscriptEvent {
                    event_type: "final",
                    channel: "mic".to_string(),
                    segment_id: "mic-segment-0000-0-1200".to_string(),
                    start_ms: 0,
                    end_ms: 1_200,
                    text: "mic alpha".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: "system".to_string(),
                    segment_id: "system-segment-0000-0-1200".to_string(),
                    start_ms: 0,
                    end_ms: 1_200,
                    text: "system alpha".to_string(),
                    source_final_segment_id: None,
                },
            ],
            &ReconciliationMatrix {
                required: true,
                applied: false,
                triggers: vec![super::ReconciliationTrigger {
                    code: "chunk_queue_drop_oldest",
                }],
            },
        );

        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|event| event.event_type == "reconciled_final"));
        assert!(events.iter().all(|event| event.start_ms == 1_700));
        let lineage = events
            .iter()
            .map(|event| event.source_final_segment_id.clone().unwrap())
            .collect::<Vec<_>>();
        assert!(lineage.contains(&"mic-segment-0001-1700-2800".to_string()));
        assert!(lineage.contains(&"system-segment-0001-1700-2800".to_string()));
    }

    #[test]
    fn reconciliation_preserves_live_provenance_and_improves_or_preserves_completeness() {
        let live = run_live_chunk_queue(
            vec![
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "mic".to_string(),
                    segment_id: "mic-0".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "mic-live-0".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 0,
                    channel: "system".to_string(),
                    segment_id: "system-0".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    text: "system-live-0".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "mic".to_string(),
                    segment_id: "mic-1".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "mic-live-1".to_string(),
                    source_final_segment_id: None,
                },
                AsrWorkItem {
                    class: AsrWorkClass::Final,
                    tick_index: 1,
                    channel: "system".to_string(),
                    segment_id: "system-1".to_string(),
                    start_ms: 1_000,
                    end_ms: 5_000,
                    text: "system-live-1".to_string(),
                    source_final_segment_id: None,
                },
            ],
            1,
            1_000,
        );
        assert!(live.telemetry.dropped_oldest > 0);
        assert!(live.events.iter().any(|event| event.event_type == "final"));

        let baseline_text = reconstruct_transcript(&live.events);
        let mut merged = live.events.clone();
        merged.extend(build_reconciliation_events(
            &[
                super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: "mic complete transcript".to_string(),
                },
                super::ChannelTranscriptSummary {
                    role: "system",
                    label: "system".to_string(),
                    text: "system complete transcript".to_string(),
                },
            ],
            &[VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 5_000,
                source: "energy_threshold",
            }],
        ));
        let merged = merge_transcript_events(merged);
        let reconciled_text = reconstruct_transcript(&merged);

        assert!(merged
            .iter()
            .any(|event| event.event_type == "reconciled_final"));
        assert!(merged.iter().any(|event| event.event_type == "final"));
        assert!(merged
            .iter()
            .filter(|event| event.event_type == "reconciled_final")
            .all(|event| event.source_final_segment_id.is_some()));
        assert!(reconciled_text.len() >= baseline_text.len());
        assert!(reconciled_text.contains("mic complete transcript"));
        assert!(reconciled_text.contains("system complete transcript"));
    }

    #[test]
    fn reconstructed_transcript_uses_timestamped_readability_defaults() {
        let events = vec![
            TranscriptEvent {
                event_type: "partial",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 50,
                text: "hello".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 100,
                text: "hello from mic".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "final",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 0,
                end_ms: 100,
                text: "hello from system".to_string(),
                source_final_segment_id: None,
            },
        ];
        let reconstructed = reconstruct_transcript(&events);
        assert_eq!(
            reconstructed,
            "[00:00.000-00:00.100] mic: hello from mic\n[00:00.000-00:00.100] system: hello from system (overlap<=120ms with mic)"
        );
    }

    #[test]
    fn per_channel_readable_transcript_is_deterministic() {
        let events = vec![
            TranscriptEvent {
                event_type: "final",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 0,
                end_ms: 90,
                text: "system one".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 100,
                text: "mic one".to_string(),
                source_final_segment_id: None,
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-1".to_string(),
                start_ms: 200,
                end_ms: 320,
                text: "mic two".to_string(),
                source_final_segment_id: None,
            },
        ];

        let per_channel = reconstruct_transcript_per_channel(&events);
        assert_eq!(per_channel.len(), 2);
        assert_eq!(per_channel[0].channel, "mic");
        assert_eq!(
            per_channel[0].text,
            "[00:00.000-00:00.100] mic one\n[00:00.200-00:00.320] mic two"
        );
        assert_eq!(per_channel[1].channel, "system");
        assert_eq!(per_channel[1].text, "[00:00.000-00:00.090] system one");
    }

    #[test]
    fn mixed_fallback_degrades_to_mixed_for_mono_input() {
        let input_wav = write_test_mono_wav();
        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.channel_mode = ChannelMode::MixedFallback;

        let plan = super::runtime_representative::prepare_channel_inputs(&config, "unit-fallback")
            .unwrap();
        assert_eq!(plan.active_mode, ChannelMode::Mixed);
        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(plan.inputs[0].role, "mixed");
        assert_eq!(plan.inputs[0].label, "merged");
        assert_eq!(plan.degradation_events.len(), 1);
        assert_eq!(plan.degradation_events[0].code, "fallback_to_mixed");

        let _ = std::fs::remove_file(input_wav);
    }

    #[test]
    fn out_wav_is_materialized_when_output_differs_from_input() {
        let input_wav = write_test_mono_wav();
        let temp_dir = write_temp_dir("recordit-out-wav-copy");
        let out_wav = temp_dir.join("nested").join("session.wav");

        materialize_out_wav(&input_wav, &out_wav).unwrap();

        assert!(out_wav.exists());
        assert_eq!(fs::read(&input_wav).unwrap(), fs::read(&out_wav).unwrap());

        let _ = fs::remove_file(input_wav);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn out_wav_materialization_is_noop_for_same_path() {
        let input_wav = write_test_mono_wav();
        materialize_out_wav(&input_wav, &input_wav).unwrap();
        assert!(input_wav.exists());
        let _ = fs::remove_file(input_wav);
    }

    #[test]
    fn live_capture_output_path_uses_input_wav_for_live_stream() {
        let mut config = TranscribeConfig::default();
        config.live_stream = true;
        config.live_chunked = true;
        config.input_wav = PathBuf::from("artifacts/live-stream.input.wav");
        config.out_wav = PathBuf::from("artifacts/live-stream.out.wav");

        assert_eq!(
            live_capture_output_path(&config),
            Path::new("artifacts/live-stream.input.wav")
        );
    }

    #[test]
    fn live_capture_materialization_paths_follow_runtime_mode_semantics() {
        let mut live_stream = TranscribeConfig::default();
        live_stream.live_stream = true;
        live_stream.live_chunked = true;
        live_stream.input_wav = PathBuf::from("artifacts/stream.input.wav");
        live_stream.out_wav = PathBuf::from("artifacts/stream.out.wav");

        let (stream_from, stream_to) = live_capture_materialization_paths(&live_stream);
        assert_eq!(stream_from, Path::new("artifacts/stream.input.wav"));
        assert_eq!(stream_to, Path::new("artifacts/stream.out.wav"));

        let mut chunked = TranscribeConfig::default();
        chunked.live_stream = false;
        chunked.live_chunked = true;
        chunked.input_wav = PathBuf::from("artifacts/chunked.input.wav");
        chunked.out_wav = PathBuf::from("artifacts/chunked.out.wav");

        let (chunked_from, chunked_to) = live_capture_materialization_paths(&chunked);
        assert_eq!(chunked_from, Path::new("artifacts/chunked.out.wav"));
        assert_eq!(chunked_to, Path::new("artifacts/chunked.input.wav"));
    }

    #[test]
    fn streaming_capture_session_grows_live_stream_input_wav_during_runtime() {
        let temp_dir = write_temp_dir("recordit-live-stream-input-growth");
        let fixture = temp_dir.join("fixture.wav");
        let input_wav = temp_dir.join("runtime.input.wav");
        write_test_stereo_wav(&fixture, 200, 600);

        let capture_config = LiveCaptureConfig {
            duration_secs: 3,
            output: input_wav.clone(),
            target_rate_hz: 200,
            mismatch_policy: LiveCaptureSampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: LiveCaptureCallbackMode::Warn,
            stop_request_path: None,
        };

        let _guard = env_lock().lock().unwrap();
        let original_fixture = env::var("RECORDIT_FAKE_CAPTURE_FIXTURE").ok();
        let original_realtime = env::var("RECORDIT_FAKE_CAPTURE_REALTIME").ok();
        let original_restart = env::var("RECORDIT_FAKE_CAPTURE_RESTART_COUNT").ok();
        unsafe {
            env::set_var("RECORDIT_FAKE_CAPTURE_FIXTURE", &fixture);
            env::set_var("RECORDIT_FAKE_CAPTURE_REALTIME", "1");
            env::set_var("RECORDIT_FAKE_CAPTURE_RESTART_COUNT", "0");
        }

        let worker = std::thread::spawn({
            let config = capture_config.clone();
            move || {
                let mut sink = NoopCaptureSink;
                run_streaming_capture_session(&config, &mut sink)
            }
        });

        let mut observed_growth = false;
        for _ in 0..120 {
            if let Ok(metadata) = fs::metadata(&input_wav) {
                if metadata.len() > 44 {
                    observed_growth = true;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        let capture_result = worker.join().unwrap().unwrap();
        restore_optional_env("RECORDIT_FAKE_CAPTURE_FIXTURE", original_fixture);
        restore_optional_env("RECORDIT_FAKE_CAPTURE_REALTIME", original_realtime);
        restore_optional_env("RECORDIT_FAKE_CAPTURE_RESTART_COUNT", original_restart);

        assert!(
            observed_growth,
            "expected input WAV growth during active capture"
        );
        assert!(input_wav.is_file());
        assert!(fs::metadata(&input_wav).unwrap().len() > 44);
        assert_eq!(capture_result.progressive_output_path, input_wav);

        let telemetry_path = super::live_capture_telemetry_path(&input_wav);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn input_wav_semantics_describes_mode_roles() {
        let mut config = TranscribeConfig::default();

        assert_eq!(
            input_wav_semantics(&config),
            "representative offline fixture input path"
        );

        config.live_chunked = true;
        assert_eq!(
            input_wav_semantics(&config),
            "representative live scratch artifact mirrored from canonical out_wav after capture"
        );

        config.live_stream = true;
        assert_eq!(
            input_wav_semantics(&config),
            "progressive live capture scratch artifact (materialized into canonical out_wav on success)"
        );
    }

    #[test]
    fn cleanup_queue_drops_when_full_without_blocking() {
        let mut config = TranscribeConfig::default();
        config.llm_cleanup = true;
        config.llm_endpoint = Some("http://127.0.0.1:9/v1/chat/completions".to_string());
        config.llm_model = Some("dummy".to_string());
        config.llm_max_queue = 1;
        config.llm_timeout_ms = 150;
        config.llm_retries = 0;

        let events = vec![
            final_event("mic-0", "mic", "hello"),
            final_event("system-0", "system", "world"),
            final_event("mixed-0", "merged", "again"),
        ];

        let result = run_cleanup_queue_with(&config, &events, |_client, _request| {
            std::thread::sleep(Duration::from_millis(40));
            CleanupAttemptOutcome {
                status: CleanupTaskStatus::Failed,
                cleaned_text: None,
            }
        });
        let telemetry = result.telemetry;

        assert_eq!(telemetry.submitted, 3);
        assert!(telemetry.dropped_queue_full >= 1);
        assert!(telemetry.enqueued <= telemetry.submitted);
        assert_eq!(telemetry.processed, telemetry.enqueued);
        assert!(telemetry.failed >= telemetry.processed);
        assert!(telemetry.drain_completed);
    }

    #[test]
    fn final_buffering_retries_without_queue_drop() {
        let temp_dir = write_temp_dir("recordit-final-buffering");
        let executor = Arc::new(MockLiveAsrExecutor {
            prewarm_calls: AtomicUsize::new(0),
            transcribe_calls: AtomicUsize::new(0),
            sleep_ms: 20,
        });
        let jobs = (0..4)
            .map(|idx| {
                let audio_path = temp_dir.join(format!("job-{idx}.wav"));
                fs::write(&audio_path, b"tmp").unwrap();
                LiveAsrJob {
                    job_id: idx,
                    class: LiveAsrJobClass::Final,
                    role: if idx % 2 == 0 { "mic" } else { "system" },
                    label: format!("chan-{idx}"),
                    segment_id: format!("seg-{idx}"),
                    audio_path,
                    is_temp_audio: true,
                }
            })
            .collect::<Vec<_>>();

        let (results, telemetry, final_buffering) =
            super::runtime_representative::run_live_asr_pool_with_final_buffering(
                executor.clone(),
                jobs,
                LiveAsrPoolConfig {
                    worker_count: 1,
                    queue_capacity: 1,
                    retries: 0,
                    temp_audio_policy: TempAudioPolicy::RetainOnFailure,
                },
            );

        assert_eq!(results.len(), 4);
        assert!(results.iter().all(|result| result.success()));
        assert_eq!(telemetry.submitted, 4);
        assert_eq!(telemetry.succeeded, 4);
        assert_eq!(telemetry.failed, 0);
        assert_eq!(telemetry.dropped_queue_full, 0);
        assert_eq!(telemetry.temp_audio_deleted, 4);
        assert_eq!(final_buffering.submit_window, 1);
        assert_eq!(final_buffering.deferred_final_submissions, 3);
        assert_eq!(final_buffering.max_pending_final_backlog, 3);
        assert_eq!(executor.prewarm_calls.load(Ordering::Relaxed), 1);
        assert_eq!(executor.transcribe_calls.load(Ordering::Relaxed), 4);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cleanup_queue_counts_retry_attempts() {
        let mut config = TranscribeConfig::default();
        config.llm_cleanup = true;
        config.llm_endpoint = Some("http://127.0.0.1:9/v1/chat/completions".to_string());
        config.llm_model = Some("dummy".to_string());
        config.llm_max_queue = 2;
        config.llm_timeout_ms = 200;
        config.llm_retries = 2;

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempt_counter = Arc::clone(&attempts);
        let events = vec![final_event("mic-0", "mic", "hello")];

        let result = run_cleanup_queue_with(&config, &events, move |_client, _request| {
            let attempt = attempt_counter.fetch_add(1, Ordering::Relaxed);
            if attempt < 2 {
                CleanupAttemptOutcome {
                    status: CleanupTaskStatus::Failed,
                    cleaned_text: None,
                }
            } else {
                CleanupAttemptOutcome {
                    status: CleanupTaskStatus::Succeeded,
                    cleaned_text: Some("cleaned".to_string()),
                }
            }
        });
        let telemetry = result.telemetry;

        assert_eq!(attempts.load(Ordering::Relaxed), 3);
        assert_eq!(telemetry.retry_attempts, 2);
        assert_eq!(telemetry.succeeded, 1);
        assert_eq!(telemetry.failed, 0);
    }

    #[test]
    fn cleanup_queue_emits_llm_final_with_lineage() {
        let mut config = TranscribeConfig::default();
        config.llm_cleanup = true;
        config.llm_endpoint = Some("http://127.0.0.1:9/v1/chat/completions".to_string());
        config.llm_model = Some("dummy".to_string());
        config.llm_max_queue = 2;
        config.llm_timeout_ms = 200;
        config.llm_retries = 0;

        let events = vec![final_event("mic-0", "mic", "hello there")];
        let result = run_cleanup_queue_with(&config, &events, |_client, _request| {
            CleanupAttemptOutcome {
                status: CleanupTaskStatus::Succeeded,
                cleaned_text: Some("hello there.".to_string()),
            }
        });

        assert_eq!(result.llm_events.len(), 1);
        let llm_event = &result.llm_events[0];
        assert_eq!(llm_event.event_type, "llm_final");
        assert_eq!(llm_event.segment_id, "mic-0-llm");
        assert_eq!(llm_event.source_final_segment_id.as_deref(), Some("mic-0"));
        assert_eq!(llm_event.text, "hello there.");
    }

    #[test]
    fn cleanup_disabled_produces_no_llm_events() {
        let config = TranscribeConfig::default();
        let events = vec![final_event("mic-0", "mic", "hello there")];
        let result = run_cleanup_queue_with(&config, &events, |_client, _request| {
            panic!("cleanup invoker should not run when llm_cleanup is disabled")
        });

        assert!(!result.telemetry.enabled);
        assert_eq!(result.telemetry.submitted, 0);
        assert!(result.llm_events.is_empty());
    }

    #[test]
    fn model_resolution_prefers_cli_override() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-model-cli");
        let cli_model = temp_dir.join("cli-model.bin");
        let env_model = temp_dir.join("env-model.bin");
        File::create(&cli_model).unwrap();
        File::create(&env_model).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::set_var("RECORDIT_ASR_MODEL", &env_model);
        }

        let mut config = TranscribeConfig::default();
        config.asr_model = cli_model.clone();
        let resolved = resolve_model_path(&config).unwrap();

        assert_eq!(resolved.path, cli_model);
        assert_eq!(resolved.source, "cli --asr-model");

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_resolution_uses_env_override_when_cli_missing() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-model-env");
        let env_model = temp_dir.join("env-model.bin");
        File::create(&env_model).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::set_var("RECORDIT_ASR_MODEL", &env_model);
        }

        let config = TranscribeConfig::default();
        let resolved = resolve_model_path(&config).unwrap();

        assert_eq!(resolved.path, env_model);
        assert_eq!(resolved.source, "env RECORDIT_ASR_MODEL");

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_resolution_uses_repo_default_when_overrides_missing() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-model-default");
        let default_model = temp_dir.join("artifacts/bench/models/whispercpp/ggml-tiny.en.bin");
        fs::create_dir_all(default_model.parent().unwrap()).unwrap();
        File::create(&default_model).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let config = TranscribeConfig::default();
        let resolved = resolve_model_path(&config).unwrap();

        assert_eq!(
            fs::canonicalize(&resolved.path).unwrap(),
            fs::canonicalize(&default_model).unwrap()
        );
        assert_eq!(resolved.source, "repo benchmark default");

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_checksum_info_reports_available_for_file_model() {
        let temp_dir = write_temp_dir("recordit-model-checksum-file");
        let model_path = temp_dir.join("model.bin");
        fs::write(&model_path, b"recordit-model").unwrap();

        let checksum = model_checksum_info(Some(&ResolvedModelPath {
            path: model_path,
            source: "test".to_string(),
        }));
        assert_eq!(checksum.status, "available");
        assert_eq!(
            checksum.sha256,
            "282b60bfec2d3545ed794a23d6790b4b8d558b4b89c334b4e0eeb6b446dbcafe"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_checksum_info_reports_unavailable_for_directory_model() {
        let temp_dir = write_temp_dir("recordit-model-checksum-dir");
        let checksum = model_checksum_info(Some(&ResolvedModelPath {
            path: temp_dir.clone(),
            source: "test".to_string(),
        }));
        assert_eq!(checksum.status, "unavailable_directory");
        assert_eq!(checksum.sha256, "<unavailable>");
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_checksum_info_reports_unresolved_when_model_missing() {
        let checksum = model_checksum_info(None);
        assert_eq!(checksum.status, "unavailable_unresolved");
        assert_eq!(checksum.sha256, "<unavailable>");
    }

    #[test]
    fn lifecycle_telemetry_tracks_expected_phase_order() {
        let mut lifecycle = LiveLifecycleTelemetry::new();
        lifecycle.transition(LiveLifecyclePhase::Warmup, "prep");
        lifecycle.transition(LiveLifecyclePhase::Active, "stream");
        lifecycle.transition(LiveLifecyclePhase::Draining, "flush");
        lifecycle.transition(LiveLifecyclePhase::Shutdown, "done");

        assert_eq!(
            lifecycle
                .transitions
                .iter()
                .map(|transition| transition.phase)
                .collect::<Vec<_>>(),
            vec![
                LiveLifecyclePhase::Warmup,
                LiveLifecyclePhase::Active,
                LiveLifecyclePhase::Draining,
                LiveLifecyclePhase::Shutdown
            ]
        );
        assert_eq!(lifecycle.current_phase, LiveLifecyclePhase::Shutdown);
        assert!(lifecycle.ready_for_transcripts);
        assert!(!lifecycle.transitions[0].phase.ready_for_transcripts());
        assert!(lifecycle.transitions[1].phase.ready_for_transcripts());
    }

    #[test]
    fn runtime_manifest_includes_ordered_event_timeline() {
        let temp_dir = write_temp_dir("recordit-runtime-manifest-events");
        let input_wav = temp_dir.join("input.wav");
        let out_wav = temp_dir.join("session.wav");
        let out_jsonl = temp_dir.join("session.jsonl");
        let out_manifest = temp_dir.join("session.manifest.json");
        File::create(&input_wav).unwrap();
        File::create(&out_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.out_wav = out_wav.clone();
        config.out_jsonl = out_jsonl.clone();
        config.out_manifest = out_manifest.clone();
        let mut chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        chunk_queue.enabled = true;
        chunk_queue.max_queue = 2;
        chunk_queue.submitted = 4;
        chunk_queue.enqueued = 4;
        chunk_queue.processed = 4;
        chunk_queue.high_water = 2;
        chunk_queue.lag_sample_count = 4;
        chunk_queue.lag_p50_ms = 1_000;
        chunk_queue.lag_p95_ms = 2_000;
        chunk_queue.lag_max_ms = 2_000;

        let report = LiveRunReport {
            generated_at_utc: "2026-02-28T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: temp_dir.join("model.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 100,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello world")],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry {
                prewarm_ok: true,
                submitted: 3,
                enqueued: 2,
                dropped_queue_full: 1,
                processed: 2,
                succeeded: 1,
                failed: 2,
                retry_attempts: 0,
                temp_audio_deleted: 1,
                temp_audio_retained: 1,
            },
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue,
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: temp_dir.join("summary.csv"),
            benchmark_runs_csv: temp_dir.join("runs.csv"),
        };

        write_runtime_manifest(&config, &report).unwrap();
        let manifest = fs::read_to_string(&out_manifest).unwrap();
        let parsed: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(
            parsed.get("runtime_mode").and_then(Value::as_str),
            Some("representative-offline")
        );
        assert_eq!(
            parsed.get("runtime_mode_taxonomy").and_then(Value::as_str),
            Some("representative-offline")
        );
        assert_eq!(
            parsed.get("runtime_mode_selector").and_then(Value::as_str),
            Some("<default>")
        );
        assert_eq!(
            parsed.get("runtime_mode_status").and_then(Value::as_str),
            Some("implemented")
        );
        assert_eq!(
            parsed.get("input_wav_semantics").and_then(Value::as_str),
            Some("representative offline fixture input path")
        );
        assert_eq!(
            parsed.get("out_wav_materialized").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(parsed.get("out_wav_bytes").and_then(Value::as_u64), Some(0));
        let events = parsed.get("events").and_then(Value::as_array).unwrap();
        assert!(
            events.iter().any(|event| {
                event.get("event_type").and_then(Value::as_str) == Some("final")
                    && event.get("segment_id").and_then(Value::as_str) == Some("mic-0")
            }),
            "expected final mic-0 event in manifest events"
        );
        let lifecycle = parsed.get("lifecycle").and_then(Value::as_object).unwrap();
        assert_eq!(
            lifecycle.get("current_phase").and_then(Value::as_str),
            Some("shutdown")
        );
        let lifecycle_phases: Vec<&str> = lifecycle
            .get("transitions")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("phase").and_then(Value::as_str))
            .collect();
        assert_eq!(
            lifecycle_phases,
            vec!["warmup", "active", "draining", "shutdown"]
        );
        let asr_worker_pool = parsed
            .get("asr_worker_pool")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            asr_worker_pool
                .get("temp_audio_deleted")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            asr_worker_pool
                .get("temp_audio_retained")
                .and_then(Value::as_u64),
            Some(1)
        );
        let terminal_summary = parsed
            .get("terminal_summary")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            terminal_summary.get("render_mode").and_then(Value::as_str),
            Some("deterministic-non-tty")
        );
        assert_eq!(
            terminal_summary
                .get("stable_line_policy")
                .and_then(Value::as_str),
            Some("final-only")
        );
        assert_eq!(
            terminal_summary
                .get("stable_line_count")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            terminal_summary
                .get("stable_lines_replayed")
                .and_then(Value::as_bool),
            Some(false)
        );
        let first_emit = parsed
            .get("first_emit_timing_ms")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            first_emit.get("first_any").and_then(Value::as_u64),
            Some(100)
        );
        assert_eq!(first_emit.get("first_partial"), Some(&Value::Null));
        assert_eq!(
            first_emit.get("first_final").and_then(Value::as_u64),
            Some(100)
        );
        assert_eq!(
            first_emit.get("first_stable").and_then(Value::as_u64),
            Some(100)
        );
        let queue_defer = parsed
            .get("queue_defer")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            queue_defer
                .get("deferred_final_submissions")
                .and_then(Value::as_u64),
            Some(0)
        );
        let ordering_metadata = parsed
            .get("ordering_metadata")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            ordering_metadata
                .get("event_sort_key")
                .and_then(Value::as_str),
            Some("start_ms,end_ms,event_type,channel,segment_id,source_final_segment_id,text")
        );
        let event_counts = parsed
            .get("event_counts")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(event_counts.get("partial").and_then(Value::as_u64), Some(0));
        assert_eq!(event_counts.get("final").and_then(Value::as_u64), Some(1));
        assert_eq!(
            event_counts.get("llm_final").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            event_counts.get("reconciled_final").and_then(Value::as_u64),
            Some(0)
        );
        let session_summary = parsed
            .get("session_summary")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            session_summary
                .get("session_status")
                .and_then(Value::as_str),
            Some("ok")
        );
        assert_eq!(
            session_summary.get("duration_sec").and_then(Value::as_u64),
            Some(10)
        );
        let transcript_events = session_summary
            .get("transcript_events")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            transcript_events.get("final").and_then(Value::as_u64),
            Some(1)
        );
        let trust_notices = session_summary
            .get("trust_notices")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(trust_notices.get("count").and_then(Value::as_u64), Some(0));
        let degradation_events = session_summary
            .get("degradation_events")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            degradation_events.get("count").and_then(Value::as_u64),
            Some(0)
        );
        let chunk_lag = session_summary
            .get("chunk_lag")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            chunk_lag.get("lag_sample_count").and_then(Value::as_u64),
            Some(4)
        );
        assert_eq!(
            chunk_lag.get("lag_p50_ms").and_then(Value::as_u64),
            Some(1000)
        );
        assert_eq!(
            chunk_lag.get("lag_p95_ms").and_then(Value::as_u64),
            Some(2000)
        );
        assert_eq!(
            chunk_lag.get("lag_max_ms").and_then(Value::as_u64),
            Some(2000)
        );
        assert!(session_summary
            .get("artifacts")
            .and_then(Value::as_object)
            .is_some());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn preflight_manifest_includes_runtime_mode_taxonomy_fields() {
        let temp_dir = write_temp_dir("recordit-preflight-manifest-mode-taxonomy");
        let out_manifest = temp_dir.join("preflight.manifest.json");

        let mut config = TranscribeConfig::default();
        config.out_manifest = out_manifest.clone();
        config.live_chunked = true;
        config.chunk_window_ms = 4_000;
        config.chunk_stride_ms = 1_000;
        config.chunk_queue_cap = 4;

        let report = PreflightReport {
            generated_at_utc: "2026-03-01T00:00:00Z".to_string(),
            checks: vec![PreflightCheck {
                id: "sample",
                status: CheckStatus::Pass,
                detail: "ok".to_string(),
                remediation: None,
            }],
        };

        write_preflight_manifest(&config, &report).unwrap();

        let manifest = fs::read_to_string(out_manifest).unwrap();
        let parsed: Value = serde_json::from_str(&manifest).unwrap();
        let config_obj = parsed.get("config").and_then(Value::as_object).unwrap();
        let input_wav = config_obj.get("input_wav").and_then(Value::as_str).unwrap();
        assert!(input_wav.ends_with("tts_phrase.wav"));
        assert_eq!(
            config_obj
                .get("input_wav_semantics")
                .and_then(Value::as_str),
            Some(
                "representative live scratch artifact mirrored from canonical out_wav after capture"
            )
        );
        assert_eq!(
            parsed.get("runtime_mode").and_then(Value::as_str),
            Some("live-chunked")
        );
        assert_eq!(
            parsed.get("runtime_mode_taxonomy").and_then(Value::as_str),
            Some("representative-chunked")
        );
        assert_eq!(
            parsed.get("runtime_mode_selector").and_then(Value::as_str),
            Some("--live-chunked")
        );
        assert_eq!(
            parsed.get("runtime_mode_status").and_then(Value::as_str),
            Some("implemented")
        );
        assert_eq!(
            config_obj.get("runtime_mode").and_then(Value::as_str),
            Some("live-chunked")
        );
        assert_eq!(
            config_obj
                .get("runtime_mode_taxonomy")
                .and_then(Value::as_str),
            Some("representative-chunked")
        );
        assert_eq!(
            config_obj
                .get("runtime_mode_selector")
                .and_then(Value::as_str),
            Some("--live-chunked")
        );
        assert_eq!(
            config_obj
                .get("runtime_mode_status")
                .and_then(Value::as_str),
            Some("implemented")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_artifacts_remain_compatible_across_runtime_mode_selectors() {
        let temp_dir = write_temp_dir("recordit-runtime-cross-mode-regression");
        let cases = [
            (
                "representative-offline",
                "representative-offline",
                "<default>",
                false,
                true,
                false,
                false,
                "representative offline fixture input path",
            ),
            (
                "live-chunked",
                "representative-chunked",
                "--live-chunked",
                false,
                true,
                true,
                false,
                "representative live scratch artifact mirrored from canonical out_wav after capture",
            ),
            (
                "live-stream",
                "live-stream",
                "--live-stream",
                true,
                false,
                false,
                true,
                "progressive live capture scratch artifact (materialized into canonical out_wav on success)",
            ),
        ];

        for (
            runtime_mode,
            runtime_taxonomy,
            runtime_selector,
            terminal_live_mode,
            stable_lines_replayed,
            live_chunked,
            live_stream,
            expected_input_wav_semantics,
        ) in cases
        {
            let mode_slug = runtime_mode.replace('-', "_");
            let input_wav = temp_dir.join(format!("{mode_slug}.input.wav"));
            let out_wav = temp_dir.join(format!("{mode_slug}.session.wav"));
            let out_jsonl = temp_dir.join(format!("{mode_slug}.session.jsonl"));
            let out_manifest = temp_dir.join(format!("{mode_slug}.session.manifest.json"));
            File::create(&input_wav).unwrap();
            File::create(&out_wav).unwrap();

            let mut config = TranscribeConfig::default();
            config.input_wav = input_wav;
            config.out_wav = out_wav;
            config.out_jsonl = out_jsonl.clone();
            config.out_manifest = out_manifest.clone();
            config.live_chunked = live_chunked;
            config.live_stream = live_stream;
            config.duration_sec = 10;
            let chunk_queue = if terminal_live_mode {
                LiveChunkQueueTelemetry::enabled(config.chunk_queue_cap)
            } else {
                LiveChunkQueueTelemetry::disabled(&config)
            };

            let report = LiveRunReport {
                generated_at_utc: "2026-03-01T00:00:00Z".to_string(),
                backend_id: "whispercpp",
                resolved_model_path: temp_dir.join(format!("{mode_slug}.model.bin")),
                resolved_model_source: "test".to_string(),
                channel_mode: ChannelMode::Separate,
                active_channel_mode: ChannelMode::Separate,
                transcript_text: format!("hello from {runtime_mode}"),
                channel_transcripts: vec![super::ChannelTranscriptSummary {
                    role: "mic",
                    label: "mic".to_string(),
                    text: format!("hello from {runtime_mode}"),
                }],
                vad_boundaries: vec![VadBoundary {
                    id: 0,
                    start_ms: 0,
                    end_ms: 100,
                    source: "energy_threshold",
                }],
                events: vec![final_event(
                    &format!("{mode_slug}-segment-0"),
                    "mic",
                    "hello world",
                )],
                degradation_events: Vec::new(),
                trust_notices: Vec::new(),
                lifecycle: sample_lifecycle(),
                reconciliation: ReconciliationMatrix::none(),
                asr_worker_pool: LiveAsrPoolTelemetry::default(),
                final_buffering: FinalBufferingTelemetry::default(),
                chunk_queue,
                cleanup_queue: CleanupQueueTelemetry::disabled(&config),
                hot_path_diagnostics: HotPathDiagnostics::default(),
                benchmark: BenchmarkSummary {
                    run_count: 1,
                    wall_ms_p50: 1.0,
                    wall_ms_p95: 1.0,
                    partial_slo_met: true,
                    final_slo_met: true,
                },
                benchmark_summary_csv: temp_dir.join(format!("{mode_slug}.summary.csv")),
                benchmark_runs_csv: temp_dir.join(format!("{mode_slug}.runs.csv")),
            };

            write_runtime_jsonl(&config, &report).unwrap();
            write_runtime_manifest(&config, &report).unwrap();
            replay_timeline(&out_jsonl).unwrap();

            let manifest = fs::read_to_string(out_manifest).unwrap();
            let parsed: Value = serde_json::from_str(&manifest).unwrap();
            assert_eq!(
                parsed.get("runtime_mode").and_then(Value::as_str),
                Some(runtime_mode)
            );
            assert_eq!(
                parsed.get("runtime_mode_taxonomy").and_then(Value::as_str),
                Some(runtime_taxonomy)
            );
            assert_eq!(
                parsed.get("runtime_mode_selector").and_then(Value::as_str),
                Some(runtime_selector)
            );
            assert_eq!(
                parsed.get("runtime_mode_status").and_then(Value::as_str),
                Some("implemented")
            );
            let terminal_summary = parsed
                .get("terminal_summary")
                .and_then(Value::as_object)
                .unwrap();
            assert_eq!(
                terminal_summary.get("live_mode").and_then(Value::as_bool),
                Some(terminal_live_mode)
            );
            assert_eq!(
                terminal_summary
                    .get("stable_lines_replayed")
                    .and_then(Value::as_bool),
                Some(stable_lines_replayed)
            );
            assert_eq!(
                parsed.get("input_wav_semantics").and_then(Value::as_str),
                Some(expected_input_wav_semantics)
            );
            let has_final = parsed
                .get("events")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|event| {
                    event.get("event_type").and_then(Value::as_str)
                        == Some(runtime_jsonl::EVENT_TYPE_FINAL)
                });
            assert!(has_final);
            assert!(parsed
                .get("session_summary")
                .and_then(Value::as_object)
                .is_some());
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_jsonl_chunk_queue_event_includes_lag_metrics() {
        let temp_dir = write_temp_dir("recordit-runtime-jsonl-chunk-lag");
        let input_wav = temp_dir.join("input.wav");
        let out_wav = temp_dir.join("session.wav");
        let out_jsonl = temp_dir.join("session.jsonl");
        File::create(&input_wav).unwrap();
        File::create(&out_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.out_wav = out_wav.clone();
        config.out_jsonl = out_jsonl.clone();

        let mut chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        chunk_queue.enabled = true;
        chunk_queue.max_queue = 2;
        chunk_queue.submitted = 4;
        chunk_queue.enqueued = 4;
        chunk_queue.processed = 4;
        chunk_queue.high_water = 2;
        chunk_queue.lag_sample_count = 4;
        chunk_queue.lag_p50_ms = 1_000;
        chunk_queue.lag_p95_ms = 2_000;
        chunk_queue.lag_max_ms = 2_000;

        let report = LiveRunReport {
            generated_at_utc: "2026-02-28T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: temp_dir.join("model.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 100,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello world")],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry {
                prewarm_ok: true,
                submitted: 4,
                enqueued: 3,
                dropped_queue_full: 1,
                processed: 3,
                succeeded: 2,
                failed: 2,
                retry_attempts: 1,
                temp_audio_deleted: 2,
                temp_audio_retained: 1,
            },
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue,
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: temp_dir.join("summary.csv"),
            benchmark_runs_csv: temp_dir.join("runs.csv"),
        };

        write_runtime_jsonl(&config, &report).unwrap();
        let jsonl = fs::read_to_string(&out_jsonl).unwrap();
        let reconciliation_line = jsonl
            .lines()
            .find(|line| line.contains("\"event_type\":\"reconciliation_matrix\""))
            .unwrap();
        assert!(reconciliation_line.contains("\"channel\":\"control\""));
        let asr_pool_line = jsonl
            .lines()
            .find(|line| line.contains("\"event_type\":\"asr_worker_pool\""))
            .unwrap();
        assert!(asr_pool_line.contains("\"channel\":\"control\""));
        assert!(asr_pool_line.contains("\"prewarm_ok\":true"));
        assert!(asr_pool_line.contains("\"submitted\":4"));
        assert!(asr_pool_line.contains("\"temp_audio_deleted\":2"));
        assert!(asr_pool_line.contains("\"temp_audio_retained\":1"));
        let chunk_queue_line = jsonl
            .lines()
            .find(|line| line.contains("\"event_type\":\"chunk_queue\""))
            .unwrap();
        assert!(chunk_queue_line.contains("\"lag_sample_count\":4"));
        assert!(chunk_queue_line.contains("\"lag_p50_ms\":1000"));
        assert!(chunk_queue_line.contains("\"lag_p95_ms\":2000"));
        assert!(chunk_queue_line.contains("\"lag_max_ms\":2000"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_jsonl_emits_lifecycle_phase_events_in_order() {
        let temp_dir = write_temp_dir("recordit-runtime-jsonl-lifecycle");
        let input_wav = temp_dir.join("input.wav");
        let out_wav = temp_dir.join("session.wav");
        let out_jsonl = temp_dir.join("session.jsonl");
        File::create(&input_wav).unwrap();
        File::create(&out_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.out_wav = out_wav.clone();
        config.out_jsonl = out_jsonl.clone();

        let report = LiveRunReport {
            generated_at_utc: "2026-02-28T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: temp_dir.join("model.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 100,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello world")],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry::default(),
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue: LiveChunkQueueTelemetry::disabled(&config),
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: temp_dir.join("summary.csv"),
            benchmark_runs_csv: temp_dir.join("runs.csv"),
        };

        write_runtime_jsonl(&config, &report).unwrap();
        let lifecycle_lines = fs::read_to_string(&out_jsonl)
            .unwrap()
            .lines()
            .filter(|line| line.contains("\"event_type\":\"lifecycle_phase\""))
            .map(str::to_string)
            .collect::<Vec<_>>();

        assert_eq!(lifecycle_lines.len(), 4);
        assert!(lifecycle_lines[0].contains("\"phase\":\"warmup\""));
        assert!(lifecycle_lines[0].contains("\"ready_for_transcripts\":false"));
        assert!(lifecycle_lines[1].contains("\"phase\":\"active\""));
        assert!(lifecycle_lines[1].contains("\"ready_for_transcripts\":true"));
        assert!(lifecycle_lines[2].contains("\"phase\":\"draining\""));
        assert!(lifecycle_lines[3].contains("\"phase\":\"shutdown\""));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_jsonl_places_active_phase_before_first_transcript_event() {
        let temp_dir = write_temp_dir("recordit-runtime-jsonl-active-before-transcript");
        let input_wav = temp_dir.join("input.wav");
        let out_wav = temp_dir.join("session.wav");
        let out_jsonl = temp_dir.join("session.jsonl");
        File::create(&input_wav).unwrap();
        File::create(&out_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.out_wav = out_wav.clone();
        config.out_jsonl = out_jsonl.clone();

        let report = LiveRunReport {
            generated_at_utc: "2026-02-28T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: temp_dir.join("model.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 100,
                source: "energy_threshold",
            }],
            events: vec![final_event("mic-0", "mic", "hello world")],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry::default(),
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue: LiveChunkQueueTelemetry::disabled(&config),
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: temp_dir.join("summary.csv"),
            benchmark_runs_csv: temp_dir.join("runs.csv"),
        };

        write_runtime_jsonl(&config, &report).unwrap();
        let lines = fs::read_to_string(&out_jsonl)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let active_idx = lines
            .iter()
            .position(|line| {
                line.contains("\"event_type\":\"lifecycle_phase\"")
                    && line.contains("\"phase\":\"active\"")
            })
            .expect("active lifecycle line missing");
        let first_transcript_idx = lines
            .iter()
            .position(|line| {
                line.contains("\"event_type\":\"partial\"")
                    || line.contains("\"event_type\":\"final\"")
                    || line.contains("\"event_type\":\"reconciled_final\"")
            })
            .expect("transcript line missing");
        assert!(
            active_idx < first_transcript_idx,
            "expected active lifecycle before first transcript event (active_idx={active_idx}, first_transcript_idx={first_transcript_idx})"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn incremental_runtime_sink_emits_stable_transcript_during_active_phase() {
        let temp_dir = write_temp_dir("recordit-live-stream-runtime-jsonl-growth");
        let out_jsonl = temp_dir.join("runtime.jsonl");
        let mut config = TranscribeConfig::default();
        config.out_jsonl = out_jsonl.clone();

        let mut sink = CollectingRuntimeOutputSink::with_incremental_jsonl(
            super::LiveStreamIncrementalJsonlWriter::open(&config).unwrap(),
        );
        RuntimeOutputSink::emit(
            &mut sink,
            RuntimeOutputEvent::Lifecycle {
                emit_seq: 1,
                phase: LiveRuntimePhase::Warmup,
                detail: "warmup".to_string(),
            },
        )
        .unwrap();
        let warmup_size = fs::metadata(&out_jsonl).unwrap().len();
        RuntimeOutputSink::emit(
            &mut sink,
            RuntimeOutputEvent::Lifecycle {
                emit_seq: 2,
                phase: LiveRuntimePhase::Active,
                detail: "active".to_string(),
            },
        )
        .unwrap();
        RuntimeOutputSink::emit(
            &mut sink,
            RuntimeOutputEvent::AsrCompleted {
                emit_seq: 3,
                result: RuntimeAsrResult {
                    job: RuntimeAsrJobSpec {
                        emit_seq: 3,
                        job_class: RuntimeAsrJobClass::Final,
                        channel: "microphone".to_string(),
                        segment_id: "microphone-seg-0001".to_string(),
                        segment_ord: 1,
                        window_ord: 1,
                        start_ms: 200,
                        end_ms: 900,
                    },
                    transcript_text: "stable text".to_string(),
                },
            },
        )
        .unwrap();
        let stable_size = fs::metadata(&out_jsonl).unwrap().len();
        RuntimeOutputSink::emit(
            &mut sink,
            RuntimeOutputEvent::Lifecycle {
                emit_seq: 4,
                phase: LiveRuntimePhase::Draining,
                detail: "draining".to_string(),
            },
        )
        .unwrap();
        sink.finalize_incremental_jsonl().unwrap();

        assert!(
            stable_size > warmup_size,
            "expected JSONL to grow after stable transcript emission"
        );
        let lines = fs::read_to_string(&out_jsonl)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let active_idx = lines
            .iter()
            .position(|line| {
                line.contains("\"event_type\":\"lifecycle_phase\"")
                    && line.contains("\"phase\":\"active\"")
            })
            .unwrap();
        let first_stable_idx = lines
            .iter()
            .position(|line| {
                line.contains("\"event_type\":\"final\"")
                    || line.contains("\"event_type\":\"llm_final\"")
                    || line.contains("\"event_type\":\"reconciled_final\"")
            })
            .unwrap();
        let draining_idx = lines
            .iter()
            .position(|line| {
                line.contains("\"event_type\":\"lifecycle_phase\"")
                    && line.contains("\"phase\":\"draining\"")
            })
            .unwrap();
        assert!(
            active_idx < first_stable_idx && first_stable_idx < draining_idx,
            "stable transcript emit should occur during active phase"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn runtime_jsonl_stream_persists_checkpointed_lines_before_finalize() {
        let temp_dir = write_temp_dir("recordit-runtime-jsonl-incremental");
        let out_jsonl = temp_dir.join("session.jsonl");
        let mut stream = RuntimeJsonlStream::open(&out_jsonl).unwrap();

        stream
            .write_line("{\"event_type\":\"lifecycle_phase\",\"phase\":\"warmup\"}")
            .unwrap();
        stream.checkpoint().unwrap();
        let first_snapshot = fs::read_to_string(&out_jsonl).unwrap();
        assert!(first_snapshot.contains("\"phase\":\"warmup\""));

        stream
            .write_line("{\"event_type\":\"vad_boundary\",\"boundary_id\":0}")
            .unwrap();
        stream.checkpoint().unwrap();
        let second_snapshot = fs::read_to_string(&out_jsonl).unwrap();
        assert!(second_snapshot.contains("\"phase\":\"warmup\""));
        assert!(second_snapshot.contains("\"event_type\":\"vad_boundary\""));

        stream.finalize().unwrap();
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn emit_latest_lifecycle_transition_jsonl_writes_only_latest_and_noops_when_empty() {
        let temp_dir = write_temp_dir("recordit-runtime-jsonl-lifecycle-latest");
        let out_jsonl = temp_dir.join("session.jsonl");
        let mut stream = RuntimeJsonlStream::open(&out_jsonl).unwrap();
        let mut lifecycle = LiveLifecycleTelemetry::new();

        emit_latest_lifecycle_transition_jsonl(&mut stream, &lifecycle).unwrap();
        assert_eq!(fs::read_to_string(&out_jsonl).unwrap(), "");

        lifecycle.transition(LiveLifecyclePhase::Active, "capture loop active");
        emit_latest_lifecycle_transition_jsonl(&mut stream, &lifecycle).unwrap();
        lifecycle.transition(
            LiveLifecyclePhase::Draining,
            "draining queue and reconciliation",
        );
        emit_latest_lifecycle_transition_jsonl(&mut stream, &lifecycle).unwrap();
        stream.finalize().unwrap();

        let lifecycle_lines = fs::read_to_string(&out_jsonl)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(lifecycle_lines.len(), 2);
        assert!(lifecycle_lines[0].contains("\"phase\":\"active\""));
        assert!(lifecycle_lines[0].contains("\"transition_index\":0"));
        assert!(lifecycle_lines[1].contains("\"phase\":\"draining\""));
        assert!(lifecycle_lines[1].contains("\"transition_index\":1"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn near_live_artifacts_remain_schema_compatible_for_replay() {
        let temp_dir = write_temp_dir("recordit-near-live-schema-replay");
        let input_wav = temp_dir.join("input.wav");
        let out_wav = temp_dir.join("session.wav");
        let out_jsonl = temp_dir.join("session.jsonl");
        let out_manifest = temp_dir.join("session.manifest.json");
        File::create(&input_wav).unwrap();
        File::create(&out_wav).unwrap();

        let mut config = TranscribeConfig::default();
        config.input_wav = input_wav.clone();
        config.out_wav = out_wav.clone();
        config.out_jsonl = out_jsonl.clone();
        config.out_manifest = out_manifest.clone();

        let mut chunk_queue = LiveChunkQueueTelemetry::disabled(&config);
        chunk_queue.enabled = true;
        chunk_queue.max_queue = 2;
        chunk_queue.submitted = 3;
        chunk_queue.enqueued = 3;
        chunk_queue.processed = 3;
        chunk_queue.high_water = 2;
        chunk_queue.lag_sample_count = 3;
        chunk_queue.lag_p50_ms = 1_000;
        chunk_queue.lag_p95_ms = 2_000;
        chunk_queue.lag_max_ms = 2_000;

        let report = LiveRunReport {
            generated_at_utc: "2026-02-28T00:00:00Z".to_string(),
            backend_id: "whispercpp",
            resolved_model_path: temp_dir.join("model.bin"),
            resolved_model_source: "test".to_string(),
            channel_mode: ChannelMode::Separate,
            active_channel_mode: ChannelMode::Separate,
            transcript_text: "hello world".to_string(),
            channel_transcripts: vec![super::ChannelTranscriptSummary {
                role: "mic",
                label: "mic".to_string(),
                text: "hello world".to_string(),
            }],
            vad_boundaries: vec![VadBoundary {
                id: 0,
                start_ms: 0,
                end_ms: 2_000,
                source: "energy_threshold",
            }],
            events: vec![
                TranscriptEvent {
                    event_type: "partial",
                    channel: "mic".to_string(),
                    segment_id: "mic-chunk-0000-0-4000".to_string(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "hello".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "final",
                    channel: "mic".to_string(),
                    segment_id: "mic-chunk-0000-0-4000".to_string(),
                    start_ms: 0,
                    end_ms: 2_000,
                    text: "hello world".to_string(),
                    source_final_segment_id: None,
                },
                TranscriptEvent {
                    event_type: "reconciled_final",
                    channel: "mic".to_string(),
                    segment_id: "mic-reconciled-0000".to_string(),
                    start_ms: 0,
                    end_ms: 2_000,
                    text: "hello world reconciled".to_string(),
                    source_final_segment_id: Some("mic-chunk-0000-0-4000".to_string()),
                },
            ],
            degradation_events: Vec::new(),
            trust_notices: Vec::new(),
            lifecycle: sample_lifecycle(),
            reconciliation: ReconciliationMatrix::none(),
            asr_worker_pool: LiveAsrPoolTelemetry::default(),
            final_buffering: FinalBufferingTelemetry::default(),
            chunk_queue,
            cleanup_queue: CleanupQueueTelemetry::disabled(&config),
            hot_path_diagnostics: HotPathDiagnostics::default(),
            benchmark: BenchmarkSummary {
                run_count: 1,
                wall_ms_p50: 1.0,
                wall_ms_p95: 1.0,
                partial_slo_met: true,
                final_slo_met: true,
            },
            benchmark_summary_csv: temp_dir.join("summary.csv"),
            benchmark_runs_csv: temp_dir.join("runs.csv"),
        };

        write_runtime_jsonl(&config, &report).unwrap();
        write_runtime_manifest(&config, &report).unwrap();

        let jsonl = fs::read_to_string(&out_jsonl).unwrap();
        assert!(jsonl.lines().any(|line| {
            line.contains("\"event_type\":\"partial\"")
                && line.contains("\"segment_id\":\"mic-chunk-0000-0-4000\"")
                && line.contains("\"start_ms\":0")
                && line.contains("\"end_ms\":1000")
                && line.contains("\"text\":\"hello\"")
        }));
        assert!(jsonl.lines().any(|line| {
            line.contains("\"event_type\":\"reconciled_final\"")
                && line.contains("\"segment_id\":\"mic-reconciled-0000\"")
                && line.contains("\"source_final_segment_id\":\"mic-chunk-0000-0-4000\"")
        }));
        assert!(jsonl
            .lines()
            .any(|line| line.contains("\"event_type\":\"chunk_queue\"")));

        let manifest = fs::read_to_string(&out_manifest).unwrap();
        let parsed: Value = serde_json::from_str(&manifest).unwrap();
        let reconciled = parsed
            .get("events")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .find(|event| {
                event.get("event_type").and_then(Value::as_str)
                    == Some(runtime_jsonl::EVENT_TYPE_RECONCILED_FINAL)
            })
            .unwrap();
        assert_eq!(
            reconciled
                .get("source_final_segment_id")
                .and_then(Value::as_str),
            Some("mic-chunk-0000-0-4000")
        );
        assert!(parsed
            .get("chunk_queue")
            .and_then(Value::as_object)
            .is_some());
        assert!(parsed.get("jsonl_path").and_then(Value::as_str).is_some());

        replay_timeline(&out_jsonl).unwrap();

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_resolution_fails_fast_for_missing_explicit_cli_model() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-model-explicit-missing");
        let default_model = temp_dir.join("artifacts/bench/models/whispercpp/ggml-tiny.en.bin");
        fs::create_dir_all(default_model.parent().unwrap()).unwrap();
        File::create(&default_model).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let mut config = TranscribeConfig::default();
        config.asr_model = temp_dir.join("does-not-exist.bin");
        let err = resolve_model_path(&config).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("explicit `--asr-model` path does not exist"));
        assert!(message.contains("omit `--asr-model` to allow default resolution"));

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn bundled_backend_program_resolution_prefers_resources_bin() {
        let temp_dir = write_temp_dir("recordit-bundled-backend-program");
        let exe_path = temp_dir
            .join("SequoiaTranscribe.app")
            .join("Contents")
            .join("MacOS")
            .join("SequoiaTranscribe");
        fs::create_dir_all(exe_path.parent().unwrap()).unwrap();
        File::create(&exe_path).unwrap();

        let resources_bin = temp_dir
            .join("SequoiaTranscribe.app")
            .join("Contents")
            .join("Resources")
            .join("bin");
        fs::create_dir_all(&resources_bin).unwrap();
        let resources_helper = resources_bin.join("whisper-cli");
        File::create(&resources_helper).unwrap();

        let helpers_dir = temp_dir
            .join("SequoiaTranscribe.app")
            .join("Contents")
            .join("Helpers");
        fs::create_dir_all(&helpers_dir).unwrap();
        File::create(helpers_dir.join("whisper-cli")).unwrap();

        let resolved = bundled_backend_program_from_exe(AsrBackend::WhisperCpp, &exe_path).unwrap();
        assert_eq!(resolved, resources_helper.to_string_lossy().to_string());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolve_backend_program_prefers_env_override() {
        let _guard = env_lock().lock().unwrap();
        let original_env = env::var("RECORDIT_WHISPERCPP_CLI_PATH").ok();
        unsafe {
            env::set_var("RECORDIT_WHISPERCPP_CLI_PATH", "/tmp/custom-whisper-cli");
        }

        let temp_dir = write_temp_dir("recordit-backend-program-env");
        let model_path = temp_dir.join("ggml.bin");
        File::create(&model_path).unwrap();

        let resolved = resolve_backend_program(AsrBackend::WhisperCpp, &model_path);
        assert_eq!(resolved, "/tmp/custom-whisper-cli");

        restore_optional_env("RECORDIT_WHISPERCPP_CLI_PATH", original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolve_backend_program_uses_model_sibling_helper() {
        let _guard = env_lock().lock().unwrap();
        let original_env = env::var("RECORDIT_WHISPERCPP_CLI_PATH").ok();
        unsafe {
            env::remove_var("RECORDIT_WHISPERCPP_CLI_PATH");
        }

        let temp_dir = write_temp_dir("recordit-backend-program-model-sibling");
        let model_dir = temp_dir.join("models");
        fs::create_dir_all(&model_dir).unwrap();
        let model_path = model_dir.join("ggml.bin");
        File::create(&model_path).unwrap();
        let helper_path = model_dir.join("whisper-cli");
        File::create(&helper_path).unwrap();

        let resolved = resolve_backend_program(AsrBackend::WhisperCpp, &model_path);
        assert_eq!(resolved, helper_path.to_string_lossy().to_string());

        restore_optional_env("RECORDIT_WHISPERCPP_CLI_PATH", original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolve_backend_program_uses_model_bin_helper_fallback() {
        let _guard = env_lock().lock().unwrap();
        let original_env = env::var("RECORDIT_WHISPERCPP_CLI_PATH").ok();
        unsafe {
            env::remove_var("RECORDIT_WHISPERCPP_CLI_PATH");
        }

        let temp_dir = write_temp_dir("recordit-backend-program-model-bin");
        let model_dir = temp_dir.join("models");
        let model_bin_dir = model_dir.join("bin");
        fs::create_dir_all(&model_bin_dir).unwrap();
        let model_path = model_dir.join("ggml.bin");
        File::create(&model_path).unwrap();
        let helper_path = model_bin_dir.join("whisper-cli");
        File::create(&helper_path).unwrap();

        let resolved = resolve_backend_program(AsrBackend::WhisperCpp, &model_path);
        assert_eq!(resolved, helper_path.to_string_lossy().to_string());

        restore_optional_env("RECORDIT_WHISPERCPP_CLI_PATH", original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn validate_model_rejects_directory_for_whispercpp() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-validate-model-dir-whispercpp");

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let mut config = TranscribeConfig::default();
        config.asr_backend = AsrBackend::WhisperCpp;
        config.asr_model = temp_dir.clone();
        let err = validate_model_path_for_backend(&config).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("expects a model file path"),
            "expected file-path error, got: {message}"
        );

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn validate_model_rejects_file_for_whisperkit() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-validate-model-file-whisperkit");
        let model_file = temp_dir.join("model.bin");
        File::create(&model_file).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let mut config = TranscribeConfig::default();
        config.asr_backend = AsrBackend::WhisperKit;
        config.asr_model = model_file;
        let err = validate_model_path_for_backend(&config).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("expects a model directory path"),
            "expected directory-path error, got: {message}"
        );

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn validate_model_accepts_file_for_whispercpp() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-validate-model-file-whispercpp");
        let model_file = temp_dir.join("ggml-tiny.en.bin");
        File::create(&model_file).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let mut config = TranscribeConfig::default();
        config.asr_backend = AsrBackend::WhisperCpp;
        config.asr_model = model_file.clone();
        let resolved = validate_model_path_for_backend(&config).unwrap();
        assert_eq!(resolved.path, model_file);

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn validate_model_accepts_directory_for_whisperkit() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-validate-model-dir-whisperkit");
        let model_dir = temp_dir.join("whisperkit-model");
        fs::create_dir_all(&model_dir).unwrap();

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let mut config = TranscribeConfig::default();
        config.asr_backend = AsrBackend::WhisperKit;
        config.asr_model = model_dir.clone();
        let resolved = validate_model_path_for_backend(&config).unwrap();
        assert_eq!(resolved.path, model_dir);

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn model_resolution_error_lists_checked_candidates() {
        let _guard = env_lock().lock().unwrap();
        let original_cwd = env::current_dir().unwrap();
        let original_env = env::var("RECORDIT_ASR_MODEL").ok();
        let temp_dir = write_temp_dir("recordit-model-no-candidates");

        env::set_current_dir(&temp_dir).unwrap();
        unsafe {
            env::remove_var("RECORDIT_ASR_MODEL");
        }

        let config = TranscribeConfig::default();
        let err = resolve_model_path(&config).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("Precedence"),
            "error should describe resolution precedence, got: {message}"
        );
        assert!(
            message.contains("Checked"),
            "error should list checked candidates, got: {message}"
        );
        assert!(
            message.contains("Remediation"),
            "error should include remediation guidance, got: {message}"
        );

        restore_env_state(original_cwd, original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolve_backend_program_falls_back_to_bare_helper_name() {
        let _guard = env_lock().lock().unwrap();
        let original_env = env::var("RECORDIT_WHISPERCPP_CLI_PATH").ok();
        unsafe {
            env::remove_var("RECORDIT_WHISPERCPP_CLI_PATH");
        }

        let temp_dir = write_temp_dir("recordit-backend-program-bare-fallback");
        let model_dir = temp_dir.join("empty-models");
        fs::create_dir_all(&model_dir).unwrap();
        let model_path = model_dir.join("ggml.bin");
        File::create(&model_path).unwrap();

        let resolved = resolve_backend_program(AsrBackend::WhisperCpp, &model_path);
        assert_eq!(
            resolved, "whisper-cli",
            "expected bare helper name fallback, got: {resolved}"
        );

        restore_optional_env("RECORDIT_WHISPERCPP_CLI_PATH", original_env);
        let _ = fs::remove_dir_all(temp_dir);
    }

    fn final_event(segment_id: &str, channel: &str, text: &str) -> TranscriptEvent {
        TranscriptEvent {
            event_type: "final",
            channel: channel.to_string(),
            segment_id: segment_id.to_string(),
            start_ms: 0,
            end_ms: 100,
            text: text.to_string(),
            source_final_segment_id: None,
        }
    }

    fn sample_lifecycle() -> LiveLifecycleTelemetry {
        let mut lifecycle = LiveLifecycleTelemetry::new();
        lifecycle.transition(LiveLifecyclePhase::Warmup, "test warmup");
        lifecycle.transition(LiveLifecyclePhase::Active, "test active");
        lifecycle.transition(LiveLifecyclePhase::Draining, "test draining");
        lifecycle.transition(LiveLifecyclePhase::Shutdown, "test shutdown");
        lifecycle
    }

    fn write_test_mono_wav() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("recordit-mono-{stamp}.wav"));
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&path, spec).unwrap();
        for _ in 0..320 {
            writer.write_sample::<i16>(0).unwrap();
        }
        writer.finalize().unwrap();
        path
    }

    fn write_test_stereo_wav(path: &Path, sample_rate_hz: u32, frame_count: usize) {
        let spec = WavSpec {
            channels: 2,
            sample_rate: sample_rate_hz,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for idx in 0..frame_count {
            let sample = ((idx % 48) as f32 / 24.0) - 1.0;
            writer.write_sample(sample).unwrap(); // microphone
            writer.write_sample(-sample).unwrap(); // system audio
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn validate_output_path_allows_session_paths_inside_canonical_root() {
        let _guard = env_lock().lock().unwrap();
        let original_policy = env::var(storage_roots::APP_MANAGED_STORAGE_POLICY_ENV).ok();
        let original_root = env::var(storage_roots::STORAGE_DATA_ROOT_ENV).ok();
        let data_root = write_temp_dir("output-policy-allow");

        unsafe {
            env::set_var(storage_roots::APP_MANAGED_STORAGE_POLICY_ENV, "1");
            env::set_var(storage_roots::STORAGE_DATA_ROOT_ENV, &data_root);
        }

        let allowed = data_root
            .join("artifacts")
            .join("packaged-beta")
            .join("sessions")
            .join("20260305")
            .join("session.manifest.json");
        let result = validate_output_path("--out-manifest", &allowed);

        restore_optional_env(
            storage_roots::APP_MANAGED_STORAGE_POLICY_ENV,
            original_policy,
        );
        restore_optional_env(storage_roots::STORAGE_DATA_ROOT_ENV, original_root);
        assert!(result.is_ok(), "expected in-root path to pass: {result:?}");
    }

    #[test]
    fn validate_output_path_rejects_paths_outside_canonical_sessions_root() {
        let _guard = env_lock().lock().unwrap();
        let original_policy = env::var(storage_roots::APP_MANAGED_STORAGE_POLICY_ENV).ok();
        let original_root = env::var(storage_roots::STORAGE_DATA_ROOT_ENV).ok();
        let data_root = write_temp_dir("output-policy-reject");

        unsafe {
            env::set_var(storage_roots::APP_MANAGED_STORAGE_POLICY_ENV, "1");
            env::set_var(storage_roots::STORAGE_DATA_ROOT_ENV, &data_root);
        }

        let outside = data_root.join("unmanaged").join("session.jsonl");
        let err = validate_output_path("--out-jsonl", &outside)
            .expect_err("out-of-policy path should be rejected");

        restore_optional_env(
            storage_roots::APP_MANAGED_STORAGE_POLICY_ENV,
            original_policy,
        );
        restore_optional_env(storage_roots::STORAGE_DATA_ROOT_ENV, original_root);
        assert!(
            err.to_string().contains("outside canonical sessions root"),
            "unexpected error: {err}"
        );
    }

    fn write_temp_dir(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("{prefix}-{stamp}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn restore_env_state(original_cwd: PathBuf, original_env: Option<String>) {
        env::set_current_dir(original_cwd).unwrap();
        restore_optional_env("RECORDIT_ASR_MODEL", original_env);
    }

    fn restore_optional_env(name: &str, original_value: Option<String>) {
        match original_value {
            Some(value) => unsafe {
                env::set_var(name, value);
            },
            None => unsafe {
                env::remove_var(name);
            },
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}
