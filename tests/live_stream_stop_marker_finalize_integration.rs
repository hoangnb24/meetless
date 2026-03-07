use serde_json::Value;
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REQUESTED_DURATION_SEC: u64 = 30;
const STARTUP_TIMEOUT_SEC: u64 = 12;
const RUNTIME_TIMEOUT_SEC: u64 = 45;
const STOP_SETTLE_TIMEOUT_SEC: u64 = 10;

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

fn contains_active_lifecycle(jsonl_path: &Path) -> bool {
    fs::read_to_string(jsonl_path)
        .ok()
        .map(|contents| runtime_events_from_jsonl(&contents))
        .map(|events| {
            events.iter().any(|value| {
                value.get("event_type").and_then(Value::as_str) == Some("lifecycle_phase")
                    && value.get("phase").and_then(Value::as_str) == Some("active")
            })
        })
        .unwrap_or(false)
}

fn wait_for_runtime_activity(input_wav: &Path, out_jsonl: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(STARTUP_TIMEOUT_SEC);
    while Instant::now() < deadline {
        let input_ready = fs::metadata(input_wav).map(|meta| meta.len() > 0).unwrap_or(false);
        let jsonl_ready = contains_active_lifecycle(out_jsonl);
        if input_ready && jsonl_ready {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(120));
    }

    Err(format!(
        "runtime did not reach active capture/transcript state within {}s (input_wav={}, out_jsonl={})",
        STARTUP_TIMEOUT_SEC,
        input_wav.display(),
        out_jsonl.display()
    )
    .into())
}

fn wait_for_completion(child: &mut Child) -> Result<std::process::ExitStatus, Box<dyn Error>> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
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

fn runtime_events_from_jsonl(contents: &str) -> Vec<Value> {
    contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn lifecycle_phases_from_events(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|value| value.get("event_type").and_then(Value::as_str) == Some("lifecycle_phase"))
        .filter_map(|value| value.get("phase").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn has_drain_completed_event(events: &[Value], event_type: &str) -> bool {
    events.iter().any(|value| {
        value.get("event_type").and_then(Value::as_str) == Some(event_type)
            && value.get("drain_completed").and_then(Value::as_bool) == Some(true)
    })
}

fn assert_phase_order(phases: &[String], required: &[&str]) {
    let mut previous_index = None;
    for expected in required {
        let index = phases
            .iter()
            .position(|phase| phase == expected)
            .unwrap_or_else(|| panic!("missing lifecycle phase `{expected}` in {phases:?}"));
        if let Some(previous_index) = previous_index {
            assert!(
                previous_index < index,
                "expected lifecycle phases in order {:?}, saw {:?}",
                required,
                phases
            );
        }
        previous_index = Some(index);
    }
}

#[test]
fn live_stream_stop_marker_drains_and_finalizes_same_run() -> Result<(), Box<dyn Error>> {
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

    let out_dir = temp_dir("recordit-live-stream-stop-marker");
    let input_wav = out_dir.join("session.input.wav");
    let out_wav = out_dir.join("session.wav");
    let out_jsonl = out_dir.join("session.jsonl");
    let out_manifest = out_dir.join("session.manifest.json");
    let stop_request = out_dir.join("session.stop.request");

    let mut child = Command::new(transcribe_live_bin())
        .env("DYLD_LIBRARY_PATH", "/usr/lib/swift")
        .env("RECORDIT_FAKE_CAPTURE_FIXTURE", &fixture)
        .env("RECORDIT_FAKE_CAPTURE_REALTIME", "1")
        .arg("--duration-sec")
        .arg(REQUESTED_DURATION_SEC.to_string())
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

    wait_for_runtime_activity(&input_wav, &out_jsonl)?;
    let stop_written_at = Instant::now();
    fs::write(&stop_request, b"stop\n")?;

    let status = wait_for_completion(&mut child)?;
    assert!(status.success(), "transcribe-live returned non-zero exit status: {status}");
    assert!(
        stop_written_at.elapsed() < Duration::from_secs(STOP_SETTLE_TIMEOUT_SEC),
        "runtime did not settle within {}s of writing stop marker",
        STOP_SETTLE_TIMEOUT_SEC
    );

    assert!(input_wav.is_file(), "missing input wav at {}", input_wav.display());
    assert!(out_wav.is_file(), "missing output wav at {}", out_wav.display());
    assert!(out_jsonl.is_file(), "missing runtime jsonl at {}", out_jsonl.display());
    assert!(
        out_manifest.is_file(),
        "missing session manifest at {}",
        out_manifest.display()
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

    let jsonl = fs::read_to_string(&out_jsonl)?;
    let events = runtime_events_from_jsonl(&jsonl);
    let lifecycle_phases = lifecycle_phases_from_events(&events);
    assert_phase_order(&lifecycle_phases, &["active", "draining", "shutdown"]);
    assert!(
        has_drain_completed_event(&events, "chunk_queue"),
        "expected chunk_queue drain completion event in runtime jsonl"
    );
    assert!(
        has_drain_completed_event(&events, "cleanup_queue"),
        "expected cleanup_queue drain completion event in runtime jsonl"
    );

    let manifest: Value = serde_json::from_str(&fs::read_to_string(&out_manifest)?)?;
    assert_eq!(
        manifest
            .get("lifecycle")
            .and_then(Value::as_object)
            .and_then(|value| value.get("current_phase"))
            .and_then(Value::as_str),
        Some("shutdown")
    );
    let manifest_lifecycle: Vec<&str> = manifest
        .get("lifecycle")
        .and_then(Value::as_object)
        .and_then(|value| value.get("transitions"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("phase").and_then(Value::as_str))
        .collect();
    assert!(manifest_lifecycle.contains(&"draining"), "manifest lifecycle missing draining transition: {manifest_lifecycle:?}");
    assert!(manifest_lifecycle.contains(&"shutdown"), "manifest lifecycle missing shutdown transition: {manifest_lifecycle:?}");
    assert_eq!(
        manifest
            .get("chunk_queue")
            .and_then(Value::as_object)
            .and_then(|value| value.get("drain_completed"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        manifest
            .get("cleanup_queue")
            .and_then(Value::as_object)
            .and_then(|value| value.get("drain_completed"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        manifest
            .get("session_summary")
            .and_then(Value::as_object)
            .and_then(|value| value.get("session_status"))
            .and_then(Value::as_str),
        Some("ok")
    );

    let _ = fs::remove_dir_all(out_dir);
    Ok(())
}
