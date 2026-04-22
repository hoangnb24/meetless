# Spike Findings: bd-2gx

## Question

Can `whisper.cpp` be packaged behind an XCFramework wrapper that stays isolated from the app target?

## Verdict

YES

## Evidence

- The upstream `whisper.swiftui` README says to build an XCFramework first with `./build-xcframework.sh`, then add `build-apple/whisper.xcframework` to the app project.
- The same README warns that pushing aggressive C/C++ flags like `-O3 -DNDEBUG` into the app project is not ideal in a real app and suggests separating that build concern.
- The upstream README and releases confirm an XCFramework workflow exists and remains maintained in current releases.
- The local machine already has a current Apple toolchain suitable for the path: `Xcode 16.4` and `Swift 6.1.2`.

## Constraints

- Keep vendor build settings inside the wrapper/package boundary instead of the main app target.
- Bundle one pinned model inside the app for Phase 1 rather than adding model download workflows now.
- Validate bundle resource placement early so the wrapper can load the model from the app environment, not just from development paths.

## Impact On Phase 1

- `bd-2lw` should own the wrapper boundary and bundle-loading proof.
- `bd-3uo` only needs enough app-shell wiring to host that proof, not vendor build logic.

## Sources

- https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.swiftui/README.md
- https://github.com/ggml-org/whisper.cpp/releases
- https://github.com/ggml-org/whisper.cpp
