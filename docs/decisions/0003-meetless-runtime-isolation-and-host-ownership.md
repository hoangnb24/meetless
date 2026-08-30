# 0003 Meetless Runtime Isolation And Host Ownership

Date: 2026-08-30

## Status

Accepted

## Context

Paseo supplies the desktop shell, daemon lifecycle, protocol, and companion
transport. Meetless owns meeting, recording, transcript, chat, and citation
policy. These responsibilities must remain independently changeable without
turning a meeting into a Paseo workspace or allowing a renderer, direct CLI, or
companion cache to become a second source of truth.

The installed desktop runtime also crosses several trust boundaries: the
LaunchServices host, managed child processes, the packaged renderer, local
recording readiness, and remote companion connections. A socket, URL, process
name, or renderer state alone is not sufficient evidence of the intended
topology or readiness.

## Decision

### Runtime and host ownership

The production topology is:

```text
LaunchServices -> MeetlessHost -> desktop -> daemon/plugin -> Meetless policy
```

`MeetlessHost` is the owner of the packaged runtime and its child process
group. Packaged daemon entry points accept work only after the host-owned
topology is proven. Development entry points may remain usable without the
packaged assertion. The host owns startup ordering, identity, capability
readiness, bounded shutdown, and cleanup of processes and listeners that this
runtime owns.

The exact direct-install path, writable support root, bundle identity, media
transaction, and distribution gates remain owned by
[ADR0002](0002-direct-notarized-macos-dmg.md). Immutable packaged resources are
bundle-relative; packaged execution never falls back to a source checkout,
builder home, system tool, or Homebrew path.

### Meetless app boundary

The Meetless app depends inward on Meetless client, meeting policy, and plain
data contracts. It must not import Paseo app/screens or coding-product domain
records. Paseo UI and runtime facilities are consumed through explicit adapters
at the edge. Meetings, recordings, transcripts, chats, and citations remain
Meetless records and are never represented as Paseo agents, workspaces,
sessions, or timelines.

### Companion transport and state

Web and mobile companions use either:

- Paseo password-authenticated direct LAN transport; or
- Paseo encrypted relay transport anchored to the daemon public key.

The companion profile/session owns only pairing and connection state. It may
retain pairing configuration and transient presentation state, but never a
meeting-data replica or offline knowledge source. The durable
`MeetingStore` remains the product source of truth. Connection loss is an
explicit offline/reconnecting state, not an empty meeting list; reconnect must
revalidate capabilities and refresh the selected meeting, complete transcript,
and durable chat before new interaction is enabled. Companions do not record
system audio in V1. Citation playback crosses the boundary as stable
`{ meetingId, segmentId }` identity and resolves through the connected host.

Passwords, pairing links, relay secrets, transcript/audio payloads, and raw
transport logs do not enter renderer state, ordinary durable evidence, or
published proof.

### Renderer, readiness, and shutdown

The packaged renderer is served from the host-configured isolated renderer
origin. Its bytes and endpoint are attested as part of the package; packaged
mode does not start an Expo or repository renderer. Renderer and companion
adapters convert external protocol objects to plain Meetless values at the
boundary.

Recording controls are exposed only after the host-owned supervisor, daemon,
plugin, recording capability, and native readiness checks agree. Socket
existence is not readiness. Startup and shutdown are abortable and bounded:
startup cancellation closes owned clients and children, shutdown propagates
through the owned supervisor, and completion verifies absence of owned
processes, listeners, and sockets. Unknown, stale, or non-owned state is never
removed as cleanup.

## Alternatives Considered

1. Keep a raw daemon URL and reconnect-disabled client in the renderer:
   rejected because it bypasses pairing, reconnection, host ownership, and
   explicit offline truth.
2. Let the renderer or companion cache own meeting state: rejected because it
   duplicates durable authority and can present stale data as current truth.
3. Let each CLI, desktop, or helper entry point manage its own runtime:
   rejected because it permits duplicate supervisors and unsafe cleanup.
4. Copy Paseo app/domain records into Meetless: rejected by
   [ADR0001](0001-maintained-paseo-fork.md) and the product boundary.

## Consequences

Positive:

- Host ownership and readiness failures identify the responsible runtime edge.
- Meetless policy remains independent of Electron, Expo, WebSocket, and Paseo
  coding-product details.
- Direct LAN, encrypted relay, web, and mobile variations share one durable
  host-owned meeting state and one reconnection lifecycle.
- Shutdown and recovery can prove ownership before mutating process state.

Tradeoffs:

- The complete Paseo transport/runtime remains part of the dependency graph.
- Direct LAN transport is authenticated but is not encrypted against a LAN
  observer; the encrypted relay is a separate path.
- Local proof can establish topology and boundary contracts but cannot replace
  physical target, permission, or hosted-relay acceptance.

## Boundary And Verification

The predicted change is that runtime startup/transport/rendering details can
change without changing Meetless meeting policy. Host lifecycle, companion
session, renderer delivery, and durable meeting state therefore change for
different reasons and remain separate responsibilities.

Dependency direction is:

```text
host/runtime composition -> adapter -> Meetless policy and store
companion profile/session -> client adapter -> host capability -> MeetingStore
```

The smallest proof is a policy-free app-boundary check, a host/readiness
ownership test, a direct and relay adapter contract test, and one composition
check proving startup, revalidation, renderer delivery, and bounded shutdown.
Keep this boundary while more than one transport, runtime, or renderer/native
execution path changes independently. Remove it when one permanent runtime and
transport leave no independent variation to isolate.
