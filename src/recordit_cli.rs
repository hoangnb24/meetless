use std::env;
use std::fmt::{self, Display};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

#[cfg(not(test))]
#[path = "bin/transcribe_live/app.rs"]
mod transcribe_live_app;

#[cfg(test)]
mod transcribe_live_app {
    use std::process::ExitCode;

    #[allow(dead_code)]
    pub(crate) fn run_with_args(args: impl Iterator<Item = String>) -> ExitCode {
        let _ = args.collect::<Vec<_>>();
        ExitCode::SUCCESS
    }

    pub(crate) fn run_with_args_in_operator_mode(
        args: impl Iterator<Item = String>,
        _concise_operator_mode: bool,
    ) -> ExitCode {
        let _ = args.collect::<Vec<_>>();
        ExitCode::SUCCESS
    }
}

const HELP_TEXT: &str = "\
recordit

Human-first operator CLI for recordit.

Usage:
  recordit run --mode <live|offline> [mode options] [shared options]
  recordit doctor [doctor options]
  recordit preflight [preflight options]
  recordit replay --jsonl <path> [--format <text|json>]
  recordit inspect-contract <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes> [--format json]
  recordit -h | --help

Commands:
  run               Start a live or offline transcription run
  doctor            Validate model/backend readiness without a full run
  preflight         Validate the next requested run configuration
  replay            Replay a prior runtime JSONL artifact
  inspect-contract  Print canonical CLI/runtime contract payloads

Run:
  --mode <live|offline>   Required mode selector
  --input-wav <path>      Required for --mode offline, forbidden for --mode live
  --duration-sec <n>      Optional runtime cap in seconds; omitted in live mode means run until interrupted
  --output-root <path>    Optional session root; defaults to artifacts/sessions/<date>/<timestamp>-<mode>/
  --profile <profile>     Maps to transcribe-live --asr-profile
  --language <tag>        Maps to transcribe-live --asr-language
  --model <path-or-id>    Maps to transcribe-live --asr-model
  --json                  Append a machine-readable summary envelope after command execution

Doctor:
  --model <path-or-id>
  --backend <auto|whispercpp|whisperkit|moonshine>
  --json

Preflight:
  --mode <live|offline>
  --input-wav <path>
  --output-root <path>
  --json

Replay:
  --jsonl <path>
  --format <text|json>    Default: text

Inspect-Contract:
  <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes>
  --format json           Default: text
";

const CLI_CONTRACT_DOC: &str = "docs/recordit-cli-grammar-contract.md";
const JSONL_SCHEMA_PATH: &str = "contracts/runtime-jsonl.schema.v1.json";
const MANIFEST_SCHEMA_PATH: &str = "contracts/session-manifest.schema.v1.json";
const EXIT_CODE_CONTRACT_PATH: &str = "contracts/recordit-exit-code-contract.v1.json";

pub(crate) fn main() -> ExitCode {
    run_from_args(env::args().skip(1))
}

fn run_from_args(args: impl Iterator<Item = String>) -> ExitCode {
    match parse_command(args) {
        Ok(RecorditCommand::Help) => {
            println!("{HELP_TEXT}");
            ExitCode::SUCCESS
        }
        Ok(command) => dispatch_command(command),
        Err(err) => {
            eprintln!("error: {err}");
            eprintln!();
            eprintln!("Run `recordit --help` to see the canonical operator contract.");
            print_failed_status_hint(
                "run `recordit --help` or use `recordit run --mode live|offline`.",
            );
            ExitCode::from(2)
        }
    }
}

#[derive(Debug)]
struct CliError {
    message: String,
}

impl CliError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunMode {
    Live,
    Offline,
}

impl RunMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Offline => "offline",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContractName {
    Cli,
    RuntimeModes,
    JsonlSchema,
    ManifestSchema,
    ExitCodes,
}

#[derive(Debug, Clone)]
struct RunCommand {
    mode: RunMode,
    input_wav: Option<PathBuf>,
    duration_sec: Option<u64>,
    output_root: Option<PathBuf>,
    profile: Option<String>,
    language: Option<String>,
    model: Option<String>,
    json_output: bool,
}

#[derive(Debug, Clone)]
struct DoctorCommand {
    model: Option<String>,
    backend: Option<String>,
    json_output: bool,
}

#[derive(Debug, Clone)]
struct PreflightCommand {
    mode: RunMode,
    input_wav: Option<PathBuf>,
    output_root: Option<PathBuf>,
    json_output: bool,
}

#[derive(Debug, Clone)]
struct ReplayCommand {
    jsonl: PathBuf,
    format: OutputFormat,
}

#[derive(Debug, Clone)]
struct InspectContractCommand {
    name: ContractName,
    format: OutputFormat,
}

#[derive(Debug, Clone)]
enum RecorditCommand {
    Help,
    Run(RunCommand),
    Doctor(DoctorCommand),
    Preflight(PreflightCommand),
    Replay(ReplayCommand),
    InspectContract(InspectContractCommand),
}

#[derive(Debug, Clone)]
struct SessionPaths {
    root: PathBuf,
    input_wav: PathBuf,
    wav: PathBuf,
    jsonl: PathBuf,
    manifest: PathBuf,
}

#[derive(Debug, Clone)]
struct MappedInvocation {
    legacy_args: Vec<String>,
    command: &'static str,
    mode: Option<RunMode>,
    json_output: bool,
    session: Option<SessionPaths>,
}

fn parse_command(args: impl Iterator<Item = String>) -> Result<RecorditCommand, CliError> {
    let mut args = args.peekable();
    let Some(first) = args.next() else {
        return Ok(RecorditCommand::Help);
    };

    match first.as_str() {
        "-h" | "--help" => Ok(RecorditCommand::Help),
        "run" => parse_run_command(args),
        "doctor" => parse_doctor_command(args),
        "preflight" => parse_preflight_command(args),
        "replay" => parse_replay_command(args),
        "inspect-contract" => parse_inspect_contract_command(args),
        other => Err(CliError::new(format!(
            "unknown command `{other}`; expected `run`, `doctor`, `preflight`, `replay`, or `inspect-contract`"
        ))),
    }
}

fn parse_run_command(mut args: impl Iterator<Item = String>) -> Result<RecorditCommand, CliError> {
    let mut mode = None;
    let mut input_wav = None;
    let mut duration_sec = None;
    let mut output_root = None;
    let mut profile = None;
    let mut language = None;
    let mut model = None;
    let mut json_output = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(RecorditCommand::Help),
            "--mode" => {
                let value = read_value(&mut args, "--mode")?;
                mode = Some(parse_run_mode(&value)?);
            }
            "--input-wav" => {
                input_wav = Some(PathBuf::from(read_value(&mut args, "--input-wav")?));
            }
            "--duration-sec" => {
                let value = parse_u64(&read_value(&mut args, "--duration-sec")?, "--duration-sec")?;
                if value == 0 {
                    return Err(CliError::new(
                        "`recordit run --duration-sec` must be greater than zero; omit the flag in live mode to run until interrupted",
                    ));
                }
                duration_sec = Some(value);
            }
            "--output-root" => {
                output_root = Some(PathBuf::from(read_value(&mut args, "--output-root")?));
            }
            "--profile" => {
                profile = Some(read_value(&mut args, "--profile")?);
            }
            "--language" => {
                language = Some(read_value(&mut args, "--language")?);
            }
            "--model" => {
                model = Some(read_value(&mut args, "--model")?);
            }
            "--json" => {
                json_output = true;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown `recordit run` option `{arg}`"
                )));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}` for `recordit run`"
                )));
            }
        }
    }

    let mode =
        mode.ok_or_else(|| CliError::new("`recordit run` requires `--mode <live|offline>`"))?;
    match mode {
        RunMode::Live if input_wav.is_some() => {
            return Err(CliError::new(
                "`recordit run --mode live` does not accept `--input-wav`; live mode owns capture input materialization",
            ));
        }
        RunMode::Offline if input_wav.is_none() => {
            return Err(CliError::new(
                "`recordit run --mode offline` requires `--input-wav <path>`",
            ));
        }
        _ => {}
    }

    Ok(RecorditCommand::Run(RunCommand {
        mode,
        input_wav,
        duration_sec,
        output_root,
        profile,
        language,
        model,
        json_output,
    }))
}

fn parse_doctor_command(
    mut args: impl Iterator<Item = String>,
) -> Result<RecorditCommand, CliError> {
    let mut model = None;
    let mut backend = None;
    let mut json_output = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(RecorditCommand::Help),
            "--model" => {
                model = Some(read_value(&mut args, "--model")?);
            }
            "--backend" => {
                let value = read_value(&mut args, "--backend")?;
                match value.as_str() {
                    "auto" | "whispercpp" | "whisperkit" | "moonshine" => backend = Some(value),
                    _ => {
                        return Err(CliError::new(format!(
                            "unsupported `recordit doctor --backend` value `{value}`; expected `auto`, `whispercpp`, `whisperkit`, or `moonshine`"
                        )));
                    }
                }
            }
            "--json" => {
                json_output = true;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown `recordit doctor` option `{arg}`"
                )));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}` for `recordit doctor`"
                )));
            }
        }
    }

    Ok(RecorditCommand::Doctor(DoctorCommand {
        model,
        backend,
        json_output,
    }))
}

fn parse_preflight_command(
    mut args: impl Iterator<Item = String>,
) -> Result<RecorditCommand, CliError> {
    let mut mode = RunMode::Live;
    let mut input_wav = None;
    let mut output_root = None;
    let mut json_output = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(RecorditCommand::Help),
            "--mode" => {
                mode = parse_run_mode(&read_value(&mut args, "--mode")?)?;
            }
            "--input-wav" => {
                input_wav = Some(PathBuf::from(read_value(&mut args, "--input-wav")?));
            }
            "--output-root" => {
                output_root = Some(PathBuf::from(read_value(&mut args, "--output-root")?));
            }
            "--json" => {
                json_output = true;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown `recordit preflight` option `{arg}`"
                )));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}` for `recordit preflight`"
                )));
            }
        }
    }

    if mode == RunMode::Live && input_wav.is_some() {
        return Err(CliError::new(
            "`recordit preflight --mode live` does not accept `--input-wav`; live mode derives capture input from the session root",
        ));
    }

    Ok(RecorditCommand::Preflight(PreflightCommand {
        mode,
        input_wav,
        output_root,
        json_output,
    }))
}

fn parse_replay_command(
    mut args: impl Iterator<Item = String>,
) -> Result<RecorditCommand, CliError> {
    let mut jsonl = None;
    let mut format = OutputFormat::Text;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(RecorditCommand::Help),
            "--jsonl" => {
                jsonl = Some(PathBuf::from(read_value(&mut args, "--jsonl")?));
            }
            "--format" => {
                format = parse_output_format(&read_value(&mut args, "--format")?)?;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown `recordit replay` option `{arg}`"
                )));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}` for `recordit replay`"
                )));
            }
        }
    }

    Ok(RecorditCommand::Replay(ReplayCommand {
        jsonl: jsonl.ok_or_else(|| CliError::new("`recordit replay` requires `--jsonl <path>`"))?,
        format,
    }))
}

fn parse_inspect_contract_command(
    mut args: impl Iterator<Item = String>,
) -> Result<RecorditCommand, CliError> {
    let Some(name) = args.next() else {
        return Err(CliError::new(
            "`recordit inspect-contract` requires one of `cli`, `runtime-modes`, `jsonl-schema`, `manifest-schema`, or `exit-codes`",
        ));
    };

    let name = match name.as_str() {
        "cli" => ContractName::Cli,
        "runtime-modes" => ContractName::RuntimeModes,
        "jsonl-schema" => ContractName::JsonlSchema,
        "manifest-schema" => ContractName::ManifestSchema,
        "exit-codes" => ContractName::ExitCodes,
        _ => {
            return Err(CliError::new(format!(
                "unsupported contract `{name}`; expected `cli`, `runtime-modes`, `jsonl-schema`, `manifest-schema`, or `exit-codes`"
            )));
        }
    };

    let mut format = OutputFormat::Text;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(RecorditCommand::Help),
            "--format" => {
                format = parse_output_format(&read_value(&mut args, "--format")?)?;
            }
            _ if arg.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown `recordit inspect-contract` option `{arg}`"
                )));
            }
            _ => {
                return Err(CliError::new(format!(
                    "unexpected positional argument `{arg}` for `recordit inspect-contract`"
                )));
            }
        }
    }

    Ok(RecorditCommand::InspectContract(InspectContractCommand {
        name,
        format,
    }))
}

fn parse_run_mode(value: &str) -> Result<RunMode, CliError> {
    match value {
        "live" => Ok(RunMode::Live),
        "offline" => Ok(RunMode::Offline),
        _ => Err(CliError::new(format!(
            "unsupported `--mode` value `{value}`; expected `live` or `offline`"
        ))),
    }
}

fn parse_output_format(value: &str) -> Result<OutputFormat, CliError> {
    match value {
        "text" => Ok(OutputFormat::Text),
        "json" => Ok(OutputFormat::Json),
        _ => Err(CliError::new(format!(
            "unsupported `--format` value `{value}`; expected `text` or `json`"
        ))),
    }
}

fn parse_u64(value: &str, flag: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| CliError::new(format!("`{flag}` expects an integer, got `{value}`")))
}

fn read_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, CliError> {
    args.next()
        .ok_or_else(|| CliError::new(format!("`{flag}` requires a value")))
}

fn print_failed_status_hint(remediation_hint: &str) {
    eprintln!("run_status=failed");
    eprintln!("remediation_hint={remediation_hint}");
}

fn dispatch_command(command: RecorditCommand) -> ExitCode {
    match command {
        RecorditCommand::Help => {
            println!("{HELP_TEXT}");
            ExitCode::SUCCESS
        }
        RecorditCommand::Run(command) => match map_run_command(&command) {
            Ok(invocation) => dispatch_transcribe_live(invocation),
            Err(err) => {
                eprintln!("error: {err}");
                print_failed_status_hint(
                    "for offline mode pass `--input-wav <path>`; for live mode omit `--input-wav`.",
                );
                ExitCode::from(2)
            }
        },
        RecorditCommand::Doctor(command) => {
            let invocation = map_doctor_command(&command);
            dispatch_transcribe_live(invocation)
        }
        RecorditCommand::Preflight(command) => match map_preflight_command(&command) {
            Ok(invocation) => dispatch_transcribe_live(invocation),
            Err(err) => {
                eprintln!("error: {err}");
                print_failed_status_hint(
                    "rerun `recordit preflight --mode live` or provide a valid offline `--input-wav` path.",
                );
                ExitCode::from(2)
            }
        },
        RecorditCommand::Replay(command) => dispatch_replay_command(&command),
        RecorditCommand::InspectContract(command) => {
            print_contract(command);
            ExitCode::SUCCESS
        }
    }
}

fn dispatch_transcribe_live(invocation: MappedInvocation) -> ExitCode {
    let exit_code = transcribe_live_app::run_with_args_in_operator_mode(
        invocation.legacy_args.clone().into_iter(),
        true,
    );
    if invocation.json_output {
        println!("{}", invocation_summary_json(&invocation, exit_code));
    }
    exit_code
}

fn map_run_command(command: &RunCommand) -> Result<MappedInvocation, CliError> {
    let session = session_paths(command.output_root.clone(), command.mode)?;
    fs::create_dir_all(&session.root).map_err(|err| {
        CliError::new(format!(
            "failed to create session root {}: {err}",
            session.root.display()
        ))
    })?;

    let mut legacy_args = vec![
        "--out-wav".to_string(),
        session.wav.display().to_string(),
        "--out-jsonl".to_string(),
        session.jsonl.display().to_string(),
        "--out-manifest".to_string(),
        session.manifest.display().to_string(),
    ];

    match command.mode {
        RunMode::Live => {
            legacy_args.push("--live-stream".to_string());
            legacy_args.push("--input-wav".to_string());
            legacy_args.push(session.input_wav.display().to_string());
            let duration_sec = command.duration_sec.unwrap_or(0);
            legacy_args.push("--duration-sec".to_string());
            legacy_args.push(duration_sec.to_string());
        }
        RunMode::Offline => {
            legacy_args.push("--input-wav".to_string());
            legacy_args.push(
                command
                    .input_wav
                    .as_ref()
                    .expect("offline input should be validated")
                    .display()
                    .to_string(),
            );
            if let Some(duration_sec) = command.duration_sec {
                legacy_args.push("--duration-sec".to_string());
                legacy_args.push(duration_sec.to_string());
            }
        }
    }

    append_shared_runtime_args(
        &mut legacy_args,
        command.profile.as_deref(),
        command.language.as_deref(),
        command.model.as_deref(),
    );

    Ok(MappedInvocation {
        legacy_args,
        command: "run",
        mode: Some(command.mode),
        json_output: command.json_output,
        session: Some(session),
    })
}

fn map_doctor_command(command: &DoctorCommand) -> MappedInvocation {
    let mut legacy_args = vec!["--model-doctor".to_string()];
    if let Some(backend) = command.backend.as_deref()
        && backend != "auto"
    {
        legacy_args.push("--asr-backend".to_string());
        legacy_args.push(backend.to_string());
    }
    if let Some(model) = command.model.as_deref() {
        legacy_args.push("--asr-model".to_string());
        legacy_args.push(model.to_string());
    }

    MappedInvocation {
        legacy_args,
        command: "doctor",
        mode: None,
        json_output: command.json_output,
        session: None,
    }
}

fn map_preflight_command(command: &PreflightCommand) -> Result<MappedInvocation, CliError> {
    let session = session_paths(command.output_root.clone(), command.mode)?;
    fs::create_dir_all(&session.root).map_err(|err| {
        CliError::new(format!(
            "failed to create preflight session root {}: {err}",
            session.root.display()
        ))
    })?;

    let mut legacy_args = vec![
        "--preflight".to_string(),
        "--out-wav".to_string(),
        session.wav.display().to_string(),
        "--out-jsonl".to_string(),
        session.jsonl.display().to_string(),
        "--out-manifest".to_string(),
        session.manifest.display().to_string(),
    ];

    match command.mode {
        RunMode::Live => {
            legacy_args.push("--live-stream".to_string());
            legacy_args.push("--input-wav".to_string());
            legacy_args.push(session.input_wav.display().to_string());
        }
        RunMode::Offline => {
            if let Some(input_wav) = &command.input_wav {
                legacy_args.push("--input-wav".to_string());
                legacy_args.push(input_wav.display().to_string());
            }
        }
    }

    Ok(MappedInvocation {
        legacy_args,
        command: "preflight",
        mode: Some(command.mode),
        json_output: command.json_output,
        session: Some(session),
    })
}

fn append_shared_runtime_args(
    legacy_args: &mut Vec<String>,
    profile: Option<&str>,
    language: Option<&str>,
    model: Option<&str>,
) {
    if let Some(profile) = profile {
        legacy_args.push("--asr-profile".to_string());
        legacy_args.push(profile.to_string());
    }
    if let Some(language) = language {
        legacy_args.push("--asr-language".to_string());
        legacy_args.push(language.to_string());
    }
    if let Some(model) = model {
        legacy_args.push("--asr-model".to_string());
        legacy_args.push(model.to_string());
    }
}

fn dispatch_replay_command(command: &ReplayCommand) -> ExitCode {
    match command.format {
        OutputFormat::Text => {
            let invocation = MappedInvocation {
                legacy_args: vec![
                    "--replay-jsonl".to_string(),
                    command.jsonl.display().to_string(),
                ],
                command: "replay",
                mode: None,
                json_output: false,
                session: None,
            };
            dispatch_transcribe_live(invocation)
        }
        OutputFormat::Json => match fs::read_to_string(&command.jsonl) {
            Ok(body) => {
                let rows = body
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .collect::<Vec<_>>();
                println!(
                    "{{\"command\":\"replay\",\"format\":\"json\",\"jsonl_path\":\"{}\",\"events\":[{}]}}",
                    json_escape(&display_path(&command.jsonl)),
                    rows.join(",")
                );
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!(
                    "error: failed to read replay JSONL {}: {err}",
                    command.jsonl.display()
                );
                print_failed_status_hint(
                    "verify `--jsonl` points to a readable file, then rerun `recordit replay`.",
                );
                ExitCode::from(2)
            }
        },
    }
}

fn print_contract(command: InspectContractCommand) {
    match command.format {
        OutputFormat::Text => print_contract_text(command.name),
        OutputFormat::Json => println!("{}", contract_json(command.name)),
    }
}

fn print_contract_text(name: ContractName) {
    match name {
        ContractName::Cli => {
            println!("contract: cli");
            println!("source: {CLI_CONTRACT_DOC}");
            println!("grammar:");
            println!("  recordit run --mode <live|offline> [mode options] [shared options]");
            println!("  recordit doctor [doctor options]");
            println!("  recordit preflight [preflight options]");
            println!("  recordit replay --jsonl <path> [--format <text|json>]");
            println!(
                "  recordit inspect-contract <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes> [--format json]"
            );
        }
        ContractName::RuntimeModes => {
            println!("contract: runtime-modes");
            println!("source: {CLI_CONTRACT_DOC}");
            println!("modes:");
            println!("  live -> transcribe-live --live-stream -> runtime_mode=live-stream");
            println!(
                "  offline -> transcribe-live default runtime -> runtime_mode=representative-offline"
            );
        }
        ContractName::JsonlSchema => {
            println!("contract: jsonl-schema");
            println!("source: {JSONL_SCHEMA_PATH}");
            println!("published: {}", Path::new(JSONL_SCHEMA_PATH).is_file());
        }
        ContractName::ManifestSchema => {
            println!("contract: manifest-schema");
            println!("source: {MANIFEST_SCHEMA_PATH}");
            println!("published: {}", Path::new(MANIFEST_SCHEMA_PATH).is_file());
        }
        ContractName::ExitCodes => {
            println!("contract: exit-codes");
            println!("source: {EXIT_CODE_CONTRACT_PATH}");
            println!(
                "published: {}",
                Path::new(EXIT_CODE_CONTRACT_PATH).is_file()
            );
        }
    }
}

fn contract_json(name: ContractName) -> String {
    match name {
        ContractName::Cli => format!(
            "{{\"contract\":\"cli\",\"published\":true,\"source\":\"{}\",\"grammar\":[\"recordit run --mode <live|offline> [mode options] [shared options]\",\"recordit doctor [doctor options]\",\"recordit preflight [preflight options]\",\"recordit replay --jsonl <path> [--format <text|json>]\",\"recordit inspect-contract <cli|runtime-modes|jsonl-schema|manifest-schema|exit-codes> [--format json]\"]}}",
            json_escape(CLI_CONTRACT_DOC)
        ),
        ContractName::RuntimeModes => "{\"contract\":\"runtime-modes\",\"published\":true,\"source\":\"docs/recordit-cli-grammar-contract.md\",\"modes\":[{\"mode\":\"live\",\"transcribe_live_selector\":\"--live-stream\",\"runtime_mode\":\"live-stream\",\"runtime_mode_taxonomy\":\"live-stream\",\"status\":\"implemented\"},{\"mode\":\"offline\",\"transcribe_live_selector\":\"<default>\",\"runtime_mode\":\"representative-offline\",\"runtime_mode_taxonomy\":\"representative-offline\",\"status\":\"implemented\"}]}".to_string(),
        ContractName::JsonlSchema => contract_artifact_json("jsonl-schema", JSONL_SCHEMA_PATH),
        ContractName::ManifestSchema => {
            contract_artifact_json("manifest-schema", MANIFEST_SCHEMA_PATH)
        }
        ContractName::ExitCodes => contract_artifact_json("exit-codes", EXIT_CODE_CONTRACT_PATH),
    }
}

fn contract_artifact_json(contract: &str, path: &str) -> String {
    match fs::read_to_string(path) {
        Ok(body) => body,
        Err(err) => format!(
            "{{\"contract\":\"{}\",\"published\":false,\"source\":\"{}\",\"error\":\"{}\"}}",
            json_escape(contract),
            json_escape(path),
            json_escape(&err.to_string())
        ),
    }
}

fn invocation_summary_json(invocation: &MappedInvocation, exit_code: ExitCode) -> String {
    let code = if exit_code == ExitCode::SUCCESS { 0 } else { 2 };
    let mode = invocation
        .mode
        .map(|mode| format!("\"{}\"", mode.as_str()))
        .unwrap_or_else(|| "null".to_string());
    let legacy_args = invocation
        .legacy_args
        .iter()
        .map(|arg| format!("\"{}\"", json_escape(arg)))
        .collect::<Vec<_>>()
        .join(",");
    let session = invocation
        .session
        .as_ref()
        .map(session_paths_json)
        .unwrap_or_else(|| "null".to_string());
    format!(
        "{{\"command\":\"{}\",\"mode\":{},\"exit_code\":{},\"legacy_args\":[{}],\"session\":{}}}",
        invocation.command, mode, code, legacy_args, session
    )
}

fn session_paths_json(session: &SessionPaths) -> String {
    format!(
        "{{\"root\":\"{}\",\"input_wav\":\"{}\",\"wav\":\"{}\",\"jsonl\":\"{}\",\"manifest\":\"{}\"}}",
        json_escape(&display_path(&session.root)),
        json_escape(&display_path(&session.input_wav)),
        json_escape(&display_path(&session.wav)),
        json_escape(&display_path(&session.jsonl)),
        json_escape(&display_path(&session.manifest)),
    )
}

fn session_paths(output_root: Option<PathBuf>, mode: RunMode) -> Result<SessionPaths, CliError> {
    let root = match output_root {
        Some(root) => root,
        None => default_session_root(mode)?,
    };

    Ok(SessionPaths {
        input_wav: root.join("session.input.wav"),
        wav: root.join("session.wav"),
        jsonl: root.join("session.jsonl"),
        manifest: root.join("session.manifest.json"),
        root,
    })
}

fn default_session_root(mode: RunMode) -> Result<PathBuf, CliError> {
    let stamp = timestamp_utc("+%Y%m%dT%H%M%SZ")?;
    let date = stamp
        .get(..8)
        .ok_or_else(|| CliError::new("timestamp generation returned an invalid date prefix"))?;
    Ok(PathBuf::from("artifacts")
        .join("sessions")
        .join(date)
        .join(format!("{stamp}-{}", mode.as_str())))
}

fn timestamp_utc(format: &str) -> Result<String, CliError> {
    let output = Command::new("date")
        .args(["-u", format])
        .output()
        .map_err(|err| CliError::new(format!("failed to invoke `date`: {err}")))?;
    if !output.status.success() {
        return Err(CliError::new(format!(
            "`date` exited with status {} while building session paths",
            output.status
        )));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|err| CliError::new(format!("`date` returned non-utf8 output: {err}")))
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            _ => vec![ch],
        })
        .collect()
}

fn display_path(path: &Path) -> String {
    if path.is_absolute() {
        return path.display().to_string();
    }
    match env::current_dir() {
        Ok(cwd) => cwd.join(path).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_run_live_accepts_shared_operator_flags() {
        let command = parse_command(
            [
                "run",
                "--mode",
                "live",
                "--output-root",
                "artifacts/sessions/custom-live",
                "--duration-sec",
                "300",
                "--profile",
                "quality",
                "--language",
                "en-US",
                "--model",
                "models/live.bin",
                "--json",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .expect("run command should parse");

        let RecorditCommand::Run(run) = command else {
            panic!("expected run command");
        };
        assert_eq!(run.mode, RunMode::Live);
        assert_eq!(
            run.output_root,
            Some(PathBuf::from("artifacts/sessions/custom-live"))
        );
        assert_eq!(run.duration_sec, Some(300));
        assert_eq!(run.profile.as_deref(), Some("quality"));
        assert_eq!(run.language.as_deref(), Some("en-US"));
        assert_eq!(run.model.as_deref(), Some("models/live.bin"));
        assert!(run.json_output);
    }

    #[test]
    fn parse_run_offline_requires_input_wav() {
        let err = parse_command(["run", "--mode", "offline"].into_iter().map(str::to_string))
            .expect_err("offline mode without input should fail");

        assert!(
            err.to_string().contains("requires `--input-wav <path>`"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn map_run_live_derives_session_artifacts_from_output_root() {
        let invocation = map_run_command(&RunCommand {
            mode: RunMode::Live,
            input_wav: None,
            duration_sec: None,
            output_root: Some(PathBuf::from("artifacts/sessions/live-case")),
            profile: Some("balanced".to_string()),
            language: Some("en".to_string()),
            model: Some("models/live.bin".to_string()),
            json_output: true,
        })
        .expect("live mapping should succeed");

        assert_eq!(invocation.command, "run");
        assert_eq!(invocation.mode, Some(RunMode::Live));
        assert!(
            invocation
                .legacy_args
                .contains(&"--live-stream".to_string())
        );
        assert!(invocation.legacy_args.windows(2).any(|pair| pair
            == [
                "--input-wav",
                "artifacts/sessions/live-case/session.input.wav"
            ]));
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--out-wav", "artifacts/sessions/live-case/session.wav"])
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--duration-sec", "0"])
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--out-jsonl", "artifacts/sessions/live-case/session.jsonl"])
        );
        assert!(invocation.legacy_args.windows(2).any(|pair| pair
            == [
                "--out-manifest",
                "artifacts/sessions/live-case/session.manifest.json"
            ]));
    }

    #[test]
    fn map_run_offline_preserves_input_wav_and_contract_artifact_names() {
        let invocation = map_run_command(&RunCommand {
            mode: RunMode::Offline,
            input_wav: Some(PathBuf::from("fixtures/offline.wav")),
            duration_sec: Some(120),
            output_root: Some(PathBuf::from("artifacts/sessions/offline-case")),
            profile: None,
            language: None,
            model: None,
            json_output: false,
        })
        .expect("offline mapping should succeed");

        assert_eq!(invocation.command, "run");
        assert_eq!(invocation.mode, Some(RunMode::Offline));
        assert!(
            !invocation
                .legacy_args
                .contains(&"--live-stream".to_string())
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--input-wav", "fixtures/offline.wav"])
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--duration-sec", "120"])
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--out-wav", "artifacts/sessions/offline-case/session.wav"])
        );
        assert!(invocation.legacy_args.windows(2).any(|pair| pair
            == [
                "--out-manifest",
                "artifacts/sessions/offline-case/session.manifest.json"
            ]));
    }

    #[test]
    fn parse_run_rejects_zero_duration_override() {
        let err = parse_command(
            ["run", "--mode", "live", "--duration-sec", "0"]
                .into_iter()
                .map(str::to_string),
        )
        .expect_err("zero duration override should fail");
        assert!(err.to_string().contains("must be greater than zero"));
    }

    #[test]
    fn map_doctor_auto_backend_omits_legacy_backend_flag() {
        let invocation = map_doctor_command(&DoctorCommand {
            model: Some("models/shared.bin".to_string()),
            backend: Some("auto".to_string()),
            json_output: true,
        });

        assert_eq!(invocation.command, "doctor");
        assert!(
            !invocation
                .legacy_args
                .contains(&"--asr-backend".to_string())
        );
        assert!(
            invocation
                .legacy_args
                .windows(2)
                .any(|pair| pair == ["--asr-model", "models/shared.bin"])
        );
    }

    #[test]
    fn preflight_defaults_to_live_mode() {
        let command = parse_command(["preflight"].into_iter().map(str::to_string))
            .expect("preflight command should parse");
        let RecorditCommand::Preflight(preflight) = command else {
            panic!("expected preflight command");
        };
        assert_eq!(preflight.mode, RunMode::Live);
    }

    #[test]
    fn map_preflight_live_sets_live_stream_selector() {
        let invocation = map_preflight_command(&PreflightCommand {
            mode: RunMode::Live,
            input_wav: None,
            output_root: Some(PathBuf::from("artifacts/sessions/preflight-live")),
            json_output: false,
        })
        .expect("preflight mapping should succeed");

        assert!(
            invocation
                .legacy_args
                .contains(&"--live-stream".to_string())
        );
    }

    #[test]
    fn parse_replay_accepts_json_format() {
        let command = parse_command(
            [
                "replay",
                "--jsonl",
                "artifacts/session.jsonl",
                "--format",
                "json",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .expect("replay command should parse");

        let RecorditCommand::Replay(replay) = command else {
            panic!("expected replay command");
        };
        assert_eq!(replay.jsonl, PathBuf::from("artifacts/session.jsonl"));
        assert_eq!(replay.format, OutputFormat::Json);
    }

    #[test]
    fn inspect_contract_json_schema_reports_schema_payload() {
        let json = contract_json(ContractName::JsonlSchema);
        assert!(json.contains("\"$schema\""));
        assert!(json.contains("runtime-jsonl.schema.v1.json"));
    }

    #[test]
    fn inspect_contract_exit_codes_reports_contract_payload() {
        let json = contract_json(ContractName::ExitCodes);
        assert!(json.contains("recordit.exit-code-contract"));
        assert!(json.contains("\"degraded_success\""));
    }
}
