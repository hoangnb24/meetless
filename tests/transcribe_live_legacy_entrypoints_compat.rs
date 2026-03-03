use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn transcribe_live_bin() -> PathBuf {
    if let Ok(path) = env::var("CARGO_BIN_EXE_transcribe-live") {
        return PathBuf::from(path);
    }
    project_root().join("target/debug/transcribe-live")
}

fn run_transcribe_live(args: &[&str]) -> Output {
    Command::new(transcribe_live_bin())
        .args(args)
        .output()
        .expect("failed to execute transcribe-live")
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()))
}

fn help_text() -> String {
    let output = run_transcribe_live(&["--help"]);
    assert!(output.status.success(), "--help should succeed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn help_surface_keeps_legacy_entrypoints_and_flags_used_by_automation() {
    let help = help_text();

    for expected in [
        "--duration-sec",
        "--input-wav",
        "--out-wav",
        "--out-jsonl",
        "--out-manifest",
        "--asr-backend",
        "--asr-model",
        "--benchmark-runs",
        "--transcribe-channels",
        "--live-chunked",
        "--live-stream",
        "--preflight",
        "--model-doctor",
        "--replay-jsonl",
    ] {
        assert!(
            help.contains(expected),
            "legacy help surface is missing automation flag {expected}"
        );
    }
}

#[test]
fn replay_entrypoint_still_replays_frozen_runtime_jsonl() {
    let fixture =
        project_root().join("artifacts/validation/bd-1qfx/live-stream-cold.runtime.jsonl");
    assert!(
        fixture.is_file(),
        "missing replay fixture {}",
        fixture.display()
    );

    let output = run_transcribe_live(&["--replay-jsonl", fixture.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "replay entrypoint should succeed, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Replay timeline"));
    assert!(stdout.contains("source_jsonl:"));
    assert!(stdout.contains("events:"));
}

#[test]
fn conflicting_legacy_entrypoints_still_fail_fast_with_contract_message() {
    let fixture =
        project_root().join("artifacts/validation/bd-1qfx/live-stream-cold.runtime.jsonl");
    let output = run_transcribe_live(&[
        "--model-doctor",
        "--replay-jsonl",
        fixture.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "invalid legacy entrypoint combination should use compatibility failure exit code"
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--model-doctor"));
    assert!(stderr.contains("--replay-jsonl"));
    assert!(stderr.contains("cannot be combined"));
    assert!(stderr.contains("transcribe-live --help"));
}

#[test]
fn makefile_and_gate_scripts_still_reference_supported_legacy_entrypoints() {
    let help = help_text();
    let root = project_root();
    let makefile = read_text(&root.join("Makefile"));

    for target in [
        "transcribe-live:",
        "transcribe-live-stream:",
        "transcribe-preflight:",
        "transcribe-model-doctor:",
    ] {
        assert!(
            makefile.contains(target),
            "Makefile lost legacy target `{target}`"
        );
    }

    for expected in [
        "--model-doctor",
        "--preflight",
        "--live-stream",
        "--live-chunked",
        "--input-wav",
        "--out-wav",
        "--out-jsonl",
        "--out-manifest",
        "--benchmark-runs",
        "--transcribe-channels",
        "--asr-model",
    ] {
        assert!(
            makefile.contains(expected),
            "Makefile no longer exercises legacy flag {expected}"
        );
        assert!(
            help.contains(expected),
            "legacy help surface no longer documents script-used flag {expected}"
        );
    }

    let gate_backlog = read_text(&root.join("scripts/gate_backlog_pressure.sh"));
    assert!(gate_backlog.contains("target/debug/transcribe-live"));
    assert!(gate_backlog.contains("--live-stream"));
    assert!(gate_backlog.contains("--benchmark-runs 1"));

    let gate_soak = read_text(&root.join("scripts/gate_d_soak.sh"));
    assert!(gate_soak.contains("target/debug/transcribe-live"));
    assert!(gate_soak.contains("--live-chunked"));
    assert!(gate_soak.contains("--transcribe-channels mixed-fallback"));

    let gate_acceptance = read_text(&root.join("scripts/gate_v1_acceptance.sh"));
    assert!(gate_acceptance.contains("target/debug/transcribe-live"));
    assert!(gate_acceptance.contains("--live-stream"));
    assert!(gate_acceptance.contains("--input-wav"));

    let gate_replay = read_text(&root.join("scripts/gate_transcript_completeness.sh"));
    assert!(gate_replay.contains("target/debug/transcribe-live --replay-jsonl"));
    assert!(help.contains("--replay-jsonl"));
}
