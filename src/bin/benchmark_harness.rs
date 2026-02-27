use anyhow::{Context, Result, bail};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::cmp::Ordering;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
struct HarnessConfig {
    corpus_path: PathBuf,
    output_root: PathBuf,
    backend_id: String,
    command_template: String,
    sample_rate_hz: u32,
}

#[derive(Debug, Clone)]
struct CorpusMetadata {
    schema_version: String,
    corpus_version: String,
}

#[derive(Debug, Clone)]
struct SampleSpec {
    id: String,
    path: PathBuf,
    language: String,
    duration_ms: u64,
    generator: Generator,
}

#[derive(Debug, Clone)]
enum Generator {
    None,
    Silence,
    Sine(f32),
}

#[derive(Debug, Clone)]
struct RunResult {
    sample_id: String,
    input_path: PathBuf,
    language: String,
    duration_ms: u64,
    success: bool,
    exit_code: i32,
    real_secs: Option<f64>,
    user_secs: Option<f64>,
    sys_secs: Option<f64>,
    cpu_percent: Option<f64>,
    max_rss_bytes: Option<u64>,
}

fn main() -> Result<()> {
    let config = parse_args(env::args().collect())?;
    let (meta, samples) = load_corpus(&config.corpus_path)?;

    if samples.is_empty() {
        bail!(
            "corpus file {} contained no samples",
            config.corpus_path.display()
        );
    }

    for sample in &samples {
        ensure_sample(sample, config.sample_rate_hz)?;
    }

    let generated_at = command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let stamp = command_stdout("date", &["-u", "+%Y%m%dT%H%M%SZ"])
        .unwrap_or_else(|_| "unknown".to_string());
    let git_commit = git_stdout(&["rev-parse", "HEAD"]).unwrap_or_else(|_| "unknown".to_string());
    let git_commit_short =
        git_stdout(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|_| "unknown".to_string());
    let git_dirty = !git_stdout(&["status", "--porcelain"])
        .unwrap_or_default()
        .trim()
        .is_empty();

    let run_dir = config.output_root.join(&stamp);
    fs::create_dir_all(&run_dir).with_context(|| {
        format!(
            "failed to create run output directory {}",
            run_dir.display()
        )
    })?;

    let mut results = Vec::with_capacity(samples.len());
    for sample in &samples {
        let result = run_sample(&config.command_template, sample)?;
        results.push(result);
    }

    let summary_path = run_dir.join("summary.csv");
    let runs_path = run_dir.join("runs.csv");

    write_summary(
        &summary_path,
        &generated_at,
        &git_commit,
        &git_commit_short,
        git_dirty,
        &meta,
        &config,
        &results,
    )?;
    write_runs(
        &runs_path,
        &generated_at,
        &git_commit,
        &meta.corpus_version,
        &config.backend_id,
        &results,
    )?;

    println!("Benchmark harness completed");
    println!("backend_id: {}", config.backend_id);
    println!("corpus_version: {}", meta.corpus_version);
    println!("summary_csv: {}", summary_path.display());
    println!("runs_csv: {}", runs_path.display());

    Ok(())
}

fn parse_args(args: Vec<String>) -> Result<HarnessConfig> {
    let mut config = HarnessConfig {
        corpus_path: PathBuf::from("bench/corpus/v1/corpus.tsv"),
        output_root: PathBuf::from("artifacts/bench"),
        backend_id: "noop-cat".to_string(),
        command_template: "cat {input} > /dev/null".to_string(),
        sample_rate_hz: 16_000,
    };

    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--corpus" => {
                i += 1;
                config.corpus_path = PathBuf::from(required_arg(&args, i, "--corpus")?);
            }
            "--out-dir" => {
                i += 1;
                config.output_root = PathBuf::from(required_arg(&args, i, "--out-dir")?);
            }
            "--backend-id" => {
                i += 1;
                config.backend_id = required_arg(&args, i, "--backend-id")?.to_string();
            }
            "--cmd" => {
                i += 1;
                config.command_template = required_arg(&args, i, "--cmd")?.to_string();
            }
            "--sample-rate" => {
                i += 1;
                config.sample_rate_hz = required_arg(&args, i, "--sample-rate")?
                    .parse::<u32>()
                    .context("--sample-rate must be an integer")?;
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
        i += 1;
    }

    Ok(config)
}

fn required_arg<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing value for {flag}"))
}

fn print_help() {
    println!("benchmark_harness");
    println!("  --corpus <path>       Path to corpus TSV");
    println!("  --out-dir <path>      Output directory root");
    println!("  --backend-id <id>     Logical backend identifier");
    println!("  --cmd <template>      Command template; use {{input}} placeholder");
    println!("  --sample-rate <hz>    Sample rate for generated fixtures");
}

fn load_corpus(path: &Path) -> Result<(CorpusMetadata, Vec<SampleSpec>)> {
    let file =
        File::open(path).with_context(|| format!("failed to open corpus {}", path.display()))?;
    let reader = BufReader::new(file);

    let mut schema_version = "unknown".to_string();
    let mut corpus_version = "unknown".to_string();
    let mut samples = Vec::new();

    for (line_no, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("failed to read line {}", line_no + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('#') {
            let rest = rest.trim();
            if let Some((key, value)) = rest.split_once('=') {
                match key.trim() {
                    "schema_version" => schema_version = value.trim().to_string(),
                    "corpus_version" => corpus_version = value.trim().to_string(),
                    _ => {}
                }
            }
            continue;
        }

        let fields: Vec<&str> = trimmed.split('\t').collect();
        if fields.len() != 5 {
            bail!(
                "invalid corpus row at {}:{}; expected 5 tab-separated fields",
                path.display(),
                line_no + 1
            );
        }

        let generator = parse_generator(fields[4])?;
        let duration_ms = fields[3]
            .parse::<u64>()
            .with_context(|| format!("invalid duration at {}:{}", path.display(), line_no + 1))?;

        samples.push(SampleSpec {
            id: fields[0].to_string(),
            path: PathBuf::from(fields[1]),
            language: fields[2].to_string(),
            duration_ms,
            generator,
        });
    }

    Ok((
        CorpusMetadata {
            schema_version,
            corpus_version,
        },
        samples,
    ))
}

fn parse_generator(value: &str) -> Result<Generator> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "-" || trimmed.eq_ignore_ascii_case("none") {
        return Ok(Generator::None);
    }
    if trimmed.eq_ignore_ascii_case("silence") {
        return Ok(Generator::Silence);
    }
    if let Some(freq) = trimmed.strip_prefix("sine:") {
        let frequency_hz = freq
            .parse::<f32>()
            .with_context(|| format!("invalid sine frequency in generator {trimmed}"))?;
        return Ok(Generator::Sine(frequency_hz));
    }
    bail!("unsupported generator: {trimmed}")
}

fn ensure_sample(sample: &SampleSpec, sample_rate_hz: u32) -> Result<()> {
    if sample.path.exists() {
        return Ok(());
    }

    match sample.generator {
        Generator::None => bail!(
            "sample {} is missing and no generator is defined: {}",
            sample.id,
            sample.path.display()
        ),
        Generator::Silence => write_wave(sample, sample_rate_hz, 0.0),
        Generator::Sine(frequency_hz) => write_wave(sample, sample_rate_hz, frequency_hz),
    }
}

fn write_wave(sample: &SampleSpec, sample_rate_hz: u32, frequency_hz: f32) -> Result<()> {
    if let Some(parent) = sample.path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create generated corpus directory {}",
                parent.display()
            )
        })?;
    }

    let spec = WavSpec {
        channels: 1,
        sample_rate: sample_rate_hz,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(&sample.path, spec)
        .with_context(|| format!("failed to create {}", sample.path.display()))?;
    let frame_count = ((sample.duration_ms as u128) * (sample_rate_hz as u128) / 1_000) as usize;
    let amplitude = (i16::MAX as f32 * 0.2).round() as i16;

    for frame in 0..frame_count {
        let sample_value = if frequency_hz <= 0.0 {
            0i16
        } else {
            let phase =
                (frame as f32) * frequency_hz * std::f32::consts::TAU / (sample_rate_hz as f32);
            (phase.sin() * (amplitude as f32)).round() as i16
        };
        writer
            .write_sample(sample_value)
            .with_context(|| format!("failed writing {}", sample.path.display()))?;
    }

    writer
        .finalize()
        .with_context(|| format!("failed to finalize {}", sample.path.display()))?;
    Ok(())
}

fn run_sample(command_template: &str, sample: &SampleSpec) -> Result<RunResult> {
    let absolute_input = if sample.path.is_absolute() {
        sample.path.clone()
    } else {
        env::current_dir()
            .context("failed to resolve current directory")?
            .join(&sample.path)
    };

    let rendered = command_template.replace("{input}", &absolute_input.to_string_lossy());
    let output = Command::new("/usr/bin/time")
        .arg("-l")
        .arg("sh")
        .arg("-c")
        .arg(&rendered)
        .output()
        .with_context(|| format!("failed to execute benchmark command: {rendered}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let (real_secs, user_secs, sys_secs, max_rss_bytes) = parse_time_output(&stderr);
    let cpu_percent = match (real_secs, user_secs, sys_secs) {
        (Some(real), Some(user), Some(sys)) if real > 0.0 => Some(((user + sys) / real) * 100.0),
        _ => None,
    };

    Ok(RunResult {
        sample_id: sample.id.clone(),
        input_path: absolute_input,
        language: sample.language.clone(),
        duration_ms: sample.duration_ms,
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        real_secs,
        user_secs,
        sys_secs,
        cpu_percent,
        max_rss_bytes,
    })
}

fn parse_time_output(stderr: &str) -> (Option<f64>, Option<f64>, Option<f64>, Option<u64>) {
    let mut real_secs = None;
    let mut user_secs = None;
    let mut sys_secs = None;
    let mut max_rss_bytes = None;

    for line in stderr.lines() {
        let trimmed = line.trim();
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.len() >= 6 && tokens[1] == "real" && tokens[3] == "user" && tokens[5] == "sys" {
            real_secs = tokens[0].parse::<f64>().ok();
            user_secs = tokens[2].parse::<f64>().ok();
            sys_secs = tokens[4].parse::<f64>().ok();
            continue;
        }

        if trimmed.contains("maximum resident set size") {
            if let Some(value) = tokens.first() {
                max_rss_bytes = value.parse::<u64>().ok();
            }
        }
    }

    (real_secs, user_secs, sys_secs, max_rss_bytes)
}

fn write_summary(
    path: &Path,
    generated_at: &str,
    git_commit: &str,
    git_commit_short: &str,
    git_dirty: bool,
    meta: &CorpusMetadata,
    config: &HarnessConfig,
    results: &[RunResult],
) -> Result<()> {
    let mut file =
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    let success_count = results.iter().filter(|r| r.success).count();
    let failure_count = results.len().saturating_sub(success_count);

    let wall_ms: Vec<f64> = results
        .iter()
        .filter_map(|r| r.real_secs.map(|value| value * 1_000.0))
        .collect();
    let cpu_pct: Vec<f64> = results.iter().filter_map(|r| r.cpu_percent).collect();
    let rss_bytes: Vec<f64> = results
        .iter()
        .filter_map(|r| r.max_rss_bytes.map(|value| value as f64))
        .collect();

    writeln!(file, "key,value")?;
    write_kv(&mut file, "generated_at_utc", generated_at)?;
    write_kv(&mut file, "git_commit", git_commit)?;
    write_kv(&mut file, "git_commit_short", git_commit_short)?;
    write_kv(
        &mut file,
        "git_dirty",
        if git_dirty { "true" } else { "false" },
    )?;
    write_kv(&mut file, "schema_version", &meta.schema_version)?;
    write_kv(&mut file, "corpus_version", &meta.corpus_version)?;
    write_kv(
        &mut file,
        "corpus_path",
        &config.corpus_path.to_string_lossy(),
    )?;
    write_kv(&mut file, "backend_id", &config.backend_id)?;
    write_kv(&mut file, "command_template", &config.command_template)?;
    write_kv(
        &mut file,
        "sample_rate_hz",
        &config.sample_rate_hz.to_string(),
    )?;
    write_kv(&mut file, "run_count", &results.len().to_string())?;
    write_kv(&mut file, "success_count", &success_count.to_string())?;
    write_kv(&mut file, "failure_count", &failure_count.to_string())?;
    write_metric(&mut file, "wall_ms_p50", percentile(&wall_ms, 0.50))?;
    write_metric(&mut file, "wall_ms_p95", percentile(&wall_ms, 0.95))?;
    write_metric(&mut file, "cpu_pct_p50", percentile(&cpu_pct, 0.50))?;
    write_metric(&mut file, "cpu_pct_p95", percentile(&cpu_pct, 0.95))?;
    write_metric(&mut file, "max_rss_bytes_p50", percentile(&rss_bytes, 0.50))?;
    write_metric(&mut file, "max_rss_bytes_p95", percentile(&rss_bytes, 0.95))?;
    Ok(())
}

fn write_runs(
    path: &Path,
    generated_at: &str,
    git_commit: &str,
    corpus_version: &str,
    backend_id: &str,
    results: &[RunResult],
) -> Result<()> {
    let mut file =
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    writeln!(
        file,
        "generated_at_utc,git_commit,corpus_version,backend_id,sample_id,input_path,language,duration_ms,success,exit_code,real_secs,user_secs,sys_secs,cpu_percent,max_rss_bytes"
    )?;

    for result in results {
        writeln!(
            file,
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            csv_escape(generated_at),
            csv_escape(git_commit),
            csv_escape(corpus_version),
            csv_escape(backend_id),
            csv_escape(&result.sample_id),
            csv_escape(&result.input_path.to_string_lossy()),
            csv_escape(&result.language),
            result.duration_ms,
            result.success,
            result.exit_code,
            format_option_f64(result.real_secs),
            format_option_f64(result.user_secs),
            format_option_f64(result.sys_secs),
            format_option_f64(result.cpu_percent),
            format_option_u64(result.max_rss_bytes),
        )?;
    }

    Ok(())
}

fn write_kv(file: &mut File, key: &str, value: &str) -> Result<()> {
    writeln!(file, "{},{}", csv_escape(key), csv_escape(value))
        .context("failed to write summary row")
}

fn write_metric(file: &mut File, key: &str, value: Option<f64>) -> Result<()> {
    writeln!(file, "{},{}", csv_escape(key), format_option_f64(value))
        .context("failed to write metric row")
}

fn percentile(values: &[f64], quantile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let index = ((sorted.len() - 1) as f64 * quantile).round() as usize;
    sorted.get(index).copied()
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn format_option_f64(value: Option<f64>) -> String {
    match value {
        Some(value) => format!("{value:.6}"),
        None => String::new(),
    }
}

fn format_option_u64(value: Option<u64>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn command_stdout(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("failed to execute {program}"))?;
    if !output.status.success() {
        bail!("{program} exited with status {}", output.status);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_stdout(args: &[&str]) -> Result<String> {
    command_stdout("git", args)
}
