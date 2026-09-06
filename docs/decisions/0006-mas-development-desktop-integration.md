# 0006 MAS Development Desktop Integration

Date: 2026-09-06

## Status

Accepted development-integration decision. This does not establish Mac App
Store publication, production billing, real recording, or release acceptance.

## Context

The accepted Mac App Store package path needed a stable Electron namespace and
an isolated Chromium temporary directory without changing the sandbox,
entitlement, host-ownership, or dependency policy. The resulting desktop UI
proof is useful development evidence, while the remaining external gates stay
separate.

## Decision

### MAS Electron identity

After archive composition and replacement, the nested Electron main bundle must
carry the exact Meetless main bundle identifier `com.meetless.app` together with
the accepted build-scoped `ElectronTeamID`, before signing. Final artifact
validation checks both the nested plist bundle identifier and the signed main
Electron identifier. Their Team ID plus main bundle ID must remain aligned with
the parent application-group namespace already authorized by the MAS package.
No new application group, entitlement, profile, or signing allowance is
introduced; helper identities remain unchanged.

### Host and Paseo ownership

Meetless owns product policy, host handoff/readiness, recording policy, and
durable meeting evidence. The separately maintained and pinned Paseo fork
supplies its approved runtime supervisor/daemon infrastructure under
[ADR0001](0001-maintained-paseo-fork.md) and
[ADR0003](0003-meetless-runtime-isolation-and-host-ownership.md). Meetless
meetings and evidence are not represented as Paseo workspaces or agents.

### Private MAS Electron temporary space

For a validated MAS installation, the Electron child receives a fresh short
directory under the canonical container's `Data/tmp`, derived from its validated
`Data/Library/Application Support` location. The
directory is created with private permissions, its canonical root/parent and
bounded UTF-8 path are checked, and abort is checked before and after creation
and before spawn. Only the Electron child receives the explicit
`MAC_CHROMIUM_TMPDIR`; an ambient value is not trusted in the MAS daemon or
renderer environment. Direct/development behavior remains unchanged.

Electron keeps its existing `userData` and singleton behavior. The owned fresh
directory is released only after a successful owned shutdown and confirmed
child absence. Unknown-identity, unavailable, or non-empty directories are
retained; cleanup is a bounded non-recursive operation on the owned fresh
directory and never a sweep of existing temporary state.

### Role-configuration boundary

The Paseo fork and Meetless artifacts must not contain Codex Room
Supervisor/Lead/Peer role configuration. Those role prompts, profiles, and
room setup belong only to `codex-room-setup`. The legitimate Paseo runtime
process named `Paseo Supervisor` is a process manager, not the Codex Room
Supervisor role, and remains governed by the runtime ownership decisions.

## Consequences and limits

The namespace and private-temp choices preserve the existing app-group policy,
Paseo pin, user data location, singleton routing, and sandbox boundary. Source
and focused composition proof plus the owner-observed visible/interactable UI
support this development integration. They do not replace live proof of
recording/TCC, second-instance handoff, purchase/restore, managed production,
App Store publication, or legal release requirements. Those contracts remain
owned by [ADR0004](0004-recording-host-and-capture-permission-boundary.md),
[ADR0005](0005-mac-app-store-and-revenuecat.md), and the product documents.
