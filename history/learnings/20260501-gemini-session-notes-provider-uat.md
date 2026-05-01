---
date: 2026-05-01
feature: gemini-session-notes
categories: [pattern, decision, failure]
severity: critical
tags: [gemini, macos-sandbox, provider-integration, uat, swiftui]
---

# Learning: Gemini Session Notes Provider UAT

## Learning 1: Mac Sandboxed Network Features Need Entitlement Review

**Category:** failure
**Severity:** critical
**Tags:** [macos-sandbox, entitlements, provider-integration]
**Applicable-when:** Adding any app feature that sends local data to an external provider from a sandboxed macOS target.

### What Happened

Gemini Session Notes passed service tests and automated review, but human UAT failed when Generate surfaced "Meetless could not prepare the Gemini request." The app target had sandbox and audio-input entitlements, but it did not have `com.apple.security.network.client`. The fix added outbound network entitlement in `MeetlessApp/Meetless.entitlements` and reran `xcodebuild test -project Meetless.xcodeproj -scheme Meetless -destination 'platform=macOS'`, which passed with 57 tests.

### Root Cause / Key Insight

Unit tests with fake transports can prove request construction, persistence rollback, and UI state, but they do not prove the signed macOS app is allowed to make outbound network calls. Entitlements are part of the runtime contract for provider features, not release-only packaging detail.

### Recommendation for Future Work

When a sandboxed macOS feature calls any external service, review entitlements during planning and validation, then verify the signed app path during review/UAT. Treat missing `com.apple.security.network.client` as a P1 blocker for external-provider features.

## Learning 2: Provider Fixture Tests Must Mirror The Real Upload Protocol

**Category:** failure
**Severity:** critical
**Tags:** [gemini, files-api, request-builder, uat]
**Applicable-when:** Building provider clients where upload/session setup has more than one request or depends on response headers.

### What Happened

The first Gemini upload client used a one-step raw file upload and fixture tests accepted that shape. Human UAT failed before useful generation, and review created P1 bead `bd-21r`. The fix changed `GeminiSessionNotesClient` to use the documented resumable Files API flow: start upload, read `X-Goog-Upload-URL`, upload/finalize audio bytes, then call `generateContent` with returned file URIs. The focused Gemini suite passed with 24 tests after the request-builder tests were updated to assert five requests for two audio files.

### Root Cause / Key Insight

The initial tests checked internal consistency, not enough provider fidelity. For multi-step provider APIs, a mock transport can accidentally bless the wrong protocol unless tests assert the actual documented sequence, required headers, auth placement, response headers, and final model request.

### Recommendation for Future Work

When validating external API clients, make fixture tests encode the provider's real wire sequence and rerun docs/live-shape verification before review. If UAT reports a generic client/request error, inspect protocol shape and app runtime permissions before tuning user copy.

## Learning 3: Service-First Phasing Protected Local Session Data

**Category:** pattern
**Severity:** standard
**Tags:** [session-repository, rollback, orchestration, phase-design]
**Applicable-when:** Adding generated artifacts to saved local bundles.

### What Happened

The feature landed as secure storage, persistence, audio resolution, provider client/parser/orchestrator, then UI lifecycle. `SessionRepository.saveGeneratedNotes` writes generated notes transactionally, the orchestrator saves only after successful provider and parser completion, and Session Detail disables regeneration after notes exist. Tests covered missing key, missing audio, provider/auth/client/parser/persistence failures, and already-generated sessions without corrupting bundles.

### Root Cause / Key Insight

Generated notes are derived artifacts inside local saved-session bundles, so the repository must remain the bundle authority and the provider path must be success-only. Keeping SwiftUI as a renderer of view-model state made failure and retry behavior easier to validate without touching local data prematurely.

### Recommendation for Future Work

When adding generated outputs to local saved data, land persistence and rollback tests before UI wiring. Use an app-level orchestrator boundary, keep provider responses out of SwiftUI, and assert that every failure path leaves the original bundle unchanged.

## Learning 4: Hidden Generated Text Still Needs A Display-Path Audit

**Category:** pattern
**Severity:** standard
**Tags:** [source-labels, generated-content, product-trust]
**Applicable-when:** Persisting AI-generated transcript or notes while showing only a subset in the UI.

### What Happened

The locked product rule kept Gemini's combined transcript persisted but hidden from the v1 Session Detail surface. Parser tests reject visible summary/action-item labels such as raw `Meeting` / `Me` source wording, and display tests assert the hidden transcript does not appear in Summary or Action Items. Review still had to audit notices, generated notes, and persisted display paths because prior Meetless work had leaked source labels through saved-detail copy.

### Root Cause / Key Insight

Hiding a field in the main UI is not enough when generated text is persisted and transformed across parser, repository, view model, and SwiftUI display paths. Product-trust wording has to be guarded at both parse time and display time.

### Recommendation for Future Work

When generated content must hide internal model/source labels, add parser rejection for invalid output and separate display-path tests for every visible surface. Do not rely only on prompt wording or one final string replacement.
