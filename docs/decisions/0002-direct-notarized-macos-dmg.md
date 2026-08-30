# 0002 Distribute Meetless Directly As A Notarized macOS DMG

Date: 2026-08-26

## Status

Superseded by [ADR0005](0005-mac-app-store-and-revenuecat.md) on 2026-08-30.

This document remains historical authority for direct-DMG artifacts and proof.
Those artifacts must not be presented as Mac App Store evidence.

## Context

Meetless needs one macOS distribution path for V1 release planning. The owner
selected direct download rather than the Mac App Store.

## Decision

Distribute Meetless directly to users as a downloadable macOS `.dmg`.

The intended release path is:

1. build the release candidate and DMG;
2. sign the final code with the accepted Developer ID Application identity,
   hardened runtime, required entitlements, and a secure timestamp;
3. notarize the distributed artifact with Apple;
4. staple the accepted notarization ticket;
5. verify signatures, timestamp, notarization, staple, and DMG contents; and
6. verify Gatekeeper and first-run UX on a clean supported Mac, including the
   intended permission flow and app relaunch.

Release acceptance needs evidence from the exact downloadable artifact. Local
development launch, ad-hoc signing, a no-timestamp signing run, or a notarized
component does not establish release acceptance.

Mac App Store sandboxing, App Store Connect submission, and App Review are out
of scope unless the owner changes the distribution decision.

The repeatable candidate, package, sign, re-sign, and validation mechanics are
defined in the [macOS artifact-validation specification](../specs/macos-artifact-validation.md).
This decision remains the authority for the direct-install path and the
owner-bound package/media transaction. Runtime topology and host ownership are
defined by [ADR0003](0003-meetless-runtime-isolation-and-host-ownership.md);
recording permissions and helper ownership are defined by
[ADR0004](0004-recording-host-and-capture-permission-boundary.md).

## Consequences

- Developer ID signing, secure timestamping, notarization, stapling, and
  clean-machine Gatekeeper and UX verification are release gates.
- The release must include the accepted license, notice, Corresponding Source,
  and build/install material required for direct binary distribution.
- App Store packaging and review work must not be added to V1 release scope.
- Upload, publication, and promotion remain separate owner-authorized actions.

## M7-F23 Direct-install contract

The approved user flow is: open the downloaded DMG, drag `Meetless.app` to
`/Applications`, and launch only `/Applications/Meetless.app`. The DMG has
exactly two top-level entries: `Meetless.app` and an `Applications` symlink to
`/Applications`.

The native host performs the exact-path check before it acquires a lock,
creates a socket, creates runtime state, writes identity, starts a capability,
or starts a child. A mounted path such as `/Volumes/.../Meetless.app` and every
other alternate path stops with actionable drag-to-Applications guidance.

Immutable resources are resolved from the running bundle. They do not use a
builder home, source checkout, or repository fallback. Writable runtime state,
the store, logs, sockets, staging, Electron user data, and host identity are
under `~/Library/Application Support/Meetless`. Recording exports remain
`~/Documents/meetings`.

After exact-path and packaged-resource attestation, the native host publishes
first-run identity at `~/Library/Application Support/Meetless/host-identity.json`
before child startup. An update may refresh identity only when the exact path,
`com.meetless.app`, and the stable designated requirement are unchanged. Other
identity drift fails closed. The bundle ID, TCC owner, and accepted entitlement
map are unchanged.

One migration exception is accepted for users who installed an earlier
development/ad-hoc build. The host may replace a recorded requirement only
when all of these facts hold: the recorded requirement is exactly the legacy
`cdhash H"<40 hex characters>"` form; the running app is the real
`/Applications/Meetless.app`; its bundle ID is `com.meetless.app`; all packaged
resources pass attestation; and `codesign` verifies the complete bundle against
the Developer ID Application certificate OIDs and team `63M98WD275`. The host
then records the stable Developer ID designated requirement. Every later update
must match that requirement exactly. Ad-hoc-to-ad-hoc rotation, another path,
another bundle ID, another team, and invalid packaged resources remain rejected.

DMG construction is an outer packaging operation. It copies the app into a
disposable staging directory, creates the `Applications -> /Applications`
layout, and proves the source app fingerprint is unchanged before and after.
The local ad-hoc result is non-release evidence. It does not claim Developer ID
signing, secure timestamping, notarization, publication, or release acceptance.

The owner-deferred unclassified runtime-error item remains open. M7-F23 does
not classify, close, or change that owner decision.

### Packaged media update adoption (Option 1)

The owner approved Option 1 for the signed-update media-cache correction. The
native host remains the trust boundary: before the runtime can prepare or adopt
media, it must verify the exact `/Applications/Meetless.app` path, bundle ID
`com.meetless.app`, complete packaged-resource closure, and the Developer ID
signature requirement for team `63M98WD275`. The real packaged composition
performs that host verification before `prepareRuntime`; an arbitrary source
path is not an additional trust input.

The runtime owns one private `media-tools` closure under the accepted Meetless
support root. Its owner marker and manifest bind the closure to that runtime,
the package source, and the complete `bin`/`lib` tree. A complete source with
the recorded fingerprint is reused idempotently. When a complete verified
packaged source has a different fingerprint, the runtime copies it to a
staging directory, validates the copied closure, renames the existing closure
to an owned recoverable `previous` directory, and atomically publishes the
staged directory at `media-tools`. The previous directory is removed only
after the published closure is revalidated; a restart restores a previous
closure when publication stopped between the two renames and removes an owned
previous directory when the new closure is already visible.

Failures before publication leave the prior closure intact. Tampered,
partial, unowned, incomplete, escaping, non-packaged, system, and Homebrew
media remain fail-closed; no source or host-tool fallback is permitted. This
operation changes only the private media closure and its recovery metadata. It
does not inspect, replace, delete, or migrate meetings, recordings, audio,
transcripts, chats, exports, or other user data. The signer, bundle identity,
installation path, and trust set are unchanged.

### Transactional correction batch (SMTM-001–003)

Packaged CLI daemon startup is an additional host-owned entry point and must
fail closed before UI-test activation or `prepareRuntime` unless
`assertSupervisorOwnedByHost(config, process.pid)` proves the exact
LaunchServices → signed MeetlessHost → desktop → daemon topology. Development
daemon startup remains usable without that packaged-only assertion.

Replacement recovery records one private, owner-bound transaction manifest with
the exact staging path, previous path, new snapshot fingerprint, transaction
phase, and previous-directory device/inode. Recovery validates the published
target first. Only a published target whose fingerprint matches that durable
transaction may authorize cleanup of the exact recorded previous directory;
cleanup does not require the previous directory's contents to remain complete,
so an interrupted recursive removal can converge on restart. Missing,
malformed, mismatched, unowned, or arbitrary cleanup authorization fails
closed. A previous directory without a transaction manifest is only an active
rollback candidate and may be restored when the published target is absent; it
is never treated as obsolete cleanup state.

The correction preserves active-snapshot tamper rejection, package-root source
containment, no system/Homebrew fallback, and the no-user-data boundary.

### M7-F23 local proof

The repository-local candidate was produced with
`npm run package:macos:dmg` and the outer builder was rerun with
`node scripts/package-macos-dmg.mjs`. The generated candidate was validated with
`node scripts/validate-macos-package.mjs --signing-mode=local-ad-hoc` and
`npm run validate:macos:dmg`.

The final local evidence paths are:

- `release/macos/Meetless.app`
- `release/macos/composition-manifest.json`
- `release/macos/Meetless.dmg`
- `release/macos/Meetless.dmg.json`

The final app fingerprint is
`3b178cf12e7337275202d8b0f9c984812ac34c11f5ad758b583c27b48ff1d0c6` before
and after DMG construction. The DMG SHA-256 is
`b86fcd1ff54e1f5835a13a65912fed25033d4637364162e66a2e1a9af4455625`. The
composition artifact digest is
`1cd290f0c85391941639a014eea8394dcb8530c751b68e48ee35ce9168ca1de4`. The
layout digest is
`1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`.
The candidate snapshot is
`b24c9f4d4e9a28872bbcacb8591536743d55ecbc61903154a8d2c1d9203780e7`, with
HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`. The sidecar is local-only and
records `releaseAcceptance: not-claimed`.
