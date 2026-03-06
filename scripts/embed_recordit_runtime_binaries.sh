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

recordit_src="$runtime_input_dir/runtime/bin/recordit"
capture_src="$runtime_input_dir/runtime/bin/sequoia_capture"

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
model_dest_dir="$resource_root/runtime/models/whispercpp"
model_dest="$model_dest_dir/ggml-tiny.en.bin"
if [[ -f "$default_model_src" ]]; then
  mkdir -p "$model_dest_dir"
  install -m 644 "$default_model_src" "$model_dest"
  echo "[embed-runtime][copy] embedded default whispercpp model into $model_dest_dir"
else
  rm -f "$model_dest"
  echo "[embed-runtime][copy] warning: prebuilt whispercpp model not found at $default_model_src; onboarding model validation may require manual model path" >&2
fi

echo "[embed-runtime][copy] embedded runtime binaries into $dest_dir"
