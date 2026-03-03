use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load_contract() -> Value {
    let path = project_root().join("contracts/recordit-cli-contract.v1.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("failed to parse {} as JSON: {err}", path.display()))
}

fn load_json(relative_path: &str) -> Value {
    let path = project_root().join(relative_path);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("failed to parse {} as JSON: {err}", path.display()))
}

fn run_recordit(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_recordit"))
        .args(args)
        .output()
        .expect("failed to execute recordit binary")
}

fn inspect_contract_json(name: &str) -> Value {
    let output = run_recordit(&["inspect-contract", name, "--format", "json"]);
    assert!(
        output.status.success(),
        "inspect-contract {name} should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|err| panic!("inspect-contract {name} returned invalid JSON: {err}"))
}

fn as_object<'a>(value: &'a Value, ctx: &str) -> &'a serde_json::Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("expected object at {ctx}"))
}

fn as_string_set(value: &Value, ctx: &str) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected string array at {ctx}"))
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .unwrap_or_else(|| panic!("non-string value in {ctx}"))
                .to_string()
        })
        .collect()
}

#[test]
fn recordit_cli_contract_exposes_canonical_top_level_surface() {
    let contract = load_contract();
    assert_eq!(contract["contract"], "recordit-cli");
    assert_eq!(contract["version"], "v1");
    assert_eq!(contract["published"], true);
    assert_eq!(contract["source"], "docs/recordit-cli-grammar-contract.md");
    assert_eq!(contract["binary"], "recordit");

    let expected_verbs: BTreeSet<String> =
        ["run", "doctor", "preflight", "replay", "inspect-contract"]
            .into_iter()
            .map(str::to_string)
            .collect();
    let verbs = as_string_set(&contract["top_level_verbs"], "top_level_verbs");
    assert_eq!(verbs, expected_verbs);

    let grammar = as_string_set(&contract["canonical_grammar"], "canonical_grammar");
    for expected in [
        "recordit run --mode <live|offline> [mode options] [shared options]",
        "recordit doctor [doctor options]",
        "recordit preflight [preflight options]",
        "recordit replay --jsonl <path> [--format <text|json>]",
        "recordit inspect-contract <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes> [--format json]",
    ] {
        assert!(
            grammar.contains(expected),
            "missing canonical grammar line: {expected}"
        );
    }
}

#[test]
fn recordit_cli_contract_pins_mode_and_option_rules() {
    let contract = load_contract();
    let commands = as_object(
        contract.get("commands").expect("missing commands object"),
        "commands",
    );

    let run = as_object(
        commands.get("run").expect("missing run command"),
        "commands.run",
    );
    assert!(
        as_string_set(
            run.get("required_options")
                .expect("missing commands.run.required_options"),
            "commands.run.required_options"
        )
        .contains("--mode"),
        "run command must require --mode"
    );

    let modes = as_object(
        run.get("modes").expect("missing commands.run.modes"),
        "commands.run.modes",
    );
    let live = as_object(
        modes.get("live").expect("missing run live mode"),
        "commands.run.modes.live",
    );
    let offline = as_object(
        modes.get("offline").expect("missing run offline mode"),
        "commands.run.modes.offline",
    );

    assert!(
        as_string_set(
            live.get("forbidden_options")
                .expect("missing live forbidden_options"),
            "commands.run.modes.live.forbidden_options"
        )
        .contains("--input-wav"),
        "live mode must forbid --input-wav"
    );
    assert!(
        as_string_set(
            offline
                .get("required_options")
                .expect("missing offline required_options"),
            "commands.run.modes.offline.required_options"
        )
        .contains("--input-wav"),
        "offline mode must require --input-wav"
    );

    let inspect = as_object(
        commands
            .get("inspect-contract")
            .expect("missing inspect-contract command"),
        "commands.inspect-contract",
    );
    let inspect_names = as_string_set(
        inspect
            .get("name_values")
            .expect("missing inspect-contract name_values"),
        "commands.inspect-contract.name_values",
    );
    for expected in [
        "cli",
        "runtime-modes",
        "jsonl-schema",
        "manifest-schema",
        "exit-codes",
    ] {
        assert!(
            inspect_names.contains(expected),
            "inspect-contract missing name value {expected}"
        );
    }

    let output_root = as_object(
        contract
            .get("output_root_contract")
            .expect("missing output_root_contract"),
        "output_root_contract",
    );
    let filenames = as_string_set(
        output_root
            .get("canonical_filenames")
            .expect("missing output_root_contract.canonical_filenames"),
        "output_root_contract.canonical_filenames",
    );
    for expected in [
        "session.input.wav",
        "session.wav",
        "session.jsonl",
        "session.manifest.json",
    ] {
        assert!(
            filenames.contains(expected),
            "missing canonical filename {expected}"
        );
    }
}

#[test]
fn inspect_contract_artifact_payloads_match_published_contract_files() {
    for (name, contract_path) in [
        ("jsonl-schema", "contracts/runtime-jsonl.schema.v1.json"),
        (
            "manifest-schema",
            "contracts/session-manifest.schema.v1.json",
        ),
        (
            "exit-codes",
            "contracts/recordit-exit-code-contract.v1.json",
        ),
    ] {
        let actual = inspect_contract_json(name);
        let expected = load_json(contract_path);
        assert_eq!(
            actual, expected,
            "inspect-contract {name} drifted from {contract_path}"
        );
    }
}

#[test]
fn inspect_contract_runtime_modes_remains_consistent_with_runtime_mode_matrix() {
    let runtime_modes = inspect_contract_json("runtime-modes");
    let runtime_modes = runtime_modes
        .get("modes")
        .and_then(Value::as_array)
        .expect("runtime-modes payload missing modes[]");

    let matrix_contract = load_json("contracts/runtime-mode-matrix.v1.json");
    let matrix_modes = matrix_contract
        .get("modes")
        .and_then(Value::as_array)
        .expect("runtime-mode-matrix contract missing modes[]");

    let live_expected = matrix_modes
        .iter()
        .find(|mode| mode.get("runtime_mode").and_then(Value::as_str) == Some("live-stream"))
        .expect("runtime-mode-matrix missing live-stream row");
    let offline_expected = matrix_modes
        .iter()
        .find(|mode| {
            mode.get("runtime_mode").and_then(Value::as_str) == Some("representative-offline")
        })
        .expect("runtime-mode-matrix missing representative-offline row");

    let live_actual = runtime_modes
        .iter()
        .find(|mode| mode.get("mode").and_then(Value::as_str) == Some("live"))
        .expect("runtime-modes payload missing live mode");
    let offline_actual = runtime_modes
        .iter()
        .find(|mode| mode.get("mode").and_then(Value::as_str) == Some("offline"))
        .expect("runtime-modes payload missing offline mode");

    assert_eq!(
        live_actual.get("runtime_mode").and_then(Value::as_str),
        live_expected.get("runtime_mode").and_then(Value::as_str)
    );
    assert_eq!(
        live_actual
            .get("runtime_mode_taxonomy")
            .and_then(Value::as_str),
        live_expected
            .get("runtime_mode_taxonomy")
            .and_then(Value::as_str)
    );
    assert_eq!(
        live_actual.get("status").and_then(Value::as_str),
        live_expected
            .get("runtime_mode_status")
            .and_then(Value::as_str)
    );

    assert_eq!(
        offline_actual.get("runtime_mode").and_then(Value::as_str),
        offline_expected.get("runtime_mode").and_then(Value::as_str)
    );
    assert_eq!(
        offline_actual
            .get("runtime_mode_taxonomy")
            .and_then(Value::as_str),
        offline_expected
            .get("runtime_mode_taxonomy")
            .and_then(Value::as_str)
    );
    assert_eq!(
        offline_actual.get("status").and_then(Value::as_str),
        offline_expected
            .get("runtime_mode_status")
            .and_then(Value::as_str)
    );
}

#[test]
fn all_published_inspect_contract_names_are_machine_readable() {
    let contract = load_contract();
    let commands = as_object(
        contract.get("commands").expect("missing commands object"),
        "commands",
    );
    let inspect = as_object(
        commands
            .get("inspect-contract")
            .expect("missing inspect-contract command"),
        "commands.inspect-contract",
    );
    let inspect_names = as_string_set(
        inspect
            .get("name_values")
            .expect("missing inspect-contract name_values"),
        "commands.inspect-contract.name_values",
    );

    for name in inspect_names {
        let payload = inspect_contract_json(&name);
        assert!(
            payload.is_object(),
            "inspect-contract {name} must return a JSON object payload"
        );
    }
}
