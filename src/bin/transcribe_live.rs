use hound::{SampleFormat, WavReader};
use screencapturekit::prelude::*;
use std::env;
use std::fmt::{self, Display};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

const PARTIAL_LATENCY_SLO_MS: f64 = 1_500.0;
const FINAL_LATENCY_SLO_MS: f64 = 2_500.0;

const HELP_TEXT: &str = "\
transcribe-live

Define and validate the live transcription CLI contract for the next phase of recordit.

Usage:
  transcribe-live [options]

Options:
  --duration-sec <seconds>        Capture duration in seconds (default: 10)
  --input-wav <path>              Representative WAV used for current runtime path (auto-generated if missing; default: artifacts/bench/corpus/gate_a/tts_phrase.wav)
  --out-wav <path>                Output WAV artifact path (default: artifacts/transcribe-live.wav)
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
  --transcribe-channels <mode>    Channel mode: separate | mixed (default: separate)
  --speaker-labels <mic,system>   Comma-separated labels for the two channels (default: mic,system)
  --benchmark-runs <n>            Number of representative latency benchmark runs (default: 3)
  --replay-jsonl <path>           Replay transcript timeline from a prior JSONL artifact
  --preflight                     Run structured preflight diagnostics and write manifest
  -h, --help                      Show this help text

Examples:
  transcribe-live --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin
  transcribe-live --asr-backend whisperkit --asr-model artifacts/bench/models/whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-tiny --transcribe-channels mixed
  transcribe-live --input-wav artifacts/bench/corpus/gate_a/tts_phrase.wav --asr-model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --llm-cleanup --llm-endpoint http://127.0.0.1:8080/v1/chat/completions --llm-model llama3.2:3b
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

#[derive(Debug, Clone, Copy)]
enum ChannelMode {
    Separate,
    Mixed,
}

impl Display for ChannelMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Separate => f.write_str("separate"),
            Self::Mixed => f.write_str("mixed"),
        }
    }
}

impl ChannelMode {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value {
            "separate" => Ok(Self::Separate),
            "mixed" => Ok(Self::Mixed),
            _ => Err(CliError::new(format!(
                "unsupported --transcribe-channels `{value}`; expected `separate` or `mixed`"
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
    channel_mode: ChannelMode,
    speaker_labels: SpeakerLabels,
    benchmark_runs: usize,
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
            channel_mode: ChannelMode::Separate,
            speaker_labels: SpeakerLabels {
                mic: "mic".to_owned(),
                system: "system".to_owned(),
            },
            benchmark_runs: 3,
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

        if !self.preflight && self.replay_jsonl.is_none() && self.asr_model.as_os_str().is_empty() {
            return Err(CliError::new(
                "`--asr-model <path>` is required so the CLI contract stays explicit about local model assets",
            ));
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

        validate_output_path("--out-wav", &self.out_wav)?;
        validate_output_path("--out-jsonl", &self.out_jsonl)?;
        validate_output_path("--out-manifest", &self.out_manifest)?;

        Ok(())
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
        println!("  asr_model: {}", display_path(&self.asr_model));
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
        println!("  transcribe_channels: {}", self.channel_mode);
        println!("  speaker_labels: {}", self.speaker_labels);
        println!("  benchmark_runs: {}", self.benchmark_runs);
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
    channel_mode: ChannelMode,
    transcript_text: String,
    channel_transcripts: Vec<ChannelTranscriptSummary>,
    vad_boundaries: Vec<VadBoundary>,
    events: Vec<TranscriptEvent>,
    benchmark: BenchmarkSummary,
    benchmark_summary_csv: PathBuf,
    benchmark_runs_csv: PathBuf,
}

#[derive(Debug, Clone)]
struct TranscriptEvent {
    event_type: &'static str,
    channel: String,
    segment_id: String,
    start_ms: u64,
    end_ms: u64,
    text: String,
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
struct ChannelTranscriptSummary {
    role: &'static str,
    label: String,
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
    validate_model_path_for_backend(config)?;
    prepare_input_wav(&config.input_wav)?;

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let stamp = command_stdout("date", &["-u", "+%Y%m%dT%H%M%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let backend_id = select_adapter(config.asr_backend)?.backend_id();
    let channel_inputs = prepare_channel_inputs(config, &stamp)?;
    let mut wall_ms_runs = Vec::with_capacity(config.benchmark_runs);
    let mut first_channel_transcripts = Vec::new();
    for _ in 0..config.benchmark_runs {
        let started_at = Instant::now();
        let transcripts = transcribe_channels_once(config, &channel_inputs)?;
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
    let events = merge_transcript_events(
        first_channel_transcripts
            .iter()
            .flat_map(|transcript| {
                build_transcript_events(
                    &transcript.text,
                    &vad_boundaries,
                    &transcript.label,
                    transcript.role,
                )
            })
            .collect(),
    );
    let transcript_text = reconstruct_transcript(&events);
    let (benchmark_summary_csv, benchmark_runs_csv, benchmark) = write_benchmark_artifact(
        &stamp,
        backend_id,
        benchmark_track(config.channel_mode),
        &wall_ms_runs,
    )?;

    let report = LiveRunReport {
        generated_at_utc,
        backend_id,
        channel_mode: config.channel_mode,
        transcript_text,
        channel_transcripts: first_channel_transcripts,
        vad_boundaries,
        events,
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
) -> Result<Vec<ChannelInputPlan>, CliError> {
    match config.channel_mode {
        ChannelMode::Mixed => Ok(vec![ChannelInputPlan {
            role: "mixed",
            label: "merged".to_string(),
            audio_path: config.input_wav.clone(),
        }]),
        ChannelMode::Separate => {
            prepare_separate_channel_inputs(&config.input_wav, &config.speaker_labels, stamp)
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
    channel_inputs: &[ChannelInputPlan],
) -> Result<Vec<ChannelTranscriptSummary>, CliError> {
    let mut handles = Vec::with_capacity(channel_inputs.len());
    for input in channel_inputs.iter().cloned() {
        let backend = config.asr_backend;
        let model_path = config.asr_model.clone();
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
) -> Vec<TranscriptEvent> {
    let start_ms = vad_boundaries.first().map(|v| v.start_ms).unwrap_or(0);
    let end_ms = vad_boundaries.last().map(|v| v.end_ms).unwrap_or(0);
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
        },
        TranscriptEvent {
            event_type: "final",
            channel: channel_label.to_string(),
            segment_id: format!("{segment_key}-representative-0"),
            start_ms,
            end_ms,
            text: transcript_text.to_string(),
        },
    ]
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
    if event_type == "partial" { 0 } else { 1 }
}

fn reconstruct_transcript(events: &[TranscriptEvent]) -> String {
    let mut parts = Vec::new();
    for event in events.iter().filter(|event| event.event_type == "final") {
        let text = event.text.trim();
        if text.is_empty() {
            continue;
        }
        if event.channel == "merged" {
            parts.push(text.to_string());
        } else {
            parts.push(format!("[{}] {text}", event.channel));
        }
    }
    if parts.is_empty() {
        "<no speech detected>".to_string()
    } else {
        parts.join(" ")
    }
}

fn benchmark_track(channel_mode: ChannelMode) -> &'static str {
    match channel_mode {
        ChannelMode::Separate => "transcribe-live-dual-channel",
        ChannelMode::Mixed => "transcribe-live-single-channel",
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

fn validate_model_path_for_backend(config: &TranscribeConfig) -> Result<(), CliError> {
    if config.asr_model.as_os_str().is_empty() {
        return Err(CliError::new(
            "no --asr-model path provided; pass a local model path for the selected backend",
        ));
    }
    if !config.asr_model.exists() {
        return Err(CliError::new(format!(
            "model path does not exist: {}",
            display_path(&config.asr_model)
        )));
    }

    match config.asr_backend {
        AsrBackend::WhisperCpp => {
            if !config.asr_model.is_file() {
                return Err(CliError::new(format!(
                    "`--asr-backend whispercpp` expects a model file path, got {}",
                    display_path(&config.asr_model)
                )));
            }
        }
        AsrBackend::WhisperKit => {
            if !config.asr_model.is_dir() {
                return Err(CliError::new(format!(
                    "`--asr-backend whisperkit` expects a model directory path, got {}",
                    display_path(&config.asr_model)
                )));
            }
        }
        AsrBackend::Moonshine => {}
    }
    Ok(())
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
    println!();
    println!("Representative runtime result");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  backend: {}", report.backend_id);
    println!("  channel_mode: {}", report.channel_mode);
    println!("  transcript_text: {}", report.transcript_text);
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
        json_escape(&display_path(&config.asr_model))
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
        "  \"channel_mode\": \"{}\",",
        json_escape(&report.channel_mode.to_string())
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
        "  \"event_counts\": {{\"vad_boundary\":{},\"transcript\":{}}},",
        report.vad_boundaries.len(),
        report.events.len()
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
    for (line_no, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(event_type) = extract_json_string_field(trimmed, "event_type") else {
            continue;
        };
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

    let reconstructed = reconstruct_transcript(&events);
    println!();
    println!("Reconstructed transcript");
    println!("  {}", reconstructed);
    Ok(())
}

fn extract_json_string_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = line.find(&needle)? + needle.len();
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
                if let Some(replay_path) = &config.replay_jsonl {
                    match replay_timeline(replay_path) {
                        Ok(()) => return ExitCode::SUCCESS,
                        Err(err) => {
                            eprintln!("error: replay failed: {err}");
                            return ExitCode::from(2);
                        }
                    }
                }

                match run_live_pipeline(&config) {
                    Ok(run_report) => {
                        config.print_summary();
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
    let mut config = TranscribeConfig::default();
    let mut args = env::args().skip(1);

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
        Ok(()) => {
            let expected_kind = match config.asr_backend {
                AsrBackend::WhisperCpp => "file",
                AsrBackend::WhisperKit => "directory",
                AsrBackend::Moonshine => "file/directory",
            };
            PreflightCheck::pass(
                "model_path",
                format!(
                    "model path found: {} (expected {expected_kind} for backend {})",
                    display_path(&config.asr_model),
                    config.asr_backend
                ),
            )
        }
        Err(err) => PreflightCheck::fail(
            "model_path",
            err.to_string(),
            "Fix --asr-model so it exists and matches backend expectations.",
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

fn write_preflight_manifest(
    config: &TranscribeConfig,
    report: &PreflightReport,
) -> Result<(), CliError> {
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
        "    \"asr_model\": \"{}\",",
        json_escape(&display_path(&config.asr_model))
    )
    .map_err(io_to_cli)?;
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
        AsrBackend, TranscriptEvent, detect_vad_boundaries, merge_transcript_events,
        reconstruct_transcript,
    };

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
            },
            TranscriptEvent {
                event_type: "partial",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "mic-partial".to_string(),
            },
            TranscriptEvent {
                event_type: "partial",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "sys-partial".to_string(),
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 10,
                end_ms: 20,
                text: "mic-final".to_string(),
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
    fn reconstructed_transcript_keeps_channel_labels_for_final_events() {
        let events = vec![
            TranscriptEvent {
                event_type: "partial",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 50,
                text: "hello".to_string(),
            },
            TranscriptEvent {
                event_type: "final",
                channel: "mic".to_string(),
                segment_id: "mic-0".to_string(),
                start_ms: 0,
                end_ms: 100,
                text: "hello from mic".to_string(),
            },
            TranscriptEvent {
                event_type: "final",
                channel: "system".to_string(),
                segment_id: "system-0".to_string(),
                start_ms: 0,
                end_ms: 100,
                text: "hello from system".to_string(),
            },
        ];
        let reconstructed = reconstruct_transcript(&events);
        assert_eq!(
            reconstructed,
            "[mic] hello from mic [system] hello from system"
        );
    }
}
