# ADR-005: Recordit.app as Canonical User-Facing Entrypoint

- Date: 2026-03-05
- Status: Accepted
- Related bead: `bd-3egg`
- Parent decision lane: `bd-jd2x`
- Supersedes: `docs/adr-004-packaged-entrypoint.md`
- Related release posture: `docs/bd-1mep-v1-release-posture.md`

## Context

`ADR-004` set the packaged beta default to `make run-transcribe-app`, which launches
`dist/SequoiaTranscribe.app`. That decision unblocked earlier packaging work, but it
is now misaligned with the current product direction and user-facing naming.

Legacy artifacts that encode the old default include:

- command surface: `make run-transcribe-app`
- bundle name/path: `dist/SequoiaTranscribe.app`
- diagnostics wrappers: `run-transcribe-preflight-app`, `run-transcribe-model-doctor-app`
- container identity/path references under `com.recordit.sequoiatranscribe`

Without an explicit superseding ADR, maintainers can unintentionally preserve the
legacy launch path in docs, packaging, and release automation.

## Decision

1. `Recordit.app` is the canonical user-facing app entrypoint for packaged builds,
   release artifacts, operator documentation, and validation runbooks.
2. `SequoiaTranscribe.app` remains supported only as an internal runtime/fallback
   surface for engineering continuity, compatibility, and controlled rollback paths.
3. Legacy `SequoiaTranscribe` paths/commands must be labeled non-default everywhere
   they are retained.
4. Any future UX-facing launch or distribution change must update this ADR lineage
   instead of introducing implicit defaults in scripts or docs.

## Fallback Boundary (Non-Default)

`SequoiaTranscribe.app` may be used only when one of the following is true:

- active compatibility support for legacy automation that still expects old paths
- temporary rollback/incident mitigation while `Recordit.app` lane is repaired
- explicit engineering validation of internal runtime components

Even in those cases, user-facing release notes and quickstart guidance must keep
`Recordit.app` as the default recommendation.

## Migration Rationale

1. Aligns artifact naming with product identity so operator actions match UI/docs.
2. Removes ambiguity from packaging and release gates that require a single default.
3. Preserves operational safety by keeping a bounded engineering fallback path.
4. Provides explicit supersession evidence so downstream traceability tasks can cite
   one canonical decision point.

## Consequences

- Build/package/sign/notarize/release scripts should target `Recordit.app` first.
- Release-posture disputes about sandboxing, notarization scope, or DMG-vs-local
  proof should defer to `docs/bd-1mep-v1-release-posture.md`.
- README/operator docs should describe GUI-first validation via `Recordit.app`.
- Traceability matrices should reference this ADR when mapping shipped entrypoint
  obligations and deprecating `SequoiaTranscribe` default language.
- Compatibility shims may remain, but they must be marked legacy and non-default.

## Revisit Conditions

Re-open this ADR if:

- product leadership changes the user-facing app identity again
- platform constraints force a temporary default away from `Recordit.app`
- fallback usage exceeds incident-only bounds and becomes operationally routine
