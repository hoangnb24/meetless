# Sequoia Capture

Sequoia Capture is a macOS 15+ Rust project that records:
- system audio from ScreenCaptureKit
- microphone audio from ScreenCaptureKit `captureMicrophone`
- a stereo WAV with channel mapping `L=mic`, `R=system`

## Requirements
- macOS 15+
- Xcode command line tools
- Rust toolchain

## Capture Model
- Capture source is ScreenCaptureKit only.
- Microphone capture is enabled through `SCStreamConfiguration.captureMicrophone`.
- System audio and microphone arrive as separate ScreenCaptureKit output streams and are aligned by PTS in the recorder pipeline.

## Project Layout
- `src/main.rs`: canonical `recordit` operator CLI shell
- `src/bin/sck_probe.rs`: engineering probe binary (stream/output/timestamp inspection)
- `src/bin/sequoia_capture.rs`: WAV recorder binary
- `src/bin/transcribe_live.rs`: transcription CLI contract and config validation entrypoint
- `Recordit.xcodeproj`: macOS app project containing the `RecorditApp` target/scheme
- `app/RecorditApp/`: SwiftUI `@main` app entrypoint and initial window scene
- `app/RecorditApp/Info.plist`: Recordit.app bundle metadata and privacy usage descriptions
- `packaging/entitlements.plist`: Recordit.app signing entitlements for the current v1 release posture (empty/unsandboxed for v1)
- `docs/research.md`: API/TCC/platform research
- `docs/architecture.md`: real-time pipeline and interleave spec
- `docs/state-machine.md`: executable state-machine single source of truth (CLI/runtime/capture/queue/lifecycle)
- `docs/operator-quickstart.md`: canonical first-run operator path for `recordit`
- `docs/adr-001-backend-decision.md`: backend decision and explicit fallback triggers
- `docs/adr-002-lock-free-transport.md`: callback transport architecture decision
- `docs/adr-003-cleanup-boundary-policy.md`: cleanup isolation and policy decision
- `docs/adr-004-packaged-entrypoint.md`: historical packaged entrypoint decision (superseded for user-facing default policy)
- `docs/adr-005-recordit-default-entrypoint.md`: canonical user-facing default entrypoint policy (`Recordit.app`) and fallback boundary
- `docs/bd-dk69-product-contract-matrix.md`: spec-clause product contract matrix with implementation/app-validation/release-evidence obligations
- `docs/bd-1nqb-build-system-strategy.md`: accepted build-system strategy decision for `Recordit.app` (`xcodebuild`/Xcode app-target first)
- `docs/bd-3vwh-recordit-app-target.md`: evidence doc for `Recordit.xcodeproj` + `@main` app-target creation/build/launch
- `docs/bd-1gx5-recordit-makefile-packaging.md`: Makefile packaging cutover evidence for Recordit-first build/bundle/sign/verify targets
- `docs/bd-1msp-packaged-gate-retarget.md`: packaged gate retarget evidence for Recordit-default launch semantics + runtime compatibility checks
- `docs/bd-yu7n-recordit-signing-notary-paths.md`: signing/notarization/gatekeeper path retarget evidence for `Recordit.app`
- `docs/bd-14y4-sequoiatranscribe-fallback-policy.md`: strict non-default fallback policy for legacy `SequoiaTranscribe` usage
- `docs/bd-k993-coverage-claim-policy.md`: canonical terminology policy for truthful coverage/readiness claims
- `docs/bd-2gw4-release-posture-and-build-context-parity.md`: canonical guide to which dev, packaged, and release contexts are authoritative for which claims
- `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md`: concrete retained-artifact contract for XCTest/XCUITest/app-launched evidence lanes
- `docs/bd-2j49-cross-lane-e2e-evidence-standard.md`: project-wide standard tying shell, packaged, XCTest, XCUITest, and app-launched retained evidence together
- `docs/bd-1ngy-cross-lane-evidence-index-and-triage-map.md`: practical triage map showing where to start and which retained artifacts to inspect for common failure classes
- `docs/beads-governance.md`: issue decomposition, traceability governance, and evidence-linking workflow

## Commands

### Operator Quickstart (canonical)
Canonical default is the GUI-first `Recordit.app` user journey. Follow [docs/operator-quickstart.md](docs/operator-quickstart.md) for the full install/launch/first-run validation flow.

Minimal GUI-first sequence:
```bash
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-local.dmg RECORDIT_DMG_VOLNAME='Recordit'
open dist/Recordit-local.dmg
```

Then drag `Recordit.app` to `Applications`, launch it, complete onboarding (permissions + model setup), and validate first live start/stop in-window.

Fallback diagnostics are non-default and should be labeled as compatibility/support workflows:
- `make run-transcribe-app ...` (`SequoiaTranscribe.app` compatibility lane)
- direct CLI commands (`cargo run --bin recordit -- ...`)

### Build
```bash
make build
```
Builds debug binaries.

`Recordit.app` builds use a two-stage runtime handoff:
- `scripts/prepare_recordit_runtime_inputs.sh` performs the Rust build/staging step outside Xcode and writes prebuilt runtime inputs under `.build/recordit-runtime-inputs/<Configuration>/...`.
- Xcode's `Embed Runtime Binaries` phase (`scripts/embed_recordit_runtime_binaries.sh`) is copy-only and consumes those prebuilt inputs via `RECORDIT_RUNTIME_INPUT_DIR` (defaulting to the same `.build` path).

`make build-recordit-app` runs both stages in order, with explicit stage-prefixed logs:
- `[recordit-app][rust-build] ...`
- `[recordit-app][xcodebuild] ...`

Embedded runtime paths inside `Recordit.app`:
- `Recordit.app/Contents/Resources/runtime/bin/recordit`
- `Recordit.app/Contents/Resources/runtime/bin/sequoia_capture`

Runtime resolution contract:
- app runtime resolution expects bundled executables in `Contents/Resources/runtime/bin` (plus explicit absolute-path overrides via `RECORDIT_RUNTIME_BINARY` / `SEQUOIA_CAPTURE_BINARY` when intentionally set)
- implicit PATH fallback is disabled by default for startup/readiness so missing bundled payloads fail explicitly

This keeps the GUI-first flow terminal-free for end users (no external PATH setup required).

### Contract/Schema Enforcement Suite
```bash
make contracts-ci
```
Runs the machine-readable contract/schema enforcement suite used by CI (`scripts/ci_contracts.sh`).

### XCTest/XCUITest Evidence Lane (CI/Local)
```bash
scripts/ci_recordit_xctest_evidence.sh
```
Runs app-level `xcodebuild` test lanes, captures per-step logs + `.xcresult` bundles, and writes deterministic status summaries under:
- `artifacts/ci/xctest_evidence/<stamp>/status.csv`
- `artifacts/ci/xctest_evidence/<stamp>/summary.csv`
- `artifacts/ci/xctest_evidence/<stamp>/responsiveness_budget_summary.csv` (app-level responsiveness gate evidence)
- `artifacts/ci/xctest_evidence/<stamp>/contracts/xctest/evidence_contract.json`
- `artifacts/ci/xctest_evidence/<stamp>/contracts/xcuitest/evidence_contract.json`
- `artifacts/ci/xctest_evidence/<stamp>/contracts/lane_matrix.json`

See `docs/bd-1ff5-xctest-xcuitest-retained-artifact-contract.md` for the truthful retained-artifact contract, including the current rule that app-launched verification is represented through the `xcuitest-evidence` lane. See `docs/bd-2j49-cross-lane-e2e-evidence-standard.md` for the cross-lane summary-surface and traceability standard shared with shell and packaged evidence lanes.

Relevant controls:
- `XCTEST_EVIDENCE_STAMP` (artifact folder name)
- `XCTEST_DESTINATION` (default: `platform=macOS`)
- `CI_STRICT_UI_TESTS` (`1` makes UI-test execution failures required-fail)
- `XCTEST_RESPONSIVENESS_SUMMARY_PATH` (override path for responsiveness gate key/value artifact)

`summary.csv` includes responsiveness threshold rows emitted from app-level XCTest gating:
- `threshold_first_stable_transcript_budget_ok`
- `threshold_stop_to_summary_budget_ok`
- `responsiveness_gate_pass`

GitHub Actions workflow: `.github/workflows/recordit-xctest-evidence.yml`.

### Probe (debug)
```bash
make probe CAPTURE_SECS=8
```
Runs `src/bin/sck_probe.rs` and prints output-type/timestamp metadata.

### Record WAV (debug)
```bash
make capture CAPTURE_SECS=10 OUT=artifacts/hello-world.wav SAMPLE_RATE=48000
```
Runs the debug recorder binary directly.

### Run Representative Transcription Runtime (debug, legacy compatibility surface)
```bash
make transcribe-live ASR_MODEL=models/ggml-base.en.bin
```
Compatibility note: prefer `recordit run --mode offline` for normal operator usage.

Validates CLI flags, runs representative ASR transcription against `--input-wav` (auto-generated locally if missing), emits `partial`/`final` events to terminal + JSONL, computes VAD boundaries, and writes runtime manifest + mode-specific latency benchmark artifacts.

### Run True Live-Stream Runtime (debug, legacy compatibility surface)
```bash
make transcribe-live-stream ASR_MODEL=models/ggml-base.en.bin
```
Compatibility note: prefer `recordit run --mode live` for normal operator usage.

Runs the `--live-stream` runtime selector and prints absolute paths for captured input + emitted artifacts before execution. In this mode, `--input-wav` is the progressive scratch capture artifact that grows during runtime, while `--out-wav` is the canonical session WAV materialized on successful closeout.

Common overrides:
- `TRANSCRIBE_LIVE_STREAM_SECS`
- `TRANSCRIBE_LIVE_STREAM_INPUT_WAV`
- `TRANSCRIBE_LIVE_STREAM_OUT_WAV`, `TRANSCRIBE_LIVE_STREAM_OUT_JSONL`, `TRANSCRIBE_LIVE_STREAM_OUT_MANIFEST`
- `TRANSCRIBE_LIVE_STREAM_ARGS` (pass-through extra `transcribe-live` flags)

### Runtime Mode Quick Guide (operator first-read)

| Runtime taxonomy mode | Selector | Use this when | When stable transcript lines appear |
|---|---|---|---|
| `representative-offline` | `<default>` | deterministic artifact validation against an input WAV | mostly at end-of-run summary/replay surfaces |
| `representative-chunked` | `--live-chunked` | near-live scheduler validation on captured WAV (no true concurrent capture) | during runtime as boundaries close, with end summary for complete closeout |
| `live-stream` | `--live-stream` | true live capture + transcription during recording | during active runtime after warmup, then deterministic close summary |

Migration note for selector naming compatibility:
- [Legacy `--live-chunked` migration note](docs/live-chunked-migration.md)

Quick first-run path for true live mode:

New machine permission bootstrap (one-time):
```bash
make probe CAPTURE_SECS=3
```
Grant Screen Recording + Microphone access to your terminal when prompted, then continue.

```bash
make setup-whispercpp-model
cargo run --bin recordit -- preflight --mode live --json
cargo run --bin recordit -- run --mode live --model artifacts/bench/models/whispercpp/ggml-tiny.en.bin --json
cargo run --bin recordit -- replay --jsonl <session-root>/session.jsonl --format json
```

What to expect:

- startup banner is deterministic and compact: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`, `channel_mode_requested`, `duration_sec`, `input_wav`, and canonical artifact paths.
- when launched through `recordit`, the legacy verbose `Transcribe-live configuration` dump is suppressed by default so startup remains concise.
- `warmup` lifecycle starts first; transcript lines are not expected until runtime reaches `active`.
- once `active`, interactive terminals show low-noise partial updates and stable final lines as segments close.
- close summary is deterministic; if stable lines were already shown live, duplicate replay is suppressed.
- health interpretation is deterministic: `ok` (no trust notices), `degraded` (trust notices present), `failed` (non-zero exit before successful close-summary emission).
- runtime result includes `remediation_hints` as a concise, deterministic top-hints line for common degradation/failure follow-ups.
- if summary reports degraded trust/degradation counters, use `reconciled_final` plus manifest trust/reconciliation fields for canonical review.

### One-Command Capture then Transcribe (debug)
```bash
make capture-transcribe
```
Runs `sequoia_capture` first and stops immediately on capture failure, then invokes `transcribe-live` on the captured WAV (`--asr-backend whispercpp` by default). The target prints absolute paths for input/output artifacts before execution.

Common overrides:
- `PIPELINE_SECS` (capture/transcribe duration)
- `PIPELINE_CAPTURE_WAV` (intermediate captured WAV used as `--input-wav`)
- `PIPELINE_OUT_WAV`, `PIPELINE_OUT_JSONL`, `PIPELINE_OUT_MANIFEST`
- `PIPELINE_CHANNEL_MODE` (`separate`, `mixed`, or `mixed-fallback`)
- `PIPELINE_ASR_MODEL` (optional explicit model path; if unset, transcribe-live uses its backend default resolution)
- `PIPELINE_ARGS` (pass-through extra `transcribe-live` flags)

### Run Transcription Preflight (debug)
```bash
make transcribe-preflight ASR_MODEL=models/ggml-base.en.bin
```
Runs structured PASS/WARN/FAIL prerequisite checks before capture/transcription startup and writes a preflight manifest to `--out-manifest`.

### Run Smoke Journeys (debug)
```bash
make smoke
```
Runs the CI-safe smoke bundle:
- `make smoke-offline` (deterministic offline journey)
- `make smoke-near-live-deterministic` (deterministic near-live fallback using a stereo fixture)

Host near-live smoke (machine-dependent, requires Screen Recording + Microphone permissions):
```bash
make smoke-near-live
```

Smoke artifact roots:
- offline: `artifacts/smoke/offline/`
- near-live host capture: `artifacts/smoke/near-live/`
- near-live deterministic fallback: `artifacts/smoke/near-live-deterministic/`

### Run Near-Live Reliability Soak Gate
```bash
make gate-d-soak
```
Runs the deterministic near-live soak harness (`scripts/gate_d_soak.sh`) and writes per-run artifacts plus `summary.csv` under `artifacts/bench/gate_d/<timestamp>/`.

### Run Near-Live Backlog Pressure Gate
```bash
make gate-backlog-pressure
```
Runs the deterministic backlog-pressure gate harness and writes artifacts under `artifacts/bench/gate_backlog_pressure/<timestamp>/`.

### Run Transcript Completeness Gate (Reconciliation Under Backlog)
```bash
make gate-transcript-completeness
```
Runs the reconciliation completeness gate under induced backlog and writes artifacts under `artifacts/bench/gate_transcript_completeness/<timestamp>/`.

### Run V1 Acceptance Gate (Cold/Warm First-Emit + Artifact/Trust Checks)
```bash
make gate-v1-acceptance
```
Runs deterministic cold/warm near-live checks plus backlog/trust checks and writes artifacts under `artifacts/bench/gate_v1_acceptance/<timestamp>/`.

### Run Packaged Live Smoke Gate (signed app, deterministic fake capture)
```bash
make gate-packaged-live-smoke
```
Runs the packaged smoke gate with two layers of validation:
- `Recordit.app` remains the GUI-default packaged launch path (`run-recordit-app` plan semantics)
- signed compatibility runtime (`SequoiaTranscribe.app`) still satisfies live-stream artifact/trust/timing contracts

Machine-readable evidence is written under:

- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/summary.csv`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/status.txt`
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/gates/gate_packaged_live_smoke/<timestamp>/recordit_run_plan.log`

Key packaged live checks:
- `recordit_launch_semantics_ok=true`: default packaged launch plan resolves to `dist/Recordit.app` via `run-recordit-app`
- `runtime_first_stable_emit_ok=true`: first stable transcript evidence is present during active runtime
- `runtime_transcript_surface_ok=true`: manifest/JSONL transcript surfaces are populated
- `runtime_manifest_out_wav_match_ok=true`: manifest `session_summary.artifacts.out_wav` matches the canonical runtime `out_wav` path
- `runtime_manifest_out_jsonl_match_ok=true`: manifest `session_summary.artifacts.out_jsonl` matches the canonical runtime JSONL path
- `runtime_terminal_live_mode_ok=true`: terminal contract stayed in live mode without replay fallback
- `gate_pass=true`: packaged live-stream operator path satisfies the current acceptance bar

Reference: `docs/gate-packaged-live-smoke.md`.
Post-implementation verification checklist and evidence index: `docs/post-implementation-verification-checklist.md`.

### Build Recordit DMG (Drag-to-Applications UX)
```bash
make create-recordit-dmg
```
Builds `dist/Recordit.dmg` from `dist/Recordit.app` and stages an `Applications` alias/symlink in the DMG root so install UX is explicit.

### Inspect Release Artifacts (Xcode + dist + DMG evidence bundle)
```bash
make inspect-recordit-release-artifacts
```
Builds or reuses the current packaged artifacts and writes a retained evidence bundle under:

- `artifacts/ops/release-artifact-inspection/<timestamp>/summary.csv`
- `artifacts/ops/release-artifact-inspection/<timestamp>/dist_release_context/summary.csv`
- `artifacts/ops/release-artifact-inspection/<timestamp>/artifacts/xcode_bundle_inventory.json`
- `artifacts/ops/release-artifact-inspection/<timestamp>/artifacts/dmg_root_inventory.json`

This is the canonical automated inspection path for the current v1 release posture: it captures Xcode-built app inventory, nested `dist/Recordit.app` release-context verification, DMG metadata/checksum/mounted contents, and runtime-payload parity across those artifact layers.

Optional overrides:
- `RECORDIT_DMG_NAME` (default: `Recordit.dmg`)
- `RECORDIT_DMG_VOLNAME` (default: `Recordit`)

### Verify DMG Install Surface (Mount/Layout/Copy/Open)
```bash
make gate-dmg-install-open
```
Runs retained install-surface verification for `Recordit.dmg` with standardized e2e evidence output:

- optional app/DMG build steps (`make sign-recordit-app`, DMG creation)
- DMG attach + layout checks (`Recordit.app` presence, `Applications` link target)
- copy/install to an explicit destination root
- launch attempt of the installed app (`open -n`) and deterministic launch diagnostics
- explicit detach cleanup

Evidence root default:
- `artifacts/ops/gate_dmg_install_open/<timestamp>/`

Key retained outputs:
- `evidence_contract.json`
- `summary.csv`
- `summary.json`
- `status.txt`
- `logs/<phase>.log|stdout|stderr`
- `artifacts/dmg_attach.plist`
- `artifacts/dmg_layout_report.txt`
- `artifacts/install_copy_report.txt`
- `artifacts/open_launch_report.txt`

Useful overrides:
- `OUT_DIR`
- `RECORDIT_DMG_NAME`
- `RECORDIT_DMG_VOLNAME`
- `SKIP_BUILD=1` (reuse existing `dist/Recordit.app`)
- `SKIP_DMG_BUILD=1` (reuse an existing DMG path)
- `INSTALL_DESTINATION=<path>`
- `OPEN_WAIT_SEC=<seconds>`

Reference: `docs/gate-dmg-install-open.md`.

### Run Packaged Beta Entrypoint (signed app mode, compatibility/fallback)
```bash
make run-transcribe-app ASR_MODEL=models/ggml-base.en.bin
```
Superseded-default context:
- `docs/adr-005-recordit-default-entrypoint.md` makes `Recordit.app` the canonical user-facing default.
- this `run-transcribe-app` / `SequoiaTranscribe.app` path remains a legacy compatibility and fallback lane for internal runtime continuity while cutover work completes.
- fallback policy guardrails (scope/escalation/timeline): `docs/bd-14y4-sequoiatranscribe-fallback-policy.md`

Builds/signs `dist/SequoiaTranscribe.app` (signed app mode for `transcribe-live`).
Default packaged runs launch via `open -W`; live selectors such as `--live-stream` and `--live-chunked` run the signed executable directly so terminal transcript output remains attached to the invoking shell.
For those attached live runs, the explicit `--asr-model` asset is staged into the app container before launch so the signed runtime can read it under sandbox rules.
This is a compatibility/fallback packaged launch path, not the primary user-facing default.
The target prints absolute container-scoped artifact destinations before launch and prints a concise post-run session summary after the signed app exits.

For packaged diagnostics on the same path, use `make run-transcribe-preflight-app`.
For engineering-only development flows, keep using debug targets such as `make transcribe-live`, `make capture-transcribe`, and direct `cargo run`.
Decision records: `docs/adr-005-recordit-default-entrypoint.md` (current default policy), `docs/adr-004-packaged-entrypoint.md` (historical/superseded for default policy).

Packaged artifact destination defaults:
- root: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`
- session files:
  - `session.wav`
  - `session.jsonl`
  - `session.manifest.json`

Optional overrides:
- `TRANSCRIBE_APP_ARTIFACT_ROOT`
- `TRANSCRIBE_APP_SESSION_STEM`

Explicit packaged live-stream wrapper:

```bash
make run-transcribe-live-stream-app ASR_MODEL=models/ggml-base.en.bin
```

This keeps the same signed app entrypoint, prints the live input/output artifact paths before launch, and uses:

- `<root>/<session-stem>.input.wav`
- `<root>/<session-stem>.wav`
- `<root>/<session-stem>.jsonl`
- `<root>/<session-stem>.manifest.json`

Artifact semantics for this wrapper:
- `<session-stem>.input.wav`: progressive live scratch artifact written during capture
- `<session-stem>.wav`: canonical session artifact materialized after successful runtime shutdown/drain

Packaged live follow-on evidence path:

- `make gate-packaged-live-smoke` writes packaged live smoke evidence under `<root>/gates/gate_packaged_live_smoke/<timestamp>/...`
- reference: `docs/adr-004-packaged-entrypoint.md` (follow-on design section)

### Run Transcription Preflight (signed app mode diagnostics)
```bash
make run-transcribe-preflight-app ASR_MODEL=models/ggml-base.en.bin
```
Runs the same preflight diagnostics in signed app context and writes results into the configured manifest path.
Default signed preflight manifest path:
- `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/session.manifest.json`

### Run Transcription Model Doctor (signed app mode diagnostics)
```bash
make run-transcribe-model-doctor-app ASR_MODEL=models/ggml-base.en.bin
```
Runs model/backend diagnostics in the same signed app context used by packaged beta runs so model resolution and backend readiness can be verified without using debug-only entrypoints.

For live-stream prerequisite diagnostics in packaged context:
```bash
make run-transcribe-model-doctor-app \
  ASR_MODEL=models/ggml-base.en.bin \
  TRANSCRIBE_ARGS=--live-stream
```
Use this path for live-mode readiness checks when you want backend/model diagnostics only.  
Canonical policy: `--preflight` is compatible with `--live-stream` and `--live-chunked`; use `--replay-jsonl` for post-run replay and keep it separate.

### Bundle + Sign
```bash
make sign SIGN_IDENTITY=-
make verify
```
Builds `dist/SequoiaCapture.app`, sets Swift runtime rpath, signs, and verifies entitlements/signature.

### Run Signed App Bundle
```bash
make run-app CAPTURE_SECS=10 OUT=artifacts/hello-world.wav SAMPLE_RATE=48000
```
Launches the app bundle via `open -W` and passes recorder arguments.

### Reset TCC for Bundle ID
```bash
make reset-perms
```
Resets ScreenCapture and Microphone grants for both:
- `com.recordit.sequoiatranscribe`
- `com.recordit.sequoiacapture`

### Clean
```bash
make clean
```
Removes build/output artifacts and runs `cargo clean`.

## Binary Arguments

### Canonical operator CLI (`src/main.rs`)
```bash
cargo run --bin recordit -- run --mode live
cargo run --bin recordit -- run --mode offline --input-wav <path>
cargo run --bin recordit -- doctor
cargo run --bin recordit -- preflight --mode live
cargo run --bin recordit -- replay --jsonl <path>
cargo run --bin recordit -- inspect-contract cli --format json
```
- `recordit` is the recommended human-facing path for normal operator workflows.
- The legacy `transcribe-live` contract remains stable for scripts, gates, and expert-only controls.
- Contract/schema evolution policy: [`docs/schema-versioning-policy.md`](docs/schema-versioning-policy.md)

### Probe binary (`src/bin/sck_probe.rs`)
```bash
cargo run --bin sck_probe -- [duration_seconds]
```
- `duration_seconds` optional, default `8`

### Recorder binary (`src/bin/sequoia_capture.rs`)
```bash
cargo run --bin sequoia_capture -- [duration_seconds] [output_path] [sample_rate_hz] [sample_rate_mismatch_policy] [callback_contract_mode]
```
- `duration_seconds` optional, default `10`
- `output_path` optional, default `artifacts/hello-world.wav`
- `sample_rate_hz` optional, default `48000`
- `sample_rate_mismatch_policy` optional, default `adapt-stream-rate` (`adapt-stream-rate` or `strict`)
  - `adapt-stream-rate` keeps callback non-blocking and performs worker-side resampling to the requested output rate when mic/system native rates differ
  - `strict` fails fast when either stream rate differs from the requested target
- `callback_contract_mode` optional, default `warn` (`warn` or `strict`)
- telemetry artifact `<output_stem>.telemetry.json` includes `sample_rate_policy` with input rates and resampled chunk/frame counters

### Transcription CLI contract (`src/bin/transcribe_live.rs`)
```bash
cargo run --bin transcribe-live -- [--asr-model <local-model-path>] [flags...]
```
- Migration note:
  - prefer `recordit run --mode live` (or `--mode offline`) for normal operator usage
  - keep using `transcribe-live` for legacy automation/gates and deep engineering controls
  - `transcribe-live --help` now prints this migration guidance directly for operators
- key flags currently validated:
  - `--duration-sec`
  - `--input-wav`
  - `--out-wav`
  - `--out-jsonl`
  - `--out-manifest`
  - `--sample-rate`
  - `--asr-backend`
  - `--asr-model`
  - `--asr-language`
  - `--asr-threads`
  - `--asr-profile`
  - `--vad-backend`
  - `--vad-threshold`
  - `--vad-min-speech-ms`
  - `--vad-min-silence-ms`
  - `--llm-cleanup`
  - `--llm-endpoint`
  - `--llm-model`
  - `--llm-timeout-ms`
  - `--llm-max-queue`
  - `--llm-retries`
  - `--live-chunked`
  - `--live-stream`
  - `--chunk-window-ms`
  - `--chunk-stride-ms`
  - `--chunk-queue-cap`
  - `--live-asr-workers`
  - `--keep-temp-audio`
  - `--transcribe-channels`
  - `--speaker-labels`
  - `--benchmark-runs`
  - `--model-doctor`
  - `--replay-jsonl`
  - `--preflight`
- `--out-wav` contract:
  - canonical session WAV artifact path for the run
  - always materialized on successful runtime execution
  - for `--live-stream`, materialized from the progressive `--input-wav` scratch artifact during successful runtime closeout
  - for representative modes, materialized according to the mode-specific input/output semantics described in the manifest
  - runtime manifest records `out_wav_materialized` and `out_wav_bytes` so artifact truth does not depend on reading the filesystem out-of-band
- backend values:
  - `whispercpp` (primary and the only standard v1 setup path for `Recordit.app`)
  - `whisperkit` (advanced/manual compatibility path until packaged parity exists)
  - `moonshine` (placeholder; adapter not wired yet)
- model resolution precedence:
  - `--asr-model <path>` (explicit override, highest priority)
  - explicit `--asr-model` is fail-fast: missing/invalid explicit paths do not fall through to defaults
  - `RECORDIT_ASR_MODEL` environment variable
  - backend defaults (sandbox container model path, then repo-local model defaults)
  - whispercpp expects a **file** path; whisperkit expects a **directory** path
  - preflight/runtime manifests expose both resolved path and source (`asr_model_resolved`, `asr_model_source`)
- model doctor:
  - run `cargo run --bin transcribe-live -- --model-doctor [--asr-backend ...] [--asr-model ...]`
  - PASS/WARN/FAIL report includes backend helper availability, model path resolution/kind, and model readability
  - use this as first-stop diagnostics before runtime execution when model/backend setup is uncertain
- channel mode values:
  - `separate`
  - `mixed`
  - `mixed-fallback` (prefers separate but falls back to mixed when dual-channel inputs are unavailable)
- near-live runtime contract:
  - default runtime mode is `representative-offline`
  - enable near-live contract with `--live-chunked`
  - runtime taxonomy is authoritative and currently split into:

    | Taxonomy mode | Current selector | `runtime_mode` artifact value | Primary operator intent | Transcript timing expectation | `--replay-jsonl` compatibility | `--preflight` compatibility |
    |---|---|---|---|---|---|---|
    | `representative-offline` | `<default>` | `representative-offline` | deterministic offline transcript contract validation | stable transcript lines are primarily end-of-run surfaces | compatible | compatible |
    | `representative-chunked` | `--live-chunked` | `live-chunked` | near-live queue/scheduler behavior validation on captured WAV | runtime stable lines emit as boundaries close; summary closes out full session | incompatible | compatible |
    | `live-stream` | `--live-stream` | `live-stream` | true concurrent capture + transcription while recording | transcript emission starts after warmup enters `active` and continues during capture | incompatible | compatible |

  - `--live-chunked` prepares runtime input via the shared in-process live capture runtime (`recordit::live_capture`) and then runs a rolling near-live scheduler over the captured WAV
  - rolling scheduler semantics: `2s` default window, `0.5s` default stride, deterministic chunk segment IDs, and tail-aligned final window coverage
  - boundary-scoped final segment IDs are normalized from deterministic boundary ordering (`start_ms`, `end_ms`, `source`, `id`) so IDs stay stable even if upstream boundary insertion order changes
  - near-live ASR work is routed through a bounded queue; when saturated, oldest queued chunk work is dropped to preserve non-blocking producer behavior
  - if chunk backlog caused drops, a post-session reconciliation pass emits `reconciled_final` events from canonical session audio to improve final completeness without hiding live-path degradation
  - `--chunk-window-ms` default `2000`
  - `--chunk-stride-ms` default `500`
  - `--chunk-queue-cap` default `4`
  - `--live-asr-workers` default `2`
  - `--chunk-stride-ms` must be `<= --chunk-window-ms`
  - live ASR channel work runs through a dedicated worker pool with explicit backend prewarm before the first live run
  - channel-slice temp WAVs default to `retain-on-failure` cleanup; add `--keep-temp-audio` to retain them on success for debugging
  - chunk tuning flags require `--live-chunked` or `--live-stream`
  - `--live-stream` and `--live-chunked` are mutually exclusive selectors
  - `--live-chunked` and `--live-stream` are incompatible with `--replay-jsonl`
  - `--preflight` is compatible with both live selectors and should be used as a readiness diagnostic lane before live runtime execution
  - selector naming/deprecation guidance lives in [`docs/live-chunked-migration.md`](docs/live-chunked-migration.md)
- mode/degradation artifact policy:
  - runtime manifest records both `channel_mode_requested` and active `channel_mode`
  - runtime manifest records mode contracts as additive fields: `runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`
  - runtime JSONL emits `event_type=mode_degradation` when fallback/degradation occurs
  - runtime JSONL emits `event_type=trust_notice` with cause/impact/guidance for user-facing trust calibration
  - runtime JSONL emits `event_type=asr_worker_pool` with prewarm, queue, and temp-audio cleanup counters
  - runtime JSONL emits `event_type=chunk_queue` with near-live queue pressure + lag counters
  - runtime JSONL is append-only and emitted incrementally during lifecycle progression (not only at shutdown)
  - in `live-stream`, lifecycle transitions and transcript events are emitted during active runtime so JSONL growth itself is evidence of true live behavior
  - runtime JSONL durability checkpoints call `sync_data()` every 24 lines and at stage boundaries
  - runtime manifest records `out_wav`, `out_wav_materialized`, and `out_wav_bytes` for canonical session artifact truth
  - runtime manifest includes a `degradation_events` array with stable `code` + `detail`
  - runtime manifest includes `asr_worker_pool` telemetry (`prewarm_ok`, `submitted`, `enqueued`, `dropped_queue_full`, `processed`, `succeeded`, `failed`, `retry_attempts`, `temp_audio_deleted`, `temp_audio_retained`)
  - runtime manifest includes `chunk_queue` telemetry (`submitted`, `enqueued`, `dropped_oldest`, `processed`, `pending`, `high_water`, `lag_sample_count`, `lag_p50_ms`, `lag_p95_ms`, `lag_max_ms`)
  - runtime manifest includes a structured `trust` object (`degraded_mode_active`, `notice_count`, `notices`)
  - runtime manifest includes `session_summary`, a deterministic machine-consumable mirror of terminal close-summary fields (`session_status`, modes, transcript event counts, queue/lag, trust/degradation top codes, cleanup queue, artifacts)
  - runtime manifest `event_counts` includes transcript family counts (`partial`, `final`, `llm_final`, `reconciled_final`) for deterministic diagnostics
  - runtime manifest `first_emit_timing_ms` includes `first_any`, `first_partial`, `first_final`, and `first_stable` so gates can validate active-runtime emission without relying on raw JSONL row ordering
  - replay output prints trust notices so audit reads preserve degraded-mode context
- readability default contract:
  - terminal rendering is capability-aware:
    - interactive `TTY` shows low-noise partial overwrite updates using `[MM:SS.mmm-MM:SS.mmm] <channel> ~ <text>` and appends stable `final` lines as segments close
    - non-`TTY` logs suppress partial overwrite updates and emit deterministic stable `final` lines during active runtime
    - end-of-session summary avoids replaying those already-emitted live stable lines to reduce duplicate noise
  - terminal close-summary fields are emitted in deterministic order (`session_status`, `duration_sec`, mode fields, transcript event counts, queue/lag, trust/degradation, cleanup queue, artifacts)
  - merged transcript line format: `[MM:SS.mmm-MM:SS.mmm] <channel>: <text>`
  - per-channel transcript line format: `[MM:SS.mmm-MM:SS.mmm] <text>`
  - near-simultaneous cross-channel finals are deterministic: keep canonical sort order and annotate the later line with `(overlap<=120ms with <channel>)`
  - runtime manifest includes `terminal_summary` (`live_mode`, `stable_line_count`, `stable_lines_replayed`, `stable_lines`) aligned with end-of-session terminal behavior
  - runtime manifest persists ordered transcript events (`partial`, `final`, `llm_final`, `reconciled_final`) under `events`
  - runtime manifest includes `readability_defaults` + `transcript_per_channel` entries
- use `cargo run --bin transcribe-live -- --help` to print the full contract
- cleanup isolation policy:
  - finalized-segment cleanup is queued via non-blocking enqueue (`try_send`)
  - queue-full cleanup requests are dropped, never blocking ASR/final event emission
  - processed cleanup requests use `--llm-timeout-ms` and `--llm-retries` policy
  - prompt policy is constrained to readability cleanup only (no semantic expansion)
  - successful cleanup emits `llm_final` events with `source_final_segment_id` lineage to the original `final` segment
  - queue telemetry is emitted as `cleanup_queue` in both JSONL and runtime manifest outputs

Sample readable transcript output:
```text
[00:00.000-00:00.420] mic: hello from mic
[00:00.050-00:00.410] system: hello from system (overlap<=120ms with mic)
```

Replay example:
```bash
cargo run --bin transcribe-live -- --replay-jsonl artifacts/transcribe-live.runtime.jsonl
```

Benchmark artifacts are written under:
- `artifacts/bench/transcribe-live-single-channel/<timestamp>/summary.csv`
- `artifacts/bench/transcribe-live-single-channel/<timestamp>/runs.csv`
- `artifacts/bench/transcribe-live-dual-channel/<timestamp>/summary.csv`
- `artifacts/bench/transcribe-live-dual-channel/<timestamp>/runs.csv`
- `artifacts/bench/gate_backlog_pressure/<timestamp>/summary.csv`
- `artifacts/bench/gate_transcript_completeness/<timestamp>/summary.csv`

## Output Paths
- `make capture` / direct `cargo run --bin sequoia_capture`: output path is resolved from the current shell working directory.
- `make run-app`: app is sandboxed, so relative paths resolve inside container storage.
- `make transcribe-live`, `make transcribe-live-stream`, and `make run-transcribe-app`: all pass absolute artifact paths and print them before execution.
- `make run-transcribe-app` keeps live selector runs (`--live-stream`, `--live-chunked`) attached to the current terminal so incremental transcript output can render during execution.
- `make run-transcribe-app` stages explicit live-run model assets under the packaged container root before attached execution so the signed runtime can read them.
- `make run-transcribe-app` also prints a post-run session summary (manifest presence + trust/degradation counters when `jq` is available).
- `make transcribe-preflight` and `make run-transcribe-preflight-app`: run deterministic preflight checks and persist checklist outcomes in the manifest output.
- `make transcribe-model-doctor` and `make run-transcribe-model-doctor-app`: run model/backend diagnostics in debug and packaged contexts with the same operator-facing contract.
- Signed transcribe targets default to container-scoped absolute destinations under:
  - `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/`

Default `run-app` output for `OUT=artifacts/hello-world.wav`:
- `~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav`

Open the generated file:
```bash
open ~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav
```

Copy into repo-local `artifacts/`:
```bash
cp ~/Library/Containers/com.recordit.sequoiacapture/Data/artifacts/hello-world.wav ./artifacts/hello-world.wav
```

## Permissions and UX
Running the signed app requests macOS privacy permissions for:
- Screen/Screen & System Audio Recording
- Microphone

On Sequoia, direct screen/audio access may also show the private-window-picker bypass prompt with an `Allow for one month` option.

## Notes
- The signed app exits automatically after `CAPTURE_SECS`; this is expected CLI behavior.
- At least one display must be available for the ScreenCaptureKit content filter.
# recordit

## Deep Dive: What We Built and Why

### Why This Project Exists
`recordit` is built to solve a specific reliability problem in real-time transcription workflows on macOS:
- capture system + microphone audio in one deterministic session
- generate readable transcript output while the session is running
- always emit machine-consumable artifacts that automation can trust
- preserve degradation signals explicitly instead of silently hiding them

The project is useful when humans and automation both need the same session output:
- humans need concise terminal feedback and readable lines
- automation needs stable schemas, stable event types, and stable exit semantics

### What We Built
At a system level, `recordit` is four cooperating layers:

1. Operator shell (`recordit` CLI)
- canonical command grammar for `run`, `preflight`, `doctor`, `replay`, and `inspect-contract`
- mode mapping and guardrails before runtime starts

2. Capture substrate (`live_capture`)
- ScreenCaptureKit callback ingestion for system audio + microphone
- non-blocking callback path with bounded lock-free transport
- deterministic stereo output contract (`L=mic`, `R=system`)

3. Runtime coordinator (`live_stream_runtime` + `live_asr_pool`)
- lifecycle control (`warmup`, `active`, `draining`, `shutdown`)
- bounded queueing and priority-aware scheduling for ASR work
- transcript/event assembly with deterministic ordering

4. Contract/artifact boundary
- append-only runtime JSONL event stream
- deterministic runtime/preflight manifests
- machine-readable compatibility contracts in `contracts/*.json`

### End-to-End Runtime Flow

1. Parse and validate command intent
- `recordit` enforces operator-facing mode rules before dispatching runtime work.

2. Resolve runtime identity
- runtime mode tuple is explicit in output (`runtime_mode`, `runtime_mode_taxonomy`, `runtime_mode_selector`, `runtime_mode_status`).

3. Start capture and scheduler
- callback thread ingests and queues audio chunks without blocking.
- worker/runtime threads perform VAD-driven chunking and ASR submission.

4. Emit progressive evidence
- JSONL is written incrementally with transcript events and control events (`lifecycle_phase`, `chunk_queue`, `trust_notice`, etc.).

5. Reconcile and close
- runtime drains outstanding work, writes final artifacts, emits session summary, and classifies session as nominal/degraded/failed via manifest fields and exit semantics.

### Core Algorithms and Scheduling Policies

#### 1) PTS-based alignment and deterministic interleave
- mic and system streams are anchored to a shared timeline using presentation timestamps (PTS).
- output frame placement is deterministic relative to timeline origin.
- channel mapping is fixed (`L=mic`, `R=system`) to keep downstream replay and analysis stable.

#### 2) Streaming segmentation with bounded windows
- live modes use chunk window/stride controls to generate rolling ASR work while recording continues.
- VAD boundaries drive segment lifecycle and finalization timing.
- deterministic replay surfaces are preserved by stable ordering metadata and event emission rules.

#### 3) Priority-aware bounded queue under pressure
- ASR queue classes are explicit: `final`, `reconcile`, `partial`.
- scheduling preference is high-signal work first (`final` before background classes).
- under pressure, eviction/drop behavior is intentional and deterministic rather than unbounded growth.
- pressure/degradation is surfaced in queue + trust telemetry instead of hidden.

#### 4) Reconciliation and cleanup as additive lanes
- reconciliation can emit `reconciled_final` when backlog/ordering recovery is required.
- readability cleanup (`llm_final`) is policy-bounded and lineage-linked to original `final` segments.
- cleanup is isolated from core runtime correctness; core transcript completion does not depend on cleanup success.

### Design Principles

#### Contract-first external behavior
Public surfaces are treated as compatibility boundaries:
- runtime mode matrix: `contracts/runtime-mode-matrix.v1.json`
- exit-code classes: `contracts/recordit-exit-code-contract.v1.json`
- JSONL event schema: `contracts/runtime-jsonl.schema.v1.json`
- session/preflight manifest schema: `contracts/session-manifest.schema.v1.json`

#### Determinism over convenience
- stable field vocabularies and deterministic summary ordering
- explicit mode labels and selectors in artifacts
- replayable JSONL + manifest pair as source-of-truth evidence

#### Bounded real-time behavior
- non-blocking callbacks
- bounded queues with explicit eviction/drop semantics
- explicit lifecycle phases and readiness transitions

#### Degradation is observable, not implicit
- degraded success is intentionally represented as `exit_code=0` plus trust/degradation signals
- failure remains explicit (`exit_code=2`) for usage/config/runtime/preflight/replay failures

### How to Read Session Health Correctly

`recordit` intentionally separates "process exit" from "session quality":

- `exit_code=0` can mean either:
  - nominal success, or
  - degraded success (artifacts produced, but trust/degradation review required)
- `exit_code=2` means execution failure or invalid invocation path

For automation, use both layers:
1. exit code class from `contracts/recordit-exit-code-contract.v1.json`
2. manifest trust/degradation fields (`trust.*`, `degradation_events`, `session_summary.session_status`)

### Why This Is Useful in Practice

- Reliable CI/gate inputs: machine-readable outputs stay stable across runs.
- Better operator ergonomics: concise terminal path with deterministic closeout summaries.
- Better postmortems: runtime JSONL + manifest preserve enough context to debug pressure/recovery behavior.
- Safer rollout evolution: compatibility contracts make change impact explicit.

### Implementation Anchors (Where Behavior Lives)

- Operator shell and command mapping: `src/recordit_cli.rs`
- Runtime compatibility shell: `src/bin/transcribe_live/app.rs`
- Shared capture runtime: `src/live_capture.rs`
- Live-stream coordinator and scheduler: `src/live_stream_runtime.rs`
- Bounded ASR pool and queue policy: `src/live_asr_pool.rs`
- Executable behavior model: `docs/state-machine.md`
- Pipeline architecture narrative: `docs/architecture.md`

### Use Cases

1. Real-time meeting/session transcription with explicit confidence/degradation telemetry
2. Regression/gate validation using deterministic artifacts and replay
3. Packaged app smoke validation with the same runtime semantics as debug mode
4. Automation pipelines that need strict schemas and stable interpretation rules

### Non-Goals (Current Scope Boundary)

- Not a general-purpose DAW/audio editor.
- Not an unconstrained low-latency stream processor with unbounded buffering.
- Not a "best effort but opaque" transcription tool; this project favors explicit contracts and telemetry.
- Not tied to one ASR backend implementation strategy; backend selection is modular and policy-driven.
