# Meetless DMG Distribution

This doc records the current practical distribution route for Meetless.

## Current Route: Internal DMG

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
- Verifies the DMG checksum.

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
