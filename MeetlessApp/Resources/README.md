Meetless app resources live here.

The app target packages these resources into `Meetless.app`:

- `Models/ggml-tiny.en.bin` - bundled whisper.cpp model used by the local
  transcription workers.
- `Samples/jfk.wav` - bundled smoke-transcription sample used by the local
  whisper bridge.
- `Assets.xcassets` - asset catalog for the app icon.
- `MeetlessIcon.icns` - macOS bundle icon referenced by `Info.plist`.
- `IconSource/` - source artwork and generated PNG used to produce the icon
  assets.

The packaging script verifies that `ggml-tiny.en.bin` is present in the Release
app bundle before creating a DMG. The embedded `whisper.xcframework` lives under
`Vendor/whisper.cpp/build-apple/` and is copied through the Xcode framework
embedding phase rather than this resources directory.
