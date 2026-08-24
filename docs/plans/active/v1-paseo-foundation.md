# Execution Plan: Meetless V1 Release Readiness

Date: 2026-08-24

## Status

Active — Milestone 7 only.

Milestones 0–6 and the new-design workstream are complete. Their accepted
decisions, candidate identities, validation, and recovery evidence remain in
[the completed foundation history](../completed/v1-paseo-foundation-m0-m6.md).

## Outcome

Accept or reject Meetless V1 for release with observable evidence from the
supported desktop and companion targets. Do not add post-MVP scope to close a
release gap.

The complete P0 path is:

```text
Record Zoom/Meet on desktop
  -> save a recoverable local MP3
  -> transcribe into timestamped segments
  -> read the complete transcript
  -> ask the open meeting a question
  -> resolve a grounded citation
  -> play the supporting audio interval
```

## Authority And Accepted Foundation

- [`docs/product/`](../../product/README.md) is the sole authority for accepted
  consumer behavior and UX. The full accepted experience contract is
  [`experience.md`](../../product/experience.md).
- [`design/`](../../../design/README.md) is the visual implementation contract
  and evidence package. It does not set product behavior.
- [`0001-maintained-paseo-fork.md`](../../decisions/0001-maintained-paseo-fork.md)
  owns the Paseo adoption and update contract.
- M0–M6 and the accepted new-design candidate
  `33ff981ad4bf3b5da485c2152bfabe75714eeaeb` are complete. M7 inherits their
  behavior, storage, transport, security, recovery, and evidence boundaries.
- The first verified recording host is macOS 26.4 arm64. Do not advertise a
  broader recording matrix without equivalent real-call evidence.

## Milestone 7 Acceptance

1. Exercise the complete P0 path on each accepted desktop target.
2. Exercise web and mobile companion behavior on real supported targets through
   direct LAN and the encrypted relay.
3. Verify recoverable recording storage, failed MP3 finalization, transcription
   failure, provider failure, host-offline recovery, and citation integrity.
4. Verify release signing, hardened runtime, notarization, production packaging,
   clean-install permission attribution, and permission persistence across an
   update or replacement.
5. Complete the third-party, native, model, bundled `ffmpeg`, and dynamic-library
   license and notice review for the intended distribution.
6. Decide the release-quality threshold for the static-like distortion observed
   in both intelligible M2 source clips. Do not present M2 as clean-audio proof.
7. Record the supported platform matrix and all remaining platform,
   model-quality, long-recording, security, and hosted-relay limits.

Acceptance requires one correlated, inspectable evidence set for the complete
P0 path plus separate failure and distribution evidence where one run cannot
safely prove the boundary.

## Open Release Risks

- Direct-LAN passwords remain in ordinary pairing-profile storage. Secure
  storage policy was not accepted during M6.
- Direct `ws://` pairing does not protect a password from a LAN observer. The
  encrypted relay is a separate protected transport.
- Peer-loopback authorization trusts same-user local processes, not a signing
  identity.
- Hosted relay availability and physical-target coverage need M7 evidence.
- Long-recording transcription coverage is not release-proven.
- Source-separated M2 audio was intelligible but distorted/static-like.
- Stable signing, permission attribution, packaging, notarization, license
  notices, and clean-install behavior remain open release gates.

## Recovery Rules

- Preserve recording chunks and meeting metadata before migration, media, or
  packaging changes.
- Never overwrite an existing MP3. Publish only a readable finalized file and
  retain committed chunks until the saved transition is durable.
- Keep capability gates for mixed app/daemon versions. Fail with an update
  message; do not maintain two product domains with a compatibility layer.
- Return to the last accepted candidate when M7 work invalidates an accepted
  foundation. Record the failed premise before changing the route.

## Progress

- [x] Complete and accept Milestones 0–6.
- [x] Complete and accept the new-design workstream.
- [x] Move accepted consumer behavior and UX authority to `docs/product/`.
- [x] Separate completed foundation history from current M7 execution.
- [ ] Complete Milestone 7 V1 acceptance and release readiness.

## Decisions

- 2026-08-24: The owner authorized the documentation reorganization.
  `docs/product/` now owns all accepted consumer behavior and UX. `design/` is
  only the visual implementation contract and evidence package. Exact duplicate
  product and prototype copies were removed, and completed M0–M6/new-design
  history was separated from this active M7 plan without removing evidence.
- 2026-08-24: Post-MVP cross-meeting Q&A and document-folder indexing remain
  outside M7.

## Validation

Record exact candidate identities, commands, manifests, target versions,
observed failures, cleanup, and owner decisions here as M7 proceeds. Completion
requires executable or observable evidence; this plan is not proof by itself.
