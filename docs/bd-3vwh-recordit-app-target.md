# bd-3vwh: Recordit.app @main Entrypoint and Project Target

Date: 2026-03-05

## Delivered

1. Added real macOS app project target:
   - `Recordit.xcodeproj`
   - shared scheme `RecorditApp`
2. Added SwiftUI app entrypoint and first window scene:
   - `app/RecorditApp/RecorditApp.swift` (`@main`)
   - `app/RecorditApp/MainWindowView.swift`
   - `app/RecorditApp/Info.plist`

## Deterministic Build Command

```bash
xcodebuild \
  -project Recordit.xcodeproj \
  -scheme RecorditApp \
  -configuration Debug \
  -destination 'platform=macOS,arch=arm64' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Deterministic Launch Proof (Local)

```bash
APP_PATH="${HOME}/Library/Developer/Xcode/DerivedData/Recordit-gpmddynhmqiolbcurcipiexqyywm/Build/Products/Debug/RecorditApp.app"
open -n "$APP_PATH"
sleep 2
pgrep -f "${APP_PATH}/Contents/MacOS/RecorditApp"
```

Observed result in this session:
- `xcodebuild` build succeeded
- app process observed after `open -n` (`RecorditApp launched`)

## Notes

- This bead establishes the concrete app target and `@main` lifecycle only.
- Deeper AppShell/runtime wiring remains follow-on scope (`bd-1e1h`, `bd-vhuq`, `bd-2hht`).
