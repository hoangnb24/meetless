use crate::capture_api::{
    capture_telemetry_path_for_output, CallbackContractSummary, CaptureCallbackAuditSummary,
    CaptureChunk, CaptureChunkKind, CaptureChunkSummary, CaptureDegradationEvent, CaptureEvent,
    CaptureEventCode, CaptureRecoveryAction, CaptureResampleSummary, CaptureRunSummary,
    CaptureSampleRatePolicySummary, CaptureSink, CaptureStream, CaptureStreamSummary,
    CaptureSummary, CaptureTransportSummary, ResampleSummary, StreamingCaptureResult,
};
use crate::rt_transport::{preallocated_spsc, PreallocatedProducer};
use anyhow::{bail, Context, Result};
use crossbeam_channel::RecvTimeoutError;
use hound::{SampleFormat, WavSpec, WavWriter};
use screencapturekit::prelude::*;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

const CALLBACK_RING_CAPACITY: usize = 1024;
const MAX_MONO_SAMPLES_PER_CHUNK: usize = 16_384;
const CALLBACK_RECV_TIMEOUT: Duration = Duration::from_millis(200);
const INTERRUPTION_IDLE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CAPTURE_RESTARTS: usize = 2;
const PROGRESSIVE_WAV_MATERIALIZE_INTERVAL: Duration = Duration::from_millis(750);
const PROGRESSIVE_WAV_MATERIALIZE_MIN_NEW_CHUNKS: usize = 8;
const FAKE_CAPTURE_FIXTURE_ENV: &str = "RECORDIT_FAKE_CAPTURE_FIXTURE";
const FAKE_CAPTURE_RESTART_COUNT_ENV: &str = "RECORDIT_FAKE_CAPTURE_RESTART_COUNT";
const FAKE_CAPTURE_REALTIME_ENV: &str = "RECORDIT_FAKE_CAPTURE_REALTIME";

static STOP_CAPTURE_REQUESTED: AtomicBool = AtomicBool::new(false);
static STOP_CAPTURE_SIGNAL_HANDLER_READY: OnceLock<()> = OnceLock::new();

fn ensure_stop_capture_signal_handler() -> Result<()> {
    if STOP_CAPTURE_SIGNAL_HANDLER_READY.get().is_some() {
        return Ok(());
    }

    ctrlc::set_handler(|| {
        STOP_CAPTURE_REQUESTED.store(true, Ordering::Relaxed);
    })
    .context("failed to install capture stop signal handler")?;

    let _ = STOP_CAPTURE_SIGNAL_HANDLER_READY.set(());
    Ok(())
}

fn stop_capture_requested() -> bool {
    STOP_CAPTURE_REQUESTED.load(Ordering::Relaxed)
}

fn stop_capture_requested_or_marker(path: Option<&Path>) -> bool {
    if stop_capture_requested() {
        return true;
    }
    let Some(path) = path else {
        return false;
    };
    if path.exists() {
        STOP_CAPTURE_REQUESTED.store(true, Ordering::Relaxed);
        return true;
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRateMismatchPolicy {
    Strict,
    AdaptStreamRate,
}

impl SampleRateMismatchPolicy {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "strict" => Ok(Self::Strict),
            "adapt-stream-rate" => Ok(Self::AdaptStreamRate),
            _ => bail!(
                "unknown sample-rate policy '{}'; expected one of: strict, adapt-stream-rate",
                value
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::AdaptStreamRate => "adapt-stream-rate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackContractMode {
    Warn,
    Strict,
}

impl CallbackContractMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "warn" => Ok(Self::Warn),
            "strict" => Ok(Self::Strict),
            _ => bail!(
                "unknown callback contract mode '{}'; expected one of: warn, strict",
                value
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCaptureConfig {
    pub duration_secs: u64,
    pub output: PathBuf,
    pub target_rate_hz: u32,
    pub mismatch_policy: SampleRateMismatchPolicy,
    pub callback_contract_mode: CallbackContractMode,
    pub stop_request_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
struct InterruptionPolicy {
    idle_timeout: Duration,
    max_restarts: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    DropSampleContinue,
    RestartStream,
    AdaptOutputRate,
    FailFastReconfigure,
}

#[derive(Debug, Clone, Copy)]
enum CallbackContractViolation {
    MissingAudioBufferList,
    MissingFirstAudioBuffer,
    MissingFormatDescription,
    MissingSampleRate,
    NonFloatPcm,
    ChunkTooLarge,
}

#[derive(Debug, Default)]
struct CallbackAudit {
    missing_audio_buffer_list: AtomicU64,
    missing_first_audio_buffer: AtomicU64,
    missing_format_description: AtomicU64,
    missing_sample_rate: AtomicU64,
    non_float_pcm: AtomicU64,
    chunk_too_large: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default)]
struct CallbackAuditSnapshot {
    missing_audio_buffer_list: u64,
    missing_first_audio_buffer: u64,
    missing_format_description: u64,
    missing_sample_rate: u64,
    non_float_pcm: u64,
    chunk_too_large: u64,
}

impl CallbackAuditSnapshot {
    fn total_violations(&self) -> u64 {
        self.missing_audio_buffer_list
            + self.missing_first_audio_buffer
            + self.missing_format_description
            + self.missing_sample_rate
            + self.non_float_pcm
            + self.chunk_too_large
    }
}

impl CallbackAudit {
    fn record(&self, violation: CallbackContractViolation) {
        let counter = match violation {
            CallbackContractViolation::MissingAudioBufferList => &self.missing_audio_buffer_list,
            CallbackContractViolation::MissingFirstAudioBuffer => &self.missing_first_audio_buffer,
            CallbackContractViolation::MissingFormatDescription => &self.missing_format_description,
            CallbackContractViolation::MissingSampleRate => &self.missing_sample_rate,
            CallbackContractViolation::NonFloatPcm => &self.non_float_pcm,
            CallbackContractViolation::ChunkTooLarge => &self.chunk_too_large,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> CallbackAuditSnapshot {
        CallbackAuditSnapshot {
            missing_audio_buffer_list: self.missing_audio_buffer_list.load(Ordering::Relaxed),
            missing_first_audio_buffer: self.missing_first_audio_buffer.load(Ordering::Relaxed),
            missing_format_description: self.missing_format_description.load(Ordering::Relaxed),
            missing_sample_rate: self.missing_sample_rate.load(Ordering::Relaxed),
            non_float_pcm: self.non_float_pcm.load(Ordering::Relaxed),
            chunk_too_large: self.chunk_too_large.load(Ordering::Relaxed),
        }
    }
}

fn parse_sample_rate_policy_arg(
    args: &[String],
    index: usize,
    default: SampleRateMismatchPolicy,
) -> Result<SampleRateMismatchPolicy> {
    if let Some(value) = args.get(index) {
        return SampleRateMismatchPolicy::parse(value);
    }
    Ok(default)
}

fn parse_callback_contract_mode_arg(
    args: &[String],
    index: usize,
    default: CallbackContractMode,
) -> Result<CallbackContractMode> {
    if let Some(value) = args.get(index) {
        return CallbackContractMode::parse(value);
    }
    Ok(default)
}

fn can_restart_capture(restarts_used: usize, policy: InterruptionPolicy) -> bool {
    restarts_used < policy.max_restarts
}

fn recovery_action_for_interruption(can_restart: bool) -> RecoveryAction {
    if can_restart {
        RecoveryAction::RestartStream
    } else {
        RecoveryAction::FailFastReconfigure
    }
}

fn recovery_action_for_callback_violation(violation: CallbackContractViolation) -> RecoveryAction {
    match violation {
        CallbackContractViolation::MissingAudioBufferList
        | CallbackContractViolation::MissingFirstAudioBuffer
        | CallbackContractViolation::MissingFormatDescription
        | CallbackContractViolation::MissingSampleRate
        | CallbackContractViolation::ChunkTooLarge => RecoveryAction::DropSampleContinue,
        CallbackContractViolation::NonFloatPcm => RecoveryAction::FailFastReconfigure,
    }
}

fn resolve_output_sample_rate(
    target_rate_hz: u32,
    mic_rate_hz: u32,
    system_rate_hz: u32,
    policy: SampleRateMismatchPolicy,
) -> Result<u32> {
    if target_rate_hz == 0 {
        bail!("target sample rate must be greater than zero");
    }

    match policy {
        SampleRateMismatchPolicy::Strict => {
            if mic_rate_hz == target_rate_hz && system_rate_hz == target_rate_hz {
                return Ok(target_rate_hz);
            }
            let action = RecoveryAction::FailFastReconfigure;
            bail!(
                "sample-rate mismatch: mic={} Hz, system={} Hz, target={} Hz. Recovery action: {:?}. Retry with policy 'adapt-stream-rate' to allow worker-side resampling.",
                mic_rate_hz,
                system_rate_hz,
                target_rate_hz,
                action
            );
        }
        SampleRateMismatchPolicy::AdaptStreamRate => {
            let _action = RecoveryAction::AdaptOutputRate;
            Ok(target_rate_hz)
        }
    }
}

#[derive(Debug, Clone)]
struct TimedChunk {
    kind: SCStreamOutputType,
    pts_seconds: f64,
    sample_rate_hz: u32,
    mono_samples: Vec<f32>,
}

impl TimedChunk {
    #[allow(dead_code)]
    fn to_capture_chunk_summary(&self) -> Option<CaptureChunkSummary> {
        let kind = match self.kind {
            SCStreamOutputType::Audio => CaptureChunkKind::SystemAudio,
            SCStreamOutputType::Microphone => CaptureChunkKind::Microphone,
            _ => return None,
        };
        Some(CaptureChunkSummary {
            kind,
            pts_seconds: self.pts_seconds,
            sample_rate_hz: self.sample_rate_hz,
            frame_count: self.mono_samples.len(),
        })
    }

    fn to_capture_chunk(&self) -> Option<CaptureChunk> {
        let stream = match self.kind {
            SCStreamOutputType::Audio => CaptureStream::SystemAudio,
            SCStreamOutputType::Microphone => CaptureStream::Microphone,
            SCStreamOutputType::Screen => return None,
        };
        Some(CaptureChunk {
            stream,
            pts_seconds: self.pts_seconds,
            sample_rate_hz: self.sample_rate_hz,
            mono_samples: self.mono_samples.clone(),
        })
    }
}

#[derive(Debug, Clone)]
struct ReusableTimedChunk {
    kind: SCStreamOutputType,
    pts_seconds: f64,
    sample_rate_hz: u32,
    mono_samples: Vec<f32>,
    valid_samples: usize,
}

impl ReusableTimedChunk {
    fn with_capacity(max_samples: usize) -> Self {
        Self {
            kind: SCStreamOutputType::Audio,
            pts_seconds: 0.0,
            sample_rate_hz: 0,
            mono_samples: vec![0.0; max_samples],
            valid_samples: 0,
        }
    }

    fn mono_slice(&self) -> &[f32] {
        &self.mono_samples[..self.valid_samples]
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ResampleStats {
    resampled_chunks: usize,
    input_frames: usize,
    output_frames: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct RuntimeEventCursor {
    restart_count: usize,
    transport: crate::rt_transport::TransportStatsSnapshot,
    callback_audit: CallbackAuditSnapshot,
}

fn parse_u64_arg(args: &[String], index: usize, default: u64) -> Result<u64> {
    if let Some(value) = args.get(index) {
        return value
            .parse::<u64>()
            .with_context(|| format!("argument {index} must be an integer"));
    }
    Ok(default)
}

fn parse_output_arg(args: &[String], index: usize, default: &str) -> PathBuf {
    args.get(index)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    let value = env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn env_u64_or_default(name: &str, default: u64) -> Result<u64> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(default),
        Ok(value) => value
            .trim()
            .parse::<u64>()
            .with_context(|| format!("{name} must be an integer")),
        Err(_) => Ok(default),
    }
}

fn env_bool_or_default(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" => Ok(default),
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            other => {
                bail!("{name} must be one of: 1|0, true|false, yes|no, on|off (received '{other}')")
            }
        },
        Err(_) => Ok(default),
    }
}

fn read_fixture_stereo_channels(path: &Path) -> Result<(u32, Vec<f32>, Vec<f32>)> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("failed to open fixture WAV {}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels < 2 {
        bail!(
            "fake capture fixture must be stereo (>=2 channels), got {} channel(s): {}",
            channels,
            path.display()
        );
    }
    if spec.sample_rate == 0 {
        bail!("fixture WAV has zero sample-rate: {}", path.display());
    }

    let mut mic = Vec::new();
    let mut system = Vec::new();

    match spec.sample_format {
        SampleFormat::Float => {
            for (idx, sample) in reader.samples::<f32>().enumerate() {
                let sample = sample.with_context(|| {
                    format!(
                        "failed to read floating-point fixture sample at index {idx} from {}",
                        path.display()
                    )
                })?;
                match idx % channels {
                    0 => mic.push(sample),
                    1 => system.push(sample),
                    _ => {}
                }
            }
        }
        SampleFormat::Int => {
            let bits = usize::from(spec.bits_per_sample);
            if bits == 0 || bits > 32 {
                bail!(
                    "unsupported integer fixture bit depth {} in {}",
                    spec.bits_per_sample,
                    path.display()
                );
            }
            let denom = ((1_i64 << (bits - 1)) - 1) as f32;
            for (idx, sample) in reader.samples::<i32>().enumerate() {
                let sample = sample.with_context(|| {
                    format!(
                        "failed to read integer fixture sample at index {idx} from {}",
                        path.display()
                    )
                })?;
                let normalized = (sample as f32 / denom).clamp(-1.0, 1.0);
                match idx % channels {
                    0 => mic.push(normalized),
                    1 => system.push(normalized),
                    _ => {}
                }
            }
        }
    }

    if mic.is_empty() || system.is_empty() {
        bail!(
            "fixture WAV must contain interleaved stereo samples (path={})",
            path.display()
        );
    }

    let frame_count = mic.len().min(system.len());
    mic.truncate(frame_count);
    system.truncate(frame_count);
    Ok((spec.sample_rate, mic, system))
}

fn fake_capture_chunk_frames(sample_rate_hz: u32) -> usize {
    // 20ms replay granularity keeps deterministic ordering while limiting sink call volume.
    usize::max(1, (sample_rate_hz as usize) / 50)
}

fn maybe_sleep_for_replay(realtime: bool, replay_start: Instant, pts_seconds: f64) -> Result<()> {
    if !realtime {
        return Ok(());
    }
    if !pts_seconds.is_finite() || pts_seconds <= 0.0 {
        return Ok(());
    }

    let target_elapsed = Duration::from_secs_f64(pts_seconds);
    let now_elapsed = replay_start.elapsed();
    if target_elapsed > now_elapsed {
        thread::sleep(target_elapsed - now_elapsed);
    }
    Ok(())
}

fn read_f32_le(bytes: &[u8], sample_index: usize) -> f32 {
    let offset = sample_index * 4;
    f32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn downmix_to_mono_in_place(
    sample: &CMSampleBuffer,
    mono_out: &mut [f32],
) -> std::result::Result<usize, CallbackContractViolation> {
    let list = sample
        .audio_buffer_list()
        .ok_or(CallbackContractViolation::MissingAudioBufferList)?;

    if list.num_buffers() == 0 {
        return Ok(0);
    }

    if list.num_buffers() == 1 {
        let buffer = list
            .get(0)
            .ok_or(CallbackContractViolation::MissingFirstAudioBuffer)?;
        let channels = usize::max(buffer.number_channels as usize, 1);
        let bytes = buffer.data();
        let sample_count = bytes.len() / 4;

        if channels == 1 {
            if sample_count > mono_out.len() {
                return Err(CallbackContractViolation::ChunkTooLarge);
            }
            for (i, slot) in mono_out.iter_mut().take(sample_count).enumerate() {
                *slot = read_f32_le(bytes, i);
            }
            return Ok(sample_count);
        }

        let frames = sample_count / channels;
        if frames > mono_out.len() {
            return Err(CallbackContractViolation::ChunkTooLarge);
        }

        for (frame_idx, slot) in mono_out.iter_mut().take(frames).enumerate() {
            let mut acc = 0.0f32;
            for ch in 0..channels {
                let sample_idx = frame_idx * channels + ch;
                acc += read_f32_le(bytes, sample_idx);
            }
            *slot = acc / channels as f32;
        }
        return Ok(frames);
    }

    let mut min_frames = usize::MAX;
    for buffer in &list {
        min_frames = min_frames.min(buffer.data().len() / 4);
    }

    if min_frames == usize::MAX || min_frames == 0 {
        return Ok(0);
    }

    if min_frames > mono_out.len() {
        return Err(CallbackContractViolation::ChunkTooLarge);
    }

    for slot in mono_out.iter_mut().take(min_frames) {
        *slot = 0.0;
    }

    let scale = 1.0f32 / list.num_buffers() as f32;
    for buffer in &list {
        let bytes = buffer.data();
        for (i, slot) in mono_out.iter_mut().take(min_frames).enumerate() {
            *slot += read_f32_le(bytes, i) * scale;
        }
    }

    Ok(min_frames)
}

fn fill_chunk_slot(
    sample: CMSampleBuffer,
    kind: SCStreamOutputType,
    slot: &mut ReusableTimedChunk,
) -> std::result::Result<(), CallbackContractViolation> {
    let pts_seconds = sample
        .presentation_timestamp()
        .as_seconds()
        .unwrap_or_default();

    let format = sample
        .format_description()
        .ok_or(CallbackContractViolation::MissingFormatDescription)?;

    if !format.audio_is_float() {
        return Err(CallbackContractViolation::NonFloatPcm);
    }

    let sample_rate_hz = format
        .audio_sample_rate()
        .ok_or(CallbackContractViolation::MissingSampleRate)?
        .round() as u32;

    let valid_samples = downmix_to_mono_in_place(&sample, &mut slot.mono_samples)?;

    slot.kind = kind;
    slot.pts_seconds = pts_seconds;
    slot.sample_rate_hz = sample_rate_hz;
    slot.valid_samples = valid_samples;

    Ok(())
}

fn callback(
    producer: &PreallocatedProducer<ReusableTimedChunk>,
    callback_audit: &CallbackAudit,
    sample: CMSampleBuffer,
    kind: SCStreamOutputType,
) {
    producer.try_push_with(|slot| match fill_chunk_slot(sample, kind, slot) {
        Ok(()) => true,
        Err(violation) => {
            callback_audit.record(violation);
            false
        }
    });
}

fn resample_linear_mono(samples: &[f32], input_rate_hz: u32, output_rate_hz: u32) -> Vec<f32> {
    if samples.is_empty()
        || input_rate_hz == output_rate_hz
        || input_rate_hz == 0
        || output_rate_hz == 0
    {
        return samples.to_vec();
    }

    let mut output_len = ((samples.len() as u128 * output_rate_hz as u128
        + input_rate_hz as u128 / 2)
        / input_rate_hz as u128) as usize;
    output_len = output_len.max(1);

    if samples.len() == 1 {
        return vec![samples[0]; output_len];
    }

    let mut output = Vec::with_capacity(output_len);
    let ratio = f64::from(input_rate_hz) / f64::from(output_rate_hz);
    for i in 0..output_len {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos.floor() as usize;
        if src_idx >= samples.len() - 1 {
            output.push(*samples.last().unwrap_or(&0.0));
            continue;
        }
        let frac = (src_pos - src_idx as f64) as f32;
        let a = samples[src_idx];
        let b = samples[src_idx + 1];
        output.push(a + ((b - a) * frac));
    }
    output
}

fn paint_chunks_timeline(
    chunks: &[TimedChunk],
    base_pts: f64,
    sample_rate_hz: u32,
) -> (Vec<f32>, ResampleStats) {
    let mut timeline = Vec::<f32>::new();
    let mut resample_stats = ResampleStats::default();
    let rate = f64::from(sample_rate_hz);

    for chunk in chunks {
        let maybe_resampled = if chunk.sample_rate_hz == sample_rate_hz {
            None
        } else {
            Some(resample_linear_mono(
                &chunk.mono_samples,
                chunk.sample_rate_hz,
                sample_rate_hz,
            ))
        };

        let chunk_samples = if let Some(resampled) = maybe_resampled.as_deref() {
            resample_stats.resampled_chunks += 1;
            resample_stats.input_frames += chunk.mono_samples.len();
            resample_stats.output_frames += resampled.len();
            resampled
        } else {
            chunk.mono_samples.as_slice()
        };

        let start = ((chunk.pts_seconds - base_pts) * rate).round();
        let start_index = if start <= 0.0 { 0usize } else { start as usize };
        let end_index = start_index.saturating_add(chunk_samples.len());
        if timeline.len() < end_index {
            timeline.resize(end_index, 0.0);
        }
        timeline[start_index..end_index].copy_from_slice(chunk_samples);
    }

    (timeline, resample_stats)
}

#[derive(Debug, Default)]
struct ProgressiveWavSnapshotState {
    output_rate_hz: u32,
    base_pts: f64,
    mic_timeline: Vec<f32>,
    sys_timeline: Vec<f32>,
    mic_applied_chunks: usize,
    sys_applied_chunks: usize,
}

fn apply_chunks_to_timeline(
    timeline: &mut Vec<f32>,
    chunks: &[TimedChunk],
    start_chunk_idx: usize,
    base_pts: f64,
    sample_rate_hz: u32,
) {
    let rate = f64::from(sample_rate_hz);
    for chunk in chunks.iter().skip(start_chunk_idx) {
        let maybe_resampled = if chunk.sample_rate_hz == sample_rate_hz {
            None
        } else {
            Some(resample_linear_mono(
                &chunk.mono_samples,
                chunk.sample_rate_hz,
                sample_rate_hz,
            ))
        };

        let chunk_samples = maybe_resampled.as_deref().unwrap_or(&chunk.mono_samples);
        let start = ((chunk.pts_seconds - base_pts) * rate).round();
        let start_index = if start <= 0.0 { 0usize } else { start as usize };
        let end_index = start_index.saturating_add(chunk_samples.len());
        if timeline.len() < end_index {
            timeline.resize(end_index, 0.0);
        }
        timeline[start_index..end_index].copy_from_slice(chunk_samples);
    }
}

fn write_interleaved_stereo_wav(
    path: &Path,
    sample_rate_hz: u32,
    mic: &[f32],
    sys: &[f32],
) -> Result<()> {
    let spec = WavSpec {
        channels: 2,
        sample_rate: sample_rate_hz,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(path, spec).context("failed to create WAV writer")?;
    let frame_count = mic.len().max(sys.len());

    for i in 0..frame_count {
        let left = mic.get(i).copied().unwrap_or(0.0);
        let right = sys.get(i).copied().unwrap_or(0.0);
        writer
            .write_sample(left)
            .context("failed to write mic sample")?;
        writer
            .write_sample(right)
            .context("failed to write system sample")?;
    }

    writer.finalize().context("failed to finalize WAV file")?;
    Ok(())
}

fn emit_capture_event_if_increased(
    sink: &mut dyn CaptureSink,
    code: CaptureEventCode,
    previous: u64,
    current: u64,
    recovery_action: RecoveryAction,
    detail: &'static str,
) -> Result<()> {
    if current <= previous {
        return Ok(());
    }
    sink.on_event(CaptureEvent {
        generated_unix: now_unix(),
        code,
        count: current - previous,
        recovery_action: to_capture_recovery_action(recovery_action),
        detail: detail.to_string(),
    })
    .map_err(|err| anyhow::anyhow!("capture sink rejected runtime event: {err}"))
}

fn emit_runtime_event_deltas(
    sink: &mut dyn CaptureSink,
    cursor: &mut RuntimeEventCursor,
    restart_count: usize,
    transport: crate::rt_transport::TransportStatsSnapshot,
    callback_audit: CallbackAuditSnapshot,
) -> Result<()> {
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::StreamInterruption,
        cursor.restart_count as u64,
        restart_count as u64,
        RecoveryAction::RestartStream,
        "capture stream interruption detected and restart attempted",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::SlotMissDrops,
        cursor.transport.slot_miss_drops,
        transport.slot_miss_drops,
        RecoveryAction::DropSampleContinue,
        "callback could not acquire a free slot",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::FillFailures,
        cursor.transport.fill_failures,
        transport.fill_failures,
        RecoveryAction::DropSampleContinue,
        "callback could not fill timed chunk payload",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::QueueFullDrops,
        cursor.transport.queue_full_drops,
        transport.queue_full_drops,
        RecoveryAction::DropSampleContinue,
        "ready queue full during callback handoff",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::RecycleFailures,
        cursor.transport.recycle_failures,
        transport.recycle_failures,
        RecoveryAction::DropSampleContinue,
        "consumer recycle path failed to return slot",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::MissingAudioBufferList,
        cursor.callback_audit.missing_audio_buffer_list,
        callback_audit.missing_audio_buffer_list,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingAudioBufferList),
        "audio buffer list was unavailable in callback path",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::MissingFirstAudioBuffer,
        cursor.callback_audit.missing_first_audio_buffer,
        callback_audit.missing_first_audio_buffer,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFirstAudioBuffer),
        "first audio buffer missing in callback path",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::MissingFormatDescription,
        cursor.callback_audit.missing_format_description,
        callback_audit.missing_format_description,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFormatDescription),
        "format description unavailable for callback sample",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::MissingSampleRate,
        cursor.callback_audit.missing_sample_rate,
        callback_audit.missing_sample_rate,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingSampleRate),
        "sample rate unavailable in callback sample metadata",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::NonFloatPcm,
        cursor.callback_audit.non_float_pcm,
        callback_audit.non_float_pcm,
        recovery_action_for_callback_violation(CallbackContractViolation::NonFloatPcm),
        "non-float PCM observed in callback path",
    )?;
    emit_capture_event_if_increased(
        sink,
        CaptureEventCode::ChunkTooLarge,
        cursor.callback_audit.chunk_too_large,
        callback_audit.chunk_too_large,
        recovery_action_for_callback_violation(CallbackContractViolation::ChunkTooLarge),
        "callback chunk exceeded preallocated max sample count",
    )?;

    cursor.restart_count = restart_count;
    cursor.transport = transport;
    cursor.callback_audit = callback_audit;
    Ok(())
}

#[cfg(test)]
fn materialize_progressive_wav_snapshot(
    output: &Path,
    mic_chunks: &[TimedChunk],
    sys_chunks: &[TimedChunk],
    target_rate_hz: u32,
    mismatch_policy: SampleRateMismatchPolicy,
) -> Result<Option<u32>> {
    if mic_chunks.is_empty() || sys_chunks.is_empty() {
        return Ok(None);
    }

    let mic_rate = mic_chunks[0].sample_rate_hz;
    let sys_rate = sys_chunks[0].sample_rate_hz;
    let output_rate_hz =
        resolve_output_sample_rate(target_rate_hz, mic_rate, sys_rate, mismatch_policy)?;
    let base_pts = mic_chunks[0].pts_seconds.min(sys_chunks[0].pts_seconds);
    let (mic, _) = paint_chunks_timeline(mic_chunks, base_pts, output_rate_hz);
    let (sys, _) = paint_chunks_timeline(sys_chunks, base_pts, output_rate_hz);
    write_interleaved_stereo_wav(output, output_rate_hz, &mic, &sys)?;

    Ok(Some(output_rate_hz))
}

fn materialize_progressive_wav_snapshot_incremental(
    output: &Path,
    mic_chunks: &[TimedChunk],
    sys_chunks: &[TimedChunk],
    target_rate_hz: u32,
    mismatch_policy: SampleRateMismatchPolicy,
    state: &mut Option<ProgressiveWavSnapshotState>,
) -> Result<Option<u32>> {
    if mic_chunks.is_empty() || sys_chunks.is_empty() {
        return Ok(None);
    }

    let mic_rate = mic_chunks[0].sample_rate_hz;
    let sys_rate = sys_chunks[0].sample_rate_hz;
    let output_rate_hz =
        resolve_output_sample_rate(target_rate_hz, mic_rate, sys_rate, mismatch_policy)?;
    let base_pts = mic_chunks[0].pts_seconds.min(sys_chunks[0].pts_seconds);

    let should_reset = match state.as_ref() {
        Some(cached) => {
            cached.output_rate_hz != output_rate_hz
                || cached.base_pts.to_bits() != base_pts.to_bits()
                || cached.mic_applied_chunks > mic_chunks.len()
                || cached.sys_applied_chunks > sys_chunks.len()
        }
        None => true,
    };
    if should_reset {
        *state = Some(ProgressiveWavSnapshotState {
            output_rate_hz,
            base_pts,
            ..ProgressiveWavSnapshotState::default()
        });
    }

    let snapshot = state
        .as_mut()
        .expect("progressive snapshot state initialized");
    apply_chunks_to_timeline(
        &mut snapshot.mic_timeline,
        mic_chunks,
        snapshot.mic_applied_chunks,
        base_pts,
        output_rate_hz,
    );
    apply_chunks_to_timeline(
        &mut snapshot.sys_timeline,
        sys_chunks,
        snapshot.sys_applied_chunks,
        base_pts,
        output_rate_hz,
    );
    snapshot.mic_applied_chunks = mic_chunks.len();
    snapshot.sys_applied_chunks = sys_chunks.len();

    write_interleaved_stereo_wav(
        output,
        output_rate_hz,
        &snapshot.mic_timeline,
        &snapshot.sys_timeline,
    )?;
    Ok(Some(output_rate_hz))
}

fn should_materialize_progressive_snapshot(
    progressive_materializations: usize,
    materialized_chunk_total: usize,
    total_chunks: usize,
    elapsed_since_last: Duration,
) -> bool {
    let new_chunks = total_chunks.saturating_sub(materialized_chunk_total);
    if new_chunks == 0 {
        return false;
    }
    if progressive_materializations == 0 {
        // Ensure the first progressive WAV appears during active capture as soon as data exists.
        return true;
    }
    new_chunks >= PROGRESSIVE_WAV_MATERIALIZE_MIN_NEW_CHUNKS
        && elapsed_since_last >= PROGRESSIVE_WAV_MATERIALIZE_INTERVAL
}

fn telemetry_path_for_output(output: &Path) -> PathBuf {
    capture_telemetry_path_for_output(output)
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            _ => vec![c],
        })
        .collect()
}

struct RunTelemetry {
    output_wav_path: PathBuf,
    duration_secs: u64,
    target_rate_hz: u32,
    output_rate_hz: u32,
    mismatch_policy: SampleRateMismatchPolicy,
    mic_input_rate_hz: u32,
    system_input_rate_hz: u32,
    mic_resample: ResampleStats,
    system_resample: ResampleStats,
    mic_chunks: usize,
    system_chunks: usize,
    output_frames: usize,
    restart_count: usize,
    transport: crate::rt_transport::TransportStatsSnapshot,
    callback_audit: CallbackAuditSnapshot,
}

#[derive(Default)]
struct CollectingCaptureSink {
    chunks: Vec<CaptureChunk>,
    events: Vec<CaptureEvent>,
}

impl CaptureSink for CollectingCaptureSink {
    fn on_chunk(&mut self, chunk: CaptureChunk) -> std::result::Result<(), String> {
        self.chunks.push(chunk);
        Ok(())
    }

    fn on_event(&mut self, event: CaptureEvent) -> std::result::Result<(), String> {
        self.events.push(event);
        Ok(())
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn to_capture_recovery_action(action: RecoveryAction) -> CaptureRecoveryAction {
    match action {
        RecoveryAction::DropSampleContinue => CaptureRecoveryAction::DropSampleContinue,
        RecoveryAction::RestartStream => CaptureRecoveryAction::RestartStream,
        RecoveryAction::AdaptOutputRate => CaptureRecoveryAction::AdaptOutputRate,
        RecoveryAction::FailFastReconfigure => CaptureRecoveryAction::FailFastReconfigure,
    }
}

fn to_capture_sample_rate_mismatch_policy(
    policy: SampleRateMismatchPolicy,
) -> crate::capture_api::SampleRateMismatchPolicy {
    match policy {
        SampleRateMismatchPolicy::Strict => crate::capture_api::SampleRateMismatchPolicy::Strict,
        SampleRateMismatchPolicy::AdaptStreamRate => {
            crate::capture_api::SampleRateMismatchPolicy::AdaptStreamRate
        }
    }
}

fn append_capture_event(
    events: &mut Vec<CaptureEvent>,
    generated_unix: u64,
    code: CaptureEventCode,
    count: u64,
    action: RecoveryAction,
    detail: &str,
) {
    if count == 0 {
        return;
    }

    events.push(CaptureEvent {
        generated_unix,
        code,
        count,
        recovery_action: to_capture_recovery_action(action),
        detail: detail.to_string(),
    });
}

fn append_degradation_event(
    events: &mut Vec<CaptureDegradationEvent>,
    generated_unix: u64,
    stage: &str,
    source: &str,
    count: u64,
    action: RecoveryAction,
    detail: &str,
) {
    if count == 0 {
        return;
    }

    events.push(CaptureDegradationEvent {
        generated_unix,
        stage: stage.to_string(),
        source: source.to_string(),
        count,
        recovery_action: to_capture_recovery_action(action),
        detail: detail.to_string(),
    });
}

fn build_degradation_events(
    telemetry: &RunTelemetry,
    generated_unix: u64,
) -> Vec<CaptureDegradationEvent> {
    let mut events = Vec::new();

    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "stream_interruption",
        telemetry.restart_count as u64,
        RecoveryAction::RestartStream,
        "capture stream interruption detected and restart attempted",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "slot_miss_drops",
        telemetry.transport.slot_miss_drops,
        RecoveryAction::DropSampleContinue,
        "callback could not acquire a free slot",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "fill_failures",
        telemetry.transport.fill_failures,
        RecoveryAction::DropSampleContinue,
        "callback could not fill timed chunk payload",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "queue_full_drops",
        telemetry.transport.queue_full_drops,
        RecoveryAction::DropSampleContinue,
        "ready queue full during callback handoff",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "recycle_failures",
        telemetry.transport.recycle_failures,
        RecoveryAction::DropSampleContinue,
        "consumer recycle path failed to return slot",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "missing_audio_buffer_list",
        telemetry.callback_audit.missing_audio_buffer_list,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingAudioBufferList),
        "audio buffer list was unavailable in callback path",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "missing_first_audio_buffer",
        telemetry.callback_audit.missing_first_audio_buffer,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFirstAudioBuffer),
        "first audio buffer missing in callback path",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "missing_format_description",
        telemetry.callback_audit.missing_format_description,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFormatDescription),
        "format description unavailable for callback sample",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "missing_sample_rate",
        telemetry.callback_audit.missing_sample_rate,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingSampleRate),
        "sample rate unavailable in callback sample metadata",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "non_float_pcm",
        telemetry.callback_audit.non_float_pcm,
        recovery_action_for_callback_violation(CallbackContractViolation::NonFloatPcm),
        "non-float PCM observed in callback path",
    );
    append_degradation_event(
        &mut events,
        generated_unix,
        "capture",
        "chunk_too_large",
        telemetry.callback_audit.chunk_too_large,
        recovery_action_for_callback_violation(CallbackContractViolation::ChunkTooLarge),
        "callback chunk exceeded preallocated max sample count",
    );

    events
}

fn build_capture_events(telemetry: &RunTelemetry, generated_unix: u64) -> Vec<CaptureEvent> {
    let mut events = Vec::new();

    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::StreamInterruption,
        telemetry.restart_count as u64,
        RecoveryAction::RestartStream,
        "capture stream interruption detected and restart attempted",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::SlotMissDrops,
        telemetry.transport.slot_miss_drops,
        RecoveryAction::DropSampleContinue,
        "callback could not acquire a free slot",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::FillFailures,
        telemetry.transport.fill_failures,
        RecoveryAction::DropSampleContinue,
        "callback could not fill timed chunk payload",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::QueueFullDrops,
        telemetry.transport.queue_full_drops,
        RecoveryAction::DropSampleContinue,
        "ready queue full during callback handoff",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::RecycleFailures,
        telemetry.transport.recycle_failures,
        RecoveryAction::DropSampleContinue,
        "consumer recycle path failed to return slot",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::MissingAudioBufferList,
        telemetry.callback_audit.missing_audio_buffer_list,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingAudioBufferList),
        "audio buffer list was unavailable in callback path",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::MissingFirstAudioBuffer,
        telemetry.callback_audit.missing_first_audio_buffer,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFirstAudioBuffer),
        "first audio buffer missing in callback path",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::MissingFormatDescription,
        telemetry.callback_audit.missing_format_description,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingFormatDescription),
        "format description unavailable for callback sample",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::MissingSampleRate,
        telemetry.callback_audit.missing_sample_rate,
        recovery_action_for_callback_violation(CallbackContractViolation::MissingSampleRate),
        "sample rate unavailable in callback sample metadata",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::NonFloatPcm,
        telemetry.callback_audit.non_float_pcm,
        recovery_action_for_callback_violation(CallbackContractViolation::NonFloatPcm),
        "non-float PCM observed in callback path",
    );
    append_capture_event(
        &mut events,
        generated_unix,
        CaptureEventCode::ChunkTooLarge,
        telemetry.callback_audit.chunk_too_large,
        recovery_action_for_callback_violation(CallbackContractViolation::ChunkTooLarge),
        "callback chunk exceeded preallocated max sample count",
    );

    events
}

fn build_capture_run_summary(
    telemetry: &RunTelemetry,
    degradation_events: Vec<CaptureDegradationEvent>,
) -> CaptureRunSummary {
    CaptureRunSummary {
        output_wav_path: telemetry.output_wav_path.to_string_lossy().to_string(),
        duration_secs: telemetry.duration_secs,
        target_rate_hz: telemetry.target_rate_hz,
        output_rate_hz: telemetry.output_rate_hz,
        mic_chunks: telemetry.mic_chunks,
        system_chunks: telemetry.system_chunks,
        output_frames: telemetry.output_frames,
        restart_count: telemetry.restart_count as u64,
        transport: CaptureTransportSummary {
            capacity: telemetry.transport.capacity,
            ready_depth_high_water: telemetry.transport.ready_depth_high_water,
            in_flight: telemetry.transport.in_flight,
            enqueued: telemetry.transport.enqueued,
            dequeued: telemetry.transport.dequeued,
            slot_miss_drops: telemetry.transport.slot_miss_drops,
            fill_failures: telemetry.transport.fill_failures,
            queue_full_drops: telemetry.transport.queue_full_drops,
            recycle_failures: telemetry.transport.recycle_failures,
        },
        callback_audit: CaptureCallbackAuditSummary {
            missing_audio_buffer_list: telemetry.callback_audit.missing_audio_buffer_list,
            missing_first_audio_buffer: telemetry.callback_audit.missing_first_audio_buffer,
            missing_format_description: telemetry.callback_audit.missing_format_description,
            missing_sample_rate: telemetry.callback_audit.missing_sample_rate,
            non_float_pcm: telemetry.callback_audit.non_float_pcm,
            chunk_too_large: telemetry.callback_audit.chunk_too_large,
        },
        sample_rate_policy: CaptureSampleRatePolicySummary {
            mismatch_policy: telemetry.mismatch_policy.as_str().to_string(),
            target_rate_hz: telemetry.target_rate_hz,
            output_rate_hz: telemetry.output_rate_hz,
            mic_input_rate_hz: telemetry.mic_input_rate_hz,
            system_input_rate_hz: telemetry.system_input_rate_hz,
            mic_resample: CaptureResampleSummary {
                resampled_chunks: telemetry.mic_resample.resampled_chunks,
                input_frames: telemetry.mic_resample.input_frames,
                output_frames: telemetry.mic_resample.output_frames,
            },
            system_resample: CaptureResampleSummary {
                resampled_chunks: telemetry.system_resample.resampled_chunks,
                input_frames: telemetry.system_resample.input_frames,
                output_frames: telemetry.system_resample.output_frames,
            },
        },
        degradation_events,
    }
}

fn build_capture_summary(telemetry: &RunTelemetry, generated_unix: u64) -> CaptureSummary {
    CaptureSummary {
        generated_unix,
        output_wav_path: telemetry.output_wav_path.clone(),
        duration_secs: telemetry.duration_secs,
        target_rate_hz: telemetry.target_rate_hz,
        output_rate_hz: telemetry.output_rate_hz,
        mismatch_policy: to_capture_sample_rate_mismatch_policy(telemetry.mismatch_policy),
        microphone: CaptureStreamSummary {
            input_rate_hz: telemetry.mic_input_rate_hz,
            chunk_count: telemetry.mic_chunks,
            resample: ResampleSummary {
                resampled_chunks: telemetry.mic_resample.resampled_chunks,
                input_frames: telemetry.mic_resample.input_frames,
                output_frames: telemetry.mic_resample.output_frames,
            },
        },
        system_audio: CaptureStreamSummary {
            input_rate_hz: telemetry.system_input_rate_hz,
            chunk_count: telemetry.system_chunks,
            resample: ResampleSummary {
                resampled_chunks: telemetry.system_resample.resampled_chunks,
                input_frames: telemetry.system_resample.input_frames,
                output_frames: telemetry.system_resample.output_frames,
            },
        },
        output_frames: telemetry.output_frames,
        restart_count: telemetry.restart_count,
        transport: telemetry.transport,
        callback_contract: CallbackContractSummary {
            missing_audio_buffer_list: telemetry.callback_audit.missing_audio_buffer_list,
            missing_first_audio_buffer: telemetry.callback_audit.missing_first_audio_buffer,
            missing_format_description: telemetry.callback_audit.missing_format_description,
            missing_sample_rate: telemetry.callback_audit.missing_sample_rate,
            non_float_pcm: telemetry.callback_audit.non_float_pcm,
            chunk_too_large: telemetry.callback_audit.chunk_too_large,
        },
        degradation_events: build_capture_events(telemetry, generated_unix),
    }
}

fn render_degradation_events_json(events: &[CaptureDegradationEvent]) -> String {
    if events.is_empty() {
        return String::new();
    }

    let rendered = events
        .iter()
        .map(|event| {
            format!(
                "    {{\"generated_unix\":{},\"stage\":\"{}\",\"source\":\"{}\",\"count\":{},\"recovery_action\":\"{}\",\"detail\":\"{}\"}}",
                event.generated_unix,
                json_escape(&event.stage),
                json_escape(&event.source),
                event.count,
                event.recovery_action.as_str(),
                json_escape(&event.detail)
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    format!("\n{rendered}\n  ")
}

fn write_run_telemetry(path: &Path, telemetry: &RunTelemetry) -> Result<()> {
    let now_unix = now_unix();
    let degradation_events = build_degradation_events(telemetry, now_unix);
    let summary = build_capture_run_summary(telemetry, degradation_events);
    let degradation_events_json = render_degradation_events_json(&summary.degradation_events);

    let json = format!(
        concat!(
            "{{\n",
            "  \"generated_unix\": {},\n",
            "  \"output_wav_path\": \"{}\",\n",
            "  \"duration_secs\": {},\n",
            "  \"target_rate_hz\": {},\n",
            "  \"output_rate_hz\": {},\n",
            "  \"mic_chunks\": {},\n",
            "  \"system_chunks\": {},\n",
            "  \"output_frames\": {},\n",
            "  \"restart_count\": {},\n",
            "  \"transport\": {{\n",
            "    \"capacity\": {},\n",
            "    \"ready_depth_high_water\": {},\n",
            "    \"in_flight\": {},\n",
            "    \"enqueued\": {},\n",
            "    \"dequeued\": {},\n",
            "    \"slot_miss_drops\": {},\n",
            "    \"fill_failures\": {},\n",
            "    \"queue_full_drops\": {},\n",
            "    \"recycle_failures\": {}\n",
            "  }},\n",
            "  \"callback_contract\": {{\n",
            "    \"missing_audio_buffer_list\": {},\n",
            "    \"missing_first_audio_buffer\": {},\n",
            "    \"missing_format_description\": {},\n",
            "    \"missing_sample_rate\": {},\n",
            "    \"non_float_pcm\": {},\n",
            "    \"chunk_too_large\": {}\n",
            "  }},\n",
            "  \"sample_rate_policy\": {{\n",
            "    \"mismatch_policy\": \"{}\",\n",
            "    \"target_rate_hz\": {},\n",
            "    \"output_rate_hz\": {},\n",
            "    \"mic_input_rate_hz\": {},\n",
            "    \"system_input_rate_hz\": {},\n",
            "    \"mic_resampled_chunks\": {},\n",
            "    \"mic_resampled_input_frames\": {},\n",
            "    \"mic_resampled_output_frames\": {},\n",
            "    \"system_resampled_chunks\": {},\n",
            "    \"system_resampled_input_frames\": {},\n",
            "    \"system_resampled_output_frames\": {}\n",
            "  }},\n",
            "  \"degradation_events\": [{}]\n",
            "}}\n"
        ),
        now_unix,
        json_escape(&summary.output_wav_path),
        summary.duration_secs,
        summary.target_rate_hz,
        summary.output_rate_hz,
        summary.mic_chunks,
        summary.system_chunks,
        summary.output_frames,
        summary.restart_count,
        summary.transport.capacity,
        summary.transport.ready_depth_high_water,
        summary.transport.in_flight,
        summary.transport.enqueued,
        summary.transport.dequeued,
        summary.transport.slot_miss_drops,
        summary.transport.fill_failures,
        summary.transport.queue_full_drops,
        summary.transport.recycle_failures,
        summary.callback_audit.missing_audio_buffer_list,
        summary.callback_audit.missing_first_audio_buffer,
        summary.callback_audit.missing_format_description,
        summary.callback_audit.missing_sample_rate,
        summary.callback_audit.non_float_pcm,
        summary.callback_audit.chunk_too_large,
        summary.sample_rate_policy.mismatch_policy,
        summary.sample_rate_policy.target_rate_hz,
        summary.sample_rate_policy.output_rate_hz,
        summary.sample_rate_policy.mic_input_rate_hz,
        summary.sample_rate_policy.system_input_rate_hz,
        summary.sample_rate_policy.mic_resample.resampled_chunks,
        summary.sample_rate_policy.mic_resample.input_frames,
        summary.sample_rate_policy.mic_resample.output_frames,
        summary.sample_rate_policy.system_resample.resampled_chunks,
        summary.sample_rate_policy.system_resample.input_frames,
        summary.sample_rate_policy.system_resample.output_frames,
        degradation_events_json,
    );

    fs::write(path, json).with_context(|| format!("failed to write telemetry {}", path.display()))
}

fn callback_recovery_breakdown(snapshot: CallbackAuditSnapshot) -> Vec<String> {
    let mut lines = Vec::new();
    let entries = [
        (
            "missing_audio_buffer_list",
            snapshot.missing_audio_buffer_list,
            recovery_action_for_callback_violation(
                CallbackContractViolation::MissingAudioBufferList,
            ),
        ),
        (
            "missing_first_audio_buffer",
            snapshot.missing_first_audio_buffer,
            recovery_action_for_callback_violation(
                CallbackContractViolation::MissingFirstAudioBuffer,
            ),
        ),
        (
            "missing_format_description",
            snapshot.missing_format_description,
            recovery_action_for_callback_violation(
                CallbackContractViolation::MissingFormatDescription,
            ),
        ),
        (
            "missing_sample_rate",
            snapshot.missing_sample_rate,
            recovery_action_for_callback_violation(CallbackContractViolation::MissingSampleRate),
        ),
        (
            "non_float_pcm",
            snapshot.non_float_pcm,
            recovery_action_for_callback_violation(CallbackContractViolation::NonFloatPcm),
        ),
        (
            "chunk_too_large",
            snapshot.chunk_too_large,
            recovery_action_for_callback_violation(CallbackContractViolation::ChunkTooLarge),
        ),
    ];

    for (name, count, action) in entries {
        if count > 0 {
            lines.push(format!("{name}={count} -> {:?}", action));
        }
    }
    lines
}

fn enforce_callback_contract(
    mode: CallbackContractMode,
    snapshot: CallbackAuditSnapshot,
) -> Result<()> {
    let total = snapshot.total_violations();
    if total == 0 {
        return Ok(());
    }

    let details = callback_recovery_breakdown(snapshot).join(", ");
    match mode {
        CallbackContractMode::Warn => {
            eprintln!(
                "callback contract violations observed (mode=warn, total={}): {}",
                total, details
            );
            Ok(())
        }
        CallbackContractMode::Strict => bail!(
            "callback contract violations observed (mode=strict, total={}): {}",
            total,
            details
        ),
    }
}

pub fn config_from_cli_args(args: &[String]) -> Result<LiveCaptureConfig> {
    Ok(LiveCaptureConfig {
        duration_secs: parse_u64_arg(args, 1, 10)?,
        output: parse_output_arg(args, 2, "artifacts/hello-world.wav"),
        target_rate_hz: parse_u64_arg(args, 3, 48_000)? as u32,
        mismatch_policy: parse_sample_rate_policy_arg(
            args,
            4,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )?,
        callback_contract_mode: parse_callback_contract_mode_arg(
            args,
            5,
            CallbackContractMode::Warn,
        )?,
        stop_request_path: None,
    })
}

pub fn run_capture_cli(args: &[String]) -> Result<()> {
    let config = config_from_cli_args(args)?;
    run_capture_session(&config)
}

fn run_fake_capture_session(
    config: &LiveCaptureConfig,
    fixture: &Path,
    restart_count: u64,
    sink: &mut dyn CaptureSink,
) -> Result<StreamingCaptureResult> {
    if !fixture.is_file() {
        bail!(
            "fake capture fixture from {} is not a file: {}",
            FAKE_CAPTURE_FIXTURE_ENV,
            fixture.display()
        );
    }
    if let Some(parent) = config.output.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory {}", parent.display()))?;
    }

    let stop_request_path = config.stop_request_path.as_deref();
    let (fixture_rate_hz, mic_samples, system_samples) = read_fixture_stereo_channels(fixture)?;
    let frame_count = mic_samples.len().min(system_samples.len());
    if config.mismatch_policy == SampleRateMismatchPolicy::Strict
        && fixture_rate_hz != config.target_rate_hz
    {
        bail!(
            "fake capture fixture sample-rate mismatch under strict policy: fixture={}Hz target={}Hz",
            fixture_rate_hz,
            config.target_rate_hz
        );
    }
    let replay_realtime = env_bool_or_default(FAKE_CAPTURE_REALTIME_ENV, false)?;
    let chunk_frames = fake_capture_chunk_frames(fixture_rate_hz);
    let replay_started = Instant::now();
    let mut mic_chunk_count = 0usize;
    let mut system_chunk_count = 0usize;
    let mut mic_chunks = Vec::<TimedChunk>::new();
    let mut sys_chunks = Vec::<TimedChunk>::new();
    let mut last_materialize_at = Instant::now();
    let mut materialized_chunk_total = 0usize;
    let mut progressive_materializations = 0usize;
    let mut progressive_snapshot_state = None;

    if restart_count > 0 {
        sink.on_event(CaptureEvent {
            generated_unix: now_unix(),
            code: CaptureEventCode::StreamInterruption,
            count: restart_count,
            recovery_action: CaptureRecoveryAction::RestartStream,
            detail: "fake capture restart count injected for deterministic testing".to_string(),
        })
        .map_err(|err| anyhow::anyhow!("capture sink rejected fake interruption event: {err}"))?;
    }

    let mut frame_start = 0usize;
    while frame_start < frame_count && !stop_capture_requested_or_marker(stop_request_path) {
        let frame_end = (frame_start + chunk_frames).min(frame_count);
        let pts_seconds = frame_start as f64 / fixture_rate_hz as f64;
        maybe_sleep_for_replay(replay_realtime, replay_started, pts_seconds)?;
        if stop_capture_requested_or_marker(stop_request_path) {
            break;
        }

        sink.on_chunk(CaptureChunk {
            stream: CaptureStream::SystemAudio,
            pts_seconds,
            sample_rate_hz: fixture_rate_hz,
            mono_samples: system_samples[frame_start..frame_end].to_vec(),
        })
        .map_err(|err| anyhow::anyhow!("capture sink rejected fake system chunk: {err}"))?;
        system_chunk_count += 1;
        sys_chunks.push(TimedChunk {
            kind: SCStreamOutputType::Audio,
            pts_seconds,
            sample_rate_hz: fixture_rate_hz,
            mono_samples: system_samples[frame_start..frame_end].to_vec(),
        });

        sink.on_chunk(CaptureChunk {
            stream: CaptureStream::Microphone,
            pts_seconds,
            sample_rate_hz: fixture_rate_hz,
            mono_samples: mic_samples[frame_start..frame_end].to_vec(),
        })
        .map_err(|err| anyhow::anyhow!("capture sink rejected fake microphone chunk: {err}"))?;
        mic_chunk_count += 1;
        mic_chunks.push(TimedChunk {
            kind: SCStreamOutputType::Microphone,
            pts_seconds,
            sample_rate_hz: fixture_rate_hz,
            mono_samples: mic_samples[frame_start..frame_end].to_vec(),
        });

        let total_chunks = mic_chunks.len().saturating_add(sys_chunks.len());
        let has_both_channels = !mic_chunks.is_empty() && !sys_chunks.is_empty();
        let cadence_elapsed = if replay_realtime {
            last_materialize_at.elapsed()
        } else {
            PROGRESSIVE_WAV_MATERIALIZE_INTERVAL
        };
        if has_both_channels
            && should_materialize_progressive_snapshot(
                progressive_materializations,
                materialized_chunk_total,
                total_chunks,
                cadence_elapsed,
            )
        {
            if materialize_progressive_wav_snapshot_incremental(
                &config.output,
                &mic_chunks,
                &sys_chunks,
                config.target_rate_hz,
                config.mismatch_policy,
                &mut progressive_snapshot_state,
            )?
            .is_some()
            {
                progressive_materializations += 1;
                materialized_chunk_total = total_chunks;
                last_materialize_at = Instant::now();
            }
        }

        frame_start = frame_end;
    }

    if mic_chunks.is_empty() && sys_chunks.is_empty() {
        bail!(
            "missing captured data (mic chunks: {}, system chunks: {})",
            mic_chunks.len(),
            sys_chunks.len()
        );
    }

    if progressive_materializations == 0 && !mic_chunks.is_empty() && !sys_chunks.is_empty() {
        if materialize_progressive_wav_snapshot_incremental(
            &config.output,
            &mic_chunks,
            &sys_chunks,
            config.target_rate_hz,
            config.mismatch_policy,
            &mut progressive_snapshot_state,
        )?
        .is_some()
        {
            progressive_materializations = 1;
        }
    }

    let output_frames = mic_chunks
        .iter()
        .map(|chunk| chunk.mono_samples.len())
        .sum::<usize>()
        .max(sys_chunks.iter().map(|chunk| chunk.mono_samples.len()).sum::<usize>());
    let telemetry_path = telemetry_path_for_output(&config.output);
    let telemetry = RunTelemetry {
        output_wav_path: config.output.clone(),
        duration_secs: config.duration_secs,
        target_rate_hz: config.target_rate_hz,
        output_rate_hz: fixture_rate_hz,
        mismatch_policy: config.mismatch_policy,
        mic_input_rate_hz: fixture_rate_hz,
        system_input_rate_hz: fixture_rate_hz,
        mic_resample: ResampleStats::default(),
        system_resample: ResampleStats::default(),
        mic_chunks: mic_chunk_count,
        system_chunks: system_chunk_count,
        output_frames,
        restart_count: restart_count as usize,
        transport: crate::rt_transport::TransportStatsSnapshot {
            capacity: CALLBACK_RING_CAPACITY as u64,
            ..crate::rt_transport::TransportStatsSnapshot::default()
        },
        callback_audit: CallbackAuditSnapshot::default(),
    };
    write_run_telemetry(&telemetry_path, &telemetry)?;

    println!(
        "Using fake live capture fixture via {}: {} (mode={}, chunk_frames={})",
        FAKE_CAPTURE_FIXTURE_ENV,
        fixture.display(),
        if replay_realtime {
            "realtime"
        } else {
            "accelerated"
        },
        chunk_frames
    );
    println!(
        "WAV written: {} (source fixture: {}, output_frames: {}, restarts: {}, output_rate: {} Hz)",
        config.output.display(),
        fixture.display(),
        output_frames,
        restart_count,
        fixture_rate_hz
    );
    println!(
        "progressive_out_wav_materializations: {}",
        progressive_materializations
    );
    println!("Telemetry written: {}", telemetry_path.display());
    let summary = build_capture_summary(&telemetry, now_unix());
    enforce_callback_contract(
        config.callback_contract_mode,
        CallbackAuditSnapshot::default(),
    )?;
    Ok(StreamingCaptureResult {
        summary,
        progressive_output_path: config.output.clone(),
    })
}

pub fn run_streaming_capture_session(
    config: &LiveCaptureConfig,
    sink: &mut dyn CaptureSink,
) -> Result<StreamingCaptureResult> {
    if let Some(fixture) = non_empty_env_path(FAKE_CAPTURE_FIXTURE_ENV) {
        let restart_count = env_u64_or_default(FAKE_CAPTURE_RESTART_COUNT_ENV, 0)?;
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
        let result = run_fake_capture_session(config, &fixture, restart_count, sink);
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
        return result;
    }

    let duration_secs = config.duration_secs;
    let output = config.output.clone();
    let target_rate_hz = config.target_rate_hz;
    let mismatch_policy = config.mismatch_policy;
    let callback_contract_mode = config.callback_contract_mode;
    let interruption_policy = InterruptionPolicy {
        idle_timeout: INTERRUPTION_IDLE_TIMEOUT,
        max_restarts: MAX_CAPTURE_RESTARTS,
    };

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory {}", parent.display()))?;
    }
    ensure_stop_capture_signal_handler()?;
    STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);

    if duration_secs == 0 {
        println!(
            "Starting Sequoia capture until interrupted -> {}",
            output.display()
        );
    } else {
        println!(
            "Starting Sequoia capture for {}s -> {}",
            duration_secs,
            output.display()
        );
    }
    println!("Stereo mapping: left=mic, right=system");
    println!("Sample-rate mismatch policy: {}", mismatch_policy.as_str());
    println!("Callback contract mode: {:?}", callback_contract_mode);

    let stop_request_path = config.stop_request_path.as_deref();

    let content = SCShareableContent::get().context(
        "failed to get shareable content (screen recording permission + active display required)",
    )?;
    let displays = content.displays();
    if displays.is_empty() {
        bail!("no displays available for SCContentFilter");
    }

    let filter = SCContentFilter::create()
        .with_display(&displays[0])
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_captures_microphone(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(target_rate_hz as i32)
        .with_channel_count(2);

    let queue = DispatchQueue::new("com.sequoia-capture.recorder", DispatchQoS::UserInteractive);
    let slots = (0..CALLBACK_RING_CAPACITY)
        .map(|_| ReusableTimedChunk::with_capacity(MAX_MONO_SAMPLES_PER_CHUNK))
        .collect();
    let (producer, consumer) = preallocated_spsc(slots);
    let callback_audit = Arc::new(CallbackAudit::default());
    let mut stream = SCStream::new(&filter, &config);

    let audio_producer = producer.clone();
    let audio_audit = Arc::clone(&callback_audit);
    stream
        .add_output_handler_with_queue(
            move |sample, kind| callback(&audio_producer, &audio_audit, sample, kind),
            SCStreamOutputType::Audio,
            Some(&queue),
        )
        .ok_or_else(|| anyhow::anyhow!("failed to add system-audio handler"))?;

    let mic_producer = producer.clone();
    let mic_audit = Arc::clone(&callback_audit);
    stream
        .add_output_handler_with_queue(
            move |sample, kind| callback(&mic_producer, &mic_audit, sample, kind),
            SCStreamOutputType::Microphone,
            Some(&queue),
        )
        .ok_or_else(|| anyhow::anyhow!("failed to add microphone handler"))?;

    stream
        .start_capture()
        .context("failed to start stream capture")?;

    let deadline = if duration_secs == 0 {
        None
    } else {
        Some(Instant::now() + Duration::from_secs(duration_secs))
    };
    let mut mic_chunks = Vec::<TimedChunk>::new();
    let mut sys_chunks = Vec::<TimedChunk>::new();
    let mut restart_count = 0usize;
    let mut last_materialize_at = Instant::now();
    let mut materialized_chunk_total = 0usize;
    let mut progressive_materializations = 0usize;
    let mut progressive_snapshot_state = None;
    let mut runtime_event_cursor = RuntimeEventCursor::default();

    while deadline.is_none_or(|end| Instant::now() < end)
        && !stop_capture_requested_or_marker(stop_request_path)
    {
        let mut last_chunk_at = Instant::now();
        let mut interrupted = false;

        while deadline.is_none_or(|end| Instant::now() < end)
            && !stop_capture_requested_or_marker(stop_request_path)
        {
            match consumer.recv_timeout(CALLBACK_RECV_TIMEOUT) {
                Ok(chunk_slot) => {
                    let chunk = TimedChunk {
                        kind: chunk_slot.kind,
                        pts_seconds: chunk_slot.pts_seconds,
                        sample_rate_hz: chunk_slot.sample_rate_hz,
                        mono_samples: chunk_slot.mono_slice().to_vec(),
                    };
                    consumer.recycle(chunk_slot);
                    last_chunk_at = Instant::now();

                    if let Some(capture_chunk) = chunk.to_capture_chunk() {
                        sink.on_chunk(capture_chunk)
                            .map_err(|err| anyhow::anyhow!("capture sink rejected chunk: {err}"))?;
                    }

                    match chunk.kind {
                        SCStreamOutputType::Audio => sys_chunks.push(chunk),
                        SCStreamOutputType::Microphone => mic_chunks.push(chunk),
                        SCStreamOutputType::Screen => {}
                    }

                    let total_chunks = mic_chunks.len().saturating_add(sys_chunks.len());
                    let has_both_channels = !mic_chunks.is_empty() && !sys_chunks.is_empty();
                    if has_both_channels
                        && should_materialize_progressive_snapshot(
                            progressive_materializations,
                            materialized_chunk_total,
                            total_chunks,
                            last_materialize_at.elapsed(),
                        )
                    {
                        if materialize_progressive_wav_snapshot_incremental(
                            &output,
                            &mic_chunks,
                            &sys_chunks,
                            target_rate_hz,
                            mismatch_policy,
                            &mut progressive_snapshot_state,
                        )?
                        .is_some()
                        {
                            progressive_materializations += 1;
                            materialized_chunk_total = total_chunks;
                            last_materialize_at = Instant::now();
                        }
                    }

                    emit_runtime_event_deltas(
                        sink,
                        &mut runtime_event_cursor,
                        restart_count,
                        consumer.stats_snapshot(),
                        callback_audit.snapshot(),
                    )?;
                }
                Err(RecvTimeoutError::Timeout) => {
                    emit_runtime_event_deltas(
                        sink,
                        &mut runtime_event_cursor,
                        restart_count,
                        consumer.stats_snapshot(),
                        callback_audit.snapshot(),
                    )?;
                    if stop_capture_requested_or_marker(stop_request_path) {
                        break;
                    }
                    let idle_gap = Instant::now().saturating_duration_since(last_chunk_at);
                    if idle_gap >= interruption_policy.idle_timeout {
                        interrupted = true;
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    interrupted = true;
                    break;
                }
            }
        }

        stream
            .stop_capture()
            .context("failed to stop stream capture")?;

        if stop_capture_requested_or_marker(stop_request_path) {
            break;
        }

        if !interrupted {
            break;
        }

        if !can_restart_capture(restart_count, interruption_policy) {
            let action = recovery_action_for_interruption(false);
            bail!(
                "capture stream interrupted and restart limit reached (attempted {} restarts). Recovery action: {:?}. Keep one active display connected and re-run.",
                interruption_policy.max_restarts,
                action
            );
        }

        restart_count += 1;
        let action = recovery_action_for_interruption(true);
        eprintln!(
            "capture interruption detected (restart {}/{}). Recovery action: {:?}.",
            restart_count, interruption_policy.max_restarts, action
        );
        sink.on_event(CaptureEvent {
            generated_unix: now_unix(),
            code: CaptureEventCode::StreamInterruption,
            count: 1,
            recovery_action: to_capture_recovery_action(action),
            detail: format!(
                "capture interruption detected (restart {restart_count}/{})",
                interruption_policy.max_restarts
            ),
        })
        .map_err(|err| anyhow::anyhow!("capture sink rejected interruption event: {err}"))?;
        runtime_event_cursor.restart_count = restart_count;

        stream
            .start_capture()
            .context("failed to restart stream capture after interruption")?;
    }

    let transport_stats = consumer.stats_snapshot();
    let callback_audit_snapshot = callback_audit.snapshot();

    if mic_chunks.is_empty() && sys_chunks.is_empty() {
        bail!(
            "missing captured data (mic chunks: {}, system chunks: {})",
            mic_chunks.len(),
            sys_chunks.len()
        );
    }

    if mic_chunks.is_empty() {
        eprintln!(
            "warning: microphone channel produced no chunks; continuing with silence-filled mic channel."
        );
    }
    if sys_chunks.is_empty() {
        eprintln!(
            "warning: system-audio channel produced no chunks; continuing with silence-filled system channel."
        );
    }

    let fallback_rate = mic_chunks
        .first()
        .map(|chunk| chunk.sample_rate_hz)
        .or_else(|| sys_chunks.first().map(|chunk| chunk.sample_rate_hz))
        .unwrap_or(target_rate_hz);
    let mic_rate = mic_chunks
        .first()
        .map(|chunk| chunk.sample_rate_hz)
        .unwrap_or(fallback_rate);
    let sys_rate = sys_chunks
        .first()
        .map(|chunk| chunk.sample_rate_hz)
        .unwrap_or(fallback_rate);

    let output_rate_hz =
        resolve_output_sample_rate(target_rate_hz, mic_rate, sys_rate, mismatch_policy)?;
    let base_pts = mic_chunks
        .first()
        .map(|chunk| chunk.pts_seconds)
        .into_iter()
        .chain(sys_chunks.first().map(|chunk| chunk.pts_seconds))
        .fold(f64::INFINITY, f64::min);
    let base_pts = if base_pts.is_finite() { base_pts } else { 0.0 };

    let (mut mic, mic_resample) = if mic_chunks.is_empty() {
        (Vec::new(), ResampleStats::default())
    } else {
        paint_chunks_timeline(&mic_chunks, base_pts, output_rate_hz)
    };
    let (mut sys, sys_resample) = if sys_chunks.is_empty() {
        (Vec::new(), ResampleStats::default())
    } else {
        paint_chunks_timeline(&sys_chunks, base_pts, output_rate_hz)
    };

    if mic.is_empty() && !sys.is_empty() {
        mic.resize(sys.len(), 0.0);
    } else if sys.is_empty() && !mic.is_empty() {
        sys.resize(mic.len(), 0.0);
    }

    write_interleaved_stereo_wav(&output, output_rate_hz, &mic, &sys)?;

    println!(
        "WAV written: {} (mic chunks: {}, system chunks: {}, frames: {}, restarts: {}, output_rate: {} Hz)",
        output.display(),
        mic_chunks.len(),
        sys_chunks.len(),
        mic.len().max(sys.len()),
        restart_count,
        output_rate_hz
    );
    println!(
        "sample_rate_policy: mode={}, mic_input_rate_hz={}, system_input_rate_hz={}, target_rate_hz={}, output_rate_hz={}, mic_resampled_chunks={}, system_resampled_chunks={}",
        mismatch_policy.as_str(),
        mic_rate,
        sys_rate,
        target_rate_hz,
        output_rate_hz,
        mic_resample.resampled_chunks,
        sys_resample.resampled_chunks
    );
    println!(
        "progressive_out_wav_materializations: {}",
        progressive_materializations
    );
    println!(
        "transport: capacity={}, high_water={}, in_flight={}, enqueued={}, dequeued={}, slot_miss_drops={}, fill_failures={}, queue_full_drops={}, recycle_failures={}",
        transport_stats.capacity,
        transport_stats.ready_depth_high_water,
        transport_stats.in_flight,
        transport_stats.enqueued,
        transport_stats.dequeued,
        transport_stats.slot_miss_drops,
        transport_stats.fill_failures,
        transport_stats.queue_full_drops,
        transport_stats.recycle_failures
    );
    println!(
        "callback_contract: missing_audio_buffer_list={}, missing_first_audio_buffer={}, missing_format_description={}, missing_sample_rate={}, non_float_pcm={}, chunk_too_large={}",
        callback_audit_snapshot.missing_audio_buffer_list,
        callback_audit_snapshot.missing_first_audio_buffer,
        callback_audit_snapshot.missing_format_description,
        callback_audit_snapshot.missing_sample_rate,
        callback_audit_snapshot.non_float_pcm,
        callback_audit_snapshot.chunk_too_large
    );
    emit_runtime_event_deltas(
        sink,
        &mut runtime_event_cursor,
        restart_count,
        transport_stats,
        callback_audit_snapshot,
    )?;

    let telemetry_path = telemetry_path_for_output(&output);
    let telemetry = RunTelemetry {
        output_wav_path: output.clone(),
        duration_secs,
        target_rate_hz,
        output_rate_hz,
        mismatch_policy,
        mic_input_rate_hz: mic_rate,
        system_input_rate_hz: sys_rate,
        mic_resample,
        system_resample: sys_resample,
        mic_chunks: mic_chunks.len(),
        system_chunks: sys_chunks.len(),
        output_frames: mic.len().max(sys.len()),
        restart_count,
        transport: transport_stats,
        callback_audit: callback_audit_snapshot,
    };
    write_run_telemetry(&telemetry_path, &telemetry)?;
    println!("Telemetry written: {}", telemetry_path.display());
    let summary = build_capture_summary(&telemetry, now_unix());
    enforce_callback_contract(callback_contract_mode, callback_audit_snapshot)?;

    Ok(StreamingCaptureResult {
        summary,
        progressive_output_path: output,
    })
}

pub fn run_capture_session(config: &LiveCaptureConfig) -> Result<()> {
    let mut sink = CollectingCaptureSink::default();
    let _ = run_streaming_capture_session(config, &mut sink)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_capture_run_summary, build_degradation_events, callback_recovery_breakdown,
        can_restart_capture, config_from_cli_args, emit_runtime_event_deltas,
        enforce_callback_contract, materialize_progressive_wav_snapshot,
        materialize_progressive_wav_snapshot_incremental, maybe_sleep_for_replay, now_unix,
        paint_chunks_timeline, recovery_action_for_callback_violation,
        recovery_action_for_interruption, resample_linear_mono, resolve_output_sample_rate,
        run_capture_session, run_fake_capture_session, run_streaming_capture_session,
        should_materialize_progressive_snapshot, stop_capture_requested,
        stop_capture_requested_or_marker, telemetry_path_for_output, write_run_telemetry,
        CallbackAuditSnapshot, CallbackContractMode, CallbackContractViolation, InterruptionPolicy,
        LiveCaptureConfig, RecoveryAction, ResampleStats, RunTelemetry, RuntimeEventCursor,
        SampleRateMismatchPolicy, TimedChunk, FAKE_CAPTURE_FIXTURE_ENV, FAKE_CAPTURE_REALTIME_ENV,
        FAKE_CAPTURE_RESTART_COUNT_ENV, STOP_CAPTURE_REQUESTED,
    };
    use crate::capture_api::{
        CaptureChunk, CaptureChunkKind, CaptureEvent, CaptureEventCode, CaptureRecoveryAction,
        CaptureSink,
    };
    use crate::rt_transport::TransportStatsSnapshot;
    use screencapturekit::prelude::SCStreamOutputType;
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct RecordingSink {
        chunks: Vec<CaptureChunk>,
        events: Vec<CaptureEvent>,
        event_sequence: Vec<&'static str>,
    }

    impl CaptureSink for RecordingSink {
        fn on_chunk(&mut self, chunk: CaptureChunk) -> std::result::Result<(), String> {
            self.chunks.push(chunk);
            self.event_sequence.push("chunk");
            Ok(())
        }

        fn on_event(&mut self, event: CaptureEvent) -> std::result::Result<(), String> {
            self.events.push(event);
            self.event_sequence.push("event");
            Ok(())
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct ScopedEnvVar {
        key: &'static str,
        prior: Option<OsString>,
    }

    impl ScopedEnvVar {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prior = std::env::var_os(key);
            // SAFETY: test helper scopes environment changes and restores on drop.
            unsafe { std::env::set_var(key, value) };
            Self { key, prior }
        }

        fn unset(key: &'static str) -> Self {
            let prior = std::env::var_os(key);
            // SAFETY: test helper scopes environment changes and restores on drop.
            unsafe { std::env::remove_var(key) };
            Self { key, prior }
        }
    }

    impl Drop for ScopedEnvVar {
        fn drop(&mut self) {
            if let Some(value) = self.prior.take() {
                // SAFETY: test helper restores prior value captured before mutation.
                unsafe { std::env::set_var(self.key, value) };
            } else {
                // SAFETY: test helper restores prior unset state captured before mutation.
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    fn write_fixture_stereo_wav(path: &Path, sample_rate: u32, frame_count: usize) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec)
            .expect("fixture wav should be writable for deterministic test");
        for idx in 0..frame_count {
            writer
                .write_sample(idx as f32) // mic
                .expect("fixture mic sample write should succeed");
            writer
                .write_sample(-(idx as f32)) // system
                .expect("fixture system sample write should succeed");
        }
        writer
            .finalize()
            .expect("fixture wav finalize should succeed");
    }

    #[test]
    fn strict_policy_fails_on_target_mismatch() {
        let result =
            resolve_output_sample_rate(48_000, 44_100, 44_100, SampleRateMismatchPolicy::Strict);
        assert!(result.is_err());
    }

    #[test]
    fn cli_args_parse_into_shared_live_capture_config() {
        let args = vec![
            "sequoia_capture".to_string(),
            "12".to_string(),
            "artifacts/demo.wav".to_string(),
            "44100".to_string(),
            "adapt-stream-rate".to_string(),
            "strict".to_string(),
        ];

        let config = config_from_cli_args(&args).unwrap();
        assert_eq!(config.output, PathBuf::from("artifacts/demo.wav"));
        assert_eq!(config.duration_secs, 12);
        assert_eq!(config.target_rate_hz, 44_100);
        assert_eq!(
            config.mismatch_policy,
            SampleRateMismatchPolicy::AdaptStreamRate
        );
        assert_eq!(config.callback_contract_mode, CallbackContractMode::Strict);
    }

    #[test]
    fn fake_capture_harness_copies_fixture_and_writes_telemetry() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "recordit-fake-capture-{}-{}",
            std::process::id(),
            stamp
        ));
        let fixture = root.join("fixture.wav");
        let output = root.join("runtime.wav");

        fs::create_dir_all(&root).expect("temp test root should be creatable");
        write_fixture_stereo_wav(&fixture, 16_000, 8);

        let config = LiveCaptureConfig {
            duration_secs: 3,
            output: output.clone(),
            target_rate_hz: 16_000,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: None,
        };

        let _lock = env_lock()
            .lock()
            .expect("fake capture env lock should not be poisoned");
        let _fixture_env = ScopedEnvVar::unset(FAKE_CAPTURE_FIXTURE_ENV);
        let _restart_env = ScopedEnvVar::unset(FAKE_CAPTURE_RESTART_COUNT_ENV);
        let _realtime_env = ScopedEnvVar::unset(FAKE_CAPTURE_REALTIME_ENV);
        let mut sink = RecordingSink::default();
        let result = run_fake_capture_session(&config, &fixture, 2, &mut sink)
            .expect("fake capture harness should materialize fixture and telemetry");
        assert!(output.is_file(), "fake capture output WAV should exist");
        let telemetry_path = telemetry_path_for_output(&output);
        assert!(
            telemetry_path.is_file(),
            "fake capture telemetry should be written"
        );
        let telemetry =
            fs::read_to_string(&telemetry_path).expect("telemetry should be readable UTF-8");
        assert!(
            telemetry.contains("\"restart_count\": 2"),
            "telemetry should include scripted restart count"
        );
        assert!(
            telemetry.contains("\"output_rate_hz\": 16000"),
            "telemetry should reflect fixture sample-rate"
        );
        assert_eq!(result.progressive_output_path, output);
        assert_eq!(result.summary.restart_count, 2);
        assert_eq!(sink.chunks.len(), 2);
        assert_eq!(
            sink.chunks[0].stream,
            crate::capture_api::CaptureStream::SystemAudio
        );
        assert_eq!(
            sink.chunks[1].stream,
            crate::capture_api::CaptureStream::Microphone
        );
        assert_eq!(result.summary.system_audio.chunk_count, 1);
        assert_eq!(result.summary.microphone.chunk_count, 1);
        assert_eq!(sink.events.len(), 1);
        assert_eq!(sink.events[0].code, CaptureEventCode::StreamInterruption);
        assert_eq!(sink.events[0].count, 2);
        assert_eq!(
            sink.event_sequence.first().copied(),
            Some("event"),
            "fake restart continuity signal should be emitted during active replay"
        );

        let _ = fs::remove_file(output);
        let _ = fs::remove_file(fixture);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir(root);
    }

    #[test]
    fn fake_capture_replay_emits_timestamp_ordered_system_then_mic_pairs() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "recordit-fake-capture-ordering-{}-{}",
            std::process::id(),
            stamp
        ));
        let fixture = root.join("fixture.wav");
        let output = root.join("runtime.wav");

        fs::create_dir_all(&root).expect("temp test root should be creatable");
        write_fixture_stereo_wav(&fixture, 200, 16);

        let config = LiveCaptureConfig {
            duration_secs: 1,
            output: output.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: None,
        };

        let _lock = env_lock()
            .lock()
            .expect("fake capture env lock should not be poisoned");
        let _fixture_env = ScopedEnvVar::unset(FAKE_CAPTURE_FIXTURE_ENV);
        let _restart_env = ScopedEnvVar::unset(FAKE_CAPTURE_RESTART_COUNT_ENV);
        let _realtime_env = ScopedEnvVar::unset(FAKE_CAPTURE_REALTIME_ENV);
        let mut sink = RecordingSink::default();
        let result = run_fake_capture_session(&config, &fixture, 0, &mut sink)
            .expect("fake capture replay should emit deterministic chunks");
        let chunk_frames = 4; // sample_rate/50 for 200Hz replay
        let expected_pairs = 16 / chunk_frames;
        assert_eq!(sink.chunks.len(), expected_pairs * 2);
        assert_eq!(result.summary.system_audio.chunk_count, expected_pairs);
        assert_eq!(result.summary.microphone.chunk_count, expected_pairs);
        assert!(sink.events.is_empty());
        assert_eq!(sink.event_sequence.first().copied(), Some("chunk"));

        let mut previous_pts = -1.0f64;
        for pair in sink.chunks.chunks_exact(2) {
            let system = &pair[0];
            let mic = &pair[1];
            assert_eq!(
                system.stream,
                crate::capture_api::CaptureStream::SystemAudio
            );
            assert_eq!(mic.stream, crate::capture_api::CaptureStream::Microphone);
            assert_eq!(system.pts_seconds, mic.pts_seconds);
            assert!(system.pts_seconds >= previous_pts);
            previous_pts = system.pts_seconds;
        }

        // Validate channel mapping from fixture interleaving (L=mic, R=system).
        assert_eq!(sink.chunks[0].mono_samples, vec![-0.0, -1.0, -2.0, -3.0]);
        assert_eq!(sink.chunks[1].mono_samples, vec![0.0, 1.0, 2.0, 3.0]);

        let telemetry_path = telemetry_path_for_output(&output);
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(fixture);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir(root);
    }

    #[test]
    fn fake_capture_stop_marker_halts_replay_before_full_fixture_is_consumed() {
        struct StopMarkerSink {
            marker: PathBuf,
            chunk_count: usize,
        }

        impl CaptureSink for StopMarkerSink {
            fn on_chunk(&mut self, _chunk: CaptureChunk) -> std::result::Result<(), String> {
                self.chunk_count += 1;
                if self.chunk_count == 1 {
                    fs::write(&self.marker, b"stop\n")
                        .map_err(|err| format!("failed to write stop marker: {err}"))?;
                }
                Ok(())
            }

            fn on_event(&mut self, _event: CaptureEvent) -> std::result::Result<(), String> {
                Ok(())
            }
        }

        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "recordit-fake-capture-stop-marker-{}-{}",
            std::process::id(),
            stamp
        ));
        let fixture = root.join("fixture.wav");
        let output = root.join("runtime.wav");
        let marker = root.join("session.stop.request");

        fs::create_dir_all(&root).expect("temp test root should be creatable");
        write_fixture_stereo_wav(&fixture, 200, 40);

        let config = LiveCaptureConfig {
            duration_secs: 1,
            output: output.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: Some(marker.clone()),
        };

        let _lock = env_lock()
            .lock()
            .expect("fake capture env lock should not be poisoned");
        let _fixture_env = ScopedEnvVar::unset(FAKE_CAPTURE_FIXTURE_ENV);
        let _restart_env = ScopedEnvVar::unset(FAKE_CAPTURE_RESTART_COUNT_ENV);
        let _realtime_env = ScopedEnvVar::unset(FAKE_CAPTURE_REALTIME_ENV);
        let mut sink = StopMarkerSink {
            marker: marker.clone(),
            chunk_count: 0,
        };
        let result = run_fake_capture_session(&config, &fixture, 0, &mut sink)
            .expect("fake capture replay should stop cleanly when marker appears");
        let telemetry_path = telemetry_path_for_output(&output);
        let telemetry =
            fs::read_to_string(&telemetry_path).expect("telemetry should be readable UTF-8");
        assert_eq!(sink.chunk_count, 2, "marker should stop replay after one chunk pair");
        assert_eq!(result.summary.system_audio.chunk_count, 1);
        assert_eq!(result.summary.microphone.chunk_count, 1);
        assert!(telemetry.contains("\"output_frames\": 4"));
        assert!(telemetry.contains("\"mic_chunks\": 1"));
        assert!(telemetry.contains("\"system_chunks\": 1"));
        assert!(output.is_file(), "partial progressive WAV should still be materialized");

        let _ = fs::remove_file(marker);
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(fixture);
        let _ = fs::remove_file(telemetry_path);
        let _ = fs::remove_dir(root);
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
    }

    #[test]
    fn fake_stop_marker_does_not_poison_next_streaming_fake_run() {
        struct StopMarkerSink {
            marker: PathBuf,
            chunk_count: usize,
        }

        impl CaptureSink for StopMarkerSink {
            fn on_chunk(&mut self, _chunk: CaptureChunk) -> std::result::Result<(), String> {
                self.chunk_count += 1;
                if self.chunk_count == 1 {
                    fs::write(&self.marker, b"stop\n")
                        .map_err(|err| format!("failed to write stop marker: {err}"))?;
                }
                Ok(())
            }

            fn on_event(&mut self, _event: CaptureEvent) -> std::result::Result<(), String> {
                Ok(())
            }
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "recordit-fake-capture-stop-reset-{}-{}",
            std::process::id(),
            stamp
        ));
        let fixture = root.join("fixture.wav");
        let output_first = root.join("first.wav");
        let output_second = root.join("second.wav");
        let marker = root.join("session.stop.request");

        fs::create_dir_all(&root).expect("temp test root should be creatable");
        write_fixture_stereo_wav(&fixture, 200, 40);

        let first_config = LiveCaptureConfig {
            duration_secs: 1,
            output: output_first.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: Some(marker.clone()),
        };
        let second_config = LiveCaptureConfig {
            duration_secs: 1,
            output: output_second.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: None,
        };

        let _lock = env_lock()
            .lock()
            .expect("fake capture env lock should not be poisoned");
        let _fixture_env = ScopedEnvVar::set(FAKE_CAPTURE_FIXTURE_ENV, fixture.as_os_str());
        let _restart_env = ScopedEnvVar::unset(FAKE_CAPTURE_RESTART_COUNT_ENV);
        let _realtime_env = ScopedEnvVar::set(FAKE_CAPTURE_REALTIME_ENV, "0");

        let mut stop_sink = StopMarkerSink {
            marker: marker.clone(),
            chunk_count: 0,
        };
        run_streaming_capture_session(&first_config, &mut stop_sink)
            .expect("first fake streaming run should stop cleanly when marker appears");
        assert!(
            !STOP_CAPTURE_REQUESTED.load(Ordering::Relaxed),
            "marker-driven fake stop should not leave the global stop flag set"
        );

        let mut clean_sink = RecordingSink::default();
        let second = run_streaming_capture_session(&second_config, &mut clean_sink)
            .expect("second fake streaming run should not inherit the prior stop request");
        assert!(second.summary.system_audio.chunk_count > 0);
        assert!(second.summary.microphone.chunk_count > 0);
        assert!(clean_sink.chunks.len() >= 2, "second fake run should deliver chunk data for both channels");
        assert_eq!(clean_sink.chunks.len() % 2, 0, "second fake run should preserve paired channel delivery");

        let _ = fs::remove_file(marker);
        let _ = fs::remove_file(output_first.clone());
        let _ = fs::remove_file(output_second.clone());
        let _ = fs::remove_file(fixture.clone());
        let _ = fs::remove_file(telemetry_path_for_output(&output_first));
        let _ = fs::remove_file(telemetry_path_for_output(&output_second));
        let _ = fs::remove_dir(root);
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
    }

    #[test]
    fn maybe_sleep_for_replay_respects_realtime_toggle() {
        let accelerated_start = Instant::now();
        maybe_sleep_for_replay(false, accelerated_start, 0.05)
            .expect("accelerated replay sleep helper should succeed");
        assert!(
            accelerated_start.elapsed() < Duration::from_millis(25),
            "accelerated mode should not add meaningful delay"
        );

        let realtime_start = Instant::now();
        maybe_sleep_for_replay(true, realtime_start, 0.05)
            .expect("realtime replay sleep helper should succeed");
        assert!(
            realtime_start.elapsed() >= Duration::from_millis(35),
            "realtime mode should wait close to target PTS"
        );
    }

    #[test]
    fn run_capture_session_wrapper_matches_streaming_fake_summary_counts() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "recordit-capture-wrapper-parity-{}-{}",
            std::process::id(),
            stamp
        ));
        let fixture = root.join("fixture.wav");
        let output_stream = root.join("streaming.wav");
        let output_wrapper = root.join("wrapper.wav");
        fs::create_dir_all(&root).expect("temp test root should be creatable");
        write_fixture_stereo_wav(&fixture, 200, 40);

        let stream_config = LiveCaptureConfig {
            duration_secs: 1,
            output: output_stream.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: None,
        };
        let wrapper_config = LiveCaptureConfig {
            duration_secs: 1,
            output: output_wrapper.clone(),
            target_rate_hz: 200,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            callback_contract_mode: CallbackContractMode::Warn,
            stop_request_path: None,
        };

        let _lock = env_lock()
            .lock()
            .expect("fake capture env lock should not be poisoned");
        let _fixture_env = ScopedEnvVar::set(FAKE_CAPTURE_FIXTURE_ENV, fixture.as_os_str());
        let _restart_env = ScopedEnvVar::set(FAKE_CAPTURE_RESTART_COUNT_ENV, "2");
        let _realtime_env = ScopedEnvVar::set(FAKE_CAPTURE_REALTIME_ENV, "0");

        let mut sink = RecordingSink::default();
        let streaming = run_streaming_capture_session(&stream_config, &mut sink)
            .expect("streaming capture wrapper should succeed");
        run_capture_session(&wrapper_config).expect("compatibility wrapper should succeed");

        let wrapper_telemetry_path = telemetry_path_for_output(&output_wrapper);
        let wrapper_telemetry = fs::read_to_string(&wrapper_telemetry_path)
            .expect("wrapper telemetry should be readable UTF-8");
        assert!(wrapper_telemetry.contains(&format!(
            "\"restart_count\": {}",
            streaming.summary.restart_count
        )));
        assert!(wrapper_telemetry.contains(&format!(
            "\"mic_chunks\": {}",
            streaming.summary.microphone.chunk_count
        )));
        assert!(wrapper_telemetry.contains(&format!(
            "\"system_chunks\": {}",
            streaming.summary.system_audio.chunk_count
        )));
        assert_eq!(streaming.summary.restart_count, 2);
        assert!(!sink.chunks.is_empty());
        assert!(output_wrapper.is_file(), "wrapper output WAV should exist");

        let stream_telemetry_path = telemetry_path_for_output(&output_stream);
        let _ = fs::remove_file(output_stream);
        let _ = fs::remove_file(stream_telemetry_path);
        let _ = fs::remove_file(output_wrapper);
        let _ = fs::remove_file(wrapper_telemetry_path);
        let _ = fs::remove_file(fixture);
        let _ = fs::remove_dir(root);
    }

    #[test]
    fn sample_rate_policy_matrix_covers_strict_and_adapt_modes() {
        let cases = [
            (
                "strict_match",
                SampleRateMismatchPolicy::Strict,
                48_000,
                48_000,
                48_000,
                Some(48_000),
            ),
            (
                "strict_equal_non_target",
                SampleRateMismatchPolicy::Strict,
                48_000,
                44_100,
                44_100,
                None,
            ),
            (
                "strict_mixed",
                SampleRateMismatchPolicy::Strict,
                48_000,
                44_100,
                48_000,
                None,
            ),
            (
                "adapt_equal_non_target",
                SampleRateMismatchPolicy::AdaptStreamRate,
                48_000,
                44_100,
                44_100,
                Some(48_000),
            ),
            (
                "adapt_mixed",
                SampleRateMismatchPolicy::AdaptStreamRate,
                48_000,
                44_100,
                48_000,
                Some(48_000),
            ),
        ];

        for (name, policy, target_rate_hz, mic_rate_hz, system_rate_hz, expected) in cases {
            let result =
                resolve_output_sample_rate(target_rate_hz, mic_rate_hz, system_rate_hz, policy);
            match expected {
                Some(expected_rate) => {
                    assert_eq!(result.unwrap_or_default(), expected_rate, "{name}");
                }
                None => assert!(result.is_err(), "{name}"),
            }
        }
    }

    #[test]
    fn adapt_policy_preserves_requested_target_rate() {
        let rate = resolve_output_sample_rate(
            48_000,
            44_100,
            44_100,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )
        .expect("adapt policy should accept equal stream rates");
        assert_eq!(rate, 48_000);
    }

    #[test]
    fn adapt_policy_handles_mixed_stream_rates() {
        let rate = resolve_output_sample_rate(
            48_000,
            44_100,
            48_000,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )
        .expect("adapt policy should allow mixed-rate worker-side resampling");
        assert_eq!(rate, 48_000);
    }

    #[test]
    fn linear_resampler_upsamples_deterministically() {
        let resampled = resample_linear_mono(&[0.0, 1.0], 2, 4);
        assert_eq!(resampled.len(), 4);
        assert_eq!(resampled[0], 0.0);
        assert!((resampled[1] - 0.5).abs() < 1e-6);
        assert!((resampled[2] - 1.0).abs() < 1e-6);
        assert!((resampled[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn mixed_rate_timeline_reports_resampling_stats() {
        let chunks = vec![TimedChunk {
            kind: SCStreamOutputType::Microphone,
            pts_seconds: 0.0,
            sample_rate_hz: 2,
            mono_samples: vec![0.0, 1.0],
        }];

        let (timeline, stats) = paint_chunks_timeline(&chunks, 0.0, 4);
        assert_eq!(timeline.len(), 4);
        assert_eq!(stats.resampled_chunks, 1);
        assert_eq!(stats.input_frames, 2);
        assert_eq!(stats.output_frames, 4);
    }

    #[test]
    fn progressive_snapshot_requires_both_channels() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let output = std::env::temp_dir().join(format!(
            "recordit-progressive-none-{}-{}.wav",
            std::process::id(),
            stamp
        ));
        let mic_chunks = vec![TimedChunk {
            kind: SCStreamOutputType::Microphone,
            pts_seconds: 0.0,
            sample_rate_hz: 4,
            mono_samples: vec![0.1, 0.2],
        }];

        let written = materialize_progressive_wav_snapshot(
            &output,
            &mic_chunks,
            &[],
            4,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )
        .expect("progressive snapshot call should not fail");
        assert!(written.is_none());
        assert!(!output.exists());
    }

    #[test]
    fn progressive_snapshot_writes_wav_with_mic_and_system_chunks() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let output = std::env::temp_dir().join(format!(
            "recordit-progressive-write-{}-{}.wav",
            std::process::id(),
            stamp
        ));
        let mic_chunks = vec![TimedChunk {
            kind: SCStreamOutputType::Microphone,
            pts_seconds: 0.0,
            sample_rate_hz: 4,
            mono_samples: vec![0.1, 0.2, 0.3],
        }];
        let sys_chunks = vec![TimedChunk {
            kind: SCStreamOutputType::Audio,
            pts_seconds: 0.0,
            sample_rate_hz: 4,
            mono_samples: vec![0.4, 0.5, 0.6],
        }];

        let written = materialize_progressive_wav_snapshot(
            &output,
            &mic_chunks,
            &sys_chunks,
            4,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )
        .expect("progressive snapshot should write a valid WAV");
        assert_eq!(written, Some(4));
        assert!(output.is_file());

        let reader = hound::WavReader::open(&output).expect("written WAV should be readable");
        let spec = reader.spec();
        assert_eq!(spec.channels, 2);
        assert_eq!(spec.sample_rate, 4);
        assert_eq!(reader.duration(), 3);

        let _ = fs::remove_file(output);
    }

    #[test]
    fn incremental_progressive_snapshot_matches_full_repaint_output() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let incremental_output = std::env::temp_dir().join(format!(
            "recordit-progressive-incremental-{}-{}.wav",
            std::process::id(),
            stamp
        ));
        let full_output = std::env::temp_dir().join(format!(
            "recordit-progressive-full-{}-{}.wav",
            std::process::id(),
            stamp
        ));
        let mic_chunks = vec![
            TimedChunk {
                kind: SCStreamOutputType::Microphone,
                pts_seconds: 0.0,
                sample_rate_hz: 4,
                mono_samples: vec![0.1, 0.2, 0.3],
            },
            TimedChunk {
                kind: SCStreamOutputType::Microphone,
                pts_seconds: 0.75,
                sample_rate_hz: 4,
                mono_samples: vec![0.7, 0.8],
            },
        ];
        let sys_chunks = vec![
            TimedChunk {
                kind: SCStreamOutputType::Audio,
                pts_seconds: 0.0,
                sample_rate_hz: 4,
                mono_samples: vec![0.4, 0.5, 0.6],
            },
            TimedChunk {
                kind: SCStreamOutputType::Audio,
                pts_seconds: 0.75,
                sample_rate_hz: 4,
                mono_samples: vec![0.9, 1.0],
            },
        ];

        let mut state = None;
        for end_idx in 1..=mic_chunks.len() {
            let written = materialize_progressive_wav_snapshot_incremental(
                &incremental_output,
                &mic_chunks[..end_idx],
                &sys_chunks[..end_idx],
                4,
                SampleRateMismatchPolicy::AdaptStreamRate,
                &mut state,
            )
            .expect("incremental progressive snapshot should succeed");
            assert_eq!(written, Some(4));
        }

        let written = materialize_progressive_wav_snapshot(
            &full_output,
            &mic_chunks,
            &sys_chunks,
            4,
            SampleRateMismatchPolicy::AdaptStreamRate,
        )
        .expect("full progressive snapshot should succeed");
        assert_eq!(written, Some(4));

        let incremental_bytes = fs::read(&incremental_output).expect("incremental output readable");
        let full_bytes = fs::read(&full_output).expect("full output readable");
        assert_eq!(
            incremental_bytes, full_bytes,
            "incremental progressive materialization should match full repaint output"
        );

        let _ = fs::remove_file(incremental_output);
        let _ = fs::remove_file(full_output);
    }

    #[test]
    fn progressive_materialization_policy_emits_initial_snapshot_then_applies_cadence() {
        assert!(should_materialize_progressive_snapshot(
            0,
            0,
            2,
            Duration::from_millis(0)
        ));
        assert!(!should_materialize_progressive_snapshot(
            1,
            10,
            14,
            Duration::from_millis(1_000)
        ));
        assert!(!should_materialize_progressive_snapshot(
            1,
            10,
            18,
            Duration::from_millis(500)
        ));
        assert!(should_materialize_progressive_snapshot(
            1,
            10,
            18,
            Duration::from_millis(800)
        ));
    }

    #[test]
    fn timed_chunk_maps_to_capture_chunk_summary() {
        let chunk = TimedChunk {
            kind: SCStreamOutputType::Audio,
            pts_seconds: 1.25,
            sample_rate_hz: 48_000,
            mono_samples: vec![0.0, 0.1, 0.2],
        };

        let summary = chunk.to_capture_chunk_summary().expect("known kind");
        assert_eq!(summary.kind, CaptureChunkKind::SystemAudio);
        assert_eq!(summary.pts_seconds, 1.25);
        assert_eq!(summary.sample_rate_hz, 48_000);
        assert_eq!(summary.frame_count, 3);
    }

    #[test]
    fn restart_policy_is_bounded() {
        let policy = InterruptionPolicy {
            idle_timeout: Duration::from_secs(3),
            max_restarts: 2,
        };

        assert!(can_restart_capture(0, policy));
        assert!(can_restart_capture(1, policy));
        assert!(!can_restart_capture(2, policy));
    }

    #[test]
    fn telemetry_path_uses_output_stem() {
        let output = PathBuf::from("artifacts/hello-world.wav");
        let telemetry = telemetry_path_for_output(&output);
        assert_eq!(
            telemetry.to_string_lossy(),
            "artifacts/hello-world.telemetry.json"
        );
    }

    #[test]
    fn telemetry_writer_persists_json_artifact() {
        let tmp = std::env::temp_dir().join(format!(
            "sequoia-telemetry-test-{}.json",
            std::process::id()
        ));
        let telemetry = RunTelemetry {
            output_wav_path: PathBuf::from("artifacts/out.wav"),
            duration_secs: 5,
            target_rate_hz: 48_000,
            output_rate_hz: 48_000,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            mic_input_rate_hz: 44_100,
            system_input_rate_hz: 48_000,
            mic_resample: ResampleStats {
                resampled_chunks: 2,
                input_frames: 8_820,
                output_frames: 9_600,
            },
            system_resample: ResampleStats::default(),
            mic_chunks: 2,
            system_chunks: 2,
            output_frames: 100,
            restart_count: 0,
            transport: TransportStatsSnapshot {
                capacity: 8,
                ready_depth_high_water: 4,
                slot_miss_drops: 1,
                fill_failures: 2,
                queue_full_drops: 3,
                recycle_failures: 0,
                enqueued: 10,
                dequeued: 9,
                in_flight: 1,
            },
            callback_audit: CallbackAuditSnapshot {
                missing_audio_buffer_list: 0,
                missing_first_audio_buffer: 0,
                missing_format_description: 1,
                missing_sample_rate: 1,
                non_float_pcm: 1,
                chunk_too_large: 1,
            },
        };

        write_run_telemetry(&tmp, &telemetry).expect("telemetry artifact write should succeed");
        let contents =
            fs::read_to_string(&tmp).expect("telemetry artifact should be readable as UTF-8");
        assert!(contents.contains("\"transport\""));
        assert!(contents.contains("\"callback_contract\""));
        assert!(contents.contains("\"sample_rate_policy\""));
        assert!(contents.contains("\"mismatch_policy\": \"adapt-stream-rate\""));
        assert!(contents.contains("\"mic_input_rate_hz\": 44100"));
        assert!(contents.contains("\"system_input_rate_hz\": 48000"));
        assert!(contents.contains("\"mic_resampled_chunks\": 2"));
        assert!(contents.contains("\"mic_resampled_output_frames\": 9600"));
        assert!(contents.contains("\"degradation_events\""));
        let _ = fs::remove_file(tmp);
    }

    #[test]
    fn degradation_events_include_timestamped_recovery_records() {
        let telemetry = RunTelemetry {
            output_wav_path: PathBuf::from("artifacts/out.wav"),
            duration_secs: 5,
            target_rate_hz: 48_000,
            output_rate_hz: 48_000,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            mic_input_rate_hz: 44_100,
            system_input_rate_hz: 48_000,
            mic_resample: ResampleStats {
                resampled_chunks: 1,
                input_frames: 4_410,
                output_frames: 4_800,
            },
            system_resample: ResampleStats::default(),
            mic_chunks: 2,
            system_chunks: 2,
            output_frames: 100,
            restart_count: 1,
            transport: TransportStatsSnapshot {
                capacity: 8,
                ready_depth_high_water: 4,
                slot_miss_drops: 2,
                fill_failures: 0,
                queue_full_drops: 1,
                recycle_failures: 0,
                enqueued: 10,
                dequeued: 9,
                in_flight: 1,
            },
            callback_audit: CallbackAuditSnapshot {
                missing_audio_buffer_list: 0,
                missing_first_audio_buffer: 0,
                missing_format_description: 1,
                missing_sample_rate: 0,
                non_float_pcm: 0,
                chunk_too_large: 0,
            },
        };

        let events = build_degradation_events(&telemetry, 1_700_000_000);
        assert!(!events.is_empty());
        assert!(events
            .iter()
            .any(|event| event.generated_unix == 1_700_000_000));
        assert!(events
            .iter()
            .any(|event| event.recovery_action == CaptureRecoveryAction::RestartStream));
        assert!(events
            .iter()
            .any(|event| event.source == "missing_format_description"));
    }

    #[test]
    fn capture_summary_preserves_restart_sample_rate_and_counter_parity() {
        let telemetry = RunTelemetry {
            output_wav_path: PathBuf::from("artifacts/parity.wav"),
            duration_secs: 9,
            target_rate_hz: 48_000,
            output_rate_hz: 48_000,
            mismatch_policy: SampleRateMismatchPolicy::AdaptStreamRate,
            mic_input_rate_hz: 44_100,
            system_input_rate_hz: 48_000,
            mic_resample: ResampleStats {
                resampled_chunks: 3,
                input_frames: 13_230,
                output_frames: 14_400,
            },
            system_resample: ResampleStats {
                resampled_chunks: 2,
                input_frames: 9_600,
                output_frames: 9_600,
            },
            mic_chunks: 5,
            system_chunks: 4,
            output_frames: 28_800,
            restart_count: 2,
            transport: TransportStatsSnapshot {
                capacity: 8,
                ready_depth_high_water: 6,
                slot_miss_drops: 2,
                fill_failures: 3,
                queue_full_drops: 4,
                recycle_failures: 1,
                enqueued: 22,
                dequeued: 21,
                in_flight: 1,
            },
            callback_audit: CallbackAuditSnapshot {
                missing_audio_buffer_list: 5,
                missing_first_audio_buffer: 6,
                missing_format_description: 7,
                missing_sample_rate: 8,
                non_float_pcm: 9,
                chunk_too_large: 10,
            },
        };

        let summary = build_capture_run_summary(
            &telemetry,
            build_degradation_events(&telemetry, 1_700_000_111),
        );
        assert_eq!(summary.restart_count, 2);
        assert_eq!(
            summary.sample_rate_policy.mismatch_policy,
            "adapt-stream-rate"
        );
        assert_eq!(summary.sample_rate_policy.target_rate_hz, 48_000);
        assert_eq!(summary.sample_rate_policy.output_rate_hz, 48_000);
        assert_eq!(summary.sample_rate_policy.mic_input_rate_hz, 44_100);
        assert_eq!(summary.sample_rate_policy.system_input_rate_hz, 48_000);
        assert_eq!(summary.sample_rate_policy.mic_resample.resampled_chunks, 3);
        assert_eq!(summary.sample_rate_policy.mic_resample.input_frames, 13_230);
        assert_eq!(
            summary.sample_rate_policy.mic_resample.output_frames,
            14_400
        );
        assert_eq!(
            summary.sample_rate_policy.system_resample.resampled_chunks,
            2
        );
        assert_eq!(
            summary.sample_rate_policy.system_resample.input_frames,
            9_600
        );
        assert_eq!(
            summary.sample_rate_policy.system_resample.output_frames,
            9_600
        );

        assert_eq!(summary.transport.slot_miss_drops, 2);
        assert_eq!(summary.transport.fill_failures, 3);
        assert_eq!(summary.transport.queue_full_drops, 4);
        assert_eq!(summary.transport.recycle_failures, 1);
        assert_eq!(summary.callback_audit.missing_audio_buffer_list, 5);
        assert_eq!(summary.callback_audit.missing_first_audio_buffer, 6);
        assert_eq!(summary.callback_audit.missing_format_description, 7);
        assert_eq!(summary.callback_audit.missing_sample_rate, 8);
        assert_eq!(summary.callback_audit.non_float_pcm, 9);
        assert_eq!(summary.callback_audit.chunk_too_large, 10);

        let by_source = |source: &str| {
            summary
                .degradation_events
                .iter()
                .find(|event| event.source == source)
                .unwrap_or_else(|| panic!("missing degradation source `{source}`"))
        };
        assert_eq!(by_source("stream_interruption").count, 2);
        assert_eq!(
            by_source("stream_interruption").recovery_action,
            CaptureRecoveryAction::RestartStream
        );
        assert_eq!(by_source("slot_miss_drops").count, 2);
        assert_eq!(by_source("fill_failures").count, 3);
        assert_eq!(by_source("queue_full_drops").count, 4);
        assert_eq!(by_source("recycle_failures").count, 1);
        assert_eq!(by_source("missing_audio_buffer_list").count, 5);
        assert_eq!(by_source("missing_first_audio_buffer").count, 6);
        assert_eq!(by_source("missing_format_description").count, 7);
        assert_eq!(by_source("missing_sample_rate").count, 8);
        assert_eq!(
            by_source("missing_sample_rate").recovery_action,
            CaptureRecoveryAction::DropSampleContinue
        );
        assert_eq!(by_source("non_float_pcm").count, 9);
        assert_eq!(
            by_source("non_float_pcm").recovery_action,
            CaptureRecoveryAction::FailFastReconfigure
        );
        assert_eq!(by_source("chunk_too_large").count, 10);
    }

    #[test]
    fn runtime_event_deltas_emit_once_per_increment() {
        let mut sink = RecordingSink::default();
        let mut cursor = RuntimeEventCursor::default();

        let transport_a = TransportStatsSnapshot {
            queue_full_drops: 2,
            ..TransportStatsSnapshot::default()
        };
        let callback_a = CallbackAuditSnapshot {
            missing_format_description: 1,
            ..CallbackAuditSnapshot::default()
        };
        emit_runtime_event_deltas(&mut sink, &mut cursor, 1, transport_a, callback_a)
            .expect("delta emission should succeed");
        assert_eq!(sink.events.len(), 3);
        assert!(sink
            .events
            .iter()
            .any(|event| event.code == CaptureEventCode::StreamInterruption && event.count == 1));
        assert!(sink
            .events
            .iter()
            .any(|event| event.code == CaptureEventCode::QueueFullDrops && event.count == 2));
        assert!(sink.events.iter().any(|event| event.code
            == CaptureEventCode::MissingFormatDescription
            && event.count == 1));

        // Re-emitting with the same snapshots must not duplicate events.
        emit_runtime_event_deltas(&mut sink, &mut cursor, 1, transport_a, callback_a)
            .expect("duplicate snapshot should not fail");
        assert_eq!(sink.events.len(), 3);

        // Incremental updates should emit only the delta.
        let transport_b = TransportStatsSnapshot {
            queue_full_drops: 5,
            ..TransportStatsSnapshot::default()
        };
        let callback_b = CallbackAuditSnapshot {
            missing_format_description: 4,
            ..CallbackAuditSnapshot::default()
        };
        emit_runtime_event_deltas(&mut sink, &mut cursor, 1, transport_b, callback_b)
            .expect("incremental update should succeed");
        assert_eq!(sink.events.len(), 5);
        assert!(sink
            .events
            .iter()
            .any(|event| event.code == CaptureEventCode::QueueFullDrops && event.count == 3));
        assert!(sink.events.iter().any(|event| event.code
            == CaptureEventCode::MissingFormatDescription
            && event.count == 3));
    }

    #[test]
    fn callback_violation_maps_to_expected_recovery_action() {
        assert_eq!(
            recovery_action_for_callback_violation(CallbackContractViolation::NonFloatPcm),
            RecoveryAction::FailFastReconfigure
        );
        assert_eq!(
            recovery_action_for_callback_violation(CallbackContractViolation::MissingSampleRate),
            RecoveryAction::DropSampleContinue
        );
    }

    #[test]
    fn interruption_mapping_respects_restart_budget() {
        assert_eq!(
            recovery_action_for_interruption(true),
            RecoveryAction::RestartStream
        );
        assert_eq!(
            recovery_action_for_interruption(false),
            RecoveryAction::FailFastReconfigure
        );
    }

    #[test]
    fn strict_mode_fails_when_contract_violations_exist() {
        let snapshot = CallbackAuditSnapshot {
            non_float_pcm: 1,
            ..CallbackAuditSnapshot::default()
        };
        let result = enforce_callback_contract(CallbackContractMode::Strict, snapshot);
        assert!(result.is_err());
    }

    #[test]
    fn warn_mode_allows_contract_violations() {
        let snapshot = CallbackAuditSnapshot {
            missing_format_description: 2,
            ..CallbackAuditSnapshot::default()
        };
        let result = enforce_callback_contract(CallbackContractMode::Warn, snapshot);
        assert!(result.is_ok());
        let lines = callback_recovery_breakdown(snapshot);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("missing_format_description"));
    }
    #[test]
    fn stop_capture_marker_sets_stop_requested_flag() {
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "recordit-stop-request-marker-{}-{}",
            std::process::id(),
            now_unix()
        ));
        fs::create_dir_all(&root).expect("temp test root should be creatable");
        let marker = root.join("session.stop.request");
        fs::write(&marker, b"stop\n").expect("marker should be writable");

        assert!(stop_capture_requested_or_marker(Some(&marker)));
        assert!(stop_capture_requested());

        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir(&root);
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
    }

    #[test]
    fn missing_stop_capture_marker_does_not_request_stop() {
        STOP_CAPTURE_REQUESTED.store(false, Ordering::Relaxed);
        let marker = std::env::temp_dir().join(format!(
            "recordit-missing-stop-request-{}-{}",
            std::process::id(),
            now_unix()
        ));
        let _ = fs::remove_file(&marker);

        assert!(!stop_capture_requested_or_marker(Some(&marker)));
        assert!(!stop_capture_requested());
    }
}
