# Meetless DMG Distribution

This doc records the practical distribution routes for Meetless.

The packaging script builds the Release app, verifies required bundled runtime
assets, signs the app according to the provided environment, creates a compressed
DMG under `.dist/`, and verifies the DMG image.

## Packaging Script Options

`./scripts/package-dmg.sh` accepts configuration through environment variables:

| Variable | Purpose |
| --- | --- |
| `SKIP_TESTS=1` | Skips the pre-package `xcodebuild test` step. |
| `DMG_NAME=<name>.dmg` | Sets the output DMG filename under `.dist/`. |
| `DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)"` | Builds with manual Developer ID signing and hardened runtime. |
| `NOTARY_KEYCHAIN_PROFILE=Meetless-Notary` | Submits the DMG to Apple's notary service, staples the ticket, and validates the stapled DMG. |

Prerequisites:

- `MeetlessApp/Resources/Models/ggml-tiny.en.bin` exists.
- `Vendor/whisper.cpp/build-apple/whisper.xcframework` exists.
- The app entitlements include sandboxing, microphone input, and outbound
  network access for Gemini notes generation.

Prepare the pinned whisper framework when needed:

```zsh
./scripts/bootstrap-whisper.sh
```

## Internal DMG Route

Use this when you want a DMG for yourself, teammates, or technical testers and
you accept that macOS may show a Gatekeeper warning.

```zsh
SKIP_TESTS=1 \
DMG_NAME="Meetless-internal-$(date +%Y%m%d-%H%M).dmg" \
DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)" \
./scripts/package-dmg.sh
```

What this does:

- Builds the Release app.
- Signs the app and embedded `whisper.framework` with Developer ID.
- Verifies the app signature.
- Checks that `ggml-tiny.en.bin` is bundled.
- Checks that the embedded `whisper` framework binary is present.
- Creates a compressed DMG in `.dist/`.
- Verifies the DMG image.
- Leaves notarization out unless `NOTARY_KEYCHAIN_PROFILE` is set.

Expected warning for this route:

```text
Gatekeeper assessment did not pass
source=Unnotarized Developer ID
```

That warning is expected because this internal route does not submit the DMG to
Apple's notarization service.

## User Install Notes

People installing this internal DMG may need to approve the app manually:

1. Open the DMG.
2. Drag `Meetless.app` to `/Applications`.
3. If macOS blocks the first launch, right-click `Meetless.app` and choose
   `Open`.
4. If needed, go to `System Settings > Privacy & Security` and choose
   `Open Anyway` for Meetless.

Use this route only for internal testing or trusted users who understand the
manual approval step.

## Fully Trusted Public Route

Use this when the goal is a DMG that normal users can open without the
unnotarized Developer ID warning.

First store notary credentials in Keychain:

```zsh
xcrun notarytool store-credentials "Meetless-Notary" \
  --apple-id "YOUR_APPLE_ID_EMAIL" \
  --team-id "63M98WD275" \
  --password "APP_SPECIFIC_PASSWORD" \
  --validate
```

Then build and notarize:

```zsh
DEVELOPER_ID_APPLICATION="Developer ID Application: Long Le (63M98WD275)" \
NOTARY_KEYCHAIN_PROFILE="Meetless-Notary" \
./scripts/package-dmg.sh
```

The script submits the DMG to Apple's notary service, waits for the result,
staples the ticket, and validates the stapled DMG when
`NOTARY_KEYCHAIN_PROFILE` is set.

## Quick Checks

Run the full app test suite:

```zsh
xcodebuild test \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -destination 'platform=macOS'
```

Check available signing identities:

```zsh
security find-identity -p codesigning -v
```

Check the built app signature:

```zsh
codesign -dvvv --entitlements :- .derived/release/Build/Products/Release/Meetless.app
```

Check Gatekeeper status:

```zsh
spctl -a -vv --type execute .derived/release/Build/Products/Release/Meetless.app
```

Check whether a DMG has a stapled notarization ticket:

```zsh
xcrun stapler validate .dist/<dmg-name>.dmg
```
