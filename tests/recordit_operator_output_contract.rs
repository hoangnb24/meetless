use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn run_recordit(args: &[String]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_recordit"))
        .args(args)
        .output()
        .expect("failed to execute recordit binary")
}

fn temp_output_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("recordit-operator-output-{nanos}"))
}

fn assert_manifest_runtime_mode_fields(
    manifest: &Value,
    expected_mode: &str,
    expected_selector: &str,
) {
    let config = manifest
        .get("config")
        .and_then(Value::as_object)
        .expect("manifest should include config object");

    assert_eq!(
        manifest.get("runtime_mode").and_then(Value::as_str),
        Some(expected_mode)
    );
    assert_eq!(
        manifest
            .get("runtime_mode_taxonomy")
            .and_then(Value::as_str),
        Some(expected_mode)
    );
    assert_eq!(
        manifest
            .get("runtime_mode_selector")
            .and_then(Value::as_str),
        Some(expected_selector)
    );
    assert_eq!(
        manifest.get("runtime_mode_status").and_then(Value::as_str),
        Some("implemented")
    );

    assert_eq!(
        config.get("runtime_mode").and_then(Value::as_str),
        Some(expected_mode)
    );
    assert_eq!(
        config.get("runtime_mode_taxonomy").and_then(Value::as_str),
        Some(expected_mode)
    );
    assert_eq!(
        config.get("runtime_mode_selector").and_then(Value::as_str),
        Some(expected_selector)
    );
    assert_eq!(
        config.get("runtime_mode_status").and_then(Value::as_str),
        Some("implemented")
    );
}

#[test]
fn recordit_run_uses_concise_operator_startup_surface() {
    let output_root = temp_output_root();
    let output = run_recordit(&[
        "run".to_string(),
        "--mode".to_string(),
        "offline".to_string(),
        "--input-wav".to_string(),
        "artifacts/bench/corpus/gate_a/tts_phrase.wav".to_string(),
        "--model".to_string(),
        "artifacts/bench/models/whispercpp/ggml-tiny.en.bin".to_string(),
        "--output-root".to_string(),
        output_root.display().to_string(),
        "--json".to_string(),
    ]);

    assert!(
        output.status.success(),
        "recordit run should succeed, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Startup banner"));
    assert!(stdout.contains("run_status:"));
    assert!(stdout.contains("remediation_hints:"));
    assert!(stdout.contains("close_summary:"));
    assert!(
        !stdout.contains("Transcribe-live configuration"),
        "recordit default operator run should suppress legacy verbose configuration block"
    );
    assert!(
        !stdout.contains("transcript_text:"),
        "recordit default operator run should suppress transcript detail blocks"
    );
    assert!(
        !stdout.contains("channel_transcripts:"),
        "recordit default operator run should suppress per-channel transcript blocks"
    );
    assert!(
        !stdout.contains("asr_worker_pool:"),
        "recordit default operator run should suppress deep runtime telemetry blocks"
    );
    assert!(
        stdout.contains("\"command\":\"run\""),
        "expected trailing machine-readable run summary envelope"
    );
}

#[test]
fn recordit_preflight_manifest_exposes_mode_labels_for_live_and_offline() {
    let live_output_root = temp_output_root();
    let live = run_recordit(&[
        "preflight".to_string(),
        "--mode".to_string(),
        "live".to_string(),
        "--output-root".to_string(),
        live_output_root.display().to_string(),
        "--json".to_string(),
    ]);
    assert!(
        live.status.success(),
        "live preflight should succeed, stderr={}",
        String::from_utf8_lossy(&live.stderr)
    );
    let live_manifest = std::fs::read_to_string(live_output_root.join("session.manifest.json"))
        .expect("live preflight should write a manifest");
    let live_manifest: Value =
        serde_json::from_str(&live_manifest).expect("live preflight manifest should parse");
    assert_manifest_runtime_mode_fields(&live_manifest, "live-stream", "--live-stream");

    let offline_output_root = temp_output_root();
    let offline = run_recordit(&[
        "preflight".to_string(),
        "--mode".to_string(),
        "offline".to_string(),
        "--input-wav".to_string(),
        "artifacts/bench/corpus/gate_a/tts_phrase.wav".to_string(),
        "--output-root".to_string(),
        offline_output_root.display().to_string(),
        "--json".to_string(),
    ]);
    assert!(
        offline.status.success(),
        "offline preflight should succeed, stderr={}",
        String::from_utf8_lossy(&offline.stderr)
    );
    let offline_manifest =
        std::fs::read_to_string(offline_output_root.join("session.manifest.json"))
            .expect("offline preflight should write a manifest");
    let offline_manifest: Value =
        serde_json::from_str(&offline_manifest).expect("offline preflight manifest should parse");
    assert_manifest_runtime_mode_fields(&offline_manifest, "representative-offline", "<default>");
}
