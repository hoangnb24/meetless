# Transcribe Operator Runbook (bd-1yp)

Date: 2026-02-27  
Scope: signing/entitlements verification, TCC reset workflow, preflight troubleshooting

## Bundle IDs and Paths

- Signed transcribe app bundle id: `com.recordit.sequoiatranscribe`
- Signed app path: `dist/SequoiaTranscribe.app`
- Signed app sandbox artifact root: `~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/`
- Evidence artifacts from this runbook validation:
  - `artifacts/ops/bd-1yp/`

## 1) Verify Signing and Entitlements

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

## 2) Permission Reset and Prompt Workflow

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

## 3) Preflight Command for Operator Checks

Debug preflight command:

```bash
make transcribe-preflight ASR_MODEL=artifacts/bench/models/whispercpp/ggml-tiny.en.bin
```

Preflight checks include:

- `model_path`
- `out_wav`, `out_jsonl`, `out_manifest`
- `sample_rate`
- `screen_capture_access`
- `microphone_access`
- `backend_runtime`

## 4) Tested Failure Signatures and Fixes

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

## 5) Important Model-Resolution Behavior

`--asr-model` does not always produce a hard failure if the provided path is missing. The resolver can fall through to backend defaults (for example repo benchmark defaults), so operators should verify the resolved source in preflight detail:

- see `model_path` detail and `via <source>` note in preflight output/manifest

This behavior was observed in:

- `artifacts/ops/bd-1yp/preflight-missing-model.log`
- `artifacts/ops/bd-1yp/preflight-missing-model.manifest.json`

## 6) Escalation Checklist

1. Re-run preflight and capture manifest/log path.
2. Confirm `model_path` source and resolved absolute path.
3. Confirm output paths are writable in current execution context (debug vs signed app).
4. Reset TCC for `com.recordit.sequoiatranscribe` and relaunch signed preflight.
5. Re-verify app signature + entitlements if behavior changed after rebuild.
