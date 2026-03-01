use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_DURATION_SEC: u64 = 3;
const RUNTIME_TIMEOUT_SEC: u64 = 45;

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn default_model_path() -> PathBuf {
    project_root().join("artifacts/bench/models/whispercpp/ggml-tiny.en.bin")
}

fn default_fixture_path() -> PathBuf {
    project_root().join("artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav")
}

fn transcribe_live_bin() -> PathBuf {
    if let Ok(path) = env::var("CARGO_BIN_EXE_transcribe-live") {
        return PathBuf::from(path);
    }
    project_root().join("target/debug/transcribe-live")
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = env::temp_dir().join(format!("{prefix}-{nanos}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn extract_u64_field(line: &str, field: &str) -> Option<u64> {
    let (_, tail) = line.split_once(field)?;
    let digits: String = tail
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse::<u64>().ok()
}

fn is_stable_event(line: &str) -> bool {
    line.contains("\"event_type\":\"final\"")
        || line.contains("\"event_type\":\"llm_final\"")
        || line.contains("\"event_type\":\"reconciled_final\"")
}

fn first_stable_end_ms(jsonl_path: &Path) -> Option<u64> {
    let contents = fs::read_to_string(jsonl_path).ok()?;
    for line in contents.lines() {
        if is_stable_event(line) {
            return extract_u64_field(line, "\"end_ms\":");
        }
    }
    None
}

fn samples_show_growth(samples: &[u64]) -> bool {
    let mut distinct = BTreeSet::new();
    for size in samples {
        distinct.insert(*size);
    }
    distinct.len() >= 2 && distinct.iter().last().copied().unwrap_or(0) > 0
}

fn track_size(path: &Path, samples: &mut Vec<u64>) {
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    samples.push(len);
}

fn wait_for_completion(
    child: &mut Child,
    input_wav: &Path,
    out_jsonl: &Path,
) -> Result<(Vec<u64>, Vec<u64>, std::process::ExitStatus), Box<dyn Error>> {
    let mut input_sizes = Vec::new();
    let mut jsonl_sizes = Vec::new();
    let started = Instant::now();

    loop {
        track_size(input_wav, &mut input_sizes);
        track_size(out_jsonl, &mut jsonl_sizes);

        if let Some(status) = child.try_wait()? {
            return Ok((input_sizes, jsonl_sizes, status));
        }
        if started.elapsed() > Duration::from_secs(RUNTIME_TIMEOUT_SEC) {
            let _ = child.kill();
            return Err(format!(
                "transcribe-live did not finish within {}s",
                RUNTIME_TIMEOUT_SEC
            )
            .into());
        }
        thread::sleep(Duration::from_millis(120));
    }
}

#[test]
fn live_stream_emits_stable_before_timeout_and_artifacts_grow_in_flight()
-> Result<(), Box<dyn Error>> {
    let model = default_model_path();
    let fixture = default_fixture_path();
    if !model.is_file() || !fixture.is_file() {
        eprintln!(
            "skipping integration test: model or fixture missing (model={}, fixture={})",
            model.display(),
            fixture.display()
        );
        return Ok(());
    }

    let out_dir = temp_dir("recordit-live-stream-integration");
    let input_wav = out_dir.join("session.input.wav");
    let out_wav = out_dir.join("session.wav");
    let out_jsonl = out_dir.join("session.jsonl");
    let out_manifest = out_dir.join("session.manifest.json");

    let mut child = Command::new(transcribe_live_bin())
        .env("DYLD_LIBRARY_PATH", "/usr/lib/swift")
        .env("RECORDIT_FAKE_CAPTURE_FIXTURE", &fixture)
        .arg("--duration-sec")
        .arg(DEFAULT_DURATION_SEC.to_string())
        .arg("--live-stream")
        .arg("--input-wav")
        .arg(&input_wav)
        .arg("--out-wav")
        .arg(&out_wav)
        .arg("--out-jsonl")
        .arg(&out_jsonl)
        .arg("--out-manifest")
        .arg(&out_manifest)
        .arg("--asr-backend")
        .arg("whispercpp")
        .arg("--asr-model")
        .arg(&model)
        .arg("--benchmark-runs")
        .arg("1")
        .arg("--transcribe-channels")
        .arg("mixed-fallback")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let (input_sizes, jsonl_sizes, status) =
        wait_for_completion(&mut child, &input_wav, &out_jsonl)?;
    assert!(
        status.success(),
        "transcribe-live returned non-zero exit status: {status}"
    );

    assert!(
        samples_show_growth(&input_sizes),
        "expected in-flight growth for input WAV sizes, got: {:?}",
        input_sizes
    );
    assert!(
        samples_show_growth(&jsonl_sizes),
        "expected in-flight growth for runtime JSONL sizes, got: {:?}",
        jsonl_sizes
    );
    assert!(
        input_wav.is_file(),
        "missing input wav at {}",
        input_wav.display()
    );
    assert!(
        out_jsonl.is_file(),
        "missing runtime jsonl at {}",
        out_jsonl.display()
    );
    assert!(
        fs::metadata(&input_wav)?.len() > 0,
        "expected non-zero bytes for {}",
        input_wav.display()
    );
    assert!(
        fs::metadata(&out_jsonl)?.len() > 0,
        "expected non-zero bytes for {}",
        out_jsonl.display()
    );

    let first_stable = first_stable_end_ms(&out_jsonl).ok_or_else(|| {
        format!(
            "expected stable transcript event in runtime jsonl, file={}",
            out_jsonl.display()
        )
    })?;
    let max_expected_ms = (DEFAULT_DURATION_SEC * 1_000) + 1_500;
    assert!(
        first_stable <= max_expected_ms,
        "first stable emit should complete before timeout window (first_stable={}ms, max_expected={}ms)",
        first_stable,
        max_expected_ms
    );

    let _ = fs::remove_dir_all(out_dir);
    Ok(())
}
