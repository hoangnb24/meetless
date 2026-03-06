#!/usr/bin/env bash
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$ROOT_DEFAULT}"

APP_PATH="${APP_PATH:-$ROOT/dist/Recordit.app}"
OUTPUT_DMG="${OUTPUT_DMG:-$ROOT/dist/Recordit.dmg}"
DMG_VOLNAME="${DMG_VOLNAME:-Recordit}"
STAGING_DIR="${STAGING_DIR:-$ROOT/.build/recordit-dmg-staging}"

usage() {
  cat <<USAGE
Usage: $0 [options]

Create a Recordit DMG with a drag-to-Applications UX surface.

Options:
  --app PATH          Path to Recordit.app bundle (default: dist/Recordit.app)
  --output PATH       Output DMG path (default: dist/Recordit.dmg)
  --volname NAME      Mounted DMG volume name (default: Recordit)
  --staging-dir PATH  Temporary staging directory (default: .build/recordit-dmg-staging)
  -h, --help          Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_PATH="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DMG="$2"
      shift 2
      ;;
    --volname)
      DMG_VOLNAME="$2"
      shift 2
      ;;
    --staging-dir)
      STAGING_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$APP_PATH" ]]; then
  echo "error: app bundle not found: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_DMG")"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

cp -R "$APP_PATH" "$STAGING_DIR/Recordit.app"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "$DMG_VOLNAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$OUTPUT_DMG"

echo "RECORDIT_DMG_PATH=$OUTPUT_DMG"
