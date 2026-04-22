# Spike Findings: bd-2ne

## Question

Can one whisper context per source keep live dual-source transcription believable on Apple Silicon?

## Verdict

YES

## Evidence

- The upstream `whisper.swiftui` sample wraps the context in a Swift `actor` with the note that the whisper context should not be accessed from more than one thread at a time.
- The same sample loads the model from the app bundle, which matches the planned local model packaging.
- The upstream README documents an XCFramework path for Apple platforms and highlights Apple Silicon acceleration paths including Metal, with Core ML as an optional optimization rather than a requirement.
- The upstream README also documents that `base.en` has a meaningful memory footprint, so model size is a first-order product choice when two contexts stay live.

## Constraints

- Keep one isolated `WhisperSourceWorker` per source, each with its own context.
- Do not share one mutable context across `Meeting` and `Me`.
- Start with a modest model class for Phase 1, such as `base.en` or smaller/quantized if early validation says memory or latency is too high.
- Treat Core ML as Phase 3 optimization territory unless early implementation proves Phase 1 unusable without it.

## Impact On Phase 1

- `bd-2lw` should keep the bridge contract actor-safe and context-local.
- `bd-2rx` should consume committed chunk updates from source-local workers rather than trying to interleave low-level inference state across both sources.

## Sources

- https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.swiftui/README.md
- https://github.com/ggml-org/whisper.cpp
