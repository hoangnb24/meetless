# Transcribe Operator Runbook (bd-1yp)

Date: 2026-02-27  
Scope: model bootstrap, signing/entitlements verification, TCC reset workflow, preflight troubleshooting

Packaged entrypoint policy: operator runs should use signed `SequoiaTranscribe.app` via
`make run-transcribe-app`, with `make run-transcribe-preflight-app` and
`make run-transcribe-model-doctor-app` as the diagnostics companions.
Debug commands in this runbook are troubleshooting/development surfaces, not the packaged default.

## Bundle IDs and Paths

- Signed transcribe app bundle id: `com.recordit.sequoiatranscribe`
- Signed app path: `dist/SequoiaTranscribe.app`
- Signed app sandbox artifact root: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`
- Default packaged session artifacts:
  - `session.input.wav` (progressive capture scratch artifact for `--live-stream`)
  - `session.wav`
  - `session.jsonl`
  - `session.manifest.json`
- Evidence artifacts from this runbook validation:
  - `artifacts/ops/bd-1yp/`

## Packaged Session Summary Contract

`make run-transcribe-app` now provides a packaged operator wrapper with:

1. pre-run absolute artifact paths (single packaged root + session files)
2. attached terminal execution for live selectors (`--live-stream`, `--live-chunked`) so transcript output stays visible during runtime
3. automatic model staging into the packaged container for attached live runs so the signed runtime can read the explicit `--asr-model` asset under sandbox rules
4. post-run summary after signed app exit:
   - manifest presence check
   - trust degraded-mode flag
   - trust notice count
   - degradation event count

This keeps the "where are my files and was this healthy?" answer in one operator-facing command flow.

## 1) Bootstrap the Default whispercpp Model

Canonical setup command:

```bash
make setup-whispercpp-model
```

Default destination path:

- `artifacts/bench/models/whispercpp/ggml-tiny.en.bin`

Expected output includes:

- absolute destination path
- sha256 digest
- file size in bytes

If you need a custom destination:

```bash
scripts/setup_whispercpp_model.sh --dest /absolute/path/to/ggml-tiny.en.bin
```

## 2) Verify Signing and Entitlements

Build and sign:

```bash
make sign-transcribe SIGN_IDENTITY=-
```

Verify signature and designated requirement:

```bash
codesign --verify --deep --strict --verbose=2 dist/SequoiaTranscribe.app
```

Expected success lines:

- `dist/SequoiaTranscribe.app: valid on disk`
- `dist/SequoiaTranscribe.app: satisfies its Designated Requirement`

Inspect embedded entitlements:

```bash
codesign -d --entitlements :- --verbose=2 dist/SequoiaTranscribe.app
```

Required entitlements:

- `com.apple.security.app-sandbox = true`
- `com.apple.security.device.audio-input = true`
- `com.apple.security.personal-information.screen-recording = true`

Validated outputs:

- `artifacts/ops/bd-1yp/codesign-verify.log`
- `artifacts/ops/bd-1yp/codesign-entitlements.plist`
- `artifacts/ops/bd-1yp/transcribe-info-plist.txt`

## 3) Permission Reset and Prompt Workflow

Reset TCC grants for transcribe bundle id:

```bash
tccutil reset ScreenCapture com.recordit.sequoiatranscribe
tccutil reset Microphone com.recordit.sequoiatranscribe
```

Validated output:

- `Successfully reset ScreenCapture approval status for com.recordit.sequoiatranscribe`
- `Successfully reset Microphone approval status for com.recordit.sequoiatranscribe`
- log: `artifacts/ops/bd-1yp/tcc-reset.log`

Trigger prompts in signed app mode:

```bash
make run-transcribe-preflight-app ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Expected first-run prompts:

1. Screen Recording permission prompt
2. Microphone permission prompt

If prompts do not appear after reset, quit the app, rerun the `tccutil reset` commands, and relaunch.

## 4) Packaged Diagnostic Commands for Operator Checks

Packaged preflight command:

```bash
make setup-whispercpp-model
make run-transcribe-preflight-app ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Packaged model-doctor command:

```bash
make setup-whispercpp-model
make run-transcribe-model-doctor-app ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Both commands run in signed-app context and keep diagnostics aligned with the packaged beta execution path.

Packaged live-stream model-doctor command:

```bash
make setup-whispercpp-model
make run-transcribe-model-doctor-app \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_ARGS=--live-stream
```

Packaged live smoke gate:

```bash
make setup-whispercpp-model
make gate-packaged-live-smoke
```

The packaged smoke gate writes deterministic evidence under:

- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`

Use `summary.csv` as the canonical packaged live evidence artifact when deciding whether downstream deprecation/review work can proceed.
If `summary.csv` reports `runtime_helper_exec_blocked=true`, treat packaged live runtime as not ready in the current signed build and keep representative-chunk mode in service.
Key packaged live pass fields should report `true`: `runtime_first_stable_emit_ok`, `runtime_transcript_surface_ok`, and `runtime_terminal_live_mode_ok`.

### Debug fallback command (engineering-only)

Debug preflight command:

```bash
make setup-whispercpp-model
make transcribe-preflight ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Preflight checks include:

- `model_path`
- `out_wav`, `out_jsonl`, `out_manifest`
- `sample_rate`
- `screen_capture_access`
- `microphone_access`
- `backend_runtime`

## 5) Degraded-Mode Interpretation and Recovery Guidance

For packaged runs, use the post-run summary emitted by `make run-transcribe-app` first:

- `run_status` (`ok|degraded|failed`)
- `remediation_hints` (top deterministic next actions)
- `trust.degraded_mode_active`
- `trust.notice_count`
- `degradation_events` count

If deeper inspection is needed, read the packaged manifest directly:

```bash
jq '.trust, .degradation_events, .reconciliation, .chunk_queue, .session_summary, .terminal_summary' \
  ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/session.manifest.json
```

For schema-tolerant trust/degradation code extraction (handles both
`trust.notices[]` and fallback `session_summary.trust_notices.top_codes[]`):

```bash
python3 scripts/manifest_signal_extract.py \
  --manifest ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/session.manifest.json
```

Primary live runtime trust/degradation codes and what to do:

- `mode_degradation`
  - Meaning: requested channel behavior degraded (for example stereo assumptions were not met).
  - Immediate action: verify input channel assumptions and re-run `make run-transcribe-preflight-app`.
- `chunk_queue_backpressure`
  - Meaning: live runtime queue saturation dropped oldest queued ASR work (`chunk_queue.dropped_oldest > 0`).
  - Immediate action: treat live transcript as degraded; tune `--chunk-queue-cap` or reduce load, then review `reconciled_final`/manifest output for canonical completeness.
- `chunk_queue_backpressure_severe`
  - Meaning: sustained queue pressure materially reduced incremental transcript fidelity/timeliness.
  - Immediate action: prioritize post-session review (`reconciled_final`, `session_summary`, `chunk_queue` lag metrics) over in-session incremental output and reduce host load before rerun.
- `reconciliation_applied`
  - Meaning: post-session reconciliation ran after backlog pressure to improve final completeness.
  - Immediate action: use `reconciled_final` as canonical text and inspect `reconciliation.trigger_codes` for root-cause classification before deciding rerun scope.
- `continuity_recovered_with_gaps`
  - Meaning: capture interruption recovery succeeded, but continuity may contain boundary gaps.
  - Immediate action: inspect `reconciliation.trigger_codes`, lifecycle timeline, and trust notices before treating session as gap-free.
- `continuity_unverified`
  - Meaning: continuity telemetry was missing/unreadable, so continuity confidence is reduced.
  - Immediate action: verify writable artifact paths and rerun packaged preflight/model-doctor before trusting continuity-sensitive outcomes.

Adaptive backpressure burn-in and kill-switch guidance:

- Default posture: keep adaptive backpressure enabled during normal Phase 1 operation.
- Operator kill-switch: pass `--disable-adaptive-backpressure` in live modes to pin behavior to normal mode when adaptive behavior appears to regress.
- Enter kill-switch mode when any of these conditions holds across two consecutive runs:
  - trust/degradation includes `chunk_queue_backpressure_severe`
  - `session_summary.chunk_queue.drop_ratio` exceeds the induced-lane guardrail (`0.326667`)
  - first stable timing regresses above `2332ms` versus the frozen Phase 1 anchor
- Exit kill-switch mode only after burn-in evidence shows all of the following for at least three consecutive runs:
  - no `chunk_queue_backpressure_severe` trust/degradation signals
  - bounded queue pressure with stable lag (`lag_p95_ms` not worsening versus current lane baseline)
  - first stable timing at or below the `2332ms` guardrail
- Evidence location requirements for each burn-in decision:
  - manifest: `session_summary`, `chunk_queue`, `trust`, `degradation_events`
  - runtime JSONL: `chunk_queue` control events and lifecycle/trust context
  - baseline comparison source: `docs/phase1-baseline-anchors.md`

Manifest interpretation checklist for degraded runs:

1. If `trust.degraded_mode_active=true`, treat run as degraded even when command exit status is success.
2. If `reconciliation.applied=true`, prefer `reconciled_final` output over raw `final` lines for operator review.
3. If `chunk_queue.dropped_oldest > 0` or trust code includes `chunk_queue_backpressure*`, classify session as backlog-pressured and adjust queue/load tuning before next run.
4. If trust code includes `continuity_*`, treat continuity-sensitive conclusions as provisional until a rerun verifies clean continuity telemetry.
5. Use `terminal_summary` versus `session_summary` to separate what operators actually saw live from machine-normalized close-summary aggregates.

Hot-path observability breadcrumbs (runtime output, schema-safe):

- `close_summary` now includes deterministic `diagnostics_*` lines for:
  - transport input mode usage (`path` vs `pcm_window`)
  - worker scratch write/reuse estimates
  - backpressure mode/transition reason + per-channel processed/pending/drop estimates
  - pump trigger counts (chunk cadence decisions vs forced drains)
- `Runtime result` also emits `diagnostics_breadcrumbs` with artifact paths plus the same counter snapshot in one line for copy/paste incident triage.
- These breadcrumbs are additive log output only and do not change runtime JSONL/manifest schema fields.

## 6) Incident Triage Workflow (Pressure and Kill-Switch)

Use this workflow for live-runtime pressure incidents where transcript trust or continuity is degraded.

### Step 1: Classify incident state from manifest + close summary

Primary evidence fields:
- `trust.degraded_mode_active`
- `trust.codes[]`
- `degradation_events.codes[]`
- `chunk_queue` counters (`dropped_oldest`, `drop_ratio`, `lag_p95_ms`)
- close-summary diagnostics lines (`diagnostics_backpressure`, `diagnostics_pump`, `diagnostics_transport`)

### Step 2: Map signal to operator action

| Signal | Threshold / trigger | Classification | Immediate action |
|---|---|---|---|
| `chunk_queue_backpressure_severe` in trust/degradation codes | present | `SEVERE_PRESSURE` | Move run to degraded handling; evaluate kill-switch for next run. |
| `chunk_queue.drop_ratio` | `> 0.326667` | `DROP_PATH_REGRESSION` | Treat as rollback candidate; collect artifacts and compare with baseline anchors. |
| first stable emit timing | `> 2332ms` | `LATENCY_GUARDRAIL_BREACH` | Reduce load and evaluate kill-switch before accepting run quality. |
| continuity code (`continuity_*`) | present | `CONTINUITY_RISK` | Treat continuity-sensitive conclusions as provisional until clean rerun. |
| `reconciliation.applied=true` | true | `POST_RECOVERY_ACTIVE` | Use `reconciled_final` as canonical output for review. |

Threshold anchors:
- `docs/phase1-baseline-anchors.md`
- `docs/optimization-readiness-decision.md`

### Step 3: Decide kill-switch or rollback path

Decision path:
1. If two consecutive runs classify as `SEVERE_PRESSURE` or `DROP_PATH_REGRESSION`, enable kill-switch (`--disable-adaptive-backpressure`) for next validation run.
2. If kill-switch run still breaches thresholds, follow rollback path from:
   - `docs/phase1-rollback-killswitch-playbook.md`
3. Do not return to adaptive mode until burn-in criteria are met for three consecutive runs.

### Step 4: Collect and hand off incident packet

Required artifact bundle:
- session manifest path
- session JSONL path
- startup/close-summary logs
- trust/degradation code list
- chunk queue counters and lag metrics
- command invocation (including whether kill-switch was enabled)

Handoff requirements (on-call continuity):
1. incident classification (`SEVERE_PRESSURE`, `DROP_PATH_REGRESSION`, etc.)
2. actions already taken (retune, kill-switch, rollback candidate)
3. explicit next action owner and deadline

## 7) Tested Failure Signatures and Fixes

### A) Unwritable output path

Reproduction:

```bash
make transcribe-preflight \
  ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin \
  TRANSCRIBE_OUT_WAV=/System/Library/recordit-preflight.wav \
  TRANSCRIBE_OUT_JSONL=/System/Library/recordit-preflight.jsonl \
  TRANSCRIBE_OUT_MANIFEST=/System/Library/recordit-preflight.manifest.json
```

Observed signature:

- preflight `overall_status: FAIL`
- `out_wav/out_jsonl/out_manifest` fail with `Operation not permitted`
- `make: *** [transcribe-live] Error 2`

Fix:

- choose writable output paths (for signed app, prefer container path under `~/Library/Containers/com.recordit.sequoiatranscribe/Data/...`)

Evidence:

- `artifacts/ops/bd-1yp/preflight-unwritable-output.log`

### B) Backend/model resolution failure (moonshine)

Reproduction:

```bash
make transcribe-live \
  ASR_MODEL=/tmp/moonshine-model \
  TRANSCRIBE_ARGS='--asr-backend moonshine --preflight' \
  TRANSCRIBE_OUT_WAV=artifacts/ops/bd-1yp/preflight-moonshine.wav \
  TRANSCRIBE_OUT_JSONL=artifacts/ops/bd-1yp/preflight-moonshine.jsonl \
  TRANSCRIBE_OUT_MANIFEST=artifacts/ops/bd-1yp/preflight-moonshine.manifest.json
```

Observed signature:

- `model_path: FAIL` with explicit precedence and searched paths
- `backend_runtime: WARN` (`moonshine` binary not found in PATH)
- preflight summary `FAIL`, command exits with `Error 2`

Fix:

- pass a valid `--asr-model` path for selected backend, or set `RECORDIT_ASR_MODEL`
- use `whispercpp` on hosts where `moonshine` tooling/assets are unavailable

Evidence:

- `artifacts/ops/bd-1yp/preflight-moonshine.log`
- `artifacts/ops/bd-1yp/preflight-moonshine.manifest.json`

## 8) Important Model-Resolution Behavior

Current packaged/debug behavior is strict for explicit model overrides:

- `--asr-model <path>` is fail-fast.
- if the explicit path is missing/invalid for the selected backend kind, preflight/model-doctor reports failure and the command exits non-zero.
- explicit invalid `--asr-model` does not silently fall through to backend defaults.

When `--asr-model` is not provided, resolver precedence remains:

1. `RECORDIT_ASR_MODEL`
2. backend defaults for the current execution context

Operator verification path:

- inspect `model_path` detail and `via <source>` note in preflight/model-doctor output
- confirm manifest fields `asr_model_resolved` and `asr_model_source` match expectation

## 9) Escalation Checklist

1. Re-run preflight and capture manifest/log path.
2. Confirm model bootstrap completed (`make setup-whispercpp-model`).
3. Confirm `model_path` source and resolved absolute path.
4. Confirm output paths are writable in current execution context (debug vs signed app).
5. Reset TCC for `com.recordit.sequoiatranscribe` and relaunch signed preflight.
6. Re-verify app signature + entitlements if behavior changed after rebuild.
