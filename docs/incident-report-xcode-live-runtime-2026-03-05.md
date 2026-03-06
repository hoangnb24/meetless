# Recordit Xcode Live-Run Incident Report (2026-03-05)

## Purpose
This report is a handoff for the next agent to trace and fix the real-build Xcode failures across:
- onboarding preflight permissions,
- model setup path resolution,
- live start/stop finalization,
- build-phase runtime bundling.

The focus is root cause, not workaround-only behavior.

## Sources Used
1. `cass` session evidence from:
   - `/Users/themrb/.codex/sessions/2026/03/05/rollout-2026-03-05T15-18-30-019cbd13-b176-7100-a9d7-2eae192f2105.jsonl`
2. Current code paths in app/runtime:
   - `app/AppShell/AppEnvironment.swift`
   - `app/AppShell/PreflightViewModel.swift`
   - `app/AppShell/PermissionRemediationViewModel.swift`
   - `app/RecorditApp/RecorditApp.swift`
   - `app/RecorditAppUITests/RecorditAppUITests.swift`
   - `app/RuntimeProcessLayer/RuntimeProcessManager.swift`
   - `app/RuntimeProcessLayer/ProcessBackedRuntimeService.swift`
   - `app/ViewModels/RuntimeViewModel.swift`
   - `app/Services/FileSystemModelResolutionService.swift`
   - `scripts/embed_recordit_runtime_binaries.sh`
   - `Recordit.xcodeproj/project.pbxproj`
   - `src/live_capture.rs`
   - `src/bin/transcribe_live/preflight.rs`
   - `src/bin/transcribe_live/app.rs`
   - `src/bin/transcribe_live/runtime_live_stream.rs`
   - `src/bin/transcribe_live/runtime_representative.rs`
3. Local runtime artifacts:
   - `/var/folders/9q/zrq7jhjs4pz4b48b82s82z4w0000gn/T/recordit-ui-sessions/*`

## Chronological Timeline (from `cass`)

Key user-reported milestones (line numbers are from the session JSONL):

1. Line 8 @ `2026-03-05T08:25:30.971Z`
   - Xcode build/run had missing runtime binary while `scripts/ci_recordit_xctest_evidence.sh` looked fine.
2. Line 136 @ `2026-03-05T08:37:19.968Z`
   - Requirement clarified: runtime/CLI must be bundled from day 1, users should not manage CLI manually.
3. Line 486 @ `2026-03-05T09:32:31.900Z`
   - `Command PhaseScriptExecution failed with a nonzero exit code`.
4. Line 537 @ `2026-03-05T09:38:04.798Z`
   - Onboarding Permissions step failing; no deep-link buttons initially.
5. Lines 1070 / 1220 / 1291 / 1697 / 1854
   - User granted Screen + Microphone in macOS settings, but preflight still failed (Permissions and sometimes Model Setup gate).
6. Line 1950
   - Explicit error: `ScreenCaptureKit has no shareable content`.
7. Line 2489
   - Live run failure on start/stop path: `unable to resolve ASR model for backend whispercpp`.
8. Line 2603
   - Continued live failure: `failed to get shareable content (screen recording permission + active display required)`.
9. Line 2957
   - Xcode sandbox error from build phase:
     - `Sandbox: cargo ... deny file-read-data .../.cargo/config.toml`
     - `failed to parse manifest at .../Cargo.toml`
10. Line 3024
    - User concern: fixes were becoming workaround-heavy instead of root-cause.
11. Line 3090 and line 3571
    - Permissions eventually looked passed, but stop/finalization still produced runtime errors.

## What Has Already Been Changed

### 1) Runtime bundling in Xcode build phase
- Added/updated shell phase `Embed Runtime Binaries` in project:
  - `Recordit.xcodeproj/project.pbxproj` (build phase + script wiring).
- Script now:
  - resolves `cargo` robustly (`CARGO_BIN`, PATH, fallback locations),
  - builds `recordit` + `sequoia_capture`,
  - installs them into app resources `runtime/bin/`,
  - tries to embed default whispercpp model into `runtime/models/whispercpp/`.
  - File: `scripts/embed_recordit_runtime_binaries.sh`.

### 2) App environment normalization for runtime/preflight/model
- `AppEnvironment.production()` now:
  - normalizes PATH,
  - resolves runtime binary readiness early,
  - prepends recordit directory to PATH when found,
  - resolves default model and propagates `RECORDIT_ASR_MODEL` into runtime/model/preflight environments.
  - File: `app/AppShell/AppEnvironment.swift`.

### 3) Model resolution behavior
- Model resolver checks precedence:
  - explicit path -> `RECORDIT_ASR_MODEL` -> backend defaults (including bundled resource path).
  - File: `app/Services/FileSystemModelResolutionService.swift`.

### 4) Permission remediation and preflight behavior
- Permission UI now has deep-links and fallback handling.
- Production preflight is based on helper/runtime output; permission normalization override is limited to UI test mode.
  - Files: `app/AppShell/PermissionRemediationViewModel.swift`, `app/AppShell/PreflightViewModel.swift`.

### 5) Stop/finalization timeouts and diagnostics
- Runtime stop timeout and finalization timeout now default to 15s.
- Added bounded finalization loop + diagnostics on timeout.
  - Files: `app/RuntimeProcessLayer/ProcessBackedRuntimeService.swift`, `app/ViewModels/RuntimeViewModel.swift`.

### 6) Runtime benchmark artifact fallback hardening
- Benchmark artifact write now attempts current dir and fallback root; read-only `/artifacts` no longer hard-fails run.
  - Files: `src/bin/transcribe_live/app.rs`, `src/bin/transcribe_live/runtime_live_stream.rs`, `src/bin/transcribe_live/runtime_representative.rs`.

## Root-Cause Map (Current Understanding)

### A) Why tests passed while real Xcode run failed
This is the biggest gap:

1. UI tests force fixture mode:
   - `RECORDIT_UI_TEST_MODE=1`
   - `RECORDIT_RUNTIME_BINARY=/usr/bin/true`
   - `SEQUOIA_CAPTURE_BINARY=/usr/bin/true`
   - file: `app/RecorditAppUITests/RecorditAppUITests.swift`.
2. App entry switches to preview/scripted services in UI test mode:
   - scripted preflight payloads,
   - scripted runtime stop failure scenarios,
   - file: `app/RecorditApp/RecorditApp.swift`.
3. Multiple smoke tests stub readiness and preflight outcomes directly.

Net effect: tests validate onboarding state-machine behavior, not full real-world runtime/capture/TCC/sandbox integration.

### B) Permissions granted but preflight fails
Two separate checks can disagree:

1. Native app-level checks (CG/AVFoundation):
   - `CGPreflightScreenCaptureAccess()`, `AVCaptureDevice.authorizationStatus(.audio)`.
   - file: `app/AppShell/PermissionRemediationViewModel.swift`.
2. Runtime/helper checks using ScreenCaptureKit content + active display:
   - preflight: `SCShareableContent::get()` in Rust (`src/bin/transcribe_live/preflight.rs`).
   - live capture: same dependency in `src/live_capture.rs`.

So “permission granted” in Settings is necessary but not sufficient if:
- no active display is available, or
- ScreenCaptureKit cannot provide shareable content in the current app session/state.

### C) Model setup/start failures (earlier phase)
Observed runtime error:
- `unable to resolve ASR model ... Checked: .../Containers/... | /artifacts/... | /models/...`

Interpretation:
- runtime process did not have a valid model path in effective environment/CLI at that moment.
- later builds show `--asr-model` passed and successful runs using bundled model path.

### D) Build phase sandbox / cargo manifest parse failure
Observed error:
- `Sandbox: cargo(...) deny file-read-data .../.cargo/config.toml`.

This indicates Xcode script sandbox blocked cargo reading config in at least one config/state. Project currently contains mixed `ENABLE_USER_SCRIPT_SANDBOXING` values (project vs target configs), and this has been a moving part during fixes.

### E) Stop/finalization failures
Stop pipeline:
1. UI calls stop -> runtime service `controlSession(.stop)`.
2. Process manager sends `interrupt()`.
3. Nonzero exit/crash/timeout is mapped as failure.
4. UI then waits for `session.manifest.json` during bounded finalization.

Problem symptoms:
- some session dirs are empty (no logs/manifest),
- some have only partial artifacts (e.g. only `session.jsonl` warmup+active events),
- at least one session is fully successful.

This points to intermittent or sequence-sensitive failure, not a single always-on hard failure.

## Runtime Artifact Evidence Snapshot

### Fully successful recent run exists
- Session: `/var/folders/9q/zrq7jhjs4pz4b48b82s82z4w0000gn/T/recordit-ui-sessions/2026-03-05T15-11-03.208Z-live`
- Evidence:
  - `session.manifest.json` present,
  - runtime stdout reports `run_status: ok`,
  - trailing command JSON reports `"exit_code":0`,
  - ASR model resolved from bundled app resource path,
  - benchmark fallback warning is non-fatal (falls back after `/artifacts` read-only failure).

### Recent failing attempts with little/no artifacts
- `.../2026-03-05T15-14-21.155Z-live` and `.../2026-03-05T15-15-57.109Z-live` are empty directories.
- `.../2026-03-05T14-05-19.159Z-live` has only minimal `session.jsonl` lifecycle entries, no manifest/logs.

This split is important: there are at least two failure modes (early/incomplete vs full successful run).

## Why This Keeps Reappearing
Likely multiple root causes were interleaving:

1. Packaging/environment root cause (runtime binaries/model path in Xcode app context).
2. ScreenCaptureKit availability root cause (permission + active display + session state).
3. Build-script sandbox/cargo environment root cause.
4. Stop/finalization race/termination classification root cause.

Because failures moved between these subsystems, each patch exposed the next blocker.

## Priority Investigation Plan For Next Agent

1. Lock on a single fresh app build and verify embedded runtime assets before launch.
2. Reproduce start->stop once with full artifact capture and classify run into:
   - empty dir,
   - partial artifacts,
   - full manifest.
3. For each failed run, capture exact `runtime.stdout.log`, `runtime.stderr.log`, and Xcode console JSON summary line.
4. Validate ScreenCaptureKit state at failure moment (not just System Settings state).
5. Confirm build-phase sandbox behavior in active RecorditApp build config used by Xcode run action.
6. Reconcile stop-path behavior only after the above is stable (avoid masking with longer timeouts).

## Immediate Commands For Next Agent

### 1) Confirm app bundle embeds runtime + model
```bash
APP="/Users/themrb/Library/Developer/Xcode/DerivedData/Recordit-gpmddynhmqiolbcurcipiexqyywm/Build/Products/Debug/Recordit.app"
ls -lah "$APP/Contents/Resources/runtime/bin"
ls -lah "$APP/Contents/Resources/runtime/models/whispercpp"
```

### 2) Run preflight from the same built runtime context
```bash
"$APP/Contents/Resources/runtime/bin/recordit" preflight --mode live --json --output-root /tmp/recordit-preflight-manual
```

### 3) Manual live run with explicit model and output root
```bash
ROOT="/tmp/recordit-live-manual-$(date +%s)"
mkdir -p "$ROOT"
"$APP/Contents/Resources/runtime/bin/recordit" run \
  --live-stream \
  --duration-sec 0 \
  --input-wav "$ROOT/session.input.wav" \
  --out-wav "$ROOT/session.wav" \
  --out-jsonl "$ROOT/session.jsonl" \
  --out-manifest "$ROOT/session.manifest.json" \
  --asr-model "$APP/Contents/Resources/runtime/models/whispercpp/ggml-tiny.en.bin"
```

### 4) If Xcode build script fails again, inspect full build log for script sandbox deny lines.

## Open Questions
1. Why do some runs create only the session folder with no logs, while a neighboring run is fully successful?
2. Is ScreenCaptureKit shareable-content failure tied to display state transitions (lid/monitor/sleep/space) during run?
3. Are there still config mismatches between project-level and target-level script sandbox settings in the active scheme/config?
4. Is stop requested before capture pipeline reaches a stable state in certain UX timings?

## Bottom Line
- The issue is real and not solely user-environment error.
- Tests passing does not currently prove live production path correctness.
- We now have direct evidence of both failure and success on real builds, so the next fix must focus on stabilizing the specific failing runtime modes (especially ScreenCaptureKit availability and early stop/finalization behavior) using artifact-based classification.
