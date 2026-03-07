#!/usr/bin/env bash
set -euo pipefail

if [[ "${RECORDIT_EMBED_RUNTIME_BINARIES:-1}" == "0" ]]; then
  echo "[embed-runtime] RECORDIT_EMBED_RUNTIME_BINARIES=0; skipping"
  exit 0
fi

ROOT="${SRCROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
configuration="${CONFIGURATION:-Debug}"
default_runtime_input_dir="$ROOT/.build/recordit-runtime-inputs/$configuration"
runtime_input_dir="${RECORDIT_RUNTIME_INPUT_DIR:-$default_runtime_input_dir}"
require_strict_runtime_payload=0
if [[ "$configuration" == "Release" ]]; then
  require_strict_runtime_payload=1
fi

fail_or_warn() {
  local message="$1"
  if [[ "$require_strict_runtime_payload" == "1" ]]; then
    echo "error: $message" >&2
    exit 1
  fi
  echo "[embed-runtime][copy] warning: $message" >&2
}

recordit_src="$runtime_input_dir/runtime/bin/recordit"
capture_src="$runtime_input_dir/runtime/bin/sequoia_capture"
runtime_artifact_manifest_src="$runtime_input_dir/runtime/artifact-manifest.json"

if [[ ! -x "$recordit_src" ]]; then
  echo "error: missing prebuilt runtime binary: $recordit_src" >&2
  echo "hint: run scripts/prepare_recordit_runtime_inputs.sh with RECORDIT_RUNTIME_CONFIGURATION=$configuration" >&2
  echo "hint: or run make build-recordit-app RECORDIT_XCODE_CONFIGURATION=$configuration" >&2
  exit 1
fi
if [[ ! -x "$capture_src" ]]; then
  echo "error: missing prebuilt runtime binary: $capture_src" >&2
  echo "hint: run scripts/prepare_recordit_runtime_inputs.sh with RECORDIT_RUNTIME_CONFIGURATION=$configuration" >&2
  echo "hint: or run make build-recordit-app RECORDIT_XCODE_CONFIGURATION=$configuration" >&2
  exit 1
fi

resource_root="${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
dest_dir="$resource_root/runtime/bin"
mkdir -p "$dest_dir"

echo "[embed-runtime][copy] configuration=$configuration"
echo "[embed-runtime][copy] runtime_input_dir=$runtime_input_dir"
install -m 755 "$recordit_src" "$dest_dir/recordit"
install -m 755 "$capture_src" "$dest_dir/sequoia_capture"

default_model_src="${RECORDIT_DEFAULT_WHISPERCPP_MODEL:-$runtime_input_dir/runtime/models/whispercpp/ggml-tiny.en.bin}"
runtime_manifest_dest="$resource_root/runtime/artifact-manifest.json"
model_dest_dir="$resource_root/runtime/models/whispercpp"
model_dest="$model_dest_dir/ggml-tiny.en.bin"
if [[ -f "$default_model_src" ]]; then
  mkdir -p "$model_dest_dir"
  if [[ -e "$model_dest" && "$default_model_src" -ef "$model_dest" ]]; then
    echo "[embed-runtime][copy] default whispercpp model already present at $model_dest"
  else
    install -m 644 "$default_model_src" "$model_dest"
    echo "[embed-runtime][copy] embedded default whispercpp model into $model_dest_dir"
  fi
else
  rm -f "$model_dest"
  fail_or_warn "prebuilt whispercpp model not found at $default_model_src; standard app runtime parity requires a bundled default model"
fi

if [[ -f "$runtime_artifact_manifest_src" ]]; then
  install -m 644 "$runtime_artifact_manifest_src" "$runtime_manifest_dest"
  echo "[embed-runtime][copy] embedded runtime artifact manifest into $runtime_manifest_dest"
else
  rm -f "$runtime_manifest_dest"
  fail_or_warn "runtime artifact manifest not found at $runtime_artifact_manifest_src; bundled runtime parity verification requires this manifest"
fi

echo "[embed-runtime][copy] embedded runtime binaries into $dest_dir"
