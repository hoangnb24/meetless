# 0004 Recording Host And Capture Permission Boundary

Date: 2026-08-30

## Status

Accepted

## Context

Meetless records microphone and system audio on the desktop while preserving a
recoverable local recording. macOS permission prompts, the packaged host, the
native capture helper, the daemon store, and the renderer have different
responsibilities. Treating a helper, renderer, or display-capture error as the
permission authority creates incorrect prompts, unsafe startup, and lost media.

The desktop app must also remain usable when permission is denied or not yet
determined so it can render recovery guidance. Permission readiness must gate
recording/session creation and helper startup without making MeetingStore
bootstrap or permission recovery impossible.

## Decision

### Owners and trust boundary

The packaged `com.meetless.app` host is the sole TCC owner. `MeetlessHost` owns
the public microphone and Screen/System Audio status APIs, user-initiated
requests, the return-active recheck, and supported System Settings recovery.
The native `meetless-capture` helper owns capture streams and durable chunks;
it is not a second permission or meeting-lifecycle owner. The daemon-side
`MeetingStore` owns meeting/recording lifecycle, committed chunks, finalization,
and saved output identity.

The approved packaged signing policy gives the outer app,
`Contents/MacOS/MeetlessHost`, and the independently signed
`native/macos-capture/meetless-capture` exactly the audio-input entitlement.
No screen-capture entitlement is introduced. The outer `Info.plist` owns
non-empty microphone, screen-capture, and system-audio purpose strings. The
complete per-executable entitlement map and its validation stages are owned by
[the macOS artifact-validation specification](../specs/macos-artifact-validation.md).

### Typed permission and recording lifecycle

Permission status is typed separately as `microphone` and `systemAudio`, with
states such as authorized, denied, restricted, and notDetermined. UI guidance
names the source. A localized ScreenCaptureKit display error is not inferred to
mean that System Audio permission has a particular state.

MeetingStore bootstrap may occur so the app can render status and recovery.
Neither `store.create` for a recording session nor native helper construction
may occur until both required sources are authorized. The existing second
pre-helper authorization gate remains. If capture startup fails, the accepted
zero-media rollback and retained-media recovery rules apply; valid chunks are
not deleted merely because permission or helper startup failed.

### Renderer request boundary

Permission-changing requests originate from an explicit user action in the
packaged renderer. The host accepts only the exact configured renderer
Host/Origin and a fresh one-use server-issued intent. Missing, malformed,
foreign, expired, or replayed intent fails before native invocation. Status is
read-only. Transport, decode, and settings failures remain visible and expose
an actionable recheck; a false `settingsOpened` result is failure.

No permission secret, raw native error, or unrelated display-capture wording is
promoted into durable meeting state or published evidence.

## Alternatives Considered

1. Give only the helper the audio-input entitlement: rejected because the
   packaged host owns the TCC interaction and must perform pre-start readiness.
2. Request permissions directly from renderer code: rejected because renderer
   content is not the host/TCC authority and could be spoofed or replayed.
3. Create a Meeting before permission is ready: rejected because it leaves
   misleading empty sessions and violates the zero-media startup invariant.
4. Add a second XPC or capture policy path: rejected because the existing
   authenticated host capability and helper boundary already isolate the
   required variation.

## Consequences

Positive:

- Permission state, recording lifecycle, and native capture have one explicit
  owner each and can fail with source-specific diagnostics.
- Denied/not-determined permission remains recoverable in context without
  creating a false recording or losing valid media.
- The renderer cannot turn a stale or cross-origin request into a native
  permission mutation.

Tradeoffs:

- Real TCC attribution, clean-install behavior, and persistence across update
  remain external acceptance gates.
- The helper and host must remain packaged and signed according to the exact
  artifact policy; local fixture mode cannot prove production permission.

## Boundary And Verification

The predicted change is that permission API/runtime details can change without
changing recording policy, chunk durability, or presentation. Host permission
calls, helper capture, store lifecycle, and renderer recovery therefore remain
independent responsibilities.

Dependency direction is:

```text
renderer user action -> authenticated host permission adapter -> typed status
recording use case -> MeetingStore <- chunk/helper and finalizer adapters
```

The smallest proof is a pure typed-status/state-mapping test, host capability
request/response tests, plugin tests proving no `store.create` or helper spawn
before authorization, and one composition check for rollback/recovery. Keep
this boundary while macOS permission APIs or capture runtimes vary independently;
remove it only when the recording host and helper are one permanent runtime with
no separate permission or capture responsibility.
