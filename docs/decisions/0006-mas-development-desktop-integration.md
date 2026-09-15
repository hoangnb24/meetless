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

The native host retains `com.meetless.app`. After archive composition and
replacement, the nested Electron main bundle uses the distinct identifier
`com.meetless.app.electron` together with the accepted build-scoped
`ElectronTeamID`, before signing. Producer, signed artifact and gate checks must
reject a nested identifier equal to the native host identifier. Electron's
renderer/GPU/plugin helper identities remain unchanged.

This corrects the original shared-identifier choice on 2026-09-15 after the
owner's TestFlight Open failure. Actual LaunchServices lookup selected embedded
Electron instead of MeetlessHost, causing the inherited-sandbox child to launch
without its sandboxed parent. The owner requested this startup failure fixed;
removing sandbox inheritance or clearing existing recording data is not a fix.
Exact old/new app identities and crash/lookup evidence are retained in the active
release plan.

The existing parent application group `63M98WD275.com.meetless.app`, provisioning
profile and child sandbox/inherit entitlements remain the authorized boundary.
No additional group or privilege is granted by this identity correction.
Electron 41.2.0 derives its internal BaseBundleID from `ElectronTeamID` plus the
inner bundle identifier ([bundle override source](https://github.com/electron/electron/blob/v41.2.0/shell/app/electron_main_delegate_mac.mm),
[bundle resolution source](https://github.com/electron/electron/blob/v41.2.0/shell/common/mac/main_application_bundle.mm)).
The new internal namespace therefore differs from the inherited parent group.
Source/gate acceptance does not prove IPC/app-group compatibility: a candidate
must be exercised through the actual Apple-distributed launch path with the
existing group/profile before runtime acceptance. If that fails, preserve the
failure and resolve the namespace explicitly; do not silently add entitlements
or treat inheritance alone as compatibility proof.

### MAS Electron bundle layout

The MAS development artifact places the Electron application at exactly
`Meetless.app/Contents/Helpers/Electron.app`; its main executable is
`Contents/Helpers/Electron.app/Contents/MacOS/Electron`. The MAS installation
contract carries the versioned descriptor
`MEETLESS_MAS_ELECTRON_BINARY v1` with `pathBase: "bundle"` and that exact
bundle-relative path. The runtime and native host resolve and attest this
descriptor from the outer bundle root, reject absolute or traversal paths,
symlink escapes, the legacy
`Contents/Resources/meetless/runtime/electron/Electron.app` location, and any
duplicate legacy nested app before launch. Other MAS resources remain
package-root-relative. The direct/notarized composition retains its existing
package-root-relative Electron route and carries no MAS descriptor.

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

The private-temp choices preserve the existing app-group policy, Paseo pin,
user data location, singleton routing, and sandbox boundary. The 2026-09-15
identifier correction keeps those privilege/data constraints, but its changed
Electron internal namespace still requires actual candidate compatibility proof. Source
and focused composition proof plus the owner-observed visible/interactable UI
support this development integration. They do not replace live proof of
recording/TCC, second-instance handoff, purchase/restore, managed production,
App Store publication, or legal release requirements. Those contracts remain
owned by [ADR0004](0004-recording-host-and-capture-permission-boundary.md),
[ADR0005](0005-mac-app-store-and-revenuecat.md), and the product documents.
