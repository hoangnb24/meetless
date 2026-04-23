#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}/.."
VENDOR_DIR="${ROOT_DIR}/Vendor/whisper.cpp"
FRAMEWORK_DIR="${VENDOR_DIR}/build-apple/whisper.xcframework"

if [[ ! -f "${VENDOR_DIR}/build-xcframework.sh" ]]; then
  echo "Vendor/whisper.cpp is not initialized. Run ./scripts/bootstrap-whisper.sh first."
  exit 1
fi

cd "${VENDOR_DIR}"
echo "Building whisper.xcframework at ${FRAMEWORK_DIR}..."
BUILD_STATIC_XCFRAMEWORK=ON ./build-xcframework.sh
echo "whisper.xcframework is ready."
