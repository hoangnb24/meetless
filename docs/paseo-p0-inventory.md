# Paseo P0 Adoption Inventory

Authority: maintained-fork decision at
[`decisions/0001-maintained-paseo-fork.md`](decisions/0001-maintained-paseo-fork.md).
Inventory base: the `vendor/paseo` submodule at Paseo commit
`ee3420e80d93f7f0c875fcd45e816a5a9d06188f`, tagged
`meetless-v1-base-2026-08-16` in `https://github.com/hoangnb24/paseo`.

The separate Paseo fork preserves complete packages and its workspace graph.
The paths below live in that repository and identify concrete P0 integration
seams; they are not directories to copy into the Meetless repository.

| Workspace | P0 reason | Concrete starting seams |
| --- | --- | --- |
| `packages/app` | Expo web/mobile/desktop renderer, routing, design system, host runtime | `app.config.js`, `src/app/_layout.tsx`, `src/runtime/`, `src/desktop/`, `src/hooks/use-audio-recorder.web.ts` (microphone mechanics only) |
| `packages/desktop` | Electron packaging, preload boundary, managed daemon | `src/main.ts`, `src/preload.ts`, `src/desktop-startup.ts`, `src/daemon/`, `electron-builder.yml`, `build/entitlements.mac*.plist` |
| `packages/server` | Daemon bootstrap, local state, WebSocket sessions, provider execution, speech mechanics | `src/server/bootstrap.ts`, `websocket-server.ts`, `session.ts`, `paseo-home.ts`, `managed-processes/`, `agent/`, `speech/` |
| `packages/client` | Client runtime, reconnect, WebSocket and relay transports | `src/daemon-client.ts`, `src/daemon-client-transport*.ts`, `src/daemon-client-websocket-transport.ts` |
| `packages/protocol` | Zod wire schemas, capabilities, RPC compatibility and generated validation | `src/messages.ts`, `src/client-capabilities.ts`, `src/daemon-endpoints.ts`, `src/validation/`, generated validator outputs |
| `packages/cli` | Desktop dependency and daemon lifecycle/diagnostics entrypoints | package entrypoints and daemon commands required by `packages/desktop` |
| `packages/highlight` | Transitive renderer/server build dependency | complete workspace until app/server usage is removed or replaced |
| `packages/plugin` | Transitive server/app contract | complete workspace; plugin product behavior is not P0 meeting scope |
| `packages/relay` | Client/server transport dependency | complete workspace for build closure; remote relay behavior is deferred from P0 |
| `packages/expo-two-way-audio` | Existing native microphone/audio mechanics | complete MIT workspace; it does not prove desktop system-audio capture |

`packages/website` is excluded from the P0 adoption surface.

Meetless owns meeting, recording, MP3 finalization, transcript, citation,
retrieval, and meeting-tool modules in the Meetless repository. Meetless
integrates with the pinned Paseo checkout through explicit adapters and does not
write product code inside these Paseo paths. Paseo voice sessions and audio
recorders are implementation references only: current desktop recording uses
`getUserMedia` microphone input and does not satisfy the system-audio gate.
