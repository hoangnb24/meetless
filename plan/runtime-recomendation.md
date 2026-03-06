# Recordit.app Runtime Boundary Recommendation

Last updated: 2026-03-06
Primary tracking epic: `bd-22dc`
Documentation task: `bd-25as`

## Why this document exists

This document turns the 2026-03-05 Xcode live-runtime incident into an explicit architectural recommendation and an execution roadmap.

The key goal is not merely to fix the latest failure. The goal is to make `Recordit.app` reliable as a **DMG-first, no-terminal macOS product** where a user can:

1. install the app,
2. grant permissions,
3. start a live session,
4. stop it cleanly,
5. trust the resulting artifacts and status.

The incident made clear that the project is no longer blocked by one isolated bug. It is blocked by a **boundary problem**: multiple subsystems currently make overlapping claims about readiness, packaging, runtime ownership, and stop/finalization semantics.

This document is meant to be self-contained so a future agent can understand:

- what the correct Swift/Rust split is,
- what is wrong with the current boundary,
- what v1 release posture we should optimize for,
- what work must land first,
- how that work serves the product-level goal.

## Executive recommendation

### Bottom line

For v1, the best path is:

- keep the **SwiftUI shell + Rust runtime** split,
- ship `Recordit.app` as a **DMG-distributed, hardened-runtime, notarized macOS app**,
- **do not treat App Sandbox as a v1 requirement** while the app still launches embedded Rust executables directly,
- make **Rust preflight/runtime the single authority** for whether live transcription can run,
- narrow the default supported backend path to the bundled `whispercpp` model,
- move from signal-first stopping toward a **graceful app-oriented stop/finalization path**.

### Why this is the best v1 approach

Because it preserves the strongest parts of the current design while removing the main sources of confusion and instability:

- SwiftUI remains responsible for product UX, routing, remediation, and presentation.
- Rust remains responsible for the hard systems work: ScreenCaptureKit capture, ASR orchestration, JSONL event generation, manifest generation, and runtime truth.
- The product stops pretending that Xcode-debug validation, packaged validation, and release signing are interchangeable contexts when they are not.
- The app stops using two different definitions of “ready to start live.”

### What we are *not* recommending for v1

We are **not** recommending:

- rewriting the runtime into Swift,
- moving capture/ASR orchestration out of Rust for v1,
- claiming a sandboxed release while still validating a materially different unsandboxed app during development,
- broadening the default backend surface before bundle/runtime parity is trustworthy.

## What the incident actually taught us

The incident is best understood as four overlapping classes of failure.

### 1) Mismatched authority for live readiness

Today, live readiness is decided in more than one place:

- Swift-native checks use CoreGraphics / AVFoundation permission state.
- Rust preflight uses ScreenCaptureKit reality.
- Rust live runtime uses ScreenCaptureKit reality again at actual start time.

That means the app can enter contradictory states such as:

- macOS permissions appear granted,
- onboarding looks green,
- but Rust still fails because `SCShareableContent` is unavailable or no active display exists.

This is not a minor UX mismatch. It is an architecture bug. A desktop app must have exactly one authoritative answer to the question:

> “Can this user start live transcription right now in this app session?”

That authority should be the runtime preflight / runtime itself.

### 2) Mismatched validation context

The project currently mixes different build/run realities:

- Xcode app target behavior,
- build-phase script sandbox settings,
- `dist/Recordit.app` signing behavior,
- packaged validation and Gatekeeper/notarization checks.

This creates a false sense of progress when one context passes but another context is what users actually run.

A trustworthy productization path requires:

- one explicit dev validation context,
- one explicit packaged/release validation context,
- documentation of how they differ,
- and agreement on which one is authoritative for release decisions.

### 3) Cargo-inside-Xcode is the wrong seam

Running `cargo build` inside the Xcode embed phase made the build sensitive to `.cargo/config.toml`, local Rust toolchain state, and script sandbox behavior. That is exactly how the `.cargo/config.toml` denial appeared.

This is a structural problem, not just a build-script bug.

The right seam is:

1. build Rust artifacts explicitly,
2. hand them off as known inputs,
3. let Xcode copy/embed them into the app.

That separation makes build failures diagnosable and keeps packaging deterministic.

### 4) CLI-style stop semantics do not map cleanly to a GUI product

Today, stop behavior still has strong CLI assumptions:

- user presses Stop,
- process gets interrupted,
- app waits for final artifacts,
- failure is inferred from what happened after the signal.

That is acceptable for a CLI operator workflow, but weak for a GUI-first product.

The app needs a stronger stop contract:

- request graceful drain/finalization first,
- preserve logs/diagnostics even on failure,
- distinguish empty session, partial artifacts, finalized failure, and clean success.

## Are we taking the correct Swift vs Rust approach?

## Yes — with one correction

The high-level split is correct.

### SwiftUI should own

- app lifecycle,
- onboarding flow,
- permission education and deep links,
- model setup UX,
- session controls,
- transcript/status presentation,
- diagnostics presentation,
- release/user-facing messaging.

### Rust should own

- live capture orchestration,
- ScreenCaptureKit runtime truth,
- model resolution truth during actual runtime,
- ASR scheduling and execution,
- JSONL event generation,
- manifest generation,
- lifecycle state transitions that reflect runtime reality.

### The correction

Swift must not also become a second source of truth for runtime readiness.

Swift can ask for permissions, open settings, and explain failures. But Rust preflight/runtime should decide whether the live pipeline can actually start.

That means the architecture is not “Swift vs Rust.”
It is:

- **Swift for UX and orchestration**,
- **Rust for runtime truth**.

That is the right boundary for v1.

## Permissions: what is correct, what is incorrect

## What is already correct

The app already has the core privacy usage strings needed for prompts:

- `NSMicrophoneUsageDescription`
- `NSScreenCaptureUsageDescription`

The onboarding/remediation surfaces also already move in the right direction by using runtime preflight results in production rather than blindly normalizing to native permission state.

## What is still wrong

The product still conflates two different questions:

1. **Has macOS granted TCC permission?**
2. **Can the runtime execute live capture right now?**

Those are not the same thing.

A user can have Screen Recording permission and still fail live start because:

- there is no active display,
- ScreenCaptureKit shareable content is unavailable,
- the app session/runtime state is not actually ready.

### Correct permission model for v1

The app should model these separately:

#### A. TCC permission state

- Screen Recording granted / denied
- Microphone granted / denied

#### B. Runtime readiness state

- ScreenCaptureKit access OK / failed
- active display available / unavailable
- microphone stream observed / failed

#### C. User-facing result

The app should surface messages like:

- “Screen Recording permission is missing.”
- “Microphone permission is missing.”
- “Permissions are granted, but no active display is available.”
- “Permissions are granted, but runtime preflight still failed.”

That is the right mental model for a user and the right debug model for engineering.

## Model embedding and runtime mounting

## Current direction is mostly correct

The current bundle strategy is the correct *shape*:

- embed `recordit` and `sequoia_capture` under `Contents/Resources/runtime/bin/`
- embed the default `whispercpp` model under `Contents/Resources/runtime/models/whispercpp/`
- let app/runtime resolution prefer bundled assets first for the default path

This supports the no-terminal product goal.

## What needs to be tightened

### 1) Bundle parity must be verified explicitly

We should not assume that Xcode-built bundles, copied `dist/Recordit.app`, and release candidates all contain the same runtime/model payload.

This must be checked by automation.

### 2) v1 default backend scope should be narrower

The right v1 product stance is:

- `whispercpp` is the bundled, default, supported backend path
- `whisperkit` remains advanced/manual until it has equivalent packaging and packaged-validation parity

This is not anti-flexibility. It is pro-reliability.

### 3) App context and runtime context must agree

Any time the runtime can resolve a model in one app context but not another, the product becomes untrustworthy. So bundle/model parity is not “nice to have.” It is part of the product contract.

## Build, signing, and sandbox posture

## The real mismatch

Right now the repo simultaneously expresses these ideas:

- Xcode app target behavior that is effectively validating an unsandboxed app path,
- release packaging that later applies App Sandbox entitlements,
- an embedded-helper runtime architecture that is not the clean long-term shape for a sandboxed app.

That is too much ambiguity.

## Recommended v1 posture

For v1:

- optimize for **DMG distribution**,
- use **hardened runtime + notarization**,
- do **not** require App Sandbox while the app still launches embedded Rust executables directly,
- validate the same app posture you actually intend to ship.

## Why not App Sandbox in v1?

Because sandboxing is not just a signing tweak here. It is a boundary decision.

If sandboxing becomes mandatory later, the right architectural response is likely one of:

- move runtime functionality in-process,
- or expose it via a supported XPC/service boundary.

It is **not** simply “keep the same helper-executable architecture and layer on entitlements until it seems to work.”

That would create a fragile product and a debugging nightmare.

## Long-term posture

Long-term, a sandboxed app may still be the right direction. But that should be treated as a dedicated migration program, not as an incidental v1 hardening tweak.

## Stop/finalization recommendation

## What should change

The stop pipeline should become:

1. app requests graceful stop,
2. runtime drains and finalizes artifacts if possible,
3. app waits within a bounded window,
4. signal-based interruption/termination becomes fallback behavior,
5. diagnostics clearly classify the result.

## Required failure classes

The system should explicitly distinguish:

- **empty session root** — failure before useful runtime initialization completed
- **partial artifact session** — runtime started but did not finalize all expected artifacts
- **finalized failure** — manifest exists and says the run failed
- **finalized success** — manifest exists and says OK/degraded

This classification is important because each case implies a different root cause and remediation path.

## Why this serves the product goal

The overarching product goal is not “use Swift” or “use Rust.”
It is:

> deliver a trustworthy, GUI-first recording/transcription app that users can run without terminal knowledge.

This recommendation supports that goal by:

- keeping the strong systems work in Rust,
- keeping user-facing workflow and education in SwiftUI,
- removing hidden mismatches between what the user sees and what the runtime can do,
- making shipping posture explicit,
- tightening the default supported path instead of pretending broader support than we can validate,
- turning failure modes into diagnosable categories rather than opaque flakiness.

## Execution roadmap (bead graph)

## Primary epic

- `bd-22dc` — **[Epic] Recordit.app Runtime Boundary Stabilization and Release Posture**

This is the new parent epic for the runtime-boundary recommendation.

## Documentation task

- `bd-25as` — **Publish expanded runtime boundary recommendation and roadmap**

This task exists so the architectural reasoning remains traceable in Beads rather than living only in chat history.

## Execution feature 1: release posture and build-context parity

- `bd-2gw4` — **Lock v1 Recordit.app release posture and build-context parity**
  - `bd-1mep` — Decide/document v1 unsandboxed release posture and long-term sandbox migration boundary
  - `bd-1agx` — Replace cargo-in-Xcode runtime embedding with prebuilt artifact handoff and copy-only bundling
  - `bd-3mag` — Align Xcode validation, `dist/Recordit.app` signing, and entitlements verification into one trusted release context

### Why this lane exists

Without this lane, every later runtime bug is harder to interpret because the build/run context itself is unstable.

## Execution feature 2: single readiness authority

- `bd-2a08` — **Make runtime preflight the single authority for live readiness**
  - `bd-qdqt` — Remove duplicate native live-start gating from the main session flow
  - `bd-3r0m` — Model remediation states separately for TCC grant, active display availability, and runtime readiness
  - `bd-tr8z` — Add parity coverage between onboarding preflight, remediation surfaces, and actual live-start enablement

### Why this lane exists

This is the highest-leverage product fix because it replaces contradictory readiness states with one coherent contract and ensures that stricter gating still degrades into the most useful user path rather than a dead end.

## Execution feature 3: bundled runtime/model parity

- `bd-ufhs` — **Harden bundled runtime and model resolution for the v1 default backend**
  - `bd-355d` — Guarantee whispercpp model embedding parity across Xcode and packaged artifacts
  - `bd-1122` — Narrow v1 backend exposure to whispercpp and demote whisperkit to advanced/manual
  - `bd-diqp` — Add startup and packaged-smoke verification for runtime binary and model bundle parity

### Why this lane exists

A default backend is only real if it is bundled, resolved, and validated in the same app context the user runs.

## Execution feature 4: stop/finalization hardening

- `bd-cc3u` — **Stabilize live stop/finalization and failure artifact classification**
  - `bd-384f` — Preserve diagnostics and classify empty-session versus partial-artifact failures
  - `bd-3rqf` — Introduce a graceful live stop handshake before interrupt/terminate fallback
  - `bd-p77p` — Extend lifecycle coverage for early stop, partial artifacts, and manifest-finalization races

### Why this lane exists

Stop/finalization is where app-grade expectations diverge most from CLI-grade assumptions. This is the lane that converts the runtime from “works often enough” to “behaves like a product.”

## Existing closure umbrella

- `bd-34vh` — **Post-Validation Hardening: Recordit.app UI Reliability + Privacy Metadata**

This issue has been reparented under `bd-22dc` and now depends on the four execution features above.

That means release hardening cannot close independently of the deeper runtime-boundary work.

### Existing downstream children under `bd-34vh`

- `bd-g89x` — Retarget workflow/release gate to enforce strict UI validation for release candidates (now explicitly sequenced after `bd-3mag`)
- `bd-1vo3` — Clarify Gatekeeper/notarization expectations for local ad-hoc builds vs distributable artifacts (now explicitly sequenced after `bd-1mep` + `bd-3mag`)

These remain valid, but they should now be understood as **closure work**, not substitutes for the runtime-boundary fixes.

## Recommended sequencing

1. **`bd-2gw4` first**
   - stabilize release posture and build-context assumptions
2. **`bd-2a08` next**
   - unify readiness authority
   - preserve a clear `Record Only` fallback when live is blocked for model/backend reasons
3. **`bd-ufhs` in parallel with or immediately after feature 1**
   - make bundled model/runtime parity trustworthy
4. **`bd-cc3u` after readiness and model-start stability are no longer noisy**
   - otherwise stop-path work will be debugging the wrong failure class
5. **`bd-34vh` closure work after the above**
   - strict UI evidence, packaged validation, and release-doc polish

## Decision summary for future sessions

If you only remember five things from this document, remember these:

1. **SwiftUI + Rust is still the right v1 split.**
2. **Rust preflight/runtime should be the single authority for live readiness.**
3. **v1 should optimize for DMG + hardened runtime + notarization, not App Sandbox.**
4. **Cargo should not be part of the Xcode embed phase for the primary app path.**
5. **Stop/finalization must become app-oriented and diagnosable, not merely signal-driven.**
