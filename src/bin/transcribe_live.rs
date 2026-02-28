use hound::{SampleFormat, WavReader};
use sha2::{Digest, Sha256};
use screencapturekit::prelude::*;
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fmt::{self, Display};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::mpsc::{self, sync_channel, Receiver, RecvTimeoutError, TrySendError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const PARTIAL_LATENCY_SLO_MS: f64 = 1_500.0;
const FINAL_LATENCY_SLO_MS: f64 = 2_500.0;
const OVERLAP_WINDOW_MS: u64 = 120;
const OUT_WAV_SEMANTICS: &str = "canonical session WAV artifact for the run";
const DEFAULT_CHUNK_WINDOW_MS: u64 = 4_000;
const DEFAULT_CHUNK_STRIDE_MS: u64 = 1_000;
const DEFAULT_CHUNK_QUEUE_CAP: usize = 4;
const LIVE_CAPTURE_SAMPLE_RATE_POLICY: &str = "adapt-stream-rate";
const LIVE_CAPTURE_CALLBACK_MODE: &str = "warn";
const LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE: &str = "live_capture_interruption_recovered";
const LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE: &str = "live_capture_continuity_unverified";
const LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE: &str = "live_chunk_queue_drop_oldest";

const HELP_TEXT: &str = "\
transcribe-live

Define and validate the live transcription CLI contract for the next phase of recordit.

Usage:
  transcribe-live [options]

Options:
  --duration-sec <seconds>        Capture duration in seconds (default: 10)
  --input-wav <path>              Runtime WAV path (offline: representative fixture path; live-chunked: capture destination; default: artifacts/bench/corpus/gate_a/tts_phrase.wav)
  --out-wav <path>                Canonical session WAV artifact path (always materialized on success; default: artifacts/transcribe-live.wav)
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
  --live-chunked                  Select the near-live chunk pipeline contract
  --chunk-window-ms <ms>          Near-live chunk window in milliseconds (default: 4000; requires --live-chunked)
  --chunk-stride-ms <ms>          Near-live chunk stride in milliseconds (default: 1000; requires --live-chunked)
  --chunk-queue-cap <n>           Bounded near-live ASR work queue capacity (default: 4; requires --live-chunked)
  --transcribe-channels <mode>    Channel mode: separate | mixed | mixed-fallback (default: separate)
  --speaker-labels <mic,system>   Comma-separated labels for the two channels (default: mic,system)
  --benchmark-runs <n>            Number of representative latency benchmark runs (default: 3)
  --model-doctor                  Run model/backend diagnostics and exit
  --replay-jsonl <path>           Replay transcript timeline from a prior JSONL artifact
  --preflight                     Run structured preflight diagnostics and write manifest
  -h, --help                      Show this help text

Examples:
  transcribe-live --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
  transcribe-live --asr-backend whisperkit --asr-model artifacts/bench/models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-tiny --transcribe-channels mixed
  transcribe-live --input-wav artifacts/bench/corpus/gate_a/tts_phrase.wav --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --llm-cleanup --llm-endpoint http://127.0.0.1:8080/v1/chat/completions --llm-model llama3.2:3b
  transcribe-live --live-chunked --chunk-window-ms 4000 --chunk-stride-ms 1000 --chunk-queue-cap 4 --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
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
    chunk_window_ms: u64,
    chunk_stride_ms: u64,
    chunk_queue_cap: usize,
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
            chunk_window_ms: DEFAULT_CHUNK_WINDOW_MS,
            chunk_stride_ms: DEFAULT_CHUNK_STRIDE_MS,
            chunk_queue_cap: DEFAULT_CHUNK_QUEUE_CAP,
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
        if self.duration_sec == 0 {
            return Err(CliError::new("`--duration-sec` must be greater than zero"));
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

        if !self.live_chunked
            && (self.chunk_window_ms != DEFAULT_CHUNK_WINDOW_MS
                || self.chunk_stride_ms != DEFAULT_CHUNK_STRIDE_MS
                || self.chunk_queue_cap != DEFAULT_CHUNK_QUEUE_CAP)
        {
            return Err(CliError::new(
                "`--chunk-window-ms`, `--chunk-stride-ms`, and `--chunk-queue-cap` require `--live-chunked`; omit them for representative offline runs",
            ));
        }

        if self.live_chunked && self.replay_jsonl.is_some() {
            return Err(CliError::new(
                "`--live-chunked` cannot be combined with `--replay-jsonl`; replay reads a completed artifact instead of configuring a live runtime",
            ));
        }

        if self.live_chunked && self.preflight {
            return Err(CliError::new(
                "`--live-chunked` cannot be combined with `--preflight`; run preflight first, then start the near-live runtime separately",
            ));
        }

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

    fn runtime_mode_label(&self) -> &'static str {
        if self.live_chunked {
            "live-chunked"
        } else {
            "representative-offline"
        }
    }

    fn live_mode_summary_lines(&self) -> [String; 5] {
        let inactive_suffix = if self.live_chunked {
            ""
        } else {
            " (inactive; enable with --live-chunked)"
        };
        [
            format!("  runtime_mode: {}", self.runtime_mode_label()),
            format!("  live_chunked: {}", self.live_chunked),
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
        ]
    }

    fn print_summary(&self) {
        println!("Transcribe-live configuration");
        println!("  status: contract validated + representative runtime enabled");
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
    chunk_queue: LiveChunkQueueTelemetry,
    cleanup_queue: CleanupQueueTelemetry,
    benchmark: BenchmarkSummary,
    benchmark_summary_csv: PathBuf,
    benchmark_runs_csv: PathBuf,
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
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct RollingChunkWindow {
    index: usize,
    start_ms: u64,
    end_ms: u64,
    overlap_prev_ms: u64,
}

#[derive(Debug, Clone)]
struct LiveChunkTask {
    tick_index: usize,
    channel: String,
    segment_id: String,
    start_ms: u64,
    end_ms: u64,
    text: String,
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
struct ReadableChannelTranscript {
    channel: String,
    text: String,
}

struct AsrRequest<'a> {
    model_path: &'a Path,
    audio_path: &'a Path,
    language: &'a str,
    threads: usize,
}

trait AsrAdapter {
    fn backend_id(&self) -> &'static str;
    fn transcribe(&self, request: &AsrRequest<'_>) -> Result<String, CliError>;
}

struct WhisperCppAdapter;

impl AsrAdapter for WhisperCppAdapter {
    fn backend_id(&self) -> &'static str {
        "whispercpp"
    }

    fn transcribe(&self, request: &AsrRequest<'_>) -> Result<String, CliError> {
        let output = Command::new("whisper-cli")
            .args([
                "-m",
                &request.model_path.to_string_lossy(),
                "-f",
                &request.audio_path.to_string_lossy(),
                "-l",
                request.language,
                "-t",
                &request.threads.to_string(),
                "-nt",
                "-np",
            ])
            .output()
            .map_err(|err| CliError::new(format!("failed to execute `whisper-cli`: {err}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CliError::new(format!(
                "`whisper-cli` exited with status {}: {}",
                output.status,
                clean_field(stderr.trim())
            )));
        }

        let transcript = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if transcript.is_empty() {
            return Ok("<no speech detected>".to_string());
        }
        Ok(transcript)
    }
}

struct WhisperKitAdapter;

impl AsrAdapter for WhisperKitAdapter {
    fn backend_id(&self) -> &'static str {
        "whisperkit"
    }

    fn transcribe(&self, request: &AsrRequest<'_>) -> Result<String, CliError> {
        let output = Command::new("whisperkit-cli")
            .args([
                "transcribe",
                "--audio-path",
                &request.audio_path.to_string_lossy(),
                "--model-path",
                &request.model_path.to_string_lossy(),
                "--language",
                request.language,
                "--task",
                "transcribe",
                "--without-timestamps",
            ])
            .output()
            .map_err(|err| CliError::new(format!("failed to execute `whisperkit-cli`: {err}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CliError::new(format!(
                "`whisperkit-cli` exited with status {}: {}",
                output.status,
                clean_field(stderr.trim())
            )));
        }

        let transcript = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if transcript.is_empty() {
            return Ok("<no speech detected>".to_string());
        }
        Ok(transcript)
    }
}

fn select_adapter(backend: AsrBackend) -> Result<Box<dyn AsrAdapter>, CliError> {
    match backend {
        AsrBackend::WhisperCpp => Ok(Box::new(WhisperCppAdapter)),
        AsrBackend::WhisperKit => Ok(Box::new(WhisperKitAdapter)),
        AsrBackend::Moonshine => Err(CliError::new(
            "moonshine adapter is not wired in this phase; use `--asr-backend whispercpp` or `--asr-backend whisperkit`",
        )),
    }
}

fn run_live_pipeline(config: &TranscribeConfig) -> Result<LiveRunReport, CliError> {
    let resolved_model = validate_model_path_for_backend(config)?;
    prepare_runtime_input_wav(config)?;
    materialize_out_wav(&config.input_wav, &config.out_wav)?;

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let stamp = command_stdout("date", &["-u", "+%Y%m%dT%H%M%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let backend_id = select_adapter(config.asr_backend)?.backend_id();
    let channel_plan = prepare_channel_inputs(config, &stamp)?;
    let mut wall_ms_runs = Vec::with_capacity(config.benchmark_runs);
    let mut first_channel_transcripts = Vec::new();
    for _ in 0..config.benchmark_runs {
        let started_at = Instant::now();
        let transcripts =
            transcribe_channels_once(config, &resolved_model.path, &channel_plan.inputs)?;
        wall_ms_runs.push(started_at.elapsed().as_secs_f64() * 1_000.0);
        if first_channel_transcripts.is_empty() {
            first_channel_transcripts = transcripts;
        }
    }
    let vad_boundaries = detect_vad_boundaries_from_wav(
        &config.input_wav,
        config.vad_threshold,
        config.vad_min_speech_ms,
        config.vad_min_silence_ms,
    )?;
    let mut degradation_events = channel_plan.degradation_events;
    let (mut events, chunk_queue) = if config.live_chunked {
        let live_chunked = build_live_chunked_events_with_queue(
            &first_channel_transcripts,
            &vad_boundaries,
            config.chunk_window_ms,
            config.chunk_stride_ms,
            config.chunk_queue_cap,
        );
        if live_chunked.telemetry.dropped_oldest > 0 {
            degradation_events.push(ModeDegradationEvent {
                code: LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE,
                detail: format!(
                    "near-live ASR chunk queue dropped {} oldest task(s) under pressure (cap={}, submitted={}, processed={})",
                    live_chunked.telemetry.dropped_oldest,
                    live_chunked.telemetry.max_queue,
                    live_chunked.telemetry.submitted,
                    live_chunked.telemetry.processed
                ),
            });
        }
        (merge_transcript_events(live_chunked.events), live_chunked.telemetry)
    } else {
        (
            merge_transcript_events(
                first_channel_transcripts
                    .iter()
                    .flat_map(|transcript| {
                        build_transcript_events(
                            &transcript.text,
                            &vad_boundaries,
                            &transcript.label,
                            transcript.role,
                            false,
                            config.chunk_window_ms,
                            config.chunk_stride_ms,
                        )
                    })
                    .collect(),
            ),
            LiveChunkQueueTelemetry::disabled(config),
        )
    };
    let cleanup_run = run_cleanup_queue(config, &events);
    events.extend(cleanup_run.llm_events);
    let events = merge_transcript_events(events);
    let cleanup_queue = cleanup_run.telemetry;
    degradation_events.extend(collect_live_capture_continuity_events(config));
    let trust_notices = build_trust_notices(
        config.channel_mode,
        channel_plan.active_mode,
        &degradation_events,
        &cleanup_queue,
        &chunk_queue,
    );
    let transcript_text = reconstruct_transcript(&events);
    let (benchmark_summary_csv, benchmark_runs_csv, benchmark) = write_benchmark_artifact(
        &stamp,
        backend_id,
        benchmark_track(channel_plan.active_mode),
        &wall_ms_runs,
    )?;

    let report = LiveRunReport {
        generated_at_utc,
        backend_id,
        resolved_model_path: resolved_model.path,
        resolved_model_source: resolved_model.source,
        channel_mode: config.channel_mode,
        active_channel_mode: channel_plan.active_mode,
        transcript_text,
        channel_transcripts: first_channel_transcripts,
        vad_boundaries,
        events,
        degradation_events,
        trust_notices,
        chunk_queue,
        cleanup_queue,
        benchmark,
        benchmark_summary_csv,
        benchmark_runs_csv,
    };

    write_runtime_jsonl(config, &report)?;
    write_runtime_manifest(config, &report)?;
    Ok(report)
}

fn prepare_channel_inputs(
    config: &TranscribeConfig,
    stamp: &str,
) -> Result<ChannelInputPlanResult, CliError> {
    match config.channel_mode {
        ChannelMode::Mixed => Ok(ChannelInputPlanResult {
            inputs: vec![ChannelInputPlan {
                role: "mixed",
                label: "merged".to_string(),
                audio_path: config.input_wav.clone(),
            }],
            active_mode: ChannelMode::Mixed,
            degradation_events: Vec::new(),
        }),
        ChannelMode::Separate => Ok(ChannelInputPlanResult {
            inputs: prepare_separate_channel_inputs(
                &config.input_wav,
                &config.speaker_labels,
                stamp,
            )?,
            active_mode: ChannelMode::Separate,
            degradation_events: Vec::new(),
        }),
        ChannelMode::MixedFallback => {
            let channel_count = wav_channel_count(&config.input_wav)?;
            if channel_count < 2 {
                Ok(ChannelInputPlanResult {
                    inputs: vec![ChannelInputPlan {
                        role: "mixed",
                        label: "merged".to_string(),
                        audio_path: config.input_wav.clone(),
                    }],
                    active_mode: ChannelMode::Mixed,
                    degradation_events: vec![ModeDegradationEvent {
                        code: "fallback_to_mixed",
                        detail: format!(
                            "requested mixed-fallback but input had {channel_count} channel(s); using merged mixed mode"
                        ),
                    }],
                })
            } else {
                Ok(ChannelInputPlanResult {
                    inputs: prepare_separate_channel_inputs(
                        &config.input_wav,
                        &config.speaker_labels,
                        stamp,
                    )?,
                    active_mode: ChannelMode::Separate,
                    degradation_events: Vec::new(),
                })
            }
        }
    }
}

fn prepare_separate_channel_inputs(
    input_wav: &Path,
    speaker_labels: &SpeakerLabels,
    stamp: &str,
) -> Result<Vec<ChannelInputPlan>, CliError> {
    let channel_count = wav_channel_count(input_wav)?;
    if channel_count < 2 {
        return Ok(vec![
            ChannelInputPlan {
                role: "mic",
                label: speaker_labels.mic.clone(),
                audio_path: input_wav.to_path_buf(),
            },
            ChannelInputPlan {
                role: "system",
                label: speaker_labels.system.clone(),
                audio_path: input_wav.to_path_buf(),
            },
        ]);
    }

    let slice_dir = PathBuf::from("artifacts")
        .join("transcribe-live-channel-slices")
        .join(stamp);
    fs::create_dir_all(&slice_dir).map_err(|err| {
        CliError::new(format!(
            "failed to create channel slice directory {}: {err}",
            slice_dir.display()
        ))
    })?;

    let mic_path = slice_dir.join("mic.wav");
    let system_path = slice_dir.join("system.wav");
    extract_channel_wav(input_wav, 0, &mic_path)?;
    extract_channel_wav(input_wav, 1, &system_path)?;

    Ok(vec![
        ChannelInputPlan {
            role: "mic",
            label: speaker_labels.mic.clone(),
            audio_path: mic_path,
        },
        ChannelInputPlan {
            role: "system",
            label: speaker_labels.system.clone(),
            audio_path: system_path,
        },
    ])
}

fn wav_channel_count(path: &Path) -> Result<u16, CliError> {
    let reader = WavReader::open(path).map_err(|err| {
        CliError::new(format!(
            "failed to inspect WAV {}: {err}",
            display_path(path)
        ))
    })?;
    Ok(reader.spec().channels)
}

fn extract_channel_wav(
    input_wav: &Path,
    channel_index: usize,
    output_wav: &Path,
) -> Result<(), CliError> {
    if let Some(parent) = output_wav.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create channel output directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    let mut reader = WavReader::open(input_wav).map_err(|err| {
        CliError::new(format!(
            "failed to open WAV {} for channel extraction: {err}",
            display_path(input_wav)
        ))
    })?;
    let spec = reader.spec();
    let channel_count = spec.channels as usize;
    if channel_index >= channel_count {
        return Err(CliError::new(format!(
            "cannot extract channel {} from {} channel WAV {}",
            channel_index,
            channel_count,
            display_path(input_wav)
        )));
    }

    let mono_spec = hound::WavSpec {
        channels: 1,
        sample_rate: spec.sample_rate,
        bits_per_sample: spec.bits_per_sample,
        sample_format: spec.sample_format,
    };
    let mut writer = hound::WavWriter::create(output_wav, mono_spec).map_err(|err| {
        CliError::new(format!(
            "failed to create channel WAV {}: {err}",
            display_path(output_wav)
        ))
    })?;

    match spec.sample_format {
        SampleFormat::Float => {
            for (idx, sample) in reader.samples::<f32>().enumerate() {
                let sample = sample
                    .map_err(|err| CliError::new(format!("failed to read float sample: {err}")))?;
                if idx % channel_count == channel_index {
                    writer.write_sample(sample).map_err(|err| {
                        CliError::new(format!("failed to write float sample: {err}"))
                    })?;
                }
            }
        }
        SampleFormat::Int => {
            if spec.bits_per_sample <= 16 {
                for (idx, sample) in reader.samples::<i16>().enumerate() {
                    let sample = sample.map_err(|err| {
                        CliError::new(format!("failed to read i16 sample: {err}"))
                    })?;
                    if idx % channel_count == channel_index {
                        writer.write_sample(sample).map_err(|err| {
                            CliError::new(format!("failed to write i16 sample: {err}"))
                        })?;
                    }
                }
            } else {
                for (idx, sample) in reader.samples::<i32>().enumerate() {
                    let sample = sample.map_err(|err| {
                        CliError::new(format!("failed to read i32 sample: {err}"))
                    })?;
                    if idx % channel_count == channel_index {
                        writer.write_sample(sample).map_err(|err| {
                            CliError::new(format!("failed to write i32 sample: {err}"))
                        })?;
                    }
                }
            }
        }
    }

    writer
        .finalize()
        .map_err(|err| CliError::new(format!("failed to finalize channel WAV: {err}")))?;
    Ok(())
}

fn transcribe_channels_once(
    config: &TranscribeConfig,
    resolved_model_path: &Path,
    channel_inputs: &[ChannelInputPlan],
) -> Result<Vec<ChannelTranscriptSummary>, CliError> {
    let mut handles = Vec::with_capacity(channel_inputs.len());
    for input in channel_inputs.iter().cloned() {
        let backend = config.asr_backend;
        let model_path = resolved_model_path.to_path_buf();
        let language = config.asr_language.clone();
        let threads = config.asr_threads;
        handles.push(thread::spawn(
            move || -> Result<ChannelTranscriptSummary, CliError> {
                let adapter = select_adapter(backend)?;
                let text = adapter.transcribe(&AsrRequest {
                    model_path: &model_path,
                    audio_path: &input.audio_path,
                    language: &language,
                    threads,
                })?;
                Ok(ChannelTranscriptSummary {
                    role: input.role,
                    label: input.label,
                    text,
                })
            },
        ));
    }

    let mut summaries = Vec::with_capacity(handles.len());
    for handle in handles {
        let summary = handle
            .join()
            .map_err(|_| CliError::new("dual-channel worker panicked during transcription"))??;
        summaries.push(summary);
    }
    summaries.sort_by(|a, b| {
        channel_sort_key(a.role)
            .cmp(&channel_sort_key(b.role))
            .then_with(|| a.label.cmp(&b.label))
    });
    Ok(summaries)
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
    let start_ms = vad_boundaries.first().map(|v| v.start_ms).unwrap_or(0);
    let end_ms = vad_boundaries.last().map(|v| v.end_ms).unwrap_or(0);
    let chunks = build_rolling_chunk_windows(start_ms, end_ms, chunk_window_ms, chunk_stride_ms);
    if chunks.is_empty() || channel_transcripts.is_empty() {
        return LiveChunkBuildResult {
            events: Vec::new(),
            telemetry: LiveChunkQueueTelemetry::enabled(chunk_queue_cap),
        };
    }

    let mut tasks = Vec::with_capacity(chunks.len() * channel_transcripts.len());
    for chunk in &chunks {
        for transcript in channel_transcripts {
            tasks.push(LiveChunkTask {
                tick_index: chunk.index,
                channel: transcript.label.clone(),
                segment_id: near_live_segment_id(transcript.role, chunk),
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                text: chunk_scoped_text(&transcript.text, chunk.index, chunks.len()),
            });
        }
    }
    tasks.sort_by(|a, b| {
        a.tick_index
            .cmp(&b.tick_index)
            .then_with(|| a.start_ms.cmp(&b.start_ms))
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.segment_id.cmp(&b.segment_id))
    });

    run_live_chunk_queue(tasks, chunk_queue_cap)
}

fn run_live_chunk_queue(tasks: Vec<LiveChunkTask>, chunk_queue_cap: usize) -> LiveChunkBuildResult {
    let mut telemetry = LiveChunkQueueTelemetry::enabled(chunk_queue_cap);
    let mut events = Vec::with_capacity(tasks.len() * 2);
    let mut queue = VecDeque::new();
    let mut last_tick_index: Option<usize> = None;

    for task in tasks {
        telemetry.submitted += 1;
        if last_tick_index != Some(task.tick_index) {
            process_next_live_chunk_task(&mut queue, &mut events, &mut telemetry);
            last_tick_index = Some(task.tick_index);
        }
        enqueue_live_chunk_task(&mut queue, task, &mut telemetry);
    }
    while !queue.is_empty() {
        process_next_live_chunk_task(&mut queue, &mut events, &mut telemetry);
    }

    telemetry.pending = queue.len();
    telemetry.drain_completed = telemetry.pending == 0;
    LiveChunkBuildResult { events, telemetry }
}

fn enqueue_live_chunk_task(
    queue: &mut VecDeque<LiveChunkTask>,
    task: LiveChunkTask,
    telemetry: &mut LiveChunkQueueTelemetry,
) {
    if telemetry.max_queue == 0 {
        telemetry.dropped_oldest += 1;
        return;
    }
    if queue.len() >= telemetry.max_queue {
        queue.pop_front();
        telemetry.dropped_oldest += 1;
    }
    queue.push_back(task);
    telemetry.enqueued += 1;
    telemetry.high_water = telemetry.high_water.max(queue.len());
}

fn process_next_live_chunk_task(
    queue: &mut VecDeque<LiveChunkTask>,
    events: &mut Vec<TranscriptEvent>,
    telemetry: &mut LiveChunkQueueTelemetry,
) {
    let Some(task) = queue.pop_front() else {
        return;
    };

    telemetry.processed += 1;
    let partial_end_ms = task.start_ms + ((task.end_ms.saturating_sub(task.start_ms)) / 2);
    events.push(TranscriptEvent {
        event_type: "partial",
        channel: task.channel.clone(),
        segment_id: task.segment_id.clone(),
        start_ms: task.start_ms,
        end_ms: partial_end_ms,
        text: partial_text(&task.text),
        source_final_segment_id: None,
    });
    events.push(TranscriptEvent {
        event_type: "final",
        channel: task.channel,
        segment_id: task.segment_id,
        start_ms: task.start_ms,
        end_ms: task.end_ms,
        text: task.text,
        source_final_segment_id: None,
    });
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
            let chunk_end_ms = chunk_start_ms.saturating_add(effective_window_ms).min(end_ms);
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

fn merge_transcript_events(mut events: Vec<TranscriptEvent>) -> Vec<TranscriptEvent> {
    events.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.end_ms.cmp(&b.end_ms))
            .then_with(|| event_type_rank(a.event_type).cmp(&event_type_rank(b.event_type)))
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.segment_id.cmp(&b.segment_id))
            .then_with(|| a.text.cmp(&b.text))
    });
    events
}

fn event_type_rank(event_type: &str) -> u8 {
    match event_type {
        "partial" => 0,
        "final" => 1,
        "llm_final" => 2,
        _ => 3,
    }
}

fn reconstruct_transcript(events: &[TranscriptEvent]) -> String {
    let finals = final_events_for_display(events);
    let mut lines = Vec::new();
    let mut previous: Option<&TranscriptEvent> = None;
    for event in finals {
        let text = event.text.trim();
        if text.is_empty() {
            continue;
        }
        let overlap_suffix = if let Some(prev) = previous {
            if has_near_simultaneous_overlap(prev, event) {
                format!(" (overlap<={OVERLAP_WINDOW_MS}ms with {})", prev.channel)
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        lines.push(format!(
            "[{}-{}] {}: {}{}",
            format_timestamp(event.start_ms),
            format_timestamp(event.end_ms),
            event.channel,
            text,
            overlap_suffix
        ));
        previous = Some(event);
    }

    if lines.is_empty() {
        "<no speech detected>".to_string()
    } else {
        lines.join("\n")
    }
}

fn reconstruct_transcript_per_channel(
    events: &[TranscriptEvent],
) -> Vec<ReadableChannelTranscript> {
    let finals = final_events_for_display(events);
    let mut channels = finals
        .iter()
        .map(|event| event.channel.clone())
        .collect::<Vec<_>>();
    channels.sort_by(|a, b| {
        channel_display_sort_key(a)
            .cmp(&channel_display_sort_key(b))
            .then_with(|| a.cmp(b))
    });
    channels.dedup();

    channels
        .into_iter()
        .filter_map(|channel| {
            let mut lines = Vec::new();
            for event in finals.iter().filter(|event| event.channel == channel) {
                let text = event.text.trim();
                if text.is_empty() {
                    continue;
                }
                lines.push(format!(
                    "[{}-{}] {}",
                    format_timestamp(event.start_ms),
                    format_timestamp(event.end_ms),
                    text
                ));
            }
            if lines.is_empty() {
                None
            } else {
                Some(ReadableChannelTranscript {
                    channel,
                    text: lines.join("\n"),
                })
            }
        })
        .collect()
}

fn final_events_for_display<'a>(events: &'a [TranscriptEvent]) -> Vec<&'a TranscriptEvent> {
    let mut finals = events
        .iter()
        .filter(|event| event.event_type == "final")
        .collect::<Vec<_>>();
    finals.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.end_ms.cmp(&b.end_ms))
            .then_with(|| {
                channel_display_sort_key(&a.channel).cmp(&channel_display_sort_key(&b.channel))
            })
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.segment_id.cmp(&b.segment_id))
            .then_with(|| a.text.cmp(&b.text))
    });
    finals
}

fn has_near_simultaneous_overlap(previous: &TranscriptEvent, current: &TranscriptEvent) -> bool {
    previous.channel != current.channel
        && current.start_ms.saturating_sub(previous.start_ms) <= OVERLAP_WINDOW_MS
}

fn channel_display_sort_key(channel: &str) -> u8 {
    match channel {
        "mic" => 0,
        "system" => 1,
        "merged" => 2,
        _ => 3,
    }
}

fn format_timestamp(ms: u64) -> String {
    let total_seconds = ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    let millis = ms % 1_000;
    format!("{minutes:02}:{seconds:02}.{millis:03}")
}

fn build_trust_notices(
    requested_mode: ChannelMode,
    active_mode: ChannelMode,
    degradation_events: &[ModeDegradationEvent],
    cleanup_queue: &CleanupQueueTelemetry,
    chunk_queue: &LiveChunkQueueTelemetry,
) -> Vec<TrustNotice> {
    let mut notices = Vec::new();

    for degradation in degradation_events {
        match degradation.code {
            "fallback_to_mixed" => {
                notices.push(TrustNotice {
                    code: "mode_degradation".to_string(),
                    severity: "warn".to_string(),
                    cause: degradation.detail.clone(),
                    impact: if requested_mode != active_mode {
                        format!(
                            "requested channel mode `{requested_mode}` degraded to `{active_mode}`; transcript attribution and separation guarantees are reduced"
                        )
                    } else {
                        "runtime entered degraded channel mode".to_string()
                    },
                    guidance: "Use `--transcribe-channels separate` with a stereo input fixture to restore channel-level attribution.".to_string(),
                });
            }
            LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE => {
                notices.push(TrustNotice {
                    code: "continuity_recovered_with_gaps".to_string(),
                    severity: "warn".to_string(),
                    cause: degradation.detail.clone(),
                    impact:
                        "capture continuity was preserved via bounded restart recovery, but transcript timing/content may contain interruption boundaries".to_string(),
                    guidance:
                        "Inspect continuity telemetry and runtime timeline before treating this session as gap-free.".to_string(),
                });
            }
            LIVE_CAPTURE_CONTINUITY_UNVERIFIED_CODE => {
                notices.push(TrustNotice {
                    code: "continuity_unverified".to_string(),
                    severity: "warn".to_string(),
                    cause: degradation.detail.clone(),
                    impact:
                        "near-live continuity guarantees cannot be fully confirmed for this session".to_string(),
                    guidance:
                        "Ensure capture telemetry is writable/readable and rerun the session to verify interruption recovery state.".to_string(),
                });
            }
            LIVE_CHUNK_QUEUE_DROP_OLDEST_CODE => {
                notices.push(TrustNotice {
                    code: "chunk_queue_backpressure".to_string(),
                    severity: "warn".to_string(),
                    cause: degradation.detail.clone(),
                    impact:
                        "near-live chunk backlog exceeded queue capacity; some oldest chunk tasks were dropped to keep producer non-blocking".to_string(),
                    guidance: format!(
                        "Increase `--chunk-queue-cap` (current={}) or reduce near-live load to lower backlog pressure.",
                        chunk_queue.max_queue
                    ),
                });
            }
            _ => {
                notices.push(TrustNotice {
                    code: degradation.code.to_string(),
                    severity: "warn".to_string(),
                    cause: degradation.detail.clone(),
                    impact: "runtime entered degraded mode".to_string(),
                    guidance: "Inspect degradation details and rerun with recommended defaults."
                        .to_string(),
                });
            }
        }
    }

    if cleanup_queue.enabled {
        if cleanup_queue.dropped_queue_full > 0 {
            notices.push(TrustNotice {
                code: "cleanup_queue_drop".to_string(),
                severity: "warn".to_string(),
                cause: format!(
                    "{} cleanup request(s) dropped due to full queue",
                    cleanup_queue.dropped_queue_full
                ),
                impact:
                    "some `llm_final` readability refinements are missing; raw `final` transcript remains canonical"
                        .to_string(),
                guidance:
                    "Increase `--llm-max-queue`, reduce cleanup load, or disable cleanup for strict throughput runs."
                        .to_string(),
            });
        }

        if cleanup_queue.timed_out > 0 || cleanup_queue.failed > 0 {
            notices.push(TrustNotice {
                code: "cleanup_processing_failure".to_string(),
                severity: "warn".to_string(),
                cause: format!(
                    "cleanup failures detected (timed_out={}, failed={})",
                    cleanup_queue.timed_out, cleanup_queue.failed
                ),
                impact:
                    "cleanup outputs may be incomplete or absent; rely on `final` events for authoritative transcript text"
                        .to_string(),
                guidance:
                    "Validate cleanup endpoint/model health or run with `--llm-cleanup` disabled for deterministic core transcripts."
                        .to_string(),
            });
        }

        if !cleanup_queue.drain_completed || cleanup_queue.pending > 0 {
            notices.push(TrustNotice {
                code: "cleanup_drain_incomplete".to_string(),
                severity: "warn".to_string(),
                cause: format!(
                    "cleanup drain incomplete (pending={}, drain_completed={})",
                    cleanup_queue.pending, cleanup_queue.drain_completed
                ),
                impact:
                    "session ended before all queued cleanup work finished; readability post-processing is partial"
                        .to_string(),
                guidance: "Increase `--llm-timeout-ms` or reduce workload to allow cleanup drain completion."
                    .to_string(),
            });
        }
    }

    notices
}

fn run_cleanup_queue(config: &TranscribeConfig, events: &[TranscriptEvent]) -> CleanupRunResult {
    run_cleanup_queue_with(config, events, invoke_cleanup_endpoint)
}

fn run_cleanup_queue_with<F>(
    config: &TranscribeConfig,
    events: &[TranscriptEvent],
    invoke_cleanup: F,
) -> CleanupRunResult
where
    F: Fn(&CleanupClientConfig, &CleanupRequest) -> CleanupAttemptOutcome + Send + Sync + 'static,
{
    if !config.llm_cleanup {
        return CleanupRunResult {
            telemetry: CleanupQueueTelemetry::disabled(config),
            llm_events: Vec::new(),
        };
    }

    let mut telemetry = CleanupQueueTelemetry {
        enabled: true,
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
        drain_budget_ms: config.llm_timeout_ms,
        drain_completed: true,
    };
    let mut llm_events = Vec::new();

    let Some(endpoint) = config.llm_endpoint.clone() else {
        return CleanupRunResult {
            telemetry,
            llm_events,
        };
    };
    let Some(model) = config.llm_model.clone() else {
        return CleanupRunResult {
            telemetry,
            llm_events,
        };
    };

    let requests = cleanup_requests_from_events(events);
    telemetry.submitted = requests.len();
    if requests.is_empty() {
        return CleanupRunResult {
            telemetry,
            llm_events,
        };
    }

    let client = CleanupClientConfig {
        endpoint,
        model,
        timeout_ms: config.llm_timeout_ms,
        retries: config.llm_retries,
    };
    let (request_tx, request_rx) = sync_channel::<CleanupRequest>(config.llm_max_queue);
    let (result_tx, result_rx) = mpsc::channel::<CleanupTaskResult>();
    let invoke_cleanup = Arc::new(invoke_cleanup);
    let worker_invoke = Arc::clone(&invoke_cleanup);
    let worker_handle = thread::spawn(move || {
        cleanup_worker_loop(request_rx, result_tx, client, worker_invoke);
    });

    for request in requests {
        match request_tx.try_send(request) {
            Ok(()) => telemetry.enqueued += 1,
            Err(TrySendError::Full(_)) => telemetry.dropped_queue_full += 1,
            Err(TrySendError::Disconnected(_)) => telemetry.failed += 1,
        }
    }
    drop(request_tx);

    let drain_deadline = Instant::now() + Duration::from_millis(config.llm_timeout_ms);
    while telemetry.processed < telemetry.enqueued {
        let now = Instant::now();
        if now >= drain_deadline {
            break;
        }
        let remaining = drain_deadline.saturating_duration_since(now);
        let wait_for = remaining.min(Duration::from_millis(5));
        match result_rx.recv_timeout(wait_for) {
            Ok(result) => {
                telemetry.processed += 1;
                telemetry.retry_attempts += result.retry_attempts;
                match result.status {
                    CleanupTaskStatus::Succeeded => {
                        telemetry.succeeded += 1;
                        if let Some(cleaned_text) = result.cleaned_text {
                            let source_segment_id = result.request.segment_id.clone();
                            llm_events.push(TranscriptEvent {
                                event_type: "llm_final",
                                channel: result.request.channel.clone(),
                                segment_id: format!("{source_segment_id}-llm"),
                                start_ms: result.request.start_ms,
                                end_ms: result.request.end_ms,
                                text: cleaned_text,
                                source_final_segment_id: Some(source_segment_id),
                            });
                        }
                    }
                    CleanupTaskStatus::TimedOut => telemetry.timed_out += 1,
                    CleanupTaskStatus::Failed => telemetry.failed += 1,
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    telemetry.pending = telemetry.enqueued.saturating_sub(telemetry.processed);
    telemetry.drain_completed = telemetry.pending == 0;
    if telemetry.drain_completed {
        let _ = worker_handle.join();
    }
    CleanupRunResult {
        telemetry,
        llm_events,
    }
}

fn cleanup_requests_from_events(events: &[TranscriptEvent]) -> Vec<CleanupRequest> {
    events
        .iter()
        .filter(|event| event.event_type == "final")
        .map(|event| CleanupRequest {
            segment_id: event.segment_id.clone(),
            channel: event.channel.clone(),
            start_ms: event.start_ms,
            end_ms: event.end_ms,
            text: event.text.clone(),
        })
        .collect()
}

fn cleanup_worker_loop<F>(
    request_rx: Receiver<CleanupRequest>,
    result_tx: mpsc::Sender<CleanupTaskResult>,
    client: CleanupClientConfig,
    invoke_cleanup: Arc<F>,
) where
    F: Fn(&CleanupClientConfig, &CleanupRequest) -> CleanupAttemptOutcome + Send + Sync + 'static,
{
    while let Ok(request) = request_rx.recv() {
        let mut status = CleanupTaskStatus::Failed;
        let mut retry_attempts = 0usize;
        let mut cleaned_text = None;

        for attempt in 0..=client.retries {
            let outcome = invoke_cleanup(&client, &request);
            status = outcome.status;
            cleaned_text = outcome.cleaned_text;
            if status == CleanupTaskStatus::Succeeded {
                break;
            }
            if attempt < client.retries {
                retry_attempts += 1;
            }
        }

        if result_tx
            .send(CleanupTaskResult {
                request,
                status,
                retry_attempts,
                cleaned_text,
            })
            .is_err()
        {
            break;
        }
    }
}

fn invoke_cleanup_endpoint(
    client: &CleanupClientConfig,
    request: &CleanupRequest,
) -> CleanupAttemptOutcome {
    let timeout_secs = format!("{:.3}", (client.timeout_ms as f64 / 1_000.0).max(0.001));
    let prompt = format!(
        "Polish this transcript segment for readability without changing meaning. Return only cleaned text.\nsegment_id={}\nchannel={}\ntext={}",
        request.segment_id, request.channel, request.text
    );
    let payload = format!(
        "{{\"model\":\"{}\",\"messages\":[{{\"role\":\"system\",\"content\":\"{}\"}},{{\"role\":\"user\",\"content\":\"{}\"}}],\"stream\":false}}",
        json_escape(&client.model),
        json_escape("You clean transcript text. Do not add content."),
        json_escape(&prompt)
    );

    let output = Command::new("curl")
        .arg("-sS")
        .arg("--fail-with-body")
        .arg("--max-time")
        .arg(&timeout_secs)
        .arg("-X")
        .arg("POST")
        .arg(&client.endpoint)
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg("-d")
        .arg(&payload)
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let cleaned_text = extract_json_string_field(&stdout, "content")
                .or_else(|| {
                    if stdout.is_empty() {
                        None
                    } else {
                        Some(stdout.clone())
                    }
                })
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            match cleaned_text {
                Some(text) => CleanupAttemptOutcome {
                    status: CleanupTaskStatus::Succeeded,
                    cleaned_text: Some(text),
                },
                None => CleanupAttemptOutcome {
                    status: CleanupTaskStatus::Failed,
                    cleaned_text: None,
                },
            }
        }
        Ok(output) if output.status.code() == Some(28) => CleanupAttemptOutcome {
            status: CleanupTaskStatus::TimedOut,
            cleaned_text: None,
        },
        Ok(_) => CleanupAttemptOutcome {
            status: CleanupTaskStatus::Failed,
            cleaned_text: None,
        },
        Err(_) => CleanupAttemptOutcome {
            status: CleanupTaskStatus::Failed,
            cleaned_text: None,
        },
    }
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
) -> Result<(PathBuf, PathBuf, BenchmarkSummary), CliError> {
    if wall_ms_runs.is_empty() {
        return Err(CliError::new(
            "cannot write benchmark artifact with zero runs",
        ));
    }

    let run_dir = PathBuf::from("artifacts")
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

fn validate_model_path_for_backend(
    config: &TranscribeConfig,
) -> Result<ResolvedModelPath, CliError> {
    let resolved = resolve_model_path(config)?;
    match config.asr_backend {
        AsrBackend::WhisperCpp => {
            if !resolved.path.is_file() {
                return Err(CliError::new(format!(
                    "`--asr-backend whispercpp` expects a model file path, got {} (resolved via {}). Remediation: pass a valid file path{}",
                    display_path(&resolved.path),
                    resolved.source,
                    if resolved.source == "cli --asr-model" {
                        " or omit `--asr-model` to allow default resolution"
                    } else {
                        ""
                    }
                )));
            }
        }
        AsrBackend::WhisperKit => {
            if !resolved.path.is_dir() {
                return Err(CliError::new(format!(
                    "`--asr-backend whisperkit` expects a model directory path, got {} (resolved via {}). Remediation: pass a valid directory path{}",
                    display_path(&resolved.path),
                    resolved.source,
                    if resolved.source == "cli --asr-model" {
                        " or omit `--asr-model` to allow default resolution"
                    } else {
                        ""
                    }
                )));
            }
        }
        AsrBackend::Moonshine => {}
    }
    Ok(resolved)
}

fn resolve_model_path(config: &TranscribeConfig) -> Result<ResolvedModelPath, CliError> {
    if !config.asr_model.as_os_str().is_empty() {
        let resolved = absolutize_candidate(config.asr_model.clone());
        if !resolved.exists() {
            return Err(CliError::new(format!(
                "explicit `--asr-model` path does not exist: {}. Expected {} for backend `{}`. Remediation: pass a valid {} path or omit `--asr-model` to allow default resolution.",
                display_path(&resolved),
                expected_model_kind(config.asr_backend),
                config.asr_backend,
                expected_model_kind(config.asr_backend)
            )));
        }
        return Ok(ResolvedModelPath {
            path: resolved,
            source: "cli --asr-model".to_string(),
        });
    }

    let mut candidates: Vec<(PathBuf, String)> = Vec::new();
    if let Ok(env_model) = env::var("RECORDIT_ASR_MODEL") {
        if !env_model.trim().is_empty() {
            candidates.push((
                PathBuf::from(env_model),
                "env RECORDIT_ASR_MODEL".to_string(),
            ));
        }
    }
    candidates.extend(default_model_candidates(config.asr_backend));

    let mut seen = HashSet::new();
    let mut checked = Vec::new();
    for (candidate, source) in candidates {
        let resolved = absolutize_candidate(candidate);
        let normalized = resolved.to_string_lossy().to_string();
        if !seen.insert(normalized) {
            continue;
        }
        checked.push(display_path(&resolved));
        if resolved.exists() {
            return Ok(ResolvedModelPath {
                path: resolved,
                source,
            });
        }
    }

    Err(CliError::new(format!(
        "unable to resolve ASR model for backend `{}`. Precedence: `--asr-model` > `RECORDIT_ASR_MODEL` > backend defaults. Expected {}. Checked: {}. Remediation: pass `--asr-model <path>` or set `RECORDIT_ASR_MODEL` to a valid {} path.",
        config.asr_backend,
        expected_model_kind(config.asr_backend),
        checked.join(" | "),
        expected_model_kind(config.asr_backend)
    )))
}

fn default_model_candidates(backend: AsrBackend) -> Vec<(PathBuf, String)> {
    let mut candidates = Vec::new();
    let sandbox_root = sandbox_model_root();
    match backend {
        AsrBackend::WhisperCpp => {
            if let Some(root) = &sandbox_root {
                candidates.push((
                    root.join("whispercpp").join("ggml-tiny.en.bin"),
                    "sandbox default".to_string(),
                ));
            }
            candidates.push((
                PathBuf::from("artifacts/bench/models/whispercpp/ggml-tiny.en.bin"),
                "repo benchmark default".to_string(),
            ));
            candidates.push((
                PathBuf::from("models/ggml-tiny.en.bin"),
                "repo local models default".to_string(),
            ));
        }
        AsrBackend::WhisperKit => {
            if let Some(root) = &sandbox_root {
                candidates.push((
                    root.join("whisperkit")
                        .join("models/argmaxinc/whisperkit-coreml/openai_whisper-tiny"),
                    "sandbox default".to_string(),
                ));
            }
            candidates.push((
                PathBuf::from(
                    "artifacts/bench/models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-tiny",
                ),
                "repo benchmark default".to_string(),
            ));
            candidates.push((
                PathBuf::from("models/whisperkit/openai_whisper-tiny"),
                "repo local models default".to_string(),
            ));
        }
        AsrBackend::Moonshine => {
            if let Some(root) = &sandbox_root {
                candidates.push((
                    root.join("moonshine").join("base"),
                    "sandbox default".to_string(),
                ));
            }
            candidates.push((
                PathBuf::from("artifacts/bench/models/moonshine/base"),
                "repo benchmark default".to_string(),
            ));
            candidates.push((
                PathBuf::from("models/moonshine/base"),
                "repo local models default".to_string(),
            ));
        }
    }
    candidates
}

fn sandbox_model_root() -> Option<PathBuf> {
    env::var("HOME").ok().map(|home| {
        PathBuf::from(home).join("Library/Containers/com.recordit.sequoiatranscribe/Data/models")
    })
}

fn absolutize_candidate(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    match env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path,
    }
}

fn expected_model_kind(backend: AsrBackend) -> &'static str {
    match backend {
        AsrBackend::WhisperCpp => "file",
        AsrBackend::WhisperKit => "directory",
        AsrBackend::Moonshine => "file/directory",
    }
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

fn sha256_file_hex(path: &Path) -> Result<String, CliError> {
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

fn prepare_runtime_input_wav(config: &TranscribeConfig) -> Result<(), CliError> {
    if config.live_chunked {
        run_live_capture_session(config)
    } else {
        prepare_input_wav(&config.input_wav)
    }
}

fn run_live_capture_session(config: &TranscribeConfig) -> Result<(), CliError> {
    if let Some(parent) = config.input_wav.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create live capture output directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    let launcher_paths = sequoia_capture_binary_candidates();
    for path in launcher_paths {
        if path.is_file() {
            let mut command = Command::new(&path);
            command.args(live_capture_cli_args(config));
            execute_live_capture_command(command, &format!("binary `{}`", path.display()))?;
            return ensure_live_capture_output_exists(&config.input_wav);
        }
    }

    let mut fallback = Command::new("cargo");
    fallback.args(["run", "--quiet", "--bin", "sequoia_capture", "--"]);
    fallback.args(live_capture_cli_args(config));
    execute_live_capture_command(fallback, "cargo-run fallback")?;
    ensure_live_capture_output_exists(&config.input_wav)
}

fn live_capture_cli_args(config: &TranscribeConfig) -> Vec<String> {
    vec![
        config.duration_sec.to_string(),
        config.input_wav.to_string_lossy().to_string(),
        config.sample_rate_hz.to_string(),
        LIVE_CAPTURE_SAMPLE_RATE_POLICY.to_string(),
        LIVE_CAPTURE_CALLBACK_MODE.to_string(),
    ]
}

fn sequoia_capture_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join("sequoia_capture"));
        }
    }
    candidates.push(PathBuf::from("target/debug/sequoia_capture"));
    candidates.push(PathBuf::from("target/release/sequoia_capture"));
    candidates
}

fn execute_live_capture_command(
    mut command: Command,
    launcher_label: &str,
) -> Result<(), CliError> {
    if env::var_os("DYLD_LIBRARY_PATH").is_none() {
        command.env("DYLD_LIBRARY_PATH", "/usr/lib/swift");
    }

    let output = command.output().map_err(|err| {
        CliError::new(format!(
            "failed to start live capture session via {launcher_label}: {err}"
        ))
    })?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CliError::new(format!(
            "live capture session failed via {launcher_label} with status {}. stdout=`{}` stderr=`{}`",
            output.status,
            clean_field(stdout.trim()),
            clean_field(stderr.trim()),
        )));
    }

    Ok(())
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
    if !config.live_chunked {
        return Vec::new();
    }

    let telemetry_path = live_capture_telemetry_path(&config.input_wav);
    match load_live_capture_restart_count(&telemetry_path) {
        Ok(restart_count) if restart_count > 0 => vec![ModeDegradationEvent {
            code: LIVE_CAPTURE_INTERRUPTION_RECOVERED_CODE,
            detail: format!(
                "near-live capture recovered from {restart_count} stream interruption restart(s) under bounded restart policy; continuity may include restart gaps (telemetry={})",
                display_path(&telemetry_path)
            ),
        }],
        Ok(_) => Vec::new(),
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

fn live_capture_telemetry_path(output_wav: &Path) -> PathBuf {
    let stem = output_wav
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("capture");
    let parent = output_wav
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}.telemetry.json"))
}

fn load_live_capture_restart_count(telemetry_path: &Path) -> Result<u64, CliError> {
    let payload = fs::read_to_string(telemetry_path).map_err(|err| {
        CliError::new(format!(
            "failed to read live capture telemetry {}: {err}",
            display_path(telemetry_path)
        ))
    })?;
    extract_json_u64_field(&payload, "restart_count").ok_or_else(|| {
        CliError::new(format!(
            "live capture telemetry {} is missing `restart_count`",
            display_path(telemetry_path)
        ))
    })
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
    let mut frame_levels = Vec::with_capacity(normalized_samples.len() / channels + 1);
    for frame in normalized_samples.chunks(channels) {
        let mean_abs = frame.iter().map(|value| value.abs()).sum::<f32>() / frame.len() as f32;
        frame_levels.push(mean_abs.clamp(0.0, 1.0));
    }

    Ok(detect_vad_boundaries(
        &frame_levels,
        spec.sample_rate,
        threshold,
        min_speech_ms,
        min_silence_ms,
    ))
}

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

    let min_speech_samples =
        ((sample_rate_hz as u64 * min_speech_ms as u64) / 1_000).max(1) as usize;
    let min_silence_samples =
        ((sample_rate_hz as u64 * min_silence_ms as u64) / 1_000).max(1) as usize;

    let mut boundaries = Vec::new();
    let mut in_speech = false;
    let mut speech_run = 0usize;
    let mut silence_run = 0usize;
    let mut segment_start_idx = 0usize;

    for (idx, level) in frame_levels.iter().enumerate() {
        let is_speech = *level >= threshold;
        if !in_speech {
            if is_speech {
                speech_run += 1;
                if speech_run >= min_speech_samples {
                    in_speech = true;
                    segment_start_idx = idx + 1 - speech_run;
                    silence_run = 0;
                }
            } else {
                speech_run = 0;
            }
            continue;
        }

        if is_speech {
            silence_run = 0;
        } else {
            silence_run += 1;
            if silence_run >= min_silence_samples {
                let end_idx = idx + 1 - silence_run;
                if end_idx > segment_start_idx {
                    boundaries.push(VadBoundary {
                        id: boundaries.len(),
                        start_ms: sample_to_ms(segment_start_idx as u64, sample_rate_hz),
                        end_ms: sample_to_ms(end_idx as u64, sample_rate_hz),
                        source: "energy_threshold",
                    });
                }
                in_speech = false;
                speech_run = 0;
                silence_run = 0;
            }
        }
    }

    if in_speech {
        boundaries.push(VadBoundary {
            id: boundaries.len(),
            start_ms: sample_to_ms(segment_start_idx as u64, sample_rate_hz),
            end_ms: sample_to_ms(frame_levels.len() as u64, sample_rate_hz),
            source: "energy_threshold",
        });
    }

    if boundaries.is_empty() {
        boundaries.push(VadBoundary {
            id: 0,
            start_ms: 0,
            end_ms: sample_to_ms(frame_levels.len() as u64, sample_rate_hz),
            source: "fallback_full_audio",
        });
    }

    boundaries
}

fn sample_to_ms(sample_idx: u64, sample_rate_hz: u32) -> u64 {
    sample_idx.saturating_mul(1_000) / sample_rate_hz.max(1) as u64
}

fn print_live_report(report: &LiveRunReport) {
    let per_channel_defaults = reconstruct_transcript_per_channel(&report.events);
    let model_checksum = model_checksum_info(Some(&ResolvedModelPath {
        path: report.resolved_model_path.clone(),
        source: report.resolved_model_source.clone(),
    }));

    println!();
    println!("Representative runtime result");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  backend: {}", report.backend_id);
    println!(
        "  asr_model_resolved: {}",
        report.resolved_model_path.display()
    );
    println!("  asr_model_source: {}", report.resolved_model_source);
    println!("  asr_model_checksum_sha256: {}", model_checksum.sha256);
    println!("  asr_model_checksum_status: {}", model_checksum.status);
    println!("  channel_mode_requested: {}", report.channel_mode);
    println!("  channel_mode_active: {}", report.active_channel_mode);
    println!("  transcript_default_line_format: [MM:SS.mmm-MM:SS.mmm] <channel>: <text>");
    println!(
        "  transcript_overlap_policy: adjacent cross-channel finals within {OVERLAP_WINDOW_MS}ms keep sort order and add overlap annotation"
    );
    println!("  transcript_text:");
    for line in report.transcript_text.lines() {
        println!("    {line}");
    }
    println!("  transcript_per_channel:");
    for channel in &per_channel_defaults {
        println!("    - channel={}", channel.channel);
        for line in channel.text.lines() {
            println!("      {line}");
        }
    }
    println!("  channel_transcripts:");
    for channel in &report.channel_transcripts {
        println!(
            "    - role={} label={} text={}",
            channel.role, channel.label, channel.text
        );
    }
    println!(
        "  benchmark_wall_ms: p50={:.2} p95={:.2} (runs={})",
        report.benchmark.wall_ms_p50, report.benchmark.wall_ms_p95, report.benchmark.run_count
    );
    println!(
        "  slo_check: partial_p95<=1500ms={} final_p95<=2500ms={}",
        report.benchmark.partial_slo_met, report.benchmark.final_slo_met
    );
    println!(
        "  benchmark_summary_csv: {}",
        report.benchmark_summary_csv.display()
    );
    println!(
        "  benchmark_runs_csv: {}",
        report.benchmark_runs_csv.display()
    );
    println!("  out_wav_semantics: {OUT_WAV_SEMANTICS}");
    println!("  vad_boundaries: {}", report.vad_boundaries.len());
    for boundary in &report.vad_boundaries {
        println!(
            "    - id={} start_ms={} end_ms={} source={}",
            boundary.id, boundary.start_ms, boundary.end_ms, boundary.source
        );
    }
    println!("  terminal_event_stream:");
    for event in &report.events {
        println!(
            "    {} channel={} [{}-{}ms] {}",
            event.event_type, event.channel, event.start_ms, event.end_ms, event.text
        );
    }
    println!("  degradation_events: {}", report.degradation_events.len());
    for event in &report.degradation_events {
        println!("    - code={} detail={}", event.code, event.detail);
    }
    println!("  trust_notices: {}", report.trust_notices.len());
    if report.trust_notices.is_empty() {
        println!("    - none (runtime trust posture: nominal)");
    } else {
        println!("  degraded_mode_notices:");
        for notice in &report.trust_notices {
            println!(
                "    - [{}] code={} cause={} | impact={} | next={}",
                notice.severity, notice.code, notice.cause, notice.impact, notice.guidance
            );
        }
    }
    println!(
        "  cleanup_queue: enabled={} submitted={} enqueued={} dropped_queue_full={} processed={} succeeded={} timed_out={} failed={} retry_attempts={} pending={} drain_completed={}",
        report.cleanup_queue.enabled,
        report.cleanup_queue.submitted,
        report.cleanup_queue.enqueued,
        report.cleanup_queue.dropped_queue_full,
        report.cleanup_queue.processed,
        report.cleanup_queue.succeeded,
        report.cleanup_queue.timed_out,
        report.cleanup_queue.failed,
        report.cleanup_queue.retry_attempts,
        report.cleanup_queue.pending,
        report.cleanup_queue.drain_completed
    );
    println!("  jsonl_written: true");
    println!("  manifest_written: true");
}

fn write_runtime_jsonl(config: &TranscribeConfig, report: &LiveRunReport) -> Result<(), CliError> {
    if let Some(parent) = config.out_jsonl.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create JSONL directory {}: {err}",
                parent.display()
            ))
        })?;
    }
    let mut file = File::create(&config.out_jsonl).map_err(|err| {
        CliError::new(format!(
            "failed to create JSONL file {}: {err}",
            display_path(&config.out_jsonl)
        ))
    })?;

    for boundary in &report.vad_boundaries {
        writeln!(
            file,
            "{{\"event_type\":\"vad_boundary\",\"channel\":\"merged\",\"boundary_id\":{},\"start_ms\":{},\"end_ms\":{},\"source\":\"{}\",\"vad_backend\":\"{}\",\"vad_threshold\":{:.3}}}",
            boundary.id,
            boundary.start_ms,
            boundary.end_ms,
            json_escape(boundary.source),
            json_escape(&config.vad_backend.to_string()),
            config.vad_threshold,
        )
        .map_err(io_to_cli)?;
    }

    for event in &report.events {
        if let Some(source_segment_id) = &event.source_final_segment_id {
            writeln!(
                file,
                "{{\"event_type\":\"{}\",\"channel\":\"{}\",\"segment_id\":\"{}\",\"source_final_segment_id\":\"{}\",\"start_ms\":{},\"end_ms\":{},\"text\":\"{}\",\"asr_backend\":\"{}\",\"vad_boundary_count\":{}}}",
                event.event_type,
                event.channel,
                json_escape(&event.segment_id),
                json_escape(source_segment_id),
                event.start_ms,
                event.end_ms,
                json_escape(&event.text),
                json_escape(report.backend_id),
                report.vad_boundaries.len()
            )
            .map_err(io_to_cli)?;
        } else {
            writeln!(
                file,
                "{{\"event_type\":\"{}\",\"channel\":\"{}\",\"segment_id\":\"{}\",\"start_ms\":{},\"end_ms\":{},\"text\":\"{}\",\"asr_backend\":\"{}\",\"vad_boundary_count\":{}}}",
                event.event_type,
                event.channel,
                json_escape(&event.segment_id),
                event.start_ms,
                event.end_ms,
                json_escape(&event.text),
                json_escape(report.backend_id),
                report.vad_boundaries.len()
            )
            .map_err(io_to_cli)?;
        }
    }

    for degradation in &report.degradation_events {
        writeln!(
            file,
            "{{\"event_type\":\"mode_degradation\",\"channel\":\"control\",\"requested_mode\":\"{}\",\"active_mode\":\"{}\",\"code\":\"{}\",\"detail\":\"{}\"}}",
            json_escape(&report.channel_mode.to_string()),
            json_escape(&report.active_channel_mode.to_string()),
            json_escape(degradation.code),
            json_escape(&degradation.detail)
        )
        .map_err(io_to_cli)?;
    }

    for notice in &report.trust_notices {
        writeln!(
            file,
            "{{\"event_type\":\"trust_notice\",\"channel\":\"control\",\"code\":\"{}\",\"severity\":\"{}\",\"cause\":\"{}\",\"impact\":\"{}\",\"guidance\":\"{}\"}}",
            json_escape(&notice.code),
            json_escape(&notice.severity),
            json_escape(&notice.cause),
            json_escape(&notice.impact),
            json_escape(&notice.guidance)
        )
        .map_err(io_to_cli)?;
    }

    writeln!(
        file,
        "{{\"event_type\":\"cleanup_queue\",\"channel\":\"control\",\"enabled\":{},\"max_queue\":{},\"timeout_ms\":{},\"retries\":{},\"submitted\":{},\"enqueued\":{},\"dropped_queue_full\":{},\"processed\":{},\"succeeded\":{},\"timed_out\":{},\"failed\":{},\"retry_attempts\":{},\"pending\":{},\"drain_budget_ms\":{},\"drain_completed\":{}}}",
        report.cleanup_queue.enabled,
        report.cleanup_queue.max_queue,
        report.cleanup_queue.timeout_ms,
        report.cleanup_queue.retries,
        report.cleanup_queue.submitted,
        report.cleanup_queue.enqueued,
        report.cleanup_queue.dropped_queue_full,
        report.cleanup_queue.processed,
        report.cleanup_queue.succeeded,
        report.cleanup_queue.timed_out,
        report.cleanup_queue.failed,
        report.cleanup_queue.retry_attempts,
        report.cleanup_queue.pending,
        report.cleanup_queue.drain_budget_ms,
        report.cleanup_queue.drain_completed
    )
    .map_err(io_to_cli)?;
    Ok(())
}

fn write_runtime_manifest(
    config: &TranscribeConfig,
    report: &LiveRunReport,
) -> Result<(), CliError> {
    if let Some(parent) = config.out_manifest.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create runtime manifest directory {}: {err}",
                parent.display()
            ))
        })?;
    }
    let mut file = File::create(&config.out_manifest).map_err(|err| {
        CliError::new(format!(
            "failed to create runtime manifest {}: {err}",
            display_path(&config.out_manifest)
        ))
    })?;

    let first_start_ms = report
        .vad_boundaries
        .first()
        .map(|v| v.start_ms)
        .unwrap_or(0);
    let last_end_ms = report.vad_boundaries.last().map(|v| v.end_ms).unwrap_or(0);
    let mut event_channels = report
        .events
        .iter()
        .map(|event| event.channel.clone())
        .collect::<Vec<_>>();
    event_channels.sort();
    event_channels.dedup();
    let per_channel_defaults = reconstruct_transcript_per_channel(&report.events);
    let model_checksum = model_checksum_info(Some(&ResolvedModelPath {
        path: report.resolved_model_path.clone(),
        source: report.resolved_model_source.clone(),
    }));

    writeln!(file, "{{").map_err(io_to_cli)?;
    writeln!(file, "  \"schema_version\": \"1\",").map_err(io_to_cli)?;
    writeln!(file, "  \"kind\": \"transcribe-live-runtime\",").map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"generated_at_utc\": \"{}\",",
        json_escape(&report.generated_at_utc)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"asr_backend\": \"{}\",",
        json_escape(report.backend_id)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"asr_model\": \"{}\",",
        json_escape(&display_path(&report.resolved_model_path))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"asr_model_source\": \"{}\",",
        json_escape(&report.resolved_model_source)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"asr_model_checksum_sha256\": \"{}\",",
        json_escape(&model_checksum.sha256)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"asr_model_checksum_status\": \"{}\",",
        json_escape(&model_checksum.status)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"input_wav\": \"{}\",",
        json_escape(&display_path(&config.input_wav))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"out_wav\": \"{}\",",
        json_escape(&display_path(&config.out_wav))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"out_wav_semantics\": \"{}\",",
        json_escape(OUT_WAV_SEMANTICS)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"channel_mode\": \"{}\",",
        json_escape(&report.active_channel_mode.to_string())
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"channel_mode_requested\": \"{}\",",
        json_escape(&report.channel_mode.to_string())
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"runtime_mode\": \"{}\",",
        json_escape(config.runtime_mode_label())
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"live_config\": {{\"live_chunked\":{},\"chunk_window_ms\":{},\"chunk_stride_ms\":{},\"chunk_queue_cap\":{}}},",
        config.live_chunked,
        config.chunk_window_ms,
        config.chunk_stride_ms,
        config.chunk_queue_cap
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"speaker_labels\": [\"{}\",\"{}\"],",
        json_escape(&config.speaker_labels.mic),
        json_escape(&config.speaker_labels.system)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"event_channels\": [{}],",
        event_channels
            .iter()
            .map(|channel| format!("\"{}\"", json_escape(channel)))
            .collect::<Vec<_>>()
            .join(",")
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"vad\": {{\"backend\":\"{}\",\"threshold\":{:.3},\"min_speech_ms\":{},\"min_silence_ms\":{},\"boundary_count\":{}}},",
        json_escape(&config.vad_backend.to_string()),
        config.vad_threshold,
        config.vad_min_speech_ms,
        config.vad_min_silence_ms,
        report.vad_boundaries.len()
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"transcript\": {{\"segment_id\":\"representative-0\",\"start_ms\":{},\"end_ms\":{},\"text\":\"{}\"}},",
        first_start_ms,
        last_end_ms,
        json_escape(&report.transcript_text)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"readability_defaults\": {{\"merged_line_format\":\"[MM:SS.mmm-MM:SS.mmm] <channel>: <text>\",\"near_overlap_window_ms\":{},\"near_overlap_annotation\":\"(overlap<={}ms with <channel>)\",\"ordering\":\"start_ms,end_ms,event_type,channel,segment_id,text\"}},",
        OVERLAP_WINDOW_MS,
        OVERLAP_WINDOW_MS
    )
    .map_err(io_to_cli)?;
    writeln!(file, "  \"transcript_per_channel\": [").map_err(io_to_cli)?;
    for (idx, channel) in per_channel_defaults.iter().enumerate() {
        writeln!(
            file,
            "    {{\"channel\":\"{}\",\"text\":\"{}\"}}{}",
            json_escape(&channel.channel),
            json_escape(&channel.text),
            if idx + 1 == per_channel_defaults.len() {
                ""
            } else {
                ","
            }
        )
        .map_err(io_to_cli)?;
    }
    writeln!(file, "  ],").map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"benchmark\": {{\"run_count\":{},\"wall_ms_p50\":{:.6},\"wall_ms_p95\":{:.6},\"partial_slo_met\":{},\"final_slo_met\":{},\"summary_csv\":\"{}\",\"runs_csv\":\"{}\"}},",
        report.benchmark.run_count,
        report.benchmark.wall_ms_p50,
        report.benchmark.wall_ms_p95,
        report.benchmark.partial_slo_met,
        report.benchmark.final_slo_met,
        json_escape(&report.benchmark_summary_csv.display().to_string()),
        json_escape(&report.benchmark_runs_csv.display().to_string())
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"cleanup_queue\": {{\"enabled\":{},\"max_queue\":{},\"timeout_ms\":{},\"retries\":{},\"submitted\":{},\"enqueued\":{},\"dropped_queue_full\":{},\"processed\":{},\"succeeded\":{},\"timed_out\":{},\"failed\":{},\"retry_attempts\":{},\"pending\":{},\"drain_budget_ms\":{},\"drain_completed\":{}}},",
        report.cleanup_queue.enabled,
        report.cleanup_queue.max_queue,
        report.cleanup_queue.timeout_ms,
        report.cleanup_queue.retries,
        report.cleanup_queue.submitted,
        report.cleanup_queue.enqueued,
        report.cleanup_queue.dropped_queue_full,
        report.cleanup_queue.processed,
        report.cleanup_queue.succeeded,
        report.cleanup_queue.timed_out,
        report.cleanup_queue.failed,
        report.cleanup_queue.retry_attempts,
        report.cleanup_queue.pending,
        report.cleanup_queue.drain_budget_ms,
        report.cleanup_queue.drain_completed
    )
    .map_err(io_to_cli)?;
    writeln!(file, "  \"degradation_events\": [").map_err(io_to_cli)?;
    for (idx, degradation) in report.degradation_events.iter().enumerate() {
        writeln!(file, "    {{").map_err(io_to_cli)?;
        writeln!(
            file,
            "      \"code\": \"{}\",",
            json_escape(degradation.code)
        )
        .map_err(io_to_cli)?;
        writeln!(
            file,
            "      \"detail\": \"{}\"",
            json_escape(&degradation.detail)
        )
        .map_err(io_to_cli)?;
        if idx + 1 == report.degradation_events.len() {
            writeln!(file, "    }}").map_err(io_to_cli)?;
        } else {
            writeln!(file, "    }},").map_err(io_to_cli)?;
        }
    }
    writeln!(file, "  ],").map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"trust\": {{\"degraded_mode_active\":{},\"notice_count\":{},\"notices\": [",
        !report.trust_notices.is_empty(),
        report.trust_notices.len()
    )
    .map_err(io_to_cli)?;
    for (idx, notice) in report.trust_notices.iter().enumerate() {
        writeln!(
            file,
            "    {{\"code\":\"{}\",\"severity\":\"{}\",\"cause\":\"{}\",\"impact\":\"{}\",\"guidance\":\"{}\"}}{}",
            json_escape(&notice.code),
            json_escape(&notice.severity),
            json_escape(&notice.cause),
            json_escape(&notice.impact),
            json_escape(&notice.guidance),
            if idx + 1 == report.trust_notices.len() {
                ""
            } else {
                ","
            }
        )
        .map_err(io_to_cli)?;
    }
    writeln!(file, "  ]}},").map_err(io_to_cli)?;
    let llm_final_count = report
        .events
        .iter()
        .filter(|event| event.event_type == "llm_final")
        .count();
    writeln!(
        file,
        "  \"event_counts\": {{\"vad_boundary\":{},\"transcript\":{},\"llm_final\":{}}},",
        report.vad_boundaries.len(),
        report.events.len(),
        llm_final_count
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"jsonl_path\": \"{}\"",
        json_escape(&display_path(&config.out_jsonl))
    )
    .map_err(io_to_cli)?;
    writeln!(file, "}}").map_err(io_to_cli)?;
    Ok(())
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
        let Some(event_type) = extract_json_string_field(trimmed, "event_type") else {
            continue;
        };
        if event_type == "trust_notice" {
            if let Some(notice) = parse_trust_notice(trimmed) {
                trust_notices.push(notice);
            }
            continue;
        }
        if event_type != "partial" && event_type != "final" {
            continue;
        }

        let segment_id = extract_json_string_field(trimmed, "segment_id").ok_or_else(|| {
            CliError::new(format!(
                "invalid replay line {}: missing segment_id",
                line_no + 1
            ))
        })?;
        let channel =
            extract_json_string_field(trimmed, "channel").unwrap_or_else(|| "merged".to_string());
        let text = extract_json_string_field(trimmed, "text").unwrap_or_default();
        let start_ms = extract_json_u64_field(trimmed, "start_ms").ok_or_else(|| {
            CliError::new(format!(
                "invalid replay line {}: missing start_ms",
                line_no + 1
            ))
        })?;
        let end_ms = extract_json_u64_field(trimmed, "end_ms").ok_or_else(|| {
            CliError::new(format!(
                "invalid replay line {}: missing end_ms",
                line_no + 1
            ))
        })?;
        let event_name = if event_type == "partial" {
            "partial"
        } else {
            "final"
        };
        events.push(TranscriptEvent {
            event_type: event_name,
            channel,
            segment_id,
            start_ms,
            end_ms,
            text,
            source_final_segment_id: None,
        });
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

fn parse_trust_notice(line: &str) -> Option<TrustNotice> {
    Some(TrustNotice {
        code: extract_json_string_field(line, "code")?,
        severity: extract_json_string_field(line, "severity")?,
        cause: extract_json_string_field(line, "cause")?,
        impact: extract_json_string_field(line, "impact")?,
        guidance: extract_json_string_field(line, "guidance")?,
    })
}

fn extract_json_string_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let bytes = line.as_bytes();
    let mut start = line.find(&needle)? + needle.len();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if start >= bytes.len() || bytes[start] != b':' {
        return None;
    }
    start += 1;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if start >= bytes.len() || bytes[start] != b'"' {
        return None;
    }
    start += 1;
    let mut escaped = false;
    let mut result = String::new();
    for ch in line[start..].chars() {
        if escaped {
            let decoded = match ch {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            };
            result.push(decoded);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(result);
        }
        result.push(ch);
    }
    None
}

fn extract_json_u64_field(line: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{}\":", key);
    let start = line.find(&needle)? + needle.len();
    let mut digits = String::new();
    for ch in line[start..].chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if digits.is_empty() {
            continue;
        }
        break;
    }
    digits.parse::<u64>().ok()
}

fn main() -> ExitCode {
    match parse_args() {
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
                            return ExitCode::from(2);
                        }
                        match report.overall_status() {
                            CheckStatus::Fail => ExitCode::from(2),
                            _ => ExitCode::SUCCESS,
                        }
                    }
                    Err(err) => {
                        eprintln!("error: preflight failed unexpectedly: {err}");
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
                            return ExitCode::from(2);
                        }
                    }
                }

                if let Some(replay_path) = &config.replay_jsonl {
                    match replay_timeline(replay_path) {
                        Ok(()) => return ExitCode::SUCCESS,
                        Err(err) => {
                            eprintln!("error: replay failed: {err}");
                            return ExitCode::from(2);
                        }
                    }
                }

                config.print_summary();
                match run_live_pipeline(&config) {
                    Ok(run_report) => {
                        print_live_report(&run_report);
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("error: runtime execution failed: {err}");
                        ExitCode::from(2)
                    }
                }
            }
        }
        Err(err) => {
            eprintln!("error: {err}");
            eprintln!();
            eprintln!("Run `transcribe-live --help` to see the supported contract.");
            ExitCode::from(2)
        }
    }
}

fn parse_args() -> Result<ParseOutcome, CliError> {
    parse_args_from(env::args().skip(1))
}

fn parse_args_from(args: impl Iterator<Item = String>) -> Result<ParseOutcome, CliError> {
    let mut config = TranscribeConfig::default();
    let mut args = args;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(ParseOutcome::Help),
            "--duration-sec" => {
                config.duration_sec =
                    parse_u64(&read_value(&mut args, "--duration-sec")?, "--duration-sec")?;
            }
            "--input-wav" => {
                config.input_wav = PathBuf::from(read_value(&mut args, "--input-wav")?);
            }
            "--out-wav" => {
                config.out_wav = PathBuf::from(read_value(&mut args, "--out-wav")?);
            }
            "--out-jsonl" => {
                config.out_jsonl = PathBuf::from(read_value(&mut args, "--out-jsonl")?);
            }
            "--out-manifest" => {
                config.out_manifest = PathBuf::from(read_value(&mut args, "--out-manifest")?);
            }
            "--sample-rate" => {
                config.sample_rate_hz =
                    parse_u32(&read_value(&mut args, "--sample-rate")?, "--sample-rate")?;
            }
            "--asr-backend" => {
                config.asr_backend = AsrBackend::parse(&read_value(&mut args, "--asr-backend")?)?;
            }
            "--asr-model" => {
                config.asr_model = PathBuf::from(read_value(&mut args, "--asr-model")?);
            }
            "--asr-language" => {
                config.asr_language = read_value(&mut args, "--asr-language")?;
            }
            "--asr-threads" => {
                config.asr_threads =
                    parse_usize(&read_value(&mut args, "--asr-threads")?, "--asr-threads")?;
            }
            "--asr-profile" => {
                config.asr_profile = AsrProfile::parse(&read_value(&mut args, "--asr-profile")?)?;
            }
            "--vad-backend" => {
                config.vad_backend = VadBackend::parse(&read_value(&mut args, "--vad-backend")?)?;
            }
            "--vad-threshold" => {
                config.vad_threshold = parse_f32(
                    &read_value(&mut args, "--vad-threshold")?,
                    "--vad-threshold",
                )?;
            }
            "--vad-min-speech-ms" => {
                config.vad_min_speech_ms = parse_u32(
                    &read_value(&mut args, "--vad-min-speech-ms")?,
                    "--vad-min-speech-ms",
                )?;
            }
            "--vad-min-silence-ms" => {
                config.vad_min_silence_ms = parse_u32(
                    &read_value(&mut args, "--vad-min-silence-ms")?,
                    "--vad-min-silence-ms",
                )?;
            }
            "--llm-cleanup" => {
                config.llm_cleanup = true;
            }
            "--llm-endpoint" => {
                config.llm_endpoint = Some(read_value(&mut args, "--llm-endpoint")?);
            }
            "--llm-model" => {
                config.llm_model = Some(read_value(&mut args, "--llm-model")?);
            }
            "--llm-timeout-ms" => {
                config.llm_timeout_ms = parse_u64(
                    &read_value(&mut args, "--llm-timeout-ms")?,
                    "--llm-timeout-ms",
                )?;
            }
            "--llm-max-queue" => {
                config.llm_max_queue = parse_usize(
                    &read_value(&mut args, "--llm-max-queue")?,
                    "--llm-max-queue",
                )?;
            }
            "--llm-retries" => {
                config.llm_retries =
                    parse_usize(&read_value(&mut args, "--llm-retries")?, "--llm-retries")?;
            }
            "--live-chunked" => {
                config.live_chunked = true;
            }
            "--chunk-window-ms" => {
                config.chunk_window_ms = parse_u64(
                    &read_value(&mut args, "--chunk-window-ms")?,
                    "--chunk-window-ms",
                )?;
            }
            "--chunk-stride-ms" => {
                config.chunk_stride_ms = parse_u64(
                    &read_value(&mut args, "--chunk-stride-ms")?,
                    "--chunk-stride-ms",
                )?;
            }
            "--chunk-queue-cap" => {
                config.chunk_queue_cap = parse_usize(
                    &read_value(&mut args, "--chunk-queue-cap")?,
                    "--chunk-queue-cap",
                )?;
            }
            "--transcribe-channels" => {
                config.channel_mode =
                    ChannelMode::parse(&read_value(&mut args, "--transcribe-channels")?)?;
            }
            "--speaker-labels" => {
                config.speaker_labels =
                    SpeakerLabels::parse(&read_value(&mut args, "--speaker-labels")?)?;
            }
            "--benchmark-runs" => {
                config.benchmark_runs = parse_usize(
                    &read_value(&mut args, "--benchmark-runs")?,
                    "--benchmark-runs",
                )?;
            }
            "--model-doctor" => {
                config.model_doctor = true;
            }
            "--replay-jsonl" => {
                config.replay_jsonl = Some(PathBuf::from(read_value(&mut args, "--replay-jsonl")?));
            }
            "--preflight" => {
                config.preflight = true;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!("unknown option `{arg}`")));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}`; use named flags only"
                )));
            }
        }
    }

    config.validate()?;
    Ok(ParseOutcome::Config(config))
}

fn read_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, CliError> {
    args.next()
        .ok_or_else(|| CliError::new(format!("`{flag}` requires a value")))
}

fn parse_u64(value: &str, flag: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| CliError::new(format!("`{flag}` expects an integer, got `{value}`")))
}

fn parse_u32(value: &str, flag: &str) -> Result<u32, CliError> {
    value
        .parse::<u32>()
        .map_err(|_| CliError::new(format!("`{flag}` expects an integer, got `{value}`")))
}

fn parse_usize(value: &str, flag: &str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .map_err(|_| CliError::new(format!("`{flag}` expects an integer, got `{value}`")))
}

fn parse_f32(value: &str, flag: &str) -> Result<f32, CliError> {
    value.parse::<f32>().map_err(|_| {
        CliError::new(format!(
            "`{flag}` expects a floating-point value, got `{value}`"
        ))
    })
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

fn run_model_doctor(config: &TranscribeConfig) -> Result<PreflightReport, CliError> {
    let mut checks = Vec::new();
    checks.push(check_backend_runtime(config.asr_backend));

    match validate_model_path_for_backend(config) {
        Ok(resolved) => {
            let expected_kind = expected_model_kind(config.asr_backend);
            checks.push(PreflightCheck::pass(
                "model_path",
                format!(
                    "model path resolved: {} via {} (expected {expected_kind} for backend {})",
                    display_path(&resolved.path),
                    resolved.source,
                    config.asr_backend,
                ),
            ));
            checks.push(check_model_asset_readability(&resolved));
        }
        Err(err) => {
            checks.push(PreflightCheck::fail(
                "model_path",
                err.to_string(),
                "Pass --asr-model, set RECORDIT_ASR_MODEL, or install the backend default asset in the documented location.",
            ));
            checks.push(PreflightCheck::fail(
                "model_readability",
                "skipped because model_path did not validate".to_string(),
                "Fix model_path first, then rerun --model-doctor.",
            ));
        }
    }

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(PreflightReport {
        generated_at_utc,
        checks,
    })
}

fn check_model_asset_readability(resolved: &ResolvedModelPath) -> PreflightCheck {
    if resolved.path.is_file() {
        return match File::open(&resolved.path) {
            Ok(_) => PreflightCheck::pass(
                "model_readability",
                format!("model file is readable: {}", display_path(&resolved.path)),
            ),
            Err(err) => PreflightCheck::fail(
                "model_readability",
                format!("cannot read model file {}: {err}", display_path(&resolved.path)),
                "Fix file permissions or pass a different readable model path.",
            ),
        };
    }

    if resolved.path.is_dir() {
        return match fs::read_dir(&resolved.path) {
            Ok(_) => PreflightCheck::pass(
                "model_readability",
                format!(
                    "model directory is readable: {}",
                    display_path(&resolved.path)
                ),
            ),
            Err(err) => PreflightCheck::fail(
                "model_readability",
                format!(
                    "cannot read model directory {}: {err}",
                    display_path(&resolved.path)
                ),
                "Fix directory permissions or pass a different readable model path.",
            ),
        };
    }

    PreflightCheck::fail(
        "model_readability",
        format!(
            "model path is neither a file nor directory: {}",
            display_path(&resolved.path)
        ),
        "Use a readable file/directory path matching backend expectations.",
    )
}

fn run_preflight(config: &TranscribeConfig) -> Result<PreflightReport, CliError> {
    let mut checks = Vec::new();
    checks.push(check_model_path(config));
    checks.push(check_output_target("out_wav", &config.out_wav));
    checks.push(check_output_target("out_jsonl", &config.out_jsonl));
    checks.push(check_output_target("out_manifest", &config.out_manifest));
    checks.push(check_sample_rate(config.sample_rate_hz));
    checks.push(check_screen_capture_access());
    checks.push(check_microphone_stream(config.sample_rate_hz));
    checks.push(check_backend_runtime(config.asr_backend));

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(PreflightReport {
        generated_at_utc,
        checks,
    })
}

fn check_model_path(config: &TranscribeConfig) -> PreflightCheck {
    match validate_model_path_for_backend(config) {
        Ok(resolved) => {
            let expected_kind = expected_model_kind(config.asr_backend);
            PreflightCheck::pass(
                "model_path",
                format!(
                    "model path resolved: {} via {} (expected {expected_kind} for backend {})",
                    display_path(&resolved.path),
                    resolved.source,
                    config.asr_backend,
                ),
            )
        }
        Err(err) => PreflightCheck::fail(
            "model_path",
            err.to_string(),
            "Pass --asr-model, set RECORDIT_ASR_MODEL, or install the backend default asset in the documented location.",
        ),
    }
}

fn check_output_target(id: &'static str, path: &Path) -> PreflightCheck {
    let absolute = display_path(path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    if path.exists() && path.is_dir() {
        return PreflightCheck::fail(
            id,
            format!("target path is a directory: {absolute}"),
            "Provide a file path, not a directory.",
        );
    }

    if let Err(err) = fs::create_dir_all(&parent) {
        return PreflightCheck::fail(
            id,
            format!("cannot create parent directory {}: {err}", parent.display()),
            "Choose an output location in a writable directory.",
        );
    }

    let probe = parent.join(format!(
        ".recordit-preflight-write-{}-{}",
        id,
        std::process::id()
    ));
    match File::create(&probe).and_then(|mut file| file.write_all(b"ok")) {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            PreflightCheck::pass(id, format!("writable output target: {absolute}"))
        }
        Err(err) => PreflightCheck::fail(
            id,
            format!("cannot write under {}: {err}", parent.display()),
            "Choose an output path in a writable directory.",
        ),
    }
}

fn check_sample_rate(sample_rate_hz: u32) -> PreflightCheck {
    if sample_rate_hz == 48_000 {
        return PreflightCheck::pass("sample_rate", "sample rate is 48000 Hz");
    }

    PreflightCheck::warn(
        "sample_rate",
        format!("non-default sample rate configured: {sample_rate_hz} Hz"),
        "Use --sample-rate 48000 unless you intentionally need a different rate.",
    )
}

fn check_screen_capture_access() -> PreflightCheck {
    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(err) => {
            return PreflightCheck::fail(
                "screen_capture_access",
                format!("failed to query ScreenCaptureKit content: {err}"),
                "Grant Screen Recording permission and ensure at least one active display.",
            );
        }
    };

    let displays = content.displays();
    if displays.is_empty() {
        return PreflightCheck::fail(
            "display_availability",
            "ScreenCaptureKit returned no displays".to_string(),
            "Connect/enable a display and retry. Closed-lid headless mode is unsupported.",
        );
    }

    PreflightCheck::pass(
        "screen_capture_access",
        format!(
            "ScreenCaptureKit access OK; displays available={}",
            displays.len()
        ),
    )
}

fn check_microphone_stream(sample_rate_hz: u32) -> PreflightCheck {
    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(err) => {
            return PreflightCheck::fail(
                "microphone_access",
                format!("cannot initialize microphone preflight (shareable content error): {err}"),
                "Grant Screen Recording first, then rerun preflight.",
            );
        }
    };

    let displays = content.displays();
    if displays.is_empty() {
        return PreflightCheck::fail(
            "microphone_access",
            "cannot run microphone preflight without an active display".to_string(),
            "Connect/enable a display and rerun preflight.",
        );
    }

    let filter = SCContentFilter::create()
        .with_display(&displays[0])
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(false)
        .with_captures_microphone(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(sample_rate_hz as i32)
        .with_channel_count(1);

    let queue = DispatchQueue::new(
        "com.recordit.transcribe.preflight",
        DispatchQoS::UserInteractive,
    );
    let (tx, rx) = sync_channel::<()>(1);

    let mut stream = SCStream::new(&filter, &config);
    let tx_mic = tx.clone();
    if stream
        .add_output_handler_with_queue(
            move |_sample, _kind| {
                let _ = tx_mic.try_send(());
            },
            SCStreamOutputType::Microphone,
            Some(&queue),
        )
        .is_none()
    {
        return PreflightCheck::fail(
            "microphone_access",
            "failed to register microphone output handler".to_string(),
            "Retry preflight; if it persists, restart the app/session.",
        );
    }

    if let Err(err) = stream.start_capture() {
        return PreflightCheck::fail(
            "microphone_access",
            format!("failed to start microphone capture: {err}"),
            "Grant Microphone permission and verify an input device is connected and enabled.",
        );
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut observed_mic = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(_) => {
                observed_mic = true;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let stop_result = stream.stop_capture();
    if let Err(err) = stop_result {
        return PreflightCheck::warn(
            "microphone_access",
            format!("microphone stream started but stop_capture reported: {err}"),
            "Retry preflight; if repeated, restart the app/session.",
        );
    }

    if observed_mic {
        PreflightCheck::pass(
            "microphone_access",
            "observed at least one microphone sample buffer".to_string(),
        )
    } else {
        PreflightCheck::fail(
            "microphone_access",
            "no microphone sample buffer observed within 2s".to_string(),
            "Grant Microphone permission, unmute/select input device, and speak briefly during preflight.",
        )
    }
}

fn check_backend_runtime(backend: AsrBackend) -> PreflightCheck {
    let tool_name = match backend {
        AsrBackend::WhisperCpp => "whisper-cli",
        AsrBackend::WhisperKit => "whisperkit-cli",
        AsrBackend::Moonshine => "moonshine",
    };

    match command_stdout("which", &[tool_name]) {
        Ok(path) => PreflightCheck::pass(
            "backend_runtime",
            format!("detected backend helper binary `{tool_name}` at {path}"),
        ),
        Err(_) => PreflightCheck::warn(
            "backend_runtime",
            format!("backend helper binary `{tool_name}` not found in PATH"),
            "Install backend tooling or keep using Rust-native integration once wired.",
        ),
    }
}

fn print_preflight_report(report: &PreflightReport) {
    let mut pass_count = 0usize;
    let mut warn_count = 0usize;
    let mut fail_count = 0usize;

    println!("Transcribe-live preflight diagnostics");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  overall_status: {}", report.overall_status());
    println!();
    println!("id\tstatus\tdetail\tremediation");

    for check in &report.checks {
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
        println!(
            "{}\t{}\t{}\t{}",
            check.id,
            check.status,
            clean_field(&check.detail),
            clean_field(check.remediation.as_deref().unwrap_or("-")),
        );
    }

    println!();
    println!(
        "summary\t{}\tpass={}\twarn={}\tfail={}",
        report.overall_status(),
        pass_count,
        warn_count,
        fail_count
    );
}

fn print_model_doctor_report(report: &PreflightReport) {
    let mut pass_count = 0usize;
    let mut warn_count = 0usize;
    let mut fail_count = 0usize;

    println!("Transcribe-live model doctor");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  overall_status: {}", report.overall_status());
    println!();
    println!("id\tstatus\tdetail\tremediation");

    for check in &report.checks {
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
        println!(
            "{}\t{}\t{}\t{}",
            check.id,
            check.status,
            clean_field(&check.detail),
            clean_field(check.remediation.as_deref().unwrap_or("-")),
        );
    }

    println!();
    println!(
        "summary\t{}\tpass={}\twarn={}\tfail={}",
        report.overall_status(),
        pass_count,
        warn_count,
        fail_count
    );
}

fn write_preflight_manifest(
    config: &TranscribeConfig,
    report: &PreflightReport,
) -> Result<(), CliError> {
    let resolved_model = validate_model_path_for_backend(config).ok();
    let model_checksum = model_checksum_info(resolved_model.as_ref());
    let requested_model = if config.asr_model.as_os_str().is_empty() {
        "<auto-discover>".to_string()
    } else {
        display_path(&config.asr_model)
    };
    let resolved_model_path = resolved_model
        .as_ref()
        .map(|model| display_path(&model.path))
        .unwrap_or_else(|| "<unresolved>".to_string());
    let resolved_model_source = resolved_model
        .as_ref()
        .map(|model| model.source.as_str())
        .unwrap_or("unresolved");

    if let Some(parent) = config.out_manifest.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CliError::new(format!(
                "failed to create manifest directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    let mut file = File::create(&config.out_manifest).map_err(|err| {
        CliError::new(format!(
            "failed to create manifest {}: {err}",
            display_path(&config.out_manifest)
        ))
    })?;

    writeln!(file, "{{").map_err(io_to_cli)?;
    writeln!(file, "  \"schema_version\": \"1\",").map_err(io_to_cli)?;
    writeln!(file, "  \"kind\": \"transcribe-live-preflight\",").map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"generated_at_utc\": \"{}\",",
        json_escape(&report.generated_at_utc)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "  \"overall_status\": \"{}\",",
        report.overall_status()
    )
    .map_err(io_to_cli)?;
    writeln!(file, "  \"config\": {{").map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"out_wav\": \"{}\",",
        json_escape(&display_path(&config.out_wav))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"out_wav_semantics\": \"{}\",",
        json_escape(OUT_WAV_SEMANTICS)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"out_jsonl\": \"{}\",",
        json_escape(&display_path(&config.out_jsonl))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"out_manifest\": \"{}\",",
        json_escape(&display_path(&config.out_manifest))
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_backend\": \"{}\",",
        json_escape(&config.asr_backend.to_string())
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_model_requested\": \"{}\",",
        json_escape(&requested_model)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_model_resolved\": \"{}\",",
        json_escape(&resolved_model_path)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_model_source\": \"{}\",",
        json_escape(resolved_model_source)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_model_checksum_sha256\": \"{}\",",
        json_escape(&model_checksum.sha256)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"asr_model_checksum_status\": \"{}\",",
        json_escape(&model_checksum.status)
    )
    .map_err(io_to_cli)?;
    writeln!(
        file,
        "    \"runtime_mode\": \"{}\",",
        json_escape(config.runtime_mode_label())
    )
    .map_err(io_to_cli)?;
    writeln!(file, "    \"live_chunked\": {},", config.live_chunked).map_err(io_to_cli)?;
    writeln!(file, "    \"chunk_window_ms\": {},", config.chunk_window_ms).map_err(io_to_cli)?;
    writeln!(file, "    \"chunk_stride_ms\": {},", config.chunk_stride_ms).map_err(io_to_cli)?;
    writeln!(file, "    \"chunk_queue_cap\": {},", config.chunk_queue_cap).map_err(io_to_cli)?;
    writeln!(file, "    \"sample_rate_hz\": {}", config.sample_rate_hz).map_err(io_to_cli)?;
    writeln!(file, "  }},").map_err(io_to_cli)?;
    writeln!(file, "  \"checks\": [").map_err(io_to_cli)?;

    for (idx, check) in report.checks.iter().enumerate() {
        writeln!(file, "    {{").map_err(io_to_cli)?;
        writeln!(file, "      \"id\": \"{}\",", json_escape(check.id)).map_err(io_to_cli)?;
        writeln!(
            file,
            "      \"status\": \"{}\",",
            json_escape(&check.status.to_string())
        )
        .map_err(io_to_cli)?;
        writeln!(
            file,
            "      \"detail\": \"{}\",",
            json_escape(&check.detail)
        )
        .map_err(io_to_cli)?;
        writeln!(
            file,
            "      \"remediation\": \"{}\"",
            json_escape(check.remediation.as_deref().unwrap_or(""))
        )
        .map_err(io_to_cli)?;
        if idx + 1 == report.checks.len() {
            writeln!(file, "    }}").map_err(io_to_cli)?;
        } else {
            writeln!(file, "    }},").map_err(io_to_cli)?;
        }
    }

    writeln!(file, "  ]").map_err(io_to_cli)?;
    writeln!(file, "}}").map_err(io_to_cli)?;
    Ok(())
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
    use super::{
        build_rolling_chunk_windows, build_transcript_events, build_trust_notices,
        collect_live_capture_continuity_events, detect_vad_boundaries, live_capture_cli_args,
        materialize_out_wav, merge_transcript_events, model_checksum_info, parse_args_from,
        parse_trust_notice, prepare_channel_inputs, reconstruct_transcript,
        reconstruct_transcript_per_channel, resolve_model_path, run_cleanup_queue_with,
        sequoia_capture_binary_candidates, AsrBackend, ChannelMode, CleanupAttemptOutcome,
        CleanupQueueTelemetry, CleanupTaskStatus, ModeDegradationEvent, ParseOutcome,
        ResolvedModelPath, TranscribeConfig, TranscriptEvent, VadBoundary, HELP_TEXT,
    };
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::env;
    use std::fs::{self, File};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        assert!(HELP_TEXT.contains("--chunk-window-ms"));
        assert!(HELP_TEXT.contains("--chunk-stride-ms"));
        assert!(HELP_TEXT.contains("--chunk-queue-cap"));
    }

    #[test]
    fn live_capture_cli_args_follow_transcribe_config() {
        let mut config = TranscribeConfig::default();
        config.duration_sec = 42;
        config.input_wav = PathBuf::from("artifacts/live-input.wav");
        config.sample_rate_hz = 44_100;

        let args = live_capture_cli_args(&config);
        assert_eq!(
            args,
            vec![
                "42".to_string(),
                "artifacts/live-input.wav".to_string(),
                "44100".to_string(),
                "adapt-stream-rate".to_string(),
                "warn".to_string(),
            ]
        );
    }

    #[test]
    fn capture_binary_candidates_include_standard_local_paths() {
        let candidates = sequoia_capture_binary_candidates();
        assert!(candidates.contains(&PathBuf::from("target/debug/sequoia_capture")));
        assert!(candidates.contains(&PathBuf::from("target/release/sequoia_capture")));
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
            Err(err) => assert!(err.to_string().contains("require `--live-chunked`")),
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
    fn parse_accepts_live_chunked_contract_values() {
        let args = vec![
            "--live-chunked".to_string(),
            "--chunk-window-ms".to_string(),
            "4000".to_string(),
            "--chunk-stride-ms".to_string(),
            "1000".to_string(),
            "--chunk-queue-cap".to_string(),
            "4".to_string(),
        ];
        match parse_args_from(args.into_iter()).unwrap() {
            ParseOutcome::Help => panic!("expected config parse outcome"),
            ParseOutcome::Config(config) => {
                assert!(config.live_chunked);
                assert_eq!(config.chunk_window_ms, 4000);
                assert_eq!(config.chunk_stride_ms, 1000);
                assert_eq!(config.chunk_queue_cap, 4);
                assert_eq!(config.runtime_mode_label(), "live-chunked");
            }
        }
    }

    #[test]
    fn rolling_chunk_scheduler_uses_4s_window_and_1s_stride() {
        let windows = build_rolling_chunk_windows(0, 10_000, 4_000, 1_000);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(
            observed,
            vec![
                (0, 4_000, 0),
                (1_000, 5_000, 3_000),
                (2_000, 6_000, 3_000),
                (3_000, 7_000, 3_000),
                (4_000, 8_000, 3_000),
                (5_000, 9_000, 3_000),
                (6_000, 10_000, 3_000),
            ]
        );
    }

    #[test]
    fn rolling_chunk_scheduler_aligns_last_window_to_session_end() {
        let windows = build_rolling_chunk_windows(0, 4_500, 4_000, 1_000);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(observed, vec![(0, 4_000, 0), (500, 4_500, 3_500)]);
    }

    #[test]
    fn rolling_chunk_scheduler_handles_short_sessions_with_single_window() {
        let windows = build_rolling_chunk_windows(0, 2_200, 4_000, 1_000);
        let observed = windows
            .iter()
            .map(|window| (window.start_ms, window.end_ms, window.overlap_prev_ms))
            .collect::<Vec<_>>();

        assert_eq!(observed, vec![(0, 2_200, 0)]);
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
            4_000,
            1_000,
        );
        let finals = events
            .iter()
            .filter(|event| event.event_type == "final")
            .collect::<Vec<_>>();

        assert_eq!(finals.len(), 7);
        assert_eq!(finals[0].segment_id, "mic-chunk-0000-0-4000");
        assert_eq!(finals[0].start_ms, 0);
        assert_eq!(finals[0].end_ms, 4_000);
        assert_eq!(finals[1].segment_id, "mic-chunk-0001-1000-5000");
        assert_eq!(finals[6].segment_id, "mic-chunk-0006-6000-10000");
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
    fn extract_json_string_field_accepts_whitespace_after_colon() {
        let payload = "{\"choices\":[{\"message\":{\"content\": \"cleaned local segment\"}}]}";
        let parsed = super::extract_json_string_field(payload, "content");
        assert_eq!(parsed.as_deref(), Some("cleaned local segment"));
    }

    #[test]
    fn trust_notice_parser_reads_replay_context() {
        let line = "{\"event_type\":\"trust_notice\",\"channel\":\"control\",\"code\":\"mode_degradation\",\"severity\":\"warn\",\"cause\":\"requested mixed-fallback but input had 1 channel\",\"impact\":\"channel attribution reduced\",\"guidance\":\"use stereo input\"}";
        let notice = parse_trust_notice(line).unwrap();
        assert_eq!(notice.code, "mode_degradation");
        assert_eq!(notice.severity, "warn");
        assert_eq!(notice.impact, "channel attribution reduced");
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
        assert!(events[0].detail.contains("2 stream interruption restart(s)"));

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

        let plan = prepare_channel_inputs(&config, "unit-fallback").unwrap();
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
        match original_env {
            Some(value) => unsafe {
                env::set_var("RECORDIT_ASR_MODEL", value);
            },
            None => unsafe {
                env::remove_var("RECORDIT_ASR_MODEL");
            },
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}
