use super::*;

const CHECK_ID_MODEL_PATH: &str = "model_path";
const CHECK_ID_MODEL_READABILITY: &str = "model_readability";
const CHECK_ID_OUT_WAV: &str = "out_wav";
const CHECK_ID_OUT_JSONL: &str = "out_jsonl";
const CHECK_ID_OUT_MANIFEST: &str = "out_manifest";
const CHECK_ID_SAMPLE_RATE: &str = "sample_rate";
const CHECK_ID_SCREEN_CAPTURE_ACCESS: &str = "screen_capture_access";
const CHECK_ID_MICROPHONE_ACCESS: &str = "microphone_access";
const CHECK_ID_BACKEND_RUNTIME: &str = "backend_runtime";

#[cfg(test)]
const PREFLIGHT_BLOCKING_CHECK_IDS: [&str; 6] = [
    CHECK_ID_MODEL_PATH,
    CHECK_ID_OUT_WAV,
    CHECK_ID_OUT_JSONL,
    CHECK_ID_OUT_MANIFEST,
    CHECK_ID_SCREEN_CAPTURE_ACCESS,
    CHECK_ID_MICROPHONE_ACCESS,
];

#[cfg(test)]
const PREFLIGHT_WARN_ACK_CHECK_IDS: [&str; 2] = [CHECK_ID_SAMPLE_RATE, CHECK_ID_BACKEND_RUNTIME];

#[cfg(test)]
const MODEL_DOCTOR_DIAGNOSTIC_ONLY_CHECK_IDS: [&str; 1] = [CHECK_ID_MODEL_READABILITY];

#[cfg(test)]
const PREFLIGHT_TCC_CAPTURE_CHECK_IDS: [&str; 2] = [
    CHECK_ID_SCREEN_CAPTURE_ACCESS,
    CHECK_ID_MICROPHONE_ACCESS,
];

#[cfg(test)]
const PREFLIGHT_BACKEND_MODEL_CHECK_IDS: [&str; 1] = [CHECK_ID_MODEL_PATH];

#[cfg(test)]
const PREFLIGHT_RUNTIME_PREFLIGHT_CHECK_IDS: [&str; 4] = [
    CHECK_ID_OUT_WAV,
    CHECK_ID_OUT_JSONL,
    CHECK_ID_OUT_MANIFEST,
    CHECK_ID_SAMPLE_RATE,
];

#[cfg(test)]
const PREFLIGHT_BACKEND_RUNTIME_CHECK_IDS: [&str; 1] = [CHECK_ID_BACKEND_RUNTIME];

pub(super) fn run_model_doctor(config: &TranscribeConfig) -> Result<PreflightReport, CliError> {
    let mut checks = Vec::new();
    checks.push(check_backend_runtime(config.asr_backend));

    match validate_model_path_for_backend(config) {
        Ok(resolved) => {
            let expected_kind = expected_model_kind(config.asr_backend);
            checks.push(PreflightCheck::pass(
                CHECK_ID_MODEL_PATH,
                format!(
                    "model path resolved: {} via {} (expected {expected_kind} for backend {})",
                    display_path(&resolved.path),
                    resolved.source,
                    config.asr_backend,
                ),
            ));
            checks.push(check_model_asset_readability(&resolved));
        }
        Err(err) => {
            checks.push(PreflightCheck::fail(
                CHECK_ID_MODEL_PATH,
                err.to_string(),
                "Pass --asr-model, set RECORDIT_ASR_MODEL, or install the backend default asset in the documented location.",
            ));
            checks.push(PreflightCheck::fail(
                CHECK_ID_MODEL_READABILITY,
                "skipped because model_path did not validate".to_string(),
                "Fix model_path first, then rerun --model-doctor.",
            ));
        }
    }

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(PreflightReport {
        generated_at_utc,
        checks,
    })
}

fn check_model_asset_readability(resolved: &ResolvedModelPath) -> PreflightCheck {
    if resolved.path.is_file() {
        return match File::open(&resolved.path) {
            Ok(_) => PreflightCheck::pass(
                CHECK_ID_MODEL_READABILITY,
                format!("model file is readable: {}", display_path(&resolved.path)),
            ),
            Err(err) => PreflightCheck::fail(
                CHECK_ID_MODEL_READABILITY,
                format!(
                    "cannot read model file {}: {err}",
                    display_path(&resolved.path)
                ),
                "Fix file permissions or pass a different readable model path.",
            ),
        };
    }

    if resolved.path.is_dir() {
        return match fs::read_dir(&resolved.path) {
            Ok(_) => PreflightCheck::pass(
                CHECK_ID_MODEL_READABILITY,
                format!(
                    "model directory is readable: {}",
                    display_path(&resolved.path)
                ),
            ),
            Err(err) => PreflightCheck::fail(
                CHECK_ID_MODEL_READABILITY,
                format!(
                    "cannot read model directory {}: {err}",
                    display_path(&resolved.path)
                ),
                "Fix directory permissions or pass a different readable model path.",
            ),
        };
    }

    PreflightCheck::fail(
        CHECK_ID_MODEL_READABILITY,
        format!(
            "model path is neither a file nor directory: {}",
            display_path(&resolved.path)
        ),
        "Use a readable file/directory path matching backend expectations.",
    )
}

pub(super) fn run_preflight(config: &TranscribeConfig) -> Result<PreflightReport, CliError> {
    let mut checks = Vec::new();
    checks.push(check_model_path(config));
    checks.push(check_output_target(CHECK_ID_OUT_WAV, &config.out_wav));
    checks.push(check_output_target(CHECK_ID_OUT_JSONL, &config.out_jsonl));
    checks.push(check_output_target(
        CHECK_ID_OUT_MANIFEST,
        &config.out_manifest,
    ));
    checks.push(check_sample_rate(config.sample_rate_hz));
    checks.push(check_screen_capture_access());
    checks.push(check_microphone_stream(config.sample_rate_hz));
    checks.push(check_backend_runtime(config.asr_backend));

    let generated_at_utc = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(PreflightReport {
        generated_at_utc,
        checks,
    })
}

fn check_model_path(config: &TranscribeConfig) -> PreflightCheck {
    match validate_model_path_for_backend(config) {
        Ok(resolved) => {
            let expected_kind = expected_model_kind(config.asr_backend);
            PreflightCheck::pass(
                CHECK_ID_MODEL_PATH,
                format!(
                    "model path resolved: {} via {} (expected {expected_kind} for backend {})",
                    display_path(&resolved.path),
                    resolved.source,
                    config.asr_backend,
                ),
            )
        }
        Err(err) => PreflightCheck::fail(
            CHECK_ID_MODEL_PATH,
            err.to_string(),
            "Pass --asr-model, set RECORDIT_ASR_MODEL, or install the backend default asset in the documented location.",
        ),
    }
}

fn check_output_target(id: &'static str, path: &Path) -> PreflightCheck {
    let absolute = display_path(path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    if path.exists() && path.is_dir() {
        return PreflightCheck::fail(
            id,
            format!("target path is a directory: {absolute}"),
            "Provide a file path, not a directory.",
        );
    }

    if let Err(err) = fs::create_dir_all(&parent) {
        return PreflightCheck::fail(
            id,
            format!("cannot create parent directory {}: {err}", parent.display()),
            "Choose an output location in a writable directory.",
        );
    }

    let probe = parent.join(format!(
        ".recordit-preflight-write-{}-{}",
        id,
        std::process::id()
    ));
    match File::create(&probe).and_then(|mut file| file.write_all(b"ok")) {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            PreflightCheck::pass(id, format!("writable output target: {absolute}"))
        }
        Err(err) => PreflightCheck::fail(
            id,
            format!("cannot write under {}: {err}", parent.display()),
            "Choose an output path in a writable directory.",
        ),
    }
}

fn check_sample_rate(sample_rate_hz: u32) -> PreflightCheck {
    if sample_rate_hz == 48_000 {
        return PreflightCheck::pass(CHECK_ID_SAMPLE_RATE, "sample rate is 48000 Hz");
    }

    PreflightCheck::warn(
        CHECK_ID_SAMPLE_RATE,
        format!("non-default sample rate configured: {sample_rate_hz} Hz"),
        "Use --sample-rate 48000 unless you intentionally need a different rate.",
    )
}

fn check_screen_capture_access() -> PreflightCheck {
    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(err) => {
            return PreflightCheck::fail(
                CHECK_ID_SCREEN_CAPTURE_ACCESS,
                format!("failed to query ScreenCaptureKit content: {err}"),
                "Grant Screen Recording permission and ensure at least one active display.",
            );
        }
    };

    let displays = content.displays();
    if displays.is_empty() {
        return PreflightCheck::fail(
            CHECK_ID_SCREEN_CAPTURE_ACCESS,
            "ScreenCaptureKit returned no displays".to_string(),
            "Connect/enable a display and retry. Closed-lid headless mode is unsupported.",
        );
    }

    PreflightCheck::pass(
        CHECK_ID_SCREEN_CAPTURE_ACCESS,
        format!(
            "ScreenCaptureKit access OK; displays available={}",
            displays.len()
        ),
    )
}

fn check_microphone_stream(sample_rate_hz: u32) -> PreflightCheck {
    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(err) => {
            return PreflightCheck::fail(
                CHECK_ID_MICROPHONE_ACCESS,
                format!("cannot initialize microphone preflight (shareable content error): {err}"),
                "Grant Screen Recording first, then rerun preflight.",
            );
        }
    };

    let displays = content.displays();
    if displays.is_empty() {
        return PreflightCheck::fail(
            CHECK_ID_MICROPHONE_ACCESS,
            "cannot run microphone preflight without an active display".to_string(),
            "Connect/enable a display and rerun preflight.",
        );
    }

    let filter = SCContentFilter::create()
        .with_display(&displays[0])
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(false)
        .with_captures_microphone(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(sample_rate_hz as i32)
        .with_channel_count(1);

    let queue = DispatchQueue::new(
        "com.recordit.transcribe.preflight",
        DispatchQoS::UserInteractive,
    );
    let (tx, rx) = sync_channel::<()>(1);

    let mut stream = SCStream::new(&filter, &config);
    let tx_mic = tx.clone();
    if stream
        .add_output_handler_with_queue(
            move |_sample, _kind| {
                let _ = tx_mic.try_send(());
            },
            SCStreamOutputType::Microphone,
            Some(&queue),
        )
        .is_none()
    {
        return PreflightCheck::fail(
            CHECK_ID_MICROPHONE_ACCESS,
            "failed to register microphone output handler".to_string(),
            "Retry preflight; if it persists, restart the app/session.",
        );
    }

    if let Err(err) = stream.start_capture() {
        return PreflightCheck::fail(
            CHECK_ID_MICROPHONE_ACCESS,
            format!("failed to start microphone capture: {err}"),
            "Grant Microphone permission and verify an input device is connected and enabled.",
        );
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut observed_mic = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(_) => {
                observed_mic = true;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let stop_result = stream.stop_capture();
    if let Err(err) = stop_result {
        return PreflightCheck::warn(
            CHECK_ID_MICROPHONE_ACCESS,
            format!("microphone stream started but stop_capture reported: {err}"),
            "Retry preflight; if repeated, restart the app/session.",
        );
    }

    if observed_mic {
        PreflightCheck::pass(
            CHECK_ID_MICROPHONE_ACCESS,
            "observed at least one microphone sample buffer".to_string(),
        )
    } else {
        PreflightCheck::fail(
            CHECK_ID_MICROPHONE_ACCESS,
            "no microphone sample buffer observed within 2s".to_string(),
            "Grant Microphone permission, unmute/select input device, and speak briefly during preflight.",
        )
    }
}

fn check_backend_runtime(backend: AsrBackend) -> PreflightCheck {
    let tool_name = match backend {
        AsrBackend::WhisperCpp => "whisper-cli",
        AsrBackend::WhisperKit => "whisperkit-cli",
        AsrBackend::Moonshine => "moonshine",
    };

    match command_stdout("which", &[tool_name]) {
        Ok(path) => PreflightCheck::pass(
            CHECK_ID_BACKEND_RUNTIME,
            format!("detected backend helper binary `{tool_name}` at {path}"),
        ),
        Err(_) => PreflightCheck::warn(
            CHECK_ID_BACKEND_RUNTIME,
            format!("backend helper binary `{tool_name}` not found in PATH"),
            "Install backend tooling or keep using Rust-native integration once wired.",
        ),
    }
}

pub(super) fn print_preflight_report(report: &PreflightReport) {
    let mut pass_count = 0usize;
    let mut warn_count = 0usize;
    let mut fail_count = 0usize;

    println!("Transcribe-live preflight diagnostics");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  overall_status: {}", report.overall_status());
    println!();
    println!("id\tstatus\tdetail\tremediation");

    for check in &report.checks {
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
        println!(
            "{}\t{}\t{}\t{}",
            check.id,
            check.status,
            clean_field(&check.detail),
            clean_field(check.remediation.as_deref().unwrap_or("-")),
        );
    }

    println!();
    println!(
        "summary\t{}\tpass={}\twarn={}\tfail={}",
        report.overall_status(),
        pass_count,
        warn_count,
        fail_count
    );
}

pub(super) fn print_model_doctor_report(report: &PreflightReport) {
    let mut pass_count = 0usize;
    let mut warn_count = 0usize;
    let mut fail_count = 0usize;

    println!("Transcribe-live model doctor");
    println!("  generated_at_utc: {}", report.generated_at_utc);
    println!("  overall_status: {}", report.overall_status());
    println!();
    println!("id\tstatus\tdetail\tremediation");

    for check in &report.checks {
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
        println!(
            "{}\t{}\t{}\t{}",
            check.id,
            check.status,
            clean_field(&check.detail),
            clean_field(check.remediation.as_deref().unwrap_or("-")),
        );
    }

    println!();
    println!(
        "summary\t{}\tpass={}\twarn={}\tfail={}",
        report.overall_status(),
        pass_count,
        warn_count,
        fail_count
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    fn as_set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn preflight_check_ids_match_readiness_contract() {
        let contract_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("contracts")
            .join("readiness-contract-ids.v1.json");
        let raw = fs::read_to_string(&contract_path).expect("failed to read readiness contract");
        let json: Value =
            serde_json::from_str(&raw).expect("failed to parse readiness contract json");

        let entries = json["preflight_check_ids"]
            .as_array()
            .expect("preflight_check_ids must be an array");

        let mut blocking = BTreeSet::new();
        let mut warn_ack = BTreeSet::new();
        let mut tcc_capture = BTreeSet::new();
        let mut backend_model = BTreeSet::new();
        let mut runtime_preflight = BTreeSet::new();
        let mut backend_runtime = BTreeSet::new();
        for entry in entries {
            let id = entry["id"]
                .as_str()
                .expect("preflight_check_ids[].id must be a string")
                .to_string();
            let class = entry["class"]
                .as_str()
                .expect("preflight_check_ids[].class must be a string");
            match class {
                "blocking" => {
                    blocking.insert(id.clone());
                }
                "warn_ack_required" => {
                    warn_ack.insert(id.clone());
                }
                other => {
                    assert_eq!(
                        other, "warn_ack_required",
                        "unexpected readiness class in contract"
                    );
                }
            }

            let domain = entry["domain"]
                .as_str()
                .expect("preflight_check_ids[].domain must be a string");
            match domain {
                "tcc_capture" => {
                    tcc_capture.insert(id.clone());
                }
                "backend_model" => {
                    backend_model.insert(id.clone());
                }
                "runtime_preflight" => {
                    runtime_preflight.insert(id.clone());
                }
                "backend_runtime" => {
                    backend_runtime.insert(id.clone());
                }
                other => {
                    assert!(false, "unexpected readiness domain in contract: {other}");
                }
            }
        }

        assert_eq!(blocking, as_set(&PREFLIGHT_BLOCKING_CHECK_IDS));
        assert_eq!(warn_ack, as_set(&PREFLIGHT_WARN_ACK_CHECK_IDS));
        assert_eq!(tcc_capture, as_set(&PREFLIGHT_TCC_CAPTURE_CHECK_IDS));
        assert_eq!(backend_model, as_set(&PREFLIGHT_BACKEND_MODEL_CHECK_IDS));
        assert_eq!(
            runtime_preflight,
            as_set(&PREFLIGHT_RUNTIME_PREFLIGHT_CHECK_IDS)
        );
        assert_eq!(
            backend_runtime,
            as_set(&PREFLIGHT_BACKEND_RUNTIME_CHECK_IDS)
        );

        let diagnostic_entries = json["diagnostic_only_check_ids"]
            .as_array()
            .expect("diagnostic_only_check_ids must be an array");
        let mut diagnostic_only = BTreeSet::new();
        for entry in diagnostic_entries {
            let id = entry["id"]
                .as_str()
                .expect("diagnostic_only_check_ids[].id must be a string")
                .to_string();
            let domain = entry["domain"]
                .as_str()
                .expect("diagnostic_only_check_ids[].domain must be a string");
            assert_eq!(domain, "diagnostic_only");
            diagnostic_only.insert(id);
        }
        assert_eq!(
            diagnostic_only,
            as_set(&MODEL_DOCTOR_DIAGNOSTIC_ONLY_CHECK_IDS)
        );
    }

    #[test]
    fn diagnostic_only_model_doctor_check_ids_do_not_overlap_live_gating_ids() {
        let blocking = as_set(&PREFLIGHT_BLOCKING_CHECK_IDS);
        let warn_ack = as_set(&PREFLIGHT_WARN_ACK_CHECK_IDS);
        let diagnostic = as_set(&MODEL_DOCTOR_DIAGNOSTIC_ONLY_CHECK_IDS);

        assert!(blocking.is_disjoint(&diagnostic));
        assert!(warn_ack.is_disjoint(&diagnostic));
    }

    fn scenario_report(checks: Vec<(&'static str, CheckStatus)>) -> PreflightReport {
        PreflightReport {
            generated_at_utc: "2026-03-07T00:00:00Z".to_string(),
            checks: checks
                .into_iter()
                .map(|(id, status)| match status {
                    CheckStatus::Pass => PreflightCheck::pass(id, format!("{id} check passed")),
                    CheckStatus::Warn => PreflightCheck::warn(
                        id,
                        format!("{id} check warned"),
                        format!("{id} remediation guidance"),
                    ),
                    CheckStatus::Fail => PreflightCheck::fail(
                        id,
                        format!("{id} check failed"),
                        format!("{id} remediation guidance"),
                    ),
                })
                .collect(),
        }
    }

    fn all_check_ids_pass() -> Vec<(&'static str, CheckStatus)> {
        vec![
            ("model_path", CheckStatus::Pass),
            ("out_wav", CheckStatus::Pass),
            ("out_jsonl", CheckStatus::Pass),
            ("out_manifest", CheckStatus::Pass),
            ("sample_rate", CheckStatus::Pass),
            ("screen_capture_access", CheckStatus::Pass),
            ("microphone_access", CheckStatus::Pass),
            ("backend_runtime", CheckStatus::Pass),
        ]
    }

    fn with_override(
        mut checks: Vec<(&'static str, CheckStatus)>,
        id: &'static str,
        status: CheckStatus,
    ) -> Vec<(&'static str, CheckStatus)> {
        for entry in &mut checks {
            if entry.0 == id {
                entry.1 = status;
                return checks;
            }
        }
        checks.push((id, status));
        checks
    }

    #[test]
    fn all_pass_scenario_reports_pass_overall_with_no_remediation() {
        let report = scenario_report(all_check_ids_pass());
        assert!(
            matches!(report.overall_status(), CheckStatus::Pass),
            "all-pass scenario should report overall Pass"
        );
        for check in &report.checks {
            assert!(
                matches!(check.status, CheckStatus::Pass),
                "check {} should be Pass",
                check.id
            );
            assert!(
                check.remediation.is_none(),
                "pass check {} should carry no remediation",
                check.id
            );
        }
    }

    #[test]
    fn model_path_fail_produces_overall_fail_with_remediation() {
        let checks = with_override(all_check_ids_pass(), "model_path", CheckStatus::Fail);
        let report = scenario_report(checks);
        assert!(
            matches!(report.overall_status(), CheckStatus::Fail),
            "model_path failure should produce overall Fail"
        );

        let model_check = report.checks.iter().find(|c| c.id == "model_path").unwrap();
        assert!(matches!(model_check.status, CheckStatus::Fail));
        assert!(
            model_check.remediation.is_some(),
            "model_path failure should carry remediation text"
        );

        assert!(
            PREFLIGHT_BACKEND_MODEL_CHECK_IDS.contains(&"model_path"),
            "model_path must belong to the backend_model domain"
        );
    }

    #[test]
    fn screen_capture_fail_blocks_with_tcc_capture_domain() {
        let checks = with_override(
            all_check_ids_pass(),
            "screen_capture_access",
            CheckStatus::Fail,
        );
        let report = scenario_report(checks);
        assert!(
            matches!(report.overall_status(), CheckStatus::Fail),
            "screen_capture_access failure should produce overall Fail"
        );

        let screen_check = report
            .checks
            .iter()
            .find(|c| c.id == "screen_capture_access")
            .unwrap();
        assert!(matches!(screen_check.status, CheckStatus::Fail));
        assert!(screen_check.remediation.is_some());

        assert!(
            PREFLIGHT_TCC_CAPTURE_CHECK_IDS.contains(&"screen_capture_access"),
            "screen_capture_access must belong to the tcc_capture domain"
        );
        assert!(
            PREFLIGHT_BLOCKING_CHECK_IDS.contains(&"screen_capture_access"),
            "screen_capture_access must be a blocking check"
        );
    }

    #[test]
    fn sample_rate_warn_produces_overall_warn_with_ack_required() {
        let checks = with_override(all_check_ids_pass(), "sample_rate", CheckStatus::Warn);
        let report = scenario_report(checks);
        assert!(
            matches!(report.overall_status(), CheckStatus::Warn),
            "sample_rate warning should produce overall Warn, not Fail"
        );

        let rate_check = report
            .checks
            .iter()
            .find(|c| c.id == "sample_rate")
            .unwrap();
        assert!(matches!(rate_check.status, CheckStatus::Warn));
        assert!(
            rate_check.remediation.is_some(),
            "sample_rate warning should carry remediation"
        );

        assert!(
            PREFLIGHT_WARN_ACK_CHECK_IDS.contains(&"sample_rate"),
            "sample_rate must be in the warn_ack class"
        );
        assert!(
            PREFLIGHT_RUNTIME_PREFLIGHT_CHECK_IDS.contains(&"sample_rate"),
            "sample_rate must belong to the runtime_preflight domain"
        );
    }

    #[test]
    fn backend_runtime_warn_produces_warn_with_remediation() {
        let checks = with_override(all_check_ids_pass(), "backend_runtime", CheckStatus::Warn);
        let report = scenario_report(checks);
        assert!(
            matches!(report.overall_status(), CheckStatus::Warn),
            "backend_runtime warning should produce overall Warn"
        );

        let backend_check = report
            .checks
            .iter()
            .find(|c| c.id == "backend_runtime")
            .unwrap();
        assert!(matches!(backend_check.status, CheckStatus::Warn));
        assert!(backend_check.remediation.is_some());

        assert!(
            PREFLIGHT_WARN_ACK_CHECK_IDS.contains(&"backend_runtime"),
            "backend_runtime must be in the warn_ack class"
        );
        assert!(
            PREFLIGHT_BACKEND_RUNTIME_CHECK_IDS.contains(&"backend_runtime"),
            "backend_runtime must belong to the backend_runtime domain"
        );
    }

    #[test]
    fn mixed_fail_and_warn_produces_overall_fail() {
        let checks = with_override(
            with_override(all_check_ids_pass(), "model_path", CheckStatus::Fail),
            "sample_rate",
            CheckStatus::Warn,
        );
        let report = scenario_report(checks);
        assert!(
            matches!(report.overall_status(), CheckStatus::Fail),
            "Fail + Warn should produce overall Fail (Fail dominates)"
        );

        let model_check = report.checks.iter().find(|c| c.id == "model_path").unwrap();
        assert!(model_check.remediation.is_some());
        let rate_check = report
            .checks
            .iter()
            .find(|c| c.id == "sample_rate")
            .unwrap();
        assert!(rate_check.remediation.is_some());
    }

    #[test]
    fn each_check_id_has_stable_domain_classification() {
        let all_domain_ids: Vec<&str> = PREFLIGHT_TCC_CAPTURE_CHECK_IDS
            .iter()
            .chain(PREFLIGHT_BACKEND_MODEL_CHECK_IDS.iter())
            .chain(PREFLIGHT_RUNTIME_PREFLIGHT_CHECK_IDS.iter())
            .chain(PREFLIGHT_BACKEND_RUNTIME_CHECK_IDS.iter())
            .copied()
            .collect();

        let blocking_and_warn: Vec<&str> = PREFLIGHT_BLOCKING_CHECK_IDS
            .iter()
            .chain(PREFLIGHT_WARN_ACK_CHECK_IDS.iter())
            .copied()
            .collect();

        for id in &blocking_and_warn {
            let domain_count = all_domain_ids.iter().filter(|d| d == &id).count();
            assert_eq!(
                domain_count, 1,
                "check ID {id} should appear in exactly one domain, found {domain_count}"
            );
        }

        let all_gating = as_set(&blocking_and_warn);
        let all_domains = as_set(&all_domain_ids);
        assert_eq!(
            all_gating, all_domains,
            "gating check ID set must equal the union of all domain ID sets"
        );
    }
}
