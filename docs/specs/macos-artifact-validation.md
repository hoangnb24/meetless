# macOS Artifact Validation

Date: 2026-08-30

## Status

Accepted operational specification

## Authority

[ADR0002](../decisions/0002-direct-notarized-macos-dmg.md) owns the direct DMG,
installation, distribution, and private media-transaction policy.
[ADR0001](../decisions/0001-maintained-paseo-fork.md) owns Paseo provenance and
the pinned dependency. [ADR0003](../decisions/0003-meetless-runtime-isolation-and-host-ownership.md)
owns runtime topology and host ownership. [ADR0004](../decisions/0004-recording-host-and-capture-permission-boundary.md)
owns the recording permission boundary. This specification owns the mechanics
and evidence shape of the candidate/package/sign/re-sign/validation stages.

## Stage Order

The stages are ordered and must not be collapsed into one ambiguous release
claim:

```text
candidate -> package -> sign -> re-sign (when required) -> validate -> owner gates
```

Every stage records the exact input identity it consumed. A later stage cannot
silently repair or replace an earlier identity.

## Candidate Stage

The candidate stage captures a deterministic repository package-source snapshot
with `node scripts/candidate-snapshot.mjs`. It binds:

- the repository HEAD and relevant source inputs;
- the exact pinned Paseo commit and provenance from ADR0001; and
- the source snapshot digest and command used to derive it.

Candidate capture is read-only with respect to release artifacts. A candidate
digest is evidence of source identity, not a signing, installation, notarization,
or release-acceptance result.

## Package Stage

The package stage composes the exact `Meetless.app` closure and, for the outer
distribution stage, the DMG defined by ADR0002. The package inventory records
every actual entry, including type, symlink target, size, and digest, plus every
regular arm64 Mach-O and its dependency closure. Package validation rejects
missing, extra, changed, unsupported, escaping, or retargeted entries.

The packaged renderer, host identity, installation markers, media closure, and
runtime paths are validated against the stable authorities. Media update
adoption remains the owner-bound transaction in ADR0002; package validation does
not authorize user-data migration or cleanup.

Local ad-hoc package output is useful deterministic evidence only. It cannot
establish the Developer ID, hardened-runtime, secure-timestamp, notarization,
stapling, Gatekeeper, clean-install, or release gates.

## Sign Stage

Signing consumes the accepted package closure and the exact checked-in
per-executable entitlement map. The signing stage must:

- sign the final outer app and every required nested Mach-O in dependency order;
- apply only the mapped JIT or audio-input entitlement to each approved image;
- preserve the outer bundle identity and required purpose strings;
- record signer identity, Team ID, certificate evidence, designated requirement,
  hardened-runtime flags, slices, and secure-timestamp state; and
- validate the complete post-signature closure, not only the main executable.

Release mode requires the owner-approved Developer ID identity and secure
timestamp. Local/ad-hoc and no-timestamp preparation modes remain explicitly
non-release evidence. Signing never changes the source snapshot or silently
rebinds the candidate.

## Re-sign Stage

Artifact re-signing is an owner-authorized transform of an exact retained stage,
not a package rebuild. It must bind the source snapshot, package/artifact input
digests, accepted artifact shape, signer/Team identity, entitlement policy, and
phase-split evidence. Pre-outer and final scopes are recorded separately so a
partial nested-signature result cannot be mistaken for a final artifact.

The transform may operate only in its explicit disposable/retained stage and
must preserve the canonical repository artifact and user state. It refuses an
unknown, stale, changed, symlinked, or mismatched stage. No re-sign command by
itself claims notarization, stapling, installation, launch, TCC acceptance, or
release acceptance.

## Validation Stage

The repository validator is the evidence owner for deterministic checks. Its
focused tests and `node scripts/validate-macos-package.mjs` validate:

- candidate, package-input, artifact-input, artifact, and signature-state
  bindings;
- exact package entry set, types, symlinks, sizes, hashes, Mach-O slices,
  dependency closure, and CodeResources;
- bundle identifier, designated requirement, Developer ID Team ID, hardened
  runtime, secure timestamp, and the exact entitlement map;
- all three non-empty outer TCC purpose strings and the required host/helper
  images; and
- package/DMG layout and sidecar bindings when the DMG stage is present.

The validator must fail with a diagnostic naming the violated stage/authority
and the compliant next action. It must not fall back to source, host tools, or a
different artifact when a bound input is absent or stale.

## Owner Gates And Evidence Classes

Deterministic repository validation may report `passed` for the checks it
actually ran. It does not promote an artifact to release acceptance. Separate
owner/external evidence is required for Developer ID credentials and private-key
use, Apple notarization, stapling, clean-machine Gatekeeper, first-run and
permission attribution, update persistence, legal/notice clearance, publication,
and final release acceptance. Network, Keychain, package mutation, installation,
launch, TCC, and publication actions require their own explicit authorization.

## Proof Ownership

Policy tests prove stable rules and state transitions. Package/signing/re-sign
tests prove adapter and artifact contracts. A thin composition check may prove
that the real stage wiring passes the same bound identities across candidate,
package, and validator. Plans and status text are navigation aids; they do not
replace executable or observable evidence.
