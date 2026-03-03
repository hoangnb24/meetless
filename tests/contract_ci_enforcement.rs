use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("failed to parse {} as JSON: {err}", path.display()))
}

fn run_recordit_json(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_recordit"))
        .args(args)
        .output()
        .expect("failed to execute recordit binary");
    assert!(
        output.status.success(),
        "recordit command should succeed: args={args:?}, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout)
        .unwrap_or_else(|err| panic!("recordit output should be valid JSON for {args:?}: {err}"))
}

fn as_string_set(value: &Value, context: &str) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{context}: expected array"))
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .unwrap_or_else(|| panic!("{context}: expected string entries"))
                .to_string()
        })
        .collect()
}

#[test]
fn inspect_contract_artifacts_match_published_files() {
    let root = project_root();
    let contracts = [
        ("jsonl-schema", "contracts/runtime-jsonl.schema.v1.json"),
        (
            "manifest-schema",
            "contracts/session-manifest.schema.v1.json",
        ),
        (
            "exit-codes",
            "contracts/recordit-exit-code-contract.v1.json",
        ),
    ];

    for (name, relative_path) in contracts {
        let expected = read_json(&root.join(relative_path));
        let actual = run_recordit_json(&["inspect-contract", name, "--format", "json"]);
        assert_eq!(
            actual, expected,
            "inspect-contract {name} drifted from published artifact {relative_path}"
        );
    }
}

#[test]
fn inspect_contract_name_inventory_is_consistent_across_sources() {
    let root = project_root();
    let cli_contract_path = root.join("contracts/recordit-cli-contract.v1.json");
    let cli_contract = read_json(&cli_contract_path);
    let grammar_doc_path = root.join("docs/recordit-cli-grammar-contract.md");
    let grammar_doc = fs::read_to_string(&grammar_doc_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", grammar_doc_path.display()));

    let expected_names: BTreeSet<String> = [
        "cli",
        "runtime-modes",
        "jsonl-schema",
        "manifest-schema",
        "exit-codes",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    let inspect_names = as_string_set(
        cli_contract
            .get("commands")
            .and_then(|commands| commands.get("inspect-contract"))
            .and_then(|command| command.get("name_values"))
            .unwrap_or_else(|| {
                panic!(
                    "{} missing inspect-contract name_values",
                    cli_contract_path.display()
                )
            }),
        "contracts/recordit-cli-contract.v1.json commands.inspect-contract.name_values",
    );
    assert_eq!(
        inspect_names, expected_names,
        "published CLI contract inspect-contract names drifted"
    );

    let inspect_grammar_line = "recordit inspect-contract <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes> [--format json]";
    let canonical_grammar = as_string_set(
        cli_contract
            .get("canonical_grammar")
            .unwrap_or_else(|| panic!("{} missing canonical_grammar", cli_contract_path.display())),
        "contracts/recordit-cli-contract.v1.json canonical_grammar",
    );
    assert!(
        canonical_grammar.contains(inspect_grammar_line),
        "published CLI contract missing inspect-contract grammar line with exit-codes"
    );
    assert!(
        grammar_doc.contains(inspect_grammar_line),
        "grammar doc missing inspect-contract grammar line with exit-codes"
    );

    let cli_payload = run_recordit_json(&["inspect-contract", "cli", "--format", "json"]);
    let cli_payload_grammar = as_string_set(
        cli_payload
            .get("grammar")
            .unwrap_or_else(|| panic!("inspect-contract cli payload missing grammar")),
        "inspect-contract cli payload grammar",
    );
    assert!(
        cli_payload_grammar.contains(inspect_grammar_line),
        "inspect-contract cli payload missing grammar line with exit-codes"
    );
}

#[test]
fn published_contract_files_are_versioned_and_machine_readable() {
    let contracts_dir = project_root().join("contracts");
    let mut discovered = BTreeSet::new();

    for entry in fs::read_dir(&contracts_dir)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", contracts_dir.display()))
    {
        let path = entry
            .unwrap_or_else(|err| panic!("failed to read contracts entry: {err}"))
            .path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| panic!("invalid UTF-8 filename in {}", path.display()))
            .to_string();
        discovered.insert(file_name.clone());

        let stem = file_name
            .strip_suffix(".json")
            .unwrap_or_else(|| panic!("unexpected JSON filename shape: {file_name}"));
        let version_suffix = stem
            .rsplit_once(".v")
            .map(|(_, suffix)| suffix)
            .unwrap_or_else(|| panic!("contract filename missing .vN suffix: {file_name}"));
        assert!(
            !version_suffix.is_empty() && version_suffix.chars().all(|c| c.is_ascii_digit()),
            "contract filename has non-numeric major version suffix: {file_name}"
        );

        let payload = read_json(&path);
        if let Some(schema_uri) = payload.get("$schema").and_then(Value::as_str) {
            assert_eq!(
                schema_uri,
                "https://json-schema.org/draft/2020-12/schema",
                "{} has unexpected $schema URI",
                path.display()
            );
        } else {
            assert!(
                payload.get("schema_version").is_some() || payload.get("version").is_some(),
                "{} must expose schema_version or version",
                path.display()
            );
        }
    }

    let required: BTreeSet<String> = [
        "recordit-cli-contract.v1.json",
        "recordit-exit-code-contract.v1.json",
        "runtime-jsonl.schema.v1.json",
        "runtime-mode-matrix.v1.json",
        "session-manifest.schema.v1.json",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert!(
        required.is_subset(&discovered),
        "required contract files missing. required={required:?}, discovered={discovered:?}"
    );
}
