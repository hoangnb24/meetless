# Benchmark Harness

This repo treats benchmark artifacts as the authority for latency and resource claims. The harness in `src/bin/benchmark_harness.rs` provides a reproducible command runner that:

- prepares a versioned corpus from `bench/corpus/<version>/corpus.tsv`
- runs one backend command against every sample
- records per-run wall time, user/sys CPU time, derived CPU percent, max RSS, exit status, and git linkage
- emits machine-readable artifacts under `artifacts/bench/<timestamp>/`

## One-Command Run

```bash
make bench-harness
```

Default command:

```bash
cat {input} > /dev/null
```

That default is a harness smoke test, not an ASR benchmark. Replace it with a real backend command when Gate A or Gate B work begins.

Example:

```bash
make bench-harness BENCH_BACKEND=whisper-stream BENCH_CMD='whisper-cli --input {input} --language en'
```

## Corpus Format

`bench/corpus/v1/corpus.tsv` is tab-separated with this schema:

```text
sample_id    relative_path    language    duration_ms    generator
```

Comment metadata uses `# key=value` lines. Current supported generators:

- `silence`
- `sine:<frequency_hz>`

If the declared file does not exist and a generator is present, the harness creates a deterministic mono WAV fixture at that path. This lets the corpus stay reproducible without checking binary fixtures into git.

Recommended practice:

- keep the versioned corpus definition in `bench/corpus/...`
- point generated fixture paths at `artifacts/bench/corpus/...` so repeated harness runs do not dirty the source tree

## Versioning Rules

- Change `corpus_version` when sample membership, duration, or generation semantics change.
- Keep old corpus files in place when comparative history matters.
- Treat benchmark artifacts as invalid for cross-version comparison unless the corpus version matches.

## Artifact Layout

Each run writes:

- `summary.csv`: run metadata plus aggregate p50/p95 fields
- `runs.csv`: one row per sample execution

Both files include `generated_at_utc` and `git_commit` linkage so later ADRs and follow-up tasks can cite exact evidence.

## Frozen Comparison Baselines

Phase 1 and post-optimization benchmark work should use the frozen anchor set in `docs/phase1-baseline-anchors.md`.

That document defines:
- canonical baseline artifact paths
- exact comparison formulas
- lane classification rules for compatibility, default pressure, and induced drop-path runs

For downstream benchmark execution beads (`B1.02-B1.07`), use
`docs/post-opt-benchmark-baseline-rules.md` as the operational contract that maps
lane commands, evidence bundle expectations, and formula consumption rules.

Benchmark beads should cite that baseline document rather than restating timing/drop thresholds locally.
