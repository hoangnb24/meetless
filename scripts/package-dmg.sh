#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}/.."
DERIVED_DATA_DIR="${ROOT_DIR}/.derived/release"
DIST_DIR="${ROOT_DIR}/.dist"
STAGING_DIR="${DIST_DIR}/staging"
DMG_NAME="${DMG_NAME:-Meetless-$(date +%Y%m%d-%H%M).dmg}"
DMG_PATH="${DIST_DIR}/${DMG_NAME}"
APP_PATH="${DERIVED_DATA_DIR}/Build/Products/Release/Meetless.app"
MODEL_PATH="${ROOT_DIR}/MeetlessApp/Resources/Models/ggml-tiny.en.bin"
WHISPER_XCFRAMEWORK="${ROOT_DIR}/Vendor/whisper.cpp/build-apple/whisper.xcframework"

cd "${ROOT_DIR}"

if [[ ! -f "${MODEL_PATH}" ]]; then
  echo "Missing bundled whisper model: ${MODEL_PATH}" >&2
  exit 1
fi

if [[ ! -d "${WHISPER_XCFRAMEWORK}" ]]; then
  echo "Missing whisper.xcframework. Run ./scripts/bootstrap-whisper.sh first." >&2
  exit 1
fi

mkdir -p "${DERIVED_DATA_DIR}" "${DIST_DIR}"

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  xcodebuild test \
    -project Meetless.xcodeproj \
    -scheme Meetless \
    -destination 'platform=macOS'
fi

build_args=(
  -project Meetless.xcodeproj
  -scheme Meetless
  -configuration Release
  -derivedDataPath "${DERIVED_DATA_DIR}"
  build
)

if [[ -n "${DEVELOPER_ID_APPLICATION:-}" ]]; then
  build_args+=(
    CODE_SIGN_STYLE=Manual
    "CODE_SIGN_IDENTITY=${DEVELOPER_ID_APPLICATION}"
    ENABLE_HARDENED_RUNTIME=YES
  )
fi

xcodebuild "${build_args[@]}"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Release build did not produce ${APP_PATH}" >&2
  exit 1
fi

if [[ ! -f "${APP_PATH}/Contents/Resources/ggml-tiny.en.bin" ]]; then
  echo "Release app is missing the bundled whisper model." >&2
  exit 1
fi

if ! find "${APP_PATH}/Contents/Frameworks" -name whisper -type f -perm +111 -print -quit | grep -q .; then
  echo "Release app is missing the embedded whisper framework binary." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

set +e
spctl -a -vv --type execute "${APP_PATH}"
spctl_status=$?
set -e

if [[ ${spctl_status} -ne 0 ]]; then
  echo "Warning: Gatekeeper assessment did not pass. For frictionless colleague installs, sign with a Developer ID Application certificate and notarize the DMG." >&2
fi

rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
ditto "${APP_PATH}" "${STAGING_DIR}/Meetless.app"
ln -s /Applications "${STAGING_DIR}/Applications"

rm -f "${DMG_PATH}"
hdiutil create \
  -volname "Meetless" \
  -srcfolder "${STAGING_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

hdiutil verify "${DMG_PATH}"

if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  xcrun notarytool submit "${DMG_PATH}" --keychain-profile "${NOTARY_KEYCHAIN_PROFILE}" --wait
  xcrun stapler staple "${DMG_PATH}"
  xcrun stapler validate "${DMG_PATH}"
fi

echo "Created ${DMG_PATH}"
