use std::process::{Command, Output};

fn run_transcribe_live(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_transcribe-live"))
        .args(args)
        .output()
        .expect("failed to execute transcribe-live")
}

#[test]
fn parse_failures_emit_failed_status_with_operator_remediation_hint() {
    let output = run_transcribe_live(&["--no-such-flag"]);
    assert_eq!(output.status.code(), Some(2));

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown option `--no-such-flag`"));
    assert!(stderr.contains("run_status=failed"));
    assert!(
        stderr.contains("remediation_hint=run `recordit --help`")
            || stderr.contains("remediation_hint=run `recordit run --mode live`"),
        "expected recordit-oriented remediation hint, got: {stderr}"
    );
}

#[test]
fn replay_failures_emit_failed_status_with_replay_specific_remediation_hint() {
    let output = run_transcribe_live(&["--replay-jsonl", "artifacts/does-not-exist/runtime.jsonl"]);
    assert_eq!(output.status.code(), Some(2));

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("failed to read replay JSONL"));
    assert!(stderr.contains("run_status=failed"));
    assert!(
        stderr.contains("remediation_hint=verify the replay JSONL path exists")
            && stderr.contains("recordit replay --jsonl <path>"),
        "expected replay remediation hint, got: {stderr}"
    );
}
