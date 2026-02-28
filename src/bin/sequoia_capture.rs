use anyhow::{bail, Context, Result};
use crossbeam_channel::RecvTimeoutError;
use hound::{SampleFormat, WavSpec, WavWriter};
use recordit::rt_transport::{preallocated_spsc, PreallocatedProducer};
use screencapturekit::prelude::*;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

const CALLBACK_RING_CAPACITY: usize = 1024;
const MAX_MONO_SAMPLES_PER_CHUNK: usize = 16_384;
const CALLBACK_RECV_TIMEOUT: Duration = Duration::from_millis(200);
const INTERRUPTION_IDLE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CAPTURE_RESTARTS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SampleRateMismatchPolicy {
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

    fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::AdaptStreamRate => "adapt-stream-rate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallbackContractMode {
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

fn recovery_action_name(action: RecoveryAction) -> &'static str {
    match action {
        RecoveryAction::DropSampleContinue => "DropSampleContinue",
        RecoveryAction::RestartStream => "RestartStream",
        RecoveryAction::AdaptOutputRate => "AdaptOutputRate",
        RecoveryAction::FailFastReconfigure => "FailFastReconfigure",
    }
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

fn telemetry_path_for_output(output: &Path) -> PathBuf {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    let stem = output
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("capture");
    parent.join(format!("{stem}.telemetry.json"))
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
    transport: recordit::rt_transport::TransportStatsSnapshot,
    callback_audit: CallbackAuditSnapshot,
}

fn append_degradation_event(
    events: &mut Vec<String>,
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

    events.push(format!(
        "    {{\"generated_unix\":{},\"stage\":\"{}\",\"source\":\"{}\",\"count\":{},\"recovery_action\":\"{}\",\"detail\":\"{}\"}}",
        generated_unix,
        json_escape(stage),
        json_escape(source),
        count,
        recovery_action_name(action),
        json_escape(detail)
    ));
}

fn build_degradation_events(telemetry: &RunTelemetry, generated_unix: u64) -> Vec<String> {
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

fn write_run_telemetry(path: &Path, telemetry: &RunTelemetry) -> Result<()> {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let degradation_events = build_degradation_events(telemetry, now_unix);
    let degradation_events_json = if degradation_events.is_empty() {
        String::new()
    } else {
        format!("\n{}\n  ", degradation_events.join(",\n"))
    };

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
        json_escape(&telemetry.output_wav_path.to_string_lossy()),
        telemetry.duration_secs,
        telemetry.target_rate_hz,
        telemetry.output_rate_hz,
        telemetry.mic_chunks,
        telemetry.system_chunks,
        telemetry.output_frames,
        telemetry.restart_count,
        telemetry.transport.capacity,
        telemetry.transport.ready_depth_high_water,
        telemetry.transport.in_flight,
        telemetry.transport.enqueued,
        telemetry.transport.dequeued,
        telemetry.transport.slot_miss_drops,
        telemetry.transport.fill_failures,
        telemetry.transport.queue_full_drops,
        telemetry.transport.recycle_failures,
        telemetry.callback_audit.missing_audio_buffer_list,
        telemetry.callback_audit.missing_first_audio_buffer,
        telemetry.callback_audit.missing_format_description,
        telemetry.callback_audit.missing_sample_rate,
        telemetry.callback_audit.non_float_pcm,
        telemetry.callback_audit.chunk_too_large,
        telemetry.mismatch_policy.as_str(),
        telemetry.target_rate_hz,
        telemetry.output_rate_hz,
        telemetry.mic_input_rate_hz,
        telemetry.system_input_rate_hz,
        telemetry.mic_resample.resampled_chunks,
        telemetry.mic_resample.input_frames,
        telemetry.mic_resample.output_frames,
        telemetry.system_resample.resampled_chunks,
        telemetry.system_resample.input_frames,
        telemetry.system_resample.output_frames,
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

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let duration_secs = parse_u64_arg(&args, 1, 10)?;
    let output = parse_output_arg(&args, 2, "artifacts/hello-world.wav");
    let target_rate_hz = parse_u64_arg(&args, 3, 48_000)? as u32;
    let mismatch_policy =
        parse_sample_rate_policy_arg(&args, 4, SampleRateMismatchPolicy::AdaptStreamRate)?;
    let callback_contract_mode =
        parse_callback_contract_mode_arg(&args, 5, CallbackContractMode::Warn)?;
    let interruption_policy = InterruptionPolicy {
        idle_timeout: INTERRUPTION_IDLE_TIMEOUT,
        max_restarts: MAX_CAPTURE_RESTARTS,
    };

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory {}", parent.display()))?;
    }

    println!(
        "Starting Sequoia capture for {}s -> {}",
        duration_secs,
        output.display()
    );
    println!("Stereo mapping: left=mic, right=system");
    println!("Sample-rate mismatch policy: {}", mismatch_policy.as_str());
    println!("Callback contract mode: {:?}", callback_contract_mode);

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

    let deadline = Instant::now() + Duration::from_secs(duration_secs);
    let mut mic_chunks = Vec::<TimedChunk>::new();
    let mut sys_chunks = Vec::<TimedChunk>::new();
    let mut restart_count = 0usize;

    while Instant::now() < deadline {
        let mut last_chunk_at = Instant::now();
        let mut interrupted = false;

        while Instant::now() < deadline {
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

                    match chunk.kind {
                        SCStreamOutputType::Audio => sys_chunks.push(chunk),
                        SCStreamOutputType::Microphone => mic_chunks.push(chunk),
                        SCStreamOutputType::Screen => {}
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
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

        stream
            .start_capture()
            .context("failed to restart stream capture after interruption")?;
    }

    let transport_stats = consumer.stats_snapshot();
    let callback_audit_snapshot = callback_audit.snapshot();

    if mic_chunks.is_empty() || sys_chunks.is_empty() {
        bail!(
            "missing captured data (mic chunks: {}, system chunks: {})",
            mic_chunks.len(),
            sys_chunks.len()
        );
    }

    let mic_rate = mic_chunks[0].sample_rate_hz;
    let sys_rate = sys_chunks[0].sample_rate_hz;

    let output_rate_hz =
        resolve_output_sample_rate(target_rate_hz, mic_rate, sys_rate, mismatch_policy)?;
    let base_pts = mic_chunks[0].pts_seconds.min(sys_chunks[0].pts_seconds);
    let (mic, mic_resample) = paint_chunks_timeline(&mic_chunks, base_pts, output_rate_hz);
    let (sys, sys_resample) = paint_chunks_timeline(&sys_chunks, base_pts, output_rate_hz);
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
    enforce_callback_contract(callback_contract_mode, callback_audit_snapshot)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_degradation_events, callback_recovery_breakdown, can_restart_capture,
        enforce_callback_contract, paint_chunks_timeline, recovery_action_for_callback_violation,
        recovery_action_for_interruption, resample_linear_mono, resolve_output_sample_rate,
        telemetry_path_for_output, write_run_telemetry, CallbackAuditSnapshot,
        CallbackContractMode, CallbackContractViolation, InterruptionPolicy, RecoveryAction,
        ResampleStats, RunTelemetry, SampleRateMismatchPolicy, TimedChunk,
    };
    use recordit::rt_transport::TransportStatsSnapshot;
    use screencapturekit::prelude::SCStreamOutputType;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn strict_policy_fails_on_target_mismatch() {
        let result =
            resolve_output_sample_rate(48_000, 44_100, 44_100, SampleRateMismatchPolicy::Strict);
        assert!(result.is_err());
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
            .any(|event| event.contains("\"generated_unix\":1700000000")));
        assert!(events
            .iter()
            .any(|event| event.contains("\"recovery_action\":\"RestartStream\"")));
        assert!(events
            .iter()
            .any(|event| event.contains("\"source\":\"missing_format_description\"")));
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
}
