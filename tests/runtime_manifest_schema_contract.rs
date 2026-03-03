use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const RUNTIME_MANIFESTS: &[&str] = &[
    "artifacts/validation/bd-1qfx/representative-offline.runtime.manifest.json",
    "artifacts/validation/bd-1qfx/representative-chunked.runtime.manifest.json",
    "artifacts/validation/bd-1qfx/live-stream-cold.runtime.manifest.json",
];

const PREFLIGHT_MANIFEST: &str = "artifacts/validation/bd-2p6.preflight.manifest.json";

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

fn object<'a>(value: &'a Value, context: &str) -> &'a Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{context}: expected JSON object"))
}

fn object_field<'a>(value: &'a Value, key: &str, context: &str) -> &'a Map<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("{context}: missing object field `{key}`"))
}

fn required_keys(schema_node: &Value, context: &str) -> BTreeSet<String> {
    schema_node
        .get("required")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{context}: missing `required` array"))
        .iter()
        .map(|value| {
            value
                .as_str()
                .unwrap_or_else(|| panic!("{context}: required entry is not string"))
                .to_string()
        })
        .collect()
}

#[test]
fn session_manifest_schema_declares_runtime_and_preflight_variants() {
    let schema = read_json("contracts/session-manifest.schema.v1.json");
    let schema_obj = object(&schema, "session-manifest schema");

    assert_eq!(
        schema_obj.get("$schema").and_then(Value::as_str),
        Some("https://json-schema.org/draft/2020-12/schema")
    );
    assert_eq!(
        schema_obj.get("type").and_then(Value::as_str),
        Some("object")
    );
    assert_eq!(
        schema_obj
            .get("oneOf")
            .and_then(Value::as_array)
            .map(|entries| entries.len()),
        Some(2)
    );

    let defs = object_field(&schema, "$defs", "session-manifest schema");
    let runtime = defs
        .get("runtime_manifest")
        .unwrap_or_else(|| panic!("missing $defs.runtime_manifest"));
    let preflight = defs
        .get("preflight_manifest")
        .unwrap_or_else(|| panic!("missing $defs.preflight_manifest"));

    let runtime_required = required_keys(runtime, "runtime_manifest");
    for key in [
        "runtime_mode",
        "runtime_mode_taxonomy",
        "runtime_mode_selector",
        "runtime_mode_status",
        "out_wav_materialized",
        "out_wav_bytes",
        "session_summary",
        "jsonl_path",
    ] {
        assert!(
            runtime_required.contains(key),
            "runtime_manifest.required missing `{key}`"
        );
    }

    let preflight_required = required_keys(preflight, "preflight_manifest");
    for key in [
        "schema_version",
        "kind",
        "generated_at_utc",
        "overall_status",
        "config",
        "checks",
    ] {
        assert!(
            preflight_required.contains(key),
            "preflight_manifest.required missing `{key}`"
        );
    }

    let preflight_props = object_field(preflight, "properties", "preflight_manifest");
    let preflight_config = preflight_props
        .get("config")
        .unwrap_or_else(|| panic!("preflight_manifest.properties missing config"));
    let preflight_config_props =
        object_field(preflight_config, "properties", "preflight_manifest.config");
    for key in [
        "runtime_mode",
        "runtime_mode_taxonomy",
        "runtime_mode_selector",
        "runtime_mode_status",
    ] {
        assert!(
            preflight_config_props.contains_key(key),
            "preflight_manifest.config.properties missing `{key}`"
        );
    }
}

#[test]
fn schema_required_fields_match_frozen_manifest_shapes() {
    let schema = read_json("contracts/session-manifest.schema.v1.json");
    let defs = object_field(&schema, "$defs", "session-manifest schema");
    let runtime_schema = defs
        .get("runtime_manifest")
        .unwrap_or_else(|| panic!("missing $defs.runtime_manifest"));
    let preflight_schema = defs
        .get("preflight_manifest")
        .unwrap_or_else(|| panic!("missing $defs.preflight_manifest"));

    let runtime_required = required_keys(runtime_schema, "runtime_manifest");
    let runtime_props = object_field(runtime_schema, "properties", "runtime_manifest");
    let terminal_summary_required = required_keys(
        runtime_props
            .get("terminal_summary")
            .unwrap_or_else(|| panic!("runtime properties missing terminal_summary")),
        "runtime_manifest.properties.terminal_summary",
    );
    let trust_required = required_keys(
        runtime_props
            .get("trust")
            .unwrap_or_else(|| panic!("runtime properties missing trust")),
        "runtime_manifest.properties.trust",
    );
    let session_summary_required = required_keys(
        runtime_props
            .get("session_summary")
            .unwrap_or_else(|| panic!("runtime properties missing session_summary")),
        "runtime_manifest.properties.session_summary",
    );

    for manifest_path in RUNTIME_MANIFESTS {
        let manifest = read_json(manifest_path);
        let context = format!("runtime manifest {}", manifest_path);
        let manifest_obj = object(&manifest, &context);
        for key in &runtime_required {
            assert!(
                manifest_obj.contains_key(key),
                "{context}: missing required top-level key `{key}`"
            );
        }

        let terminal_summary = object_field(&manifest, "terminal_summary", &context);
        for key in &terminal_summary_required {
            assert!(
                terminal_summary.contains_key(key),
                "{context}: terminal_summary missing `{key}`"
            );
        }

        let trust = object_field(&manifest, "trust", &context);
        for key in &trust_required {
            assert!(trust.contains_key(key), "{context}: trust missing `{key}`");
        }

        let session_summary = object_field(&manifest, "session_summary", &context);
        for key in &session_summary_required {
            assert!(
                session_summary.contains_key(key),
                "{context}: session_summary missing `{key}`"
            );
        }
    }

    let preflight = read_json(PREFLIGHT_MANIFEST);
    let preflight_context = format!("preflight manifest {PREFLIGHT_MANIFEST}");
    let preflight_obj = object(&preflight, &preflight_context);
    let preflight_required = required_keys(preflight_schema, "preflight_manifest");
    for key in &preflight_required {
        assert!(
            preflight_obj.contains_key(key),
            "{preflight_context}: missing required key `{key}`"
        );
    }

    let preflight_props = object_field(preflight_schema, "properties", "preflight_manifest");
    let preflight_config_schema = preflight_props
        .get("config")
        .unwrap_or_else(|| panic!("preflight schema missing config"));
    let preflight_config_required = required_keys(preflight_config_schema, "preflight.config");
    let preflight_config = object_field(&preflight, "config", &preflight_context);
    for key in &preflight_config_required {
        assert!(
            preflight_config.contains_key(key),
            "{preflight_context}: config missing required key `{key}`"
        );
    }
}
