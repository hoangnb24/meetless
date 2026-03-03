use serde_json::Value;
use std::collections::BTreeSet;
use std::process::Command;

fn run_recordit(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_recordit"))
        .args(args)
        .output()
        .expect("failed to execute recordit binary")
}

#[test]
fn inspect_contract_exit_codes_json_returns_canonical_contract() {
    let output = run_recordit(&["inspect-contract", "exit-codes", "--format", "json"]);
    assert!(
        output.status.success(),
        "inspect-contract exit-codes should succeed"
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let payload: Value =
        serde_json::from_str(&stdout).expect("exit-code contract payload should be valid JSON");
    assert_eq!(
        payload.get("kind").and_then(Value::as_str),
        Some("recordit.exit-code-contract")
    );
    assert_eq!(
        payload
            .get("default_success_exit_code")
            .and_then(Value::as_i64),
        Some(0)
    );
    assert_eq!(
        payload
            .get("default_failure_exit_code")
            .and_then(Value::as_i64),
        Some(2)
    );

    let class_ids = payload
        .get("classes")
        .and_then(Value::as_array)
        .expect("contract missing classes")
        .iter()
        .map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .expect("class missing id")
                .to_string()
        })
        .collect::<BTreeSet<_>>();
    let expected = [
        "success",
        "degraded_success",
        "usage_or_config_error",
        "preflight_failure",
        "runtime_failure",
        "replay_failure",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    assert_eq!(class_ids, expected);
}

#[test]
fn unknown_command_exits_with_contract_failure_code() {
    let output = run_recordit(&["wat"]);
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown command `wat`"));
}

#[test]
fn replay_missing_file_exits_with_contract_failure_code() {
    let output = run_recordit(&[
        "replay",
        "--jsonl",
        "artifacts/does-not-exist/session.jsonl",
        "--format",
        "json",
    ]);
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("failed to read replay JSONL"));
}

#[test]
fn help_lists_exit_codes_contract_name() {
    let output = run_recordit(&["--help"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("exit-codes"));
}
