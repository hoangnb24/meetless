# Post-M3 Electron Harness

Status: Accepted POC capability; native/live-source gate incomplete

Revision 1 corrects the POC review blockers. Base candidate
`83b981bd6a02e6155269dc4849f7e69a89e2984b` is superseded; the replacement
candidate is `POST-M3-E2E-IMPL-R1`.
The accepted implementation commit is
`1cbba679f35b0fcc7117305dc0ea3c8197d9139c`.

This runbook covers the owner-authorized post-M3 capability for capabilities 1,
3, 4, and 5. M4 remains closed. It preserves the accepted
`com.meetless.app/MeetlessHost` host and does not install or re-sign another
macOS application.

## Commands

Run from the repository root:

```text
npm run proof:post-m3:smoke
npm run proof:post-m3:fake
npm run proof:post-m3:native
npm run proof:post-m3
```

`proof:post-m3:smoke` uses Playwright's experimental `_electron.launch()` API
against a disposable renderer fixture. It proves title entry, Start/Stop
renderer behavior, screenshot capture, and tracing only. It does not prove
recording, TCC, physical WindowServer clicks, live Zoom/Meet input, or a native
provider.

`proof:post-m3:fake` launches the accepted host through LaunchServices, consumes
a fresh envelope, attaches Playwright to the exact host-owned renderer CDP
endpoint, and proves one complete deterministic fixture recording. The
correlation chain is:

```text
logical identity + run marker
  -> renderer title/Start/Stop
  -> recording socket status and runtime instance
  -> helper PID and source-labelled chunks
  -> MeetingStore saved recording and MP3 identity
  -> accepted ready fixture transcription
```

The manifest labels this evidence as generated fixture source. It is repository
wiring proof, not live-source or TCC evidence.

`proof:post-m3:native` attempts the same chain with the signed host native
provider socket. If that capability is missing or invalid, the command reports
`native-provider-unavailable` with `status: incomplete`, preserves the explicit
native label, and exits nonzero. `proof:post-m3` runs both modes and keeps their
labels separate; it also exits nonzero when native acceptance is incomplete.

Focused validation is discoverable with:

```text
npm run test:post-m3
npm run typecheck
npm run validate:isolation
npm run test:composition
```

## Identity and envelope

The tested desktop has the fixed logical ID `com.meetless.desktop`. A proof is
valid only when its fresh run marker also records:

- exact accepted bundle path `~/Applications/Meetless.app`;
- accepted bundle ID `com.meetless.app` and recorded 40-character CDHash;
- host PID -> desktop PID -> Electron ancestry and exact Electron executable;
- host and desktop process start instances, bound to the active marker;
- run-scoped loopback CDP address/port;
- runtime `instanceId` and fresh `runId`.

`com.github.Electron`, a window title, display name, or process-name lookup is
not a target identity by itself.

The one-shot `ui-test-envelope.json` lives under the accepted runtime root. The
runtime renames a valid envelope to `ui-test-run.json`, validates it, and
applies only that run's CDP, renderer marker, fixture, provider, export-root,
and accessibility controls. Missing, malformed, expired, or mismatched input
fails closed to normal production behavior. The envelope and marker are
removed by the proof cleanup.

The runtime root must be same-UID mode `0700`; envelope and marker files must
be same-UID regular non-symlinks with mode `0600`. A consumed marker is active
only while its recorded host and desktop PID/start instances are live. A later
desktop process cannot reactivate it; stale state is removed or ignored.

The integrated proof compares socket `runtime.uiTest` against the actual
`assertInstalledHostIdentity` result supplied as expected authority. Renderer
query markers only locate the page: acceptance also requires the trusted
Meetless macOS bridge and its exact managed runtime status.

Accessibility is opt-in within the consumed controlled envelope. The checked-in
Electron bootstrap can call `setAccessibilitySupportEnabled(true)` only when
the consumed marker has `forceAccessibility: true`; production has no such
call path. The integrated proof requests the least required
`labels-only-controlled-runtime` mode because Playwright can use the renderer's
explicit labels without claiming an OS accessibility event. The positive
forced mode and invalid/missing-envelope production negatives are covered by
the envelope and source-guard tests.

## Evidence boundary and cleanup

The proof records screenshots and Playwright traces under `/private/tmp` using
the fresh run ID. It stages the repository `.meetless-runtime` only after
preserving the existing root, stops only the exact accepted host it launched,
and restores the preserved root after each run. The JSON manifest reports
cleanup status, root restoration, run-state removal, live host PIDs, errors, and
the preserved diagnostic path; cleanup failure makes the command nonzero. Do
not delete a runtime root unless its ownership has first been established from
the proof output.

No proof result in this runbook establishes a physical pointer click, a TCC
grant, or a live Zoom/Meet source. Those remain external acceptance boundaries.
M4 must not use the deterministic fixture result as a substitute for that
fresh real-source gate.

Enforcement is repository-local: package scripts, positive/negative Vitest
proof, the source guard, and the correlation validator run locally. No CI,
hook, branch-protection, or external permission enforcement was added.
