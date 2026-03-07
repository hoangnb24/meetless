use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_json(relative: &str) -> Value {
    let path = repo_path(relative);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("failed to parse {} as json: {err}", path.display()))
}

fn str_field<'a>(object: &'a Value, key: &str, context: &str) -> &'a str {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{context}: missing string field `{key}`"))
}

fn mode_by_taxonomy<'a>(contract: &'a Value, taxonomy: &str) -> &'a Value {
    contract
        .get("modes")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("contract missing `modes` array"))
        .iter()
        .find(|row| {
            row.get("runtime_mode_taxonomy")
                .and_then(Value::as_str)
                .map(|value| value == taxonomy)
                .unwrap_or(false)
        })
        .unwrap_or_else(|| panic!("missing taxonomy row `{taxonomy}`"))
}

#[test]
fn runtime_mode_matrix_contract_has_expected_rows_and_rules() {
    let contract = read_json("contracts/runtime-mode-matrix.v1.json");

    assert_eq!(
        str_field(&contract, "schema_version", "runtime-mode-matrix"),
        "1"
    );
    assert_eq!(
        str_field(&contract, "kind", "runtime-mode-matrix"),
        "recordit.runtime-mode-matrix"
    );

    let runtime_mode_fields = contract
        .get("runtime_mode_fields")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("runtime-mode-matrix missing `runtime_mode_fields` array"))
        .iter()
        .map(|field| {
            field
                .as_str()
                .unwrap_or_else(|| panic!("runtime-mode-matrix field names must be strings"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        runtime_mode_fields,
        vec![
            "runtime_mode",
            "runtime_mode_taxonomy",
            "runtime_mode_selector",
            "runtime_mode_status",
        ]
    );

    let selector_rule_ids = contract
        .get("selector_rules")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("runtime-mode-matrix missing `selector_rules` array"))
        .iter()
        .map(|rule| str_field(rule, "id", "selector_rule").to_string())
        .collect::<BTreeSet<_>>();
    let expected_selector_rule_ids = [
        "live_selectors_mutually_exclusive",
        "chunk_tuning_requires_live_selector",
        "replay_incompatible_with_live_selectors",
        "preflight_compatible_with_live_selectors",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    assert_eq!(selector_rule_ids, expected_selector_rule_ids);

    let offline = mode_by_taxonomy(&contract, "representative-offline");
    assert_eq!(
        str_field(offline, "runtime_mode", "representative-offline"),
        "representative-offline"
    );
    assert_eq!(
        str_field(
            offline,
            "runtime_mode_selector",
            "representative-offline selector",
        ),
        "<default>"
    );
    assert_eq!(
        str_field(offline, "runtime_mode_status", "representative-offline"),
        "implemented"
    );
    assert_eq!(
        str_field(
            offline
                .get("compatibility")
                .unwrap_or_else(|| panic!("representative-offline missing compatibility object")),
            "chunk_tuning",
            "representative-offline chunk_tuning",
        ),
        "forbidden"
    );

    let representative_chunked = mode_by_taxonomy(&contract, "representative-chunked");
    assert_eq!(
        str_field(
            representative_chunked,
            "runtime_mode",
            "representative-chunked runtime_mode",
        ),
        "live-chunked"
    );
    assert_eq!(
        str_field(
            representative_chunked,
            "runtime_mode_selector",
            "representative-chunked selector",
        ),
        "--live-chunked"
    );
    assert_eq!(
        str_field(
            representative_chunked
                .get("compatibility")
                .unwrap_or_else(|| panic!("representative-chunked missing compatibility object")),
            "replay_jsonl",
            "representative-chunked replay_jsonl",
        ),
        "incompatible"
    );
    assert_eq!(
        str_field(
            representative_chunked
                .get("compatibility")
                .unwrap_or_else(|| panic!("representative-chunked missing compatibility object")),
            "preflight",
            "representative-chunked preflight",
        ),
        "compatible"
    );

    let live_stream = mode_by_taxonomy(&contract, "live-stream");
    assert_eq!(
        str_field(live_stream, "runtime_mode", "live-stream runtime_mode"),
        "live-stream"
    );
    assert_eq!(
        str_field(
            live_stream,
            "runtime_mode_selector",
            "live-stream runtime_mode_selector",
        ),
        "--live-stream"
    );
    assert_eq!(
        str_field(
            live_stream
                .get("compatibility")
                .unwrap_or_else(|| panic!("live-stream missing compatibility object")),
            "chunk_tuning",
            "live-stream chunk_tuning",
        ),
        "compatible"
    );
    assert_eq!(
        str_field(
            live_stream
                .get("compatibility")
                .unwrap_or_else(|| panic!("live-stream missing compatibility object")),
            "preflight",
            "live-stream preflight",
        ),
        "compatible"
    );
}

#[test]
fn runtime_mode_matrix_contract_matches_frozen_manifest_rows() {
    let contract = read_json("contracts/runtime-mode-matrix.v1.json");

    let cases = [
        (
            "artifacts/validation/bd-1qfx/representative-offline.runtime.manifest.json",
            "representative-offline",
        ),
        (
            "artifacts/validation/bd-1qfx/representative-chunked.runtime.manifest.json",
            "representative-chunked",
        ),
        (
            "artifacts/validation/bd-1qfx/live-stream-cold.runtime.manifest.json",
            "live-stream",
        ),
    ];

    for (manifest_path, taxonomy) in cases {
        let manifest = read_json(manifest_path);
        let row = mode_by_taxonomy(&contract, taxonomy);
        let context = format!("manifest `{manifest_path}`");

        assert_eq!(
            manifest.get("runtime_mode").and_then(Value::as_str),
            Some(str_field(row, "runtime_mode", &context)),
            "{context}: runtime_mode drift from contract",
        );
        assert_eq!(
            manifest
                .get("runtime_mode_taxonomy")
                .and_then(Value::as_str),
            Some(str_field(row, "runtime_mode_taxonomy", &context)),
            "{context}: runtime_mode_taxonomy drift from contract",
        );
        assert_eq!(
            manifest
                .get("runtime_mode_selector")
                .and_then(Value::as_str),
            Some(str_field(row, "runtime_mode_selector", &context)),
            "{context}: runtime_mode_selector drift from contract",
        );
        assert_eq!(
            manifest.get("runtime_mode_status").and_then(Value::as_str),
            Some(str_field(row, "runtime_mode_status", &context)),
            "{context}: runtime_mode_status drift from contract",
        );
    }
}
