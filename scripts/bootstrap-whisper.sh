#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}/.."
VENDOR_DIR="${ROOT_DIR}/Vendor/whisper.cpp"

cd "${ROOT_DIR}"

if [[ ! -d .git ]]; then
  echo "Meetless bootstrap expects a git checkout so it can initialize the pinned whisper.cpp submodule."
  exit 1
fi

if [[ ! -f .gitmodules ]]; then
  echo "Missing .gitmodules. The repo cannot initialize the pinned whisper.cpp dependency."
  exit 1
fi

if [[ ! -f "${VENDOR_DIR}/build-xcframework.sh" ]]; then
  echo "Initializing pinned whisper.cpp source into Vendor/whisper.cpp..."
  git submodule update --init --recursive Vendor/whisper.cpp
fi

"${ROOT_DIR}/scripts/build-whisper-xcframework.sh"
