# Spike Findings: Phase 3 Signing And Sandbox Feasibility

**Spike ID**: `bd-172`
**Question**: Can Meetless restore signing and sandboxing without breaking local session storage?
**Date**: 2026-04-23
**Result**: YES

## What I Checked

1. Confirmed the local machine has usable Apple Development signing identities.
2. Inspected the current Xcode build settings for signing and sandbox flags.
3. Ran a bounded build experiment that forces `CODE_SIGNING_ALLOWED=YES` without editing the project.
4. Inspected the built app's entitlements.
5. Rechecked the storage code path to see whether it uses the standard Application Support APIs that should relocate into the sandbox container at runtime.

## Commands Run

```bash
security find-identity -v -p codesigning

xcodebuild -showBuildSettings \
  -project Meetless.xcodeproj \
  -scheme Meetless \
  -configuration Debug | rg "CODE_SIGN|ENABLE_APP_SANDBOX|PRODUCT_BUNDLE_IDENTIFIER|DEVELOPMENT_TEAM|CODE_SIGN_ENTITLEMENTS"

xcodebuild -project Meetless.xcodeproj \
  -scheme Meetless \
  -configuration Debug \
  -sdk macosx \
  -derivedDataPath .derived/phase3-signing-spike \
  CODE_SIGNING_ALLOWED=YES \
  build

codesign -d --entitlements :- .derived/phase3-signing-spike/Build/Products/Debug/Meetless.app

rg -n "applicationSupportDirectory|Application Support|Sessions" \
  MeetlessApp/Services/AudioPipeline/SourceAudioPipeline.swift \
  MeetlessApp/Services/SessionRepository/SessionRepository.swift
```

## Evidence

- `security find-identity -v -p codesigning` returned valid Apple Development identities on this machine.
- The current project already has:
  - `DEVELOPMENT_TEAM = 63M98WD275`
  - `ENABLE_APP_SANDBOX = YES`
  - `CODE_SIGN_STYLE = Automatic`
  - but `CODE_SIGNING_ALLOWED = NO`
- The forced build with `CODE_SIGNING_ALLOWED=YES` completed successfully.
- The built app carried sandbox entitlements:

```xml
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.get-task-allow</key><true/>
```

- The session-artifact path already resolves through `FileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)` in both:
  - `MeetlessApp/Services/AudioPipeline/SourceAudioPipeline.swift`
  - `MeetlessApp/Services/SessionRepository/SessionRepository.swift`

## Interpretation

There is no structural blocker preventing Phase 3 from restoring real signing and sandbox behavior.

The current repo is already close:

- the development team is configured
- automatic signing is configured
- sandbox entitlement generation is already happening
- a signed build succeeds locally when code signing is re-enabled

What still needs implementation work is not feasibility but productization:

- make signing the default project configuration instead of an override
- add an explicit entitlements file that reviewers can inspect in source
- verify the runtime storage path after launch under the signed sandboxed app, so the session bundle lands where the product expects

## Answer

**YES** — Meetless can restore signing and sandboxing without a deeper architecture change. The risk is real but bounded to project configuration, entitlements wiring, and runtime storage verification.
