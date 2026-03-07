# bd-1mep: V1 Recordit.app Release Posture

Date: 2026-03-06
Status: Accepted
Related bead: `bd-1mep`
Parent feature: `bd-2gw4`
Related policy docs:
- `docs/adr-005-recordit-default-entrypoint.md`
- `docs/bd-1nqb-build-system-strategy.md`
- `docs/bd-yu7n-recordit-signing-notary-paths.md`

## Decision

For v1, `Recordit.app` ships as a **DMG-distributed, hardened-runtime, notarized,
unsandboxed macOS app** while the product still relies on embedded Rust executables
and bundled runtime assets.

More specifically:

1. `Recordit.app` is the only user-facing app artifact we describe as the release
   target.
2. Release-grade validation is defined around a distributable DMG lane, not around
   ad-hoc Xcode runs alone.
3. App Sandbox is **out of scope for v1**. We are not treating sandboxing as a
   codesign toggle or a documentation preference.
4. Any future sandboxed distribution must be treated as an architecture migration
   program, not as a follow-up entitlements patch.

## Why This Is The V1 Posture

The current shipping architecture still launches embedded Rust executables and
depends on bundled runtime/model assets, live capture permissions, and reliable
runtime artifact production. The 2026-03-05 incident showed that mixed app
contexts created false confidence:

- some docs and scripts implied sandboxed/container-scoped behavior
- Xcode/build-script sandboxing failures obscured the real packaging seam
- UI-only validation could look green while the real packaged/runtime path still
  failed

That means v1 needs one explicit posture for release work: the team must validate
the actual distributable `Recordit.app` path without pretending App Sandbox is
already compatible with the present runtime architecture.

## What “Unsandboxed” Means Here

For this project, “unsandboxed” does **not** mean “unsigned” or “developer-only.”
It means:

- the release target is still Developer ID signed
- the release target still uses hardened runtime
- distributable artifacts still go through notarization and Gatekeeper-oriented
  verification
- the app is not expected to rely on App Sandbox container semantics as part of
  the v1 product contract

This distinction is important because earlier docs sometimes conflated
“signed app” with “sandboxed app.” Those are separate choices.

## Validation Contexts We Intentionally Distinguish

Downstream work must keep these contexts separate:

1. **Local developer/Xcode validation**
   - useful for iteration, UI development, and targeted debugging
   - not sufficient on its own as release proof
2. **Packaged local validation**
   - validates `dist/Recordit.app` and DMG assembly on the machine that built it
   - should exercise the embedded runtime/model payload and app launch path that
     operators will actually use
3. **Release-candidate/notarized validation**
   - validates the distributable, notarized DMG and its Gatekeeper behavior
   - is the final evidence lane for shipping claims

Any documentation or automation that mixes these contexts should be considered
non-authoritative until corrected.

## Explicit V1 Boundary For App Sandbox

App Sandbox is deferred because the current architecture would require more than
entitlement changes to make sandboxed distribution trustworthy. A future sandbox
program would need, at minimum:

- a redesigned boundary for launching or replacing embedded Rust executables
- explicit model/runtime asset placement and access rules under the new security
  model
- permission/remediation contracts revalidated in that new execution context
- release, smoke, and incident runbooks rewritten around the sandboxed topology

Until that migration exists, treating sandbox enablement as a near-term release
toggle would recreate the same ambiguity that caused the current drift.

## Consequences For Downstream Beads

1. `bd-3mag` must align signing, validation, and entitlements verification with
   this unsandboxed v1 posture.
2. `bd-1huk` and `bd-8ic9` must collect evidence against the release contexts
   above, not against mixed sandbox assumptions.
3. `bd-1vo3` must explain local ad-hoc validation versus distributable/notarized
   expectations without implying they are interchangeable.
4. Legacy docs that describe container-scoped or sandbox-only behavior may remain
   temporarily for compatibility/history, but they must not be cited as the
   authoritative v1 release policy.

## Current-Repo Interpretation Guidance

Some repository artifacts still reflect pre-decision or transitional behavior,
including sandbox-oriented entitlement files and older packaged-runtime docs. For
`bd-1mep`, those are evidence of drift to be cleaned up by downstream execution
beads, not evidence that the v1 release decision is still undecided.

If a future agent needs one citation for the release boundary, cite this document
first and use ADR-005 / build-strategy docs as supporting context.

## Current Signing Interpretation

For the current v1 `Recordit.app` signing path, `packaging/entitlements.plist` should
not request App Sandbox entitlements. If sandbox keys appear in that file or in the
signed `dist/Recordit.app` entitlements dump, treat that as release-context drift to
be fixed before using the packaged artifact as trusted v1 evidence.
