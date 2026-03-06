#!/usr/bin/env bash
set -euo pipefail

ROOT="${SRCROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MANIFEST_PATH="$ROOT/Cargo.toml"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "error: Cargo manifest not found at $MANIFEST_PATH" >&2
  exit 1
fi

resolve_cargo_bin() {
  if [[ -n "${CARGO_BIN:-}" ]]; then
    if [[ -x "${CARGO_BIN}" ]]; then
      printf '%s\n' "${CARGO_BIN}"
      return 0
    fi
    echo "error: CARGO_BIN is set but not executable: ${CARGO_BIN}" >&2
    return 1
  fi

  local path_candidate
  path_candidate="$(command -v cargo 2>/dev/null || true)"
  if [[ -n "$path_candidate" && -x "$path_candidate" ]]; then
    printf '%s\n' "$path_candidate"
    return 0
  fi

  local fallback_candidates=(
    "$HOME/.cargo/bin/cargo"
    "/opt/homebrew/bin/cargo"
    "/usr/local/bin/cargo"
  )
  local candidate
  for candidate in "${fallback_candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "error: could not locate cargo. Install Rust toolchain or set CARGO_BIN to an absolute cargo path." >&2
  return 1
}

configuration="${RECORDIT_RUNTIME_CONFIGURATION:-${CONFIGURATION:-Release}}"
cargo_profile="debug"
if [[ "$configuration" == "Release" ]]; then
  cargo_profile="release"
fi

runtime_input_dir="${RECORDIT_RUNTIME_INPUT_DIR:-$ROOT/.build/recordit-runtime-inputs/$configuration}"
runtime_bin_dir="$runtime_input_dir/runtime/bin"
runtime_model_dir="$runtime_input_dir/runtime/models/whispercpp"
default_model_src="${RECORDIT_DEFAULT_WHISPERCPP_MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"

cargo_bin="$(resolve_cargo_bin)"

echo "[runtime-handoff][rust-build] configuration=$configuration profile=$cargo_profile"
echo "[runtime-handoff][rust-build] output_dir=$runtime_input_dir"
cargo_args=(build --manifest-path "$MANIFEST_PATH" --bin recordit --bin sequoia_capture)
if [[ "$cargo_profile" == "release" ]]; then
  cargo_args+=(--release)
fi
"$cargo_bin" "${cargo_args[@]}"

target_root="${CARGO_TARGET_DIR:-$ROOT/target}"
recordit_src="$target_root/$cargo_profile/recordit"
capture_src="$target_root/$cargo_profile/sequoia_capture"

if [[ ! -x "$recordit_src" ]]; then
  echo "error: recordit binary missing after rust build: $recordit_src" >&2
  exit 1
fi
if [[ ! -x "$capture_src" ]]; then
  echo "error: sequoia_capture binary missing after rust build: $capture_src" >&2
  exit 1
fi

mkdir -p "$runtime_bin_dir"
rm -f "$runtime_bin_dir/recordit" "$runtime_bin_dir/sequoia_capture"
rm -rf "$runtime_model_dir"
install -m 755 "$recordit_src" "$runtime_bin_dir/recordit"
install -m 755 "$capture_src" "$runtime_bin_dir/sequoia_capture"
echo "[runtime-handoff][rust-build] staged runtime binaries into $runtime_bin_dir"

if [[ -f "$default_model_src" ]]; then
  mkdir -p "$runtime_model_dir"
  install -m 644 "$default_model_src" "$runtime_model_dir/ggml-tiny.en.bin"
  echo "[runtime-handoff][rust-build] staged default whispercpp model into $runtime_model_dir"
else
  echo "[runtime-handoff][rust-build] warning: default whispercpp model not found at $default_model_src; live onboarding may require manual model path" >&2
fi

metadata_file="$runtime_input_dir/runtime_handoff.env"
cat >"$metadata_file" <<EOF
RECORDIT_RUNTIME_CONFIGURATION=$configuration
RECORDIT_RUNTIME_INPUT_DIR=$runtime_input_dir
RECORDIT_RUNTIME_BIN_RECORDIT=$runtime_bin_dir/recordit
RECORDIT_RUNTIME_BIN_CAPTURE=$runtime_bin_dir/sequoia_capture
RECORDIT_RUNTIME_MODEL_DEFAULT=$runtime_model_dir/ggml-tiny.en.bin
EOF
echo "[runtime-handoff][rust-build] wrote handoff metadata: $metadata_file"
