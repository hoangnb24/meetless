#!/usr/bin/env bash
set -euo pipefail

if [[ "${RECORDIT_EMBED_RUNTIME_BINARIES:-1}" == "0" ]]; then
  echo "[embed-runtime] RECORDIT_EMBED_RUNTIME_BINARIES=0; skipping"
  exit 0
fi

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

cargo_bin="$(resolve_cargo_bin)"

cargo_profile="debug"
if [[ "${CONFIGURATION:-Debug}" == "Release" ]]; then
  cargo_profile="release"
fi

echo "[embed-runtime] building recordit + sequoia_capture (profile=$cargo_profile)"
cargo_args=(build --manifest-path "$MANIFEST_PATH" --bin recordit --bin sequoia_capture)
if [[ "$cargo_profile" == "release" ]]; then
  cargo_args+=(--release)
fi
"$cargo_bin" "${cargo_args[@]}"

target_root="${CARGO_TARGET_DIR:-$ROOT/target}"
recordit_src="$target_root/$cargo_profile/recordit"
capture_src="$target_root/$cargo_profile/sequoia_capture"

if [[ ! -x "$recordit_src" ]]; then
  echo "error: recordit binary missing after build: $recordit_src" >&2
  exit 1
fi
if [[ ! -x "$capture_src" ]]; then
  echo "error: sequoia_capture binary missing after build: $capture_src" >&2
  exit 1
fi

resource_root="${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
dest_dir="$resource_root/runtime/bin"
mkdir -p "$dest_dir"

install -m 755 "$recordit_src" "$dest_dir/recordit"
install -m 755 "$capture_src" "$dest_dir/sequoia_capture"

default_model_src="${RECORDIT_DEFAULT_WHISPERCPP_MODEL:-$ROOT/artifacts/bench/models/whispercpp/ggml-tiny.en.bin}"
model_dest_dir="$resource_root/runtime/models/whispercpp"
if [[ -f "$default_model_src" ]]; then
  mkdir -p "$model_dest_dir"
  install -m 644 "$default_model_src" "$model_dest_dir/ggml-tiny.en.bin"
  echo "[embed-runtime] embedded default whispercpp model into $model_dest_dir"
else
  echo "[embed-runtime] warning: default whispercpp model not found at $default_model_src; onboarding model validation may require manual model path" >&2
fi

echo "[embed-runtime] embedded runtime binaries into $dest_dir"
