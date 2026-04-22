#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}/.."
VENDOR_DIR="${ROOT_DIR}/Vendor/whisper.cpp"

if [[ ! -d "${VENDOR_DIR}" ]]; then
  echo "Vendor/whisper.cpp is missing. Clone the pinned vendor source first."
  exit 1
fi

cd "${VENDOR_DIR}"
BUILD_STATIC_XCFRAMEWORK=ON ./build-xcframework.sh
