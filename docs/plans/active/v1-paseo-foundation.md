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

### M7-F1-MACOS-PACKAGE-COMPOSITION

- Superseded frozen exploratory candidate: base
  `bb678fa59674aa0292f56ada3beb57290faaf540`, implementation snapshot
  `026eed06e5de7054035819acddf4360975175fc5038a02990e8f299ed24366d7`, and
  manifest artifact digest
  `ee21fd112775d19d46ec6a1947b08aa013d7132b60f71dd20eebb85368ee1df9`.
- Correction round R1 candidate: base
  `bb678fa59674aa0292f56ada3beb57290faaf540`; canonical command
  `node scripts/candidate-snapshot.mjs`; snapshot SHA-256
  `6df50260b17e19817e05d75aff19ef50840bf38740be4b08d356b8f839ad7d26`;
  Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`. The command ran
  twice with the same digest. The artifact is bound separately by
  `release/macos/composition-manifest.json` `artifactDigest`
  `b7f72d194a1f80c8c881a7d2c2be1ecff026f998e0ce2f20c614963d7e9002b2`.
- R1-001: the package inventory and manifest account for all 13,756 entries
  and 46 regular arm64 Mach-O files. The launch proof exposed the omitted
  dynamic runtime dependency `unzip-crx-3@0.2.0`; package composition now
  includes its locked closure. No vendor source was changed.
- R1-002: every Mach-O was inspected for `LC_RPATH` and dependency closure.
  External Xcode and Sherpa build rpaths were removed or rewritten; validator
  passed with no Homebrew or unresolved `@rpath` dependency.
- R1-003: stop and ownership guards refuse restoration or deletion when an
  owned process remains or stop fails. Replacement and restore fault injection
  passed in isolated roots. Final proof stopped the exact package-owned host
  and left no package process.
- R1-004: replacement uses a journaled bundle plus identity transaction with
  staged, backup, displaced, restore, and finalization states. All interruption
  points recovered the prior artifact and identity in isolated tests; no
  single impossible atomic-rename claim is made.
- R1-005: bundle, runtime, export, and identity paths are fixed to
  `~/Applications/Meetless.app`, `/private/tmp/meetless-package-runtime`, and
  `/private/tmp/meetless-package-host-identity.json`. Exact host matching is
  independent of PPID. Proof uses a unique owner token and kernel lock.
- R1-006: packaged markers and host configuration are constrained to the fixed
  package/runtime/export locations. Positive and negative path-redirection
  tests passed; packaged mode has no repository or Homebrew fallback.
- R1-007: normal LaunchServices launch and proof carry renderer origin
  `http://127.0.0.1:18082` through host configuration. Served renderer bytes
  matched the manifest: 1,175 bytes and SHA-256
  `abbb5dca1a703261130d5d23902a447d63168882491f7725ef46ee3510a2fcc0`.
- R1-008: preflight derived daemon port `127.0.0.1:16777` and renderer port
  `127.0.0.1:18082` from the exact packaged host configuration and verified
  both before launch and after stop.
- R1-009: renderer listener registration and abort cleanup are covered by a
  deterministic lifecycle test; focused tests passed.
- R1-010: validator compares the complete actual bundle entry set, entry type,
  symlink target, size, and hash. Extra, missing, changed, and retargeted
  entries are rejected by focused tests.
- R1-011: the manifest carries the canonical snapshot command, digest, HEAD,
  and Paseo commit. The validator recomputes and verifies the digest before
  package proof, preventing same-HEAD/different-diff acceptance.
- Deterministic package proof: `node scripts/package-macos.mjs` ran twice with
  the same artifact digest, 13,756 entries, and 46 Mach-O files. Manifest
  validation passed with `node scripts/validate-macos-package.mjs`.
- Verification passed: focused package/host/lifecycle tests, 21 tests;
  `npm run validate:isolation`, 58 tests; `npm run typecheck`; and
  `git diff --check`.
- Preflight found zero active `recording`/`finalizing` meetings and no owned
  `MeetlessHost` or `meetless-capture` process. `npm run prove:package:macos`
  passed through LaunchServices with host → desktop → Electron topology,
  `com.meetless.app`, idle readiness, packaged plugin source, renderer hash,
  bounded stop, isolated recovery, and unchanged default store/export
  fingerprints. It restored the canonical bundle and identity byte-for-byte,
  removed the proof runtime, left no package process, and reported no ordinary
  runtime restart.
- Lead acceptance: `M7-F1-MACOS-PACKAGE-COMPOSITION` accepted. Lead reran the
  package validator and 16 focused tests successfully. The reviewer returned
  `CLOSEOUT_CLEAR` for accepted findings `M7F1-R1-001..011`.
- Closeout: technical package-composition contract accepted. Next frontier:
  `M7-F2-RELEASE-LICENSE-DISCOVERY`.
- Disposition: accepted by Lead. M7 remains open.
- Remaining external gates: clean-install TCC acceptance, Developer ID,
  hardened-runtime, notarization, update publication, and distribution.
- Limits: ad-hoc local verification only; this record makes no claim of those
  external gates.
  License authority remains unresolved for Paseo AGPL obligations, lock
  metadata gaps, native capture/models, bundled ffmpeg, dynamic libraries, and
  the added `unzip-crx-3` runtime dependency.

### M7-F2-LICENSE-INVENTORY-GUARD — superseded exploratory candidate

- Status: Peer candidate; pending Lead review. M7 and license clearance remain
  open.
- Authority: [`docs/decisions/0001-maintained-paseo-fork.md`](../../decisions/0001-maintained-paseo-fork.md),
  especially the pre-binary-release requirement to inventory every production
  dependency/native/model path, preserve notices, publish Corresponding Source
  and build/install scripts, expose source notices, and review AGPL
  network-interaction obligations.
- Scope: the exact `release/macos/Meetless.app` closure produced by the accepted
  M7-F1 package assembler. The inventory is packaged at
  `Contents/Resources/meetless/notices/license-inventory.json` and is bound to
  `release/macos/composition-manifest.json` and the canonical candidate
  snapshot.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; candidate snapshot SHA-256
  `9d1388bac723e7420da305fb21cd6035f672a85a719bd406db7afd7c8d8d1581`;
  accepted Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- Artifact identity: `artifactDigest`
  `1dd0dd5b470789b4dde8a2ea3317f26254ab711324b8887aaf6aaf038a28d65e`;
  13,765 entries and 46 regular arm64 Mach-O files. Rebuilds 12 and 13 produced
  the same digest, entry count, Mach-O count, candidate snapshot, and inventory
  binding.
- Component coverage: 11 required records cover every artifact path exactly
  once: Meetless 75, Paseo 718, JS closure 12,581, Electron/Chromium 274,
  Node 2, native binaries 29, capture helper 1, ffmpeg/media 24,
  Sherpa/models 25, fonts/assets 20, and unzip-crx-3 16. No unknown-path
  component remains. The inventory records 301 package members, current
  two-lockfile metadata gaps, declared-license evidence, shipped notice
  status, source/build status, and owner-decision state. Each component has
  declared-license evidence paths, including package manifests for the JS,
  native, and asset closures. Available upstream
  text files for Node, Electron/Chromium, and FFmpeg are packaged without
  adding legal text.
- Structural proof: `node scripts/validate-macos-package.mjs` passed for the
  final candidate. The focused package test passed 8 tests, including a
  complete isolated fixture, an unmapped artifact-path failure, and an
  unresolved-owner failure. `npm run typecheck` and `git diff --check` passed.
- Readiness proof: `npm run check:distribution-readiness` exits 1 and names all
  11 required unresolved Human/legal owner decisions. It reports only that
  repository-declared technical obligations remain unresolved; it does not
  claim legal clearance.
- Determinism correction evidence: early package attempts exposed stale
  inventory digests after load-path normalization and repeated ad-hoc signing.
  The final assembler normalizes, signs once, writes the inventory, signs the
  completed bundle, and excludes only the inventory, signing metadata, and
  observed Mach-O code-signature paths from the cross-entry digest. The
  composition manifest still hashes and validates every final Mach-O entry.
- Enforcement levels: local validator and readiness commands are available and
  passed/failed as stated above. No optional hook was found. No checked-in CI
  invocation was found (`.github/` is absent). Branch protection is unverified
  externally.
- Human/legal gates: resolve the 11 owner decisions; reconcile the current
  24 missing license-metadata records across `package-lock.json` and
  `vendor/paseo/package-lock.json` with the decision's earlier 28-name finding;
  decide notices, Corresponding Source, and build/install material for the JS
  closure, Electron/Chromium, Node, native binaries, capture helper, FFmpeg
  and dynamic libraries, Sherpa/model assets, fonts/assets, and unzip-crx-3;
  and review the AGPL network-interaction obligations before any binary
  release. These are not approved by this candidate.

### PLAN_RECONCILIATION v1 — M7-F2-CORRECTION-R1

- Frontier: `M7-F2-CORRECTION-R1`. Lead ruling: `REVISE_PLAN` after accepted
  findings `M7F2-R1-001..006`. Result: bounded validation-foundation redesign;
  M7 and license clearance remain open. The previous M7-F2 candidate is
  superseded: source snapshot
  `9d1388bac723e7420da305fb21cd6035f672a85a719bd406db7afd7c8d8d1581`,
  `artifactDigest`
  `1dd0dd5b470789b4dde8a2ea3317f26254ab711324b8887aaf6aaf038a28d65e`.
- Corrected candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; source snapshot
  `5d453f9c6919a65c70eaf5f8bfd14756c5d993972adcb087469f6351c172248f` from
  `node scripts/candidate-snapshot.mjs`; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. The package-input digest is
  `9bbe8fa4b0291f3804ee7d27772c420627e0c5af95cdfed15c15fffaedbd491a` and
  its final-artifact input digest is
  `54b76f8bb7a5e7f15ebd81b8ac7568e9a7f393f850ad96cb7812b531eb6e5d0b`.
  The final `artifactDigest` is
  `f491fb933b09106881329ae7af2645c7ff83d7300fa9d66006a7cc384fe8ca76`.
- Reproduction: final package builds E and F produced identical source
  snapshot, package-input digest, final-artifact input digest, artifact digest,
  13,765 entries, and 46 regular arm64 Mach-O files. Two direct snapshot
  commands also produced the same source snapshot and Paseo binding.
- Lead closeout: `M7-F2-LICENSE-INVENTORY-GUARD` is accepted. Lead considered
  the corrected source snapshot, package-input digest, artifact digest,
  accepted findings `M7F2-R1-001..006`, reviewer `CLOSEOUT_CLEAR`, the passed
  validator, 18 focused tests, and the passed `npm run prove:package:macos`.
  The proof restored the canonical bundle and identity, preserved default
  store/exports, and left no owned process. This accepts the repository-native
  technical guard only. It does not grant legal clearance. Next frontier:
  `M7-F3-PACKAGED-ACCEPTANCE-DISCOVERY`.
- Changed validation owner: `scripts/lib/macos-package-inputs.mjs` records and
  verifies source, generated, native, model, media, Electron, Node, and
  dependency inputs. `scripts/lib/macos-license-inventory.mjs` records the
  exact component, package/workspace child, native/model/asset member, notice,
  lock, and owner-decision evidence. `scripts/validate-macos-package.mjs`
  owns final structural validation and fail-closed evidence checks.

Finding correction evidence:

- `M7F2-R1-001`: 51 input records cover ignored/generated dist and build
  outputs, native sources, model output, media closure, Electron/Chromium,
  Node, and native/npm package inputs. Each record has a content digest and
  final-artifact prefix. The validator recomputes these records and rejects a
  changed source or shipped input before final validation. Source snapshot,
  package-input digest, final-artifact input digest, and artifact digest are
  separate identities; no circular digest is used.
- `M7F2-R1-002`: 11 components map all 13,765 final artifact paths. The
  inventory has 304 canonical npm package members and 14 workspace members.
  Native ownership is explicit: 3 native package members and 10 native
  artifact members are assigned to `native-binaries`; Sherpa package/model
  ownership is separate. The 13 workspace manifests without a declared
  license are explicit `not-declared` records. An isolated child-member
  removal or misassignment fails validation.
- `M7F2-R1-003`: lock evidence preserves lockfile, lock path, canonical
  package path, manifest name/version, integrity, resolved source, and license
  metadata. The final scan has 294 canonical-path matches, 9 explicit
  name/version fallback matches, and one explicit unresolved member:
  `jose@6.2.10` at
  `Contents/Resources/meetless/node_modules/jose`. Positive and incomplete
  lock-evidence mutation tests pass.
- `M7F2-R1-004`: a resolved decision now requires an authority record, an
  owner-decision record, and non-empty repository-relative evidence records
  with SHA-256 values. Empty evidence, missing paths, and stale hashes fail.
  All real component decisions remain unresolved; no legal decision was
  invented.
- `M7F2-R1-005`: notice records are accepted only for verified text filename
  forms and only after source/artifact byte equality and SHA-256 binding.
  Code files such as `notice.js` and `notice.ts` are rejected. Available
  upstream text is packaged without adding legal text; missing notice evidence
  remains unresolved.
- `M7F2-R1-006`: the final inventory derives current path, component, package,
  workspace, and lock-gap counts. Current values are 75 Meetless, 718 Paseo,
  12,554 JS closure, 274 Electron/Chromium, 2 Node, 60 native, 1 capture,
  24 FFmpeg/media, 21 Sherpa/model, 20 fonts/assets, and 16 unzip-crx-3 paths;
  304 package members; 14 workspace members; and 24 current lock metadata
  gaps. `28` is retained only as the historical authority value. The plan,
  manifest, inventory, and readiness diagnostics use these current values and
  labels consistently.

Proof and enforcement:

- Positive proof: Lead recorded 18 focused tests passed; the isolated complete
  fixture passed structural coverage. `node
  scripts/validate-macos-package.mjs`, `npm run typecheck`, and `git diff
  --check` passed. `npm run prove:package:macos` passed with canonical bundle
  and identity restoration, unchanged default store/exports, and no owned
  process remaining.
- Negative proof: the focused suite rejects an unmapped artifact path, stale
  package-input digest, removed/misassigned child member, incomplete lock
  evidence, empty/stale resolution evidence, code-like notice names or
  mismatched notice bytes, and stale derived counts. `npm run
  check:distribution-readiness` exits nonzero and names all 11 unresolved
  components. It reports repository-declared technical obligations only; it
  does not report legal clearance.
- Local command: `node scripts/validate-macos-package.mjs` is the structural
  package gate; `npm run check:distribution-readiness` is the explicit local
  distribution-readiness gate.
- Optional hook: no optional hook is configured or changed.
- Checked-in CI invocation: no checked-in CI invocation was found (`.github/`
  is absent); no CI was changed.
- Branch protection: not observable from this repository; no external state was
  changed.

Remaining owner gates and residual risk:

- Exactly 11 Human/legal owner gates remain unresolved before binary
  release. Required review still covers notices, Corresponding Source,
  build/install material, and AGPL network-interaction obligations for Paseo,
  the JS closure, Electron/Chromium, Node, native binaries, capture helper,
  FFmpeg/dynamic libraries, Sherpa/model assets, fonts/assets, unzip-crx-3,
  and Meetless-owned material.
- The current 24 lock metadata gaps and the historical authority value 28
  require owner reconciliation. The unresolved `jose@6.2.10` package record
  and missing declared licenses remain technical evidence gaps. No owner gate
  is marked approved, M7 remains open, and this record does not provide legal
  advice or legal clearance.

### PLAN_RECONCILIATION v1 — M7-F3-INTEGRATED-LEASE-ARTIFACT

- Frontier: `M7-F3-INTEGRATED-LEASE-ARTIFACT`. The fixed M7-F3 artifact route
  was superseded because it contained the old controlled envelope/readiness
  implementation. This frontier added the harness-owned external export
  lease, packaged that runtime change, and reran the dependent package and
  distribution checks. M7 remains open.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; source snapshot
  `4d9dc3db1ef70eead5b60f67e9aa122bc7e19359673f1f504fc5e4b632193b96`;
  accepted Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
  Package-input digest is
  `520fdd84b93cdea6cfcf208fd0d8b3070555936cb27b3defbc87eeb99bb5c90f`;
  artifact-input digest is
  `24a11b46c552dbbfb17f18b4705e7e888282b0fe0b88b3771db8da8b0861db23`;
  `artifactDigest` is
  `845aecac03185cbf61932a9bae97a81de9de4141f0f1048dbf9343542d60c9b8`.
  The artifact has 13,765 entries and 46 regular arm64 Mach-O files. Two
  consecutive `npm run package:macos:arm64` builds matched all these
  identities and counts.
- Foundation proof: `npx vitest run --config vitest.config.ts
  packages/runtime/test/ui-test-envelope.test.ts
  packages/runtime/test/readiness.test.ts` passed 29 tests. The tests cover
  secure external-root creation, lease integrity, session and generation
  binding, expiry, replay/stale/default-path rejection, readiness parity, and
  cleanup that preserves the external export root.
- F1 regression: `npm run prove:package:macos` passed on the new artifact.
  It passed the package validator, exact LaunchServices launch, isolated
  transaction recovery, canonical bundle and identity restoration, unchanged
  default store/exports, and no remaining owned process. The package validator
  also passed directly for artifact `845aec...`, with the full identities and
  counts above.
- F2 regression: `npm run check:distribution-readiness` completed its
  structural scan and exited 1 as the fail-closed gate requires. It listed all
  11 unresolved Human/legal owner decisions for Meetless, Paseo, the JS
  closure, Electron/Chromium, Node, native binaries, capture helper,
  FFmpeg/media, Sherpa/model assets, fonts/assets, and unzip-crx-3. This is
  not legal clearance.
- Packaged acceptance: `npm run prove:package:acceptance` reached the exact
  packaged host, generation-1 lease, controlled UI fixture, and four
  source-labelled committed chunks with complete chunk inventory. Finalization
  then remained recoverable with no output because the packaged
  `runtime/media/bin/ffmpeg` and `ffprobe` both terminate with `SIGKILL` on
  `-version`. Direct `codesign --verify` reports an invalid arm64 signature
  for the packaged `ffmpeg`; the outer bundle passes deep strict verification.
  Therefore no readable MP3, saved recording, transcript, citation,
  playback, or generation-2 restart proof was produced. This is a package
  assembly/signing boundary failure, not a controlled-evidence downgrade.
- Cleanup proof: the failed run stopped the owned host, removed its package
  runtime before export cleanup, ownership-checked and removed its unique
  leased external root, restored the canonical bundle/identity, and left the
  default store/exports unchanged. No owned package process or listener
  remained. The required pass manifest was not published because the proof
  failed before manifest publication:
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json`.
- Reopen decision: package assembly must sign every rewritten standalone media
  Mach-O, or Lead must provide a new artifact with a runnable packaged media
  closure. The Peer write scope excludes the package assembler, validator, and
  license guard, so this cannot be repaired inside this frontier. M7, real
  target/provider/TCC/audible-output proof, Developer ID signing,
  notarization, release acceptance, and Human/legal clearance remain open.

### PLAN_RECONCILIATION v1 — M7-F3-SIGNED-MACHO-CLOSURE

- Frontier: `M7-F3-SIGNED-MACHO-CLOSURE`. Artifact
  `845aecac03185cbf61932a9bae97a81de9de4141f0f1048dbf9343542d60c9b8` is
  superseded. The package assembler now signs the complete final Mach-O set
  after load-path normalization, and the validator checks each file as well as
  the outer bundle. The dependent lifecycle proof exposed a separate runtime
  media-closure dependency. M7 remains open.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; source snapshot
  `26818899208fad8ee70fa9abe7a1e74114e9218adcb29f19b19502f09edb55ff`;
  accepted Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
  Package-input digest is
  `dfcfaf60e6bddde29d4f3e564b7b9d134712bf6a6a6a43e2e15225f4cd940b2e`;
  artifact-input digest is
  `24b8086a80d8e7a54886b3506d21468f43e6fd63e8e68bb9abaf8c0bd879ded6`;
  `artifactDigest` is
  `11a6697db23eb035c9cada839c7903636fc06f5d0289df6d840948e321743bf1`.
  The artifact has 13,774 entries and 46 regular arm64 Mach-O files. Two
  consecutive package builds matched all identities and counts.
- Signing proof: direct `codesign --verify --strict` passed for 46/46
  manifest Mach-O files. Outer `codesign --verify --deep --strict` also
  passed. The package validator returned `passed` with the same 46-file
  inventory. A temporary signed Mach-O positive test passed; a code-section
  mutation failed individual validation with the path and signing action.
- F1 regression: `npm run prove:package:macos` passed on the new artifact.
  It passed exact LaunchServices launch, transaction recovery, canonical
  bundle/identity restoration, unchanged default store/exports, and no owned
  process. The final host CDHash was `b7d965a9dd0a9bfe3a006d8496fbbf2988d8616e`.
- F2 regression: `npm run check:distribution-readiness` completed the
  structural scan and exited 1 for the 11 unresolved Human/legal owner
  decisions. It did not claim legal clearance.
- F3 proof result: `npm run prove:package:acceptance` reached packaged
  LaunchServices startup, generation-1 lease, UI fixture, and four committed
  chunks. It failed before MP3 publication with `recoverable`,
  `inventory=complete`, `chunks=4`, `output=none`, and
  `capture stopped with durably closed chunks`.
- Boundary evidence: the packaged `runtime/media/bin/ffmpeg` and `ffprobe`
  each run successfully in place. The runtime preparation path copies each
  tool alone to `runtimeRoot/media-tools`. A copied packaged `ffmpeg` aborts
  with `Library not loaded: @loader_path/../lib/libavdevice.62.3.101.dylib`.
  The packaged sibling dylib closure is not copied to the runtime snapshot.
  This requires the runtime configuration/closure owner, outside this
  frontier's write scope. The proof runner must not stage unowned runtime
  libraries or use source/Homebrew fallback.
- Cleanup proof: failed acceptance stopped the owned host, removed the proof
  runtime, emptied the leased export-root parent, left no owned process, and
  published no pass manifest. F1 recorded canonical identity restoration and
  unchanged default store/exports. The expected manifest remains unpublished:
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json`.
- Dependency request: Lead must open the runtime media-tool snapshot boundary
  to copy and validate the packaged dynamic-library closure, or provide a
  self-contained packaged media tool. Then rebuild and rerun validator, F1,
  F2, and F3. Real-target/provider/TCC/audible-output proof, Developer ID
  signing, notarization, release acceptance, and Human/legal clearance remain
  open.

### PLAN_RECONCILIATION v1 — M7-F3-RUNTIME-MEDIA-CLOSURE

- Frontier: `M7-F3-RUNTIME-MEDIA-CLOSURE`. The runtime now owns one secure,
  per-runtime packaged media snapshot. It derives `runtime/media` from the
  packaged `bin/ffmpeg` and `bin/ffprobe` resources, validates sibling `bin`
  and `lib` closure entries, rejects escaping or absolute symlinks, preserves
  bytes/modes/symlink targets, and publishes the complete tree by atomic
  staging and rename. Development mode retains the prior per-tool snapshot
  behavior. Existing invalid, partial, tampered, or wrong-source snapshots
  fail closed; a valid snapshot remains usable when the canonical source is
  moved away.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; source snapshot
  `839d725cb92a73d5ccc40bab6adee2b01c0454c36051c081a20562f35796a6fe`;
  accepted Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
  Package-input digest is
  `805a58fd34087a14cea34d6c9919a1db42825a87304ab436113ec26ffc2c903f`;
  artifact-input digest is
  `b9d1e5f9956b3c24bf1ef7b5de92f240f1b098ff8dfe137a7ab8549f26389b9d`;
  `artifactDigest` is
  `e10b2c6a075df5ac981172586b47f31b43d2ccce30d9fa99355f14e30b233f4a`.
  The artifact has 13,774 entries and 46 regular arm64 Mach-O files. Two
  consecutive `npm run package:macos:arm64` builds reproduced these
  identities and counts.
- Media foundation proof: `npx vitest run --config vitest.config.ts
  packages/runtime/test/media-closure.test.ts` passed 9 tests. The focused
  suite covers complete bin/lib parity, bytes, modes, symlink targets,
  deterministic reuse, missing-library and tamper rejection, source symlink
  escape rejection, wrong-source rejection, no host fallback, unowned partial
  runtime preservation, source move independence, and secure-root rejection.
  The combined runtime/package/readiness suite passed 62 tests. `npm run
  typecheck`, script syntax checks, and `git diff --check` passed.
- Signing and F1/F2 regressions: `node scripts/validate-macos-package.mjs`
  passed. Direct individual verification passed 46/46 Mach-O files and outer
  `codesign --verify --deep --strict` passed. `npm run prove:package:macos`
  passed exact LaunchServices launch, transaction recovery, canonical bundle
  and identity restoration, unchanged default store/exports, and no owned
  process; final host CDHash was
  `017be6d68d2e3c361bb111343b4d96a89dc44678`. `npm run
  check:distribution-readiness` exited 1 as required and listed the same 11
  unresolved Human/legal owner decisions. It did not claim legal clearance.
- Packaged acceptance: `npm run prove:package:acceptance` passed the exact
  packaged generation-1/generation-2 lifecycle. The evidence manifest is
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` with SHA-256
  `b3718497ce3ce43e5a40364d4a839a46324ffb935c8de9ff82356fc55cda5202`.
  It binds the candidate and artifact identities above, four source-labelled
  chunks, collision sentinel `18-24-08-26.mp3`, distinct output
  `18-24-08-26-2.mp3`, fake ordered transcript, known citation/range and
  bounded playback, unknown citation rejection, saved state across exact-host
  restart, and fresh generation-2 process identity. Both generations reused
  media snapshot fingerprint
  `9507d949fcc25e4a758cb2e277a09e6f5f4c4bfc5bd7d9318fad2dd64db63943` with
  21 closure entries and `media-tools/bin/{ffmpeg,ffprobe}` paths.
- Cleanup proof: the final acceptance stopped only owned processes, released
  package ports, removed the runtime/store before external export cleanup,
  checked the exact expired session lease, removed the unique external root,
  restored the canonical bundle and identity byte-for-byte, and preserved the
  default store/exports. The proof lock is free and no packaged host/capture
  process remains. Evidence limits remain controlled fixture/fake provider,
  bounded machine-observed playback, no real call/native provider/audible
  output/clean-install TCC/signing/notarization/release/legal acceptance
  claim, and no credentials/network provider/real target/raw private content.
- Candidate status: this is a deterministic candidate for Lead review, not a
  self-acceptance. M7, real-target/provider/TCC/audible-output proof,
  Developer ID signing, notarization, release acceptance, and Human/legal
  clearance remain open.

### PLAN_RECONCILIATION v1 — M7-F3-EVIDENCE-IDENTITY-CORRECTION

- Frontier: \`M7-F3-EVIDENCE-IDENTITY-CORRECTION\`. This correction changes
  only the package-source and evidence-publication identity boundary. The
  default no-argument snapshot still includes published evidence. The explicit
  package-source mode is
  \`node scripts/candidate-snapshot.mjs --mode=package-source\`; it excludes
  only \`test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json\` and uses
  the domain \`MEETLESS_PACKAGE_SOURCE_SNAPSHOT_v1\`.
- Candidate identity: HEAD
  \`bb678fa59674aa0292f56ada3beb57290faaf540\`; package-source snapshot
  \`bd028ebf10223a0315a195df922cc81074d52a1027fd5f01158bf8f333b6f8b0\`;
  accepted Paseo commit
  \`c81cb84735043c281a5a2d23d456d3708ce5d94e\`. Package-input digest is
  \`9d15dab7b688389849f8cd8ccad496b15dc45d322ff6cbefa17e9243c4479bf8\`;
  artifact-input digest is
  \`b9d1e5f9956b3c24bf1ef7b5de92f240f1b098ff8dfe137a7ab8549f26389b9d\`;
  \`artifactDigest\` is
  \`a96a61a706c414c8d0e6221e607bdbef932bb3b7e076295ad31ce079efb0aa33\`.
  The artifact has 13,774 entries and 46 regular arm64 Mach-O files. Two
  consecutive package builds reproduced every identity and count.
- Identity proof: focused tests passed 17 tests. They prove domain separation,
  exact single-file evidence exclusion, default snapshot inclusion,
  evidence-only isolation, broad evidence-directory exclusion failure,
  package-input binding, and rejection of wrong source/artifact evidence.
  Post-publication \`node scripts/validate-macos-package.mjs\` passed with the
  same package-source, package-input, artifact-input, and artifact digests.
- F1/F2/F3 regression: \`npm run prove:package:macos\` passed. The structural
  package validator and individual 46/46 plus outer deep/strict signatures
  passed. \`npm run check:distribution-readiness\` exited 1 with the same 11
  unresolved Human/legal decisions. \`npm run
  prove:package:acceptance\` passed both exact-host generations, collision
  output, fake transcript, known/unknown citation behavior, bounded playback,
  restart persistence, and cleanup.
- Published evidence: \`test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json\`
  has external SHA-256
  \`69e7deddc720793c16b2eaaa4da0d77f3126a484bb89d0b219c9d429f35a08d1\`.
  The digest is not stored inside the evidence. The default post-publication
  snapshot is
  \`c7c86795e418959ab1888d2bdedeec8617cbb3c05710e136ad1608dd2407c865\`;
  the package-source snapshot remains
  \`bd028ebf10223a0315a195df922cc81074d52a1027fd5f01158bf8f333b6f8b0\`.
- Cleanup proof: the acceptance run atomically published final evidence only
  after cleanup. It stopped owned hosts, removed proof runtime/store before
  the leased external root, checked the expired exact-session lease, restored
  the canonical bundle and identity byte-for-byte, preserved default store and
  exports, released the proof lock and ports, and left no owned process.
- Candidate status: deterministic candidate for Lead review, not a
  self-acceptance. M7, real-target/provider/TCC/audible-output proof,
  Developer ID signing, notarization, release acceptance, and Human/legal
  clearance remain open.

### FINAL CANDIDATE RECORD — M7-F3-EVIDENCE-IDENTITY-CORRECTION

The final rebuild includes the source-mutation negative assertion. It
supersedes the provisional identity record immediately above.

- package-source snapshot digest:
  bd028ebf10223a0315a195df922cc81074d52a1027fd5f01158bf8f333b6f8b0
- package-input digest:
  9d15dab7b688389849f8cd8ccad496b15dc45d322ff6cbefa17e9243c4479bf8
- artifact-input digest:
  b9d1e5f9956b3c24bf1ef7b5de92f240f1b098ff8dfe137a7ab8549f26389b9d
- artifact digest:
  a96a61a706c414c8d0e6221e607bdbef932bb3b7e076295ad31ce079efb0aa33
- artifact shape: 13,774 entries and 46 regular arm64 Mach-O files
- evidence path and external SHA-256:
  test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json
  69e7deddc720793c16b2eaaa4da0d77f3126a484bb89d0b219c9d429f35a08d1
- default post-publication snapshot digest:
  c7c86795e418959ab1888d2bdedeec8617cbb3c05710e136ad1608dd2407c865

The two package builds reproduced all candidate and artifact identities.
The post-publication package validator passed. The evidence contains no
evidence digest field. Focused package identity tests passed 17 tests,
including evidence-only isolation, exact exclusion, broad-exclusion
rejection, source mutation, stale package-input mutation, and wrong
source/artifact rejection. F1 passed. F2 exited 1 with the same 11
unresolved Human/legal gates. F3 passed both exact-host generations,
collision-safe MP3, fake transcript, citation and bounded playback,
restart persistence, and cleanup.

Cleanup preserved the canonical bundle and identity byte-for-byte, default
store and exports, and removed only owned proof state. The runtime root and
external export children are absent, the proof lock is free, and no owned
MeetlessHost or meetless-capture process remains.

This is a deterministic candidate for Lead review. It is not self-accepted.
M7, real-target/provider/TCC/audible-output proof, Developer ID signing,
notarization, release acceptance, and Human/legal clearance remain open.

### PLAN_RECONCILIATION v1 — M7-F3-CORRECTION-R1

- Frontier: `M7-F3-CORRECTION-R1`. This bounded correction closes only
  `M7F3-R1-001..003`. It preserves the accepted package-source/artifact/
  evidence identity graph, F1 package mechanisms, F2 license guard, and all
  product/runtime lifecycle behavior outside the controlled proof boundary.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; package-source snapshot
  `1d9a1fafbaf490c2ce4a4a8ebed10d6b1a506392b87bcbf13f66343b060d5b2f`;
  package-input digest
  `0ea00c80a446660d7e818388ab3772fa1df375a4b35e092b5ea10744e258bdf0`;
  artifact-input digest
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact digest
  `5585ca5670723367637ae91a765e2012251e3eb665a05df307a520fe5f1b0e86`.
  The artifact has 13,774 entries and 46 regular arm64 Mach-O files. Two
  consecutive package builds reproduced all identities and counts.
- `M7F3-R1-001` closure: package validation now resolves every actual
  packaged symlink, rejecting absolute, lexical-escaping, dangling, and
  externally resolving targets across resources, marker paths, executable
  paths, and the complete Mach-O-relevant entry set. Packaged runtime resource
  resolution applies the same realpath containment check. Valid internal
  relative symlinks remain accepted. Focused fixtures cover absolute,
  escaping, dangling, external-realpath, and valid internal links.
- `M7F3-R1-002` closure: the media closure, manifest, and owned marker are
  published inside one staged `runtimeRoot/media-tools` directory unit, then
  exposed by one atomic directory rename. Fault tests inject failure before
  and after rename; the next start removes only the owned staging directory or
  reuses the complete published unit. An unowned staging directory is kept.
  The runtime still fails closed for missing, tampered, partial, or wrong-source
  snapshots. Media proof covers 13 focused tests.
- `M7F3-R1-003` closure: playback proof binds meeting, recording, segment, and
  interval identity, requires play and pause, and requires finite positive
  current-time progress strictly after the interval start and no later than
  its end. Focused tests reject zero, NaN, infinite, out-of-range, wrong-ID,
  and pause-without-progress observations. The packaged evidence records
  positive bounded progress at 1.1 seconds in the 0–1.1 second citation range
  for both generations.
- Verification: `npm run typecheck` passed. The focused package, signature,
  transaction, media, playback, isolation, envelope, and readiness suite
  passed 82 tests. `git diff --check` passed. The structural validator passed
  after publication; it also passed individual `codesign --verify --strict`
  for 46/46 Mach-O files and outer `codesign --verify --deep --strict`.
- F1/F2 regression: `npm run prove:package:macos` passed exact LaunchServices
  launch, transaction recovery, canonical bundle/identity restoration,
  unchanged default store/exports, and no owned process. The observed F1
  host CDHash was `76af7ba008a021bdc60cfdd5fc48d254ed208175`.
  `npm run check:distribution-readiness` remained fail-closed with the same
  11 unresolved Human/legal components: `meetless`, `paseo`, `js-closure`,
  `electron-chromium`, `node`, `native-binaries`, `capture-helper`,
  `ffmpeg-media`, `sherpa-model-assets`, `fonts-assets`, and `unzip-crx-3`.
- F3 evidence: `npm run prove:package:acceptance` passed both exact-host
  generations. It published
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` with external
  SHA-256
  `88403fd506583c6497a6507dbd8811348a7fa873180d7cff1a9b203a8b6d7373`.
  The evidence binds the exact identities above, source-labelled fixture
  chunks, collision-safe readable MP3, fake ordered transcript, known and
  unknown citation behavior, citation-bound playback, generation-2 restart,
  and identical 21-entry media closure fingerprint
  `9507d949fcc25e4a758cb2e277a09e6f5f4c4bfc5bd7d9318fad2dd64db63943`.
  The evidence digest is outside the evidence bytes. The default post-
  publication snapshot is
  `f94e34313a69e3d4e81fd73dfa0d1edfc326dabc2dc6ace5db5a20407d36e07f`;
  package-source remains the exact digest above and excludes only the one
  published M7 evidence file.
- Cleanup proof: the run stopped only owned processes, released package ports,
  removed the runtime/store before the leased external root, checked the exact
  expired session lease, removed the unique export root, restored the
  canonical bundle and identity byte-for-byte, preserved default store and
  exports, released the proof lock, and left no owned `MeetlessHost` or
  `meetless-capture` process. Post-publication validator and identity checks
  passed.
- Candidate status: deterministic candidate for Lead review, not a
  self-acceptance. M7, real-target/provider/TCC/audible-output proof,
  Developer ID signing, notarization, release acceptance, and Human/legal
  clearance remain open.

### PLAN_RECONCILIATION v1 — M7-F3-CORRECTION-R1B

- Frontier: `M7-F3-CORRECTION-R1B`. This bounded correction addresses only
  `M7F3-R1-004`, the clip-relative playback clock regression. It preserves
  the closed `M7F3-R1-001` symlink and `M7F3-R1-002` atomic media-publication
  boundaries.
- Candidate identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; package-source snapshot
  `79e25753df22a61f9990728e0fc7d1a8697fd774a7dc1293740485fc2d64dec2`;
  package-input digest
  `dd674c502026d7565abfdfaf1a3aaa1b6a3c651f3db3ea74cafd37f6c98b6e45`;
  artifact-input digest
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact digest
  `9d4edbfa27a4579fec51cc9e8c0dce42a46c42c178bb7b4fae88fff52061a327`.
  The artifact has 13,774 entries and 46 regular arm64 Mach-O files. Two
  consecutive package builds reproduced all identities and counts.
- `M7F3-R1-004` closure: playback identity still binds meeting, recording,
  segment, absolute `startMs`, and absolute `endMs`. The proof computes
  `(endMs - startMs) / 1000` as `clipDurationSeconds` and accepts only finite
  `0 < maximumCurrentTime <= clipDurationSeconds`, with `playResolved` and
  `pauseObserved` required. Focused tests cover zero, negative, NaN,
  infinity, beyond-duration, wrong-identity, pause-without-progress, and a
  positive non-zero citation (`2000..4000ms`, `currentTime=1.0`).
- Direct regressions: the focused playback, symlink, media-publication,
  package, signature, transaction, isolation, envelope, and readiness suite
  passed 8 files and 84 tests. R1-001 fixtures still reject absolute,
  escaping, dangling, and external-realpath links while accepting internal
  links. R1-002 fault and ownership tests still pass.
- Verification: `npm run typecheck` and `git diff --check` passed. The
  structural validator passed after evidence publication, including
  individual `codesign --verify --strict` for 46/46 Mach-O files and outer
  `codesign --verify --deep --strict`. F1 passed. F2 exited 1 with the same
  11 unresolved Human/legal components.
- F3 evidence: `npm run prove:package:acceptance` passed both exact-host
  generations and published
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` with external
  SHA-256
  `78e5e102a4b53c1bab1743edf02d39e39debf631f409ac2e372204db903ebfd2`.
  Both generations retained the 6,057-byte MP3
  `739bdeea34e5cec0fcbe66901ba3115abe537e8ccb30d21f8620ae54190ee210`,
  the 4,977-byte citation clip
  `2ba9139b18dcc52996ceeb34f238d39ac02b47ce354a4d5292b2e5ae65378d26`,
  positive bounded playback, transcript/citation state, and the identical
  21-entry media fingerprint
  `9507d949fcc25e4a758cb2e277a09e6f5f4c4bfc5bd7d9318fad2dd64db63943`.
- Cleanup proof: the run stopped only owned processes, released ports and
  the proof lock, removed the runtime before the leased external export
  root, restored the canonical bundle and identity byte-for-byte, preserved
  default store and exports, and left no owned `MeetlessHost` or
  `meetless-capture` process. Post-publication source/default identity checks
  were `79e25753df22a61f9990728e0fc7d1a8697fd774a7dc1293740485fc2d64dec2`
  and `824124b53e750e33dd17062d1a483f3541b7b73733323acf8ed02eca0f48b3d2`.
- Candidate status: deterministic candidate for Lead review, not a
  self-acceptance. Evidence is controlled fixture/fake-provider proof only;
  real calls, native providers, audible output, clean-install TCC,
  Developer ID signing, notarization, release acceptance, and Human/legal
  clearance remain open.

### LEAD_DECISION v1 — M7-F3-PACKAGED-CONTROLLED-LIFECYCLE

- Decision: `ACCEPT`; review closeout: `CLOSEOUT_CLEAR`.
- Accepted findings closed: `M7F3-R1-001..004`. The stale identity record and
  R1/R1B corrections remain above as history.
- Accepted identity: HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; package-source
  `79e25753df22a61f9990728e0fc7d1a8697fd774a7dc1293740485fc2d64dec2`;
  package-input
  `dd674c502026d7565abfdfaf1a3aaa1b6a3c651f3db3ea74cafd37f6c98b6e45`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact
  `9d4edbfa27a4579fec51cc9e8c0dce42a46c42c178bb7b4fae88fff52061a327`;
  evidence
  `78e5e102a4b53c1bab1743edf02d39e39debf631f409ac2e372204db903ebfd2`;
  default post-publication snapshot
  `824124b53e750e33dd17062d1a483f3541b7b73733323acf8ed02eca0f48b3d2`.
  Artifact shape: 13,774 entries and 46 Mach-O files.
- Lead checks passed: package-source identity, evidence SHA-256, exact
  package validator identity, default snapshot/evidence binding, and
  `git diff --check`.
- Reconciliation: M7-F1 package composition and M7-F2 license inventory
  guard remain accepted. M7-F2 distribution readiness remains fail-closed.
  M7 remains open.
- Remaining gates: real call/native provider/audible output, clean-install
  TCC, Developer ID and hardened runtime, notarization, update/publication/
  distribution acceptance, and the 11 Human/legal component decisions.
  Controlled fixture/fake-provider proof does not establish any of these
  gates.
- Next frontier: `M7-F4-RELEASE-GATE-RECONCILIATION-DISCOVERY`.

### PEER CANDIDATE — M7-F4-DEVELOPER-ID-HARDENED-RUNTIME-PREP

- Status: Peer candidate; pending independent DEEP review. This record does
  not self-accept the candidate and does not claim release acceptance.
- Authority: the M7 release-gate requirement above and the accepted
  M7-F4 discovery. The encoded scope is macOS package signing assembly and
  validation only. Explicit `local-ad-hoc` is allowed for local proof and is
  marked non-distributable. Explicit `release` requires a supplied signing
  identity and entitlement file. No production entitlement policy was added.
- Candidate identity: workspace HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; package-source snapshot
  `352c89df898c143f232db86b06a32bd8afeee70d5aa017e0264ad01840310cae`;
  accepted Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
  Package-input digest is
  `f9ca849aa2b9d56e1e1733443acadcc484173240b3a3aad68fca166516afa7e6`;
  artifact-input digest is
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  final artifact digest is
  `20b24f06b1ce390f5588c363b2bb6399223c6458fa4911ca2b1f1574587e25eb`.
  The final artifact has 13,774 entries and 46 regular arm64 Mach-O files.
- Changed validation owner: `scripts/lib/macos-package-signing.mjs` owns
  explicit mode parsing, release-input checks, deepest-first/outer-last
  order, codesign evidence, hardened-runtime/Team ID/entitlement checks, and
  the acyclic post-signature state digest. `scripts/package-macos.mjs` uses
  that owner for local and release assembly. `scripts/validate-macos-package.mjs`
  validates every final nested Mach-O and the outer app against the declared
  contract. The package scripts make local ad-hoc mode explicit and expose a
  separate explicit release command.
- Signing metadata: the manifest records mode, local-only state, requested
  identity, Team ID evidence, runtime flag evidence, entitlement file and
  signed-entitlement digests, every final signature state, and deepest-first
  order with `Meetless.app` last. The signature-state digest is computed
  without the manifest artifact digest, so there is no digest cycle. The
  local candidate records `local-ad-hoc`, `localOnly: true`,
  `releaseAcceptance: not-claimed`, and `notarization: not-run`.
- Positive proof: the structural Developer ID/hardened-runtime fixture passed
  without a credential. The local package assembled twice with the same
  artifact digest. `node scripts/validate-macos-package.mjs` passed. The
  focused package/signing/runtime suite passed 87 tests. `npm run typecheck`
  and `git diff --check` passed. `npm run prove:package:macos` passed the
  bounded F1 launch, readiness, renderer, transaction, restoration, and
  cleanup proof. `npm run prove:package:acceptance` passed both controlled F3
  generations and published evidence with external SHA-256
  `888ccdbcbe766ae2cd8d19d29100c1f8a97da05cd4229b121e63da2283a18ff3`.
- Negative proof: explicit mode is required for assembly; release mode
  rejects missing identity, missing entitlement input, and ad-hoc identity.
  Structural validation rejects ad-hoc release signatures, missing runtime
  flags, wrong Team ID, stale entitlement digest, unsigned nested Mach-O,
  post-signature mutation, and non-outer-last order. Local ad-hoc metadata
  rejects release identity, Team ID, and entitlement evidence. The F2
  readiness command remains fail-closed with the same 11 unresolved
  Human/legal components.
- Enforcement levels: local validation is available through
  `node scripts/validate-macos-package.mjs` and the explicit package/proof
  commands; it passed for this candidate. No optional hook is present or was
  installed. No checked-in CI invocation was found (`.github/` is absent),
  and no CI was added. Branch protection is unverified; no external state was
  changed.
- Cleanup and limits: the proof runtime, owned host/capture processes, and
  stale proof lock markers were absent after cleanup. No credentials, real
  Developer ID signing, notarization, upload, publication, clean-install TCC,
  real provider/target, or audible-output proof was run. Remaining gates are
  actual Developer ID credentials and owner-provided entitlements, hardened
  runtime/notarization proof, clean-install TCC attribution and persistence,
  production packaging and release acceptance, and the 11 Human/legal
  decisions. The candidate is ready for independent review.

### PEER CANDIDATE — M7-F4-CORRECTION-R1

- Status: Peer candidate; pending independent DEEP review. The writer does
  not self-accept this candidate and does not claim release acceptance.
- Encoded authority and scope: explicit macOS `local-ad-hoc` or explicit
  `release` signing preparation only. Release mode requires an owner-supplied
  identity and entitlement file. No production entitlement policy was added.
- Candidate identity: workspace HEAD
  `bb678fa59674aa0292f56ada3beb57290faaf540`; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source snapshot
  `d2752eff76d3306ac006d34670ebf84c6df95bb8be641906917376df2524a077`;
  package-input `ab8088c6bf184533738d6e306744dd155766ebee6b93f5af17fc55881171b8b3`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact `c73f44c8fc9e0ceb07ce230a248d92c8c2c1137f4d8be525625d0a7866d9d40e`;
  signature-state
  `5413bf084a1c647053217ba0d5212d2cacf85d78b18dc751ba677d9409d879bf`.
  The artifact contains 13,774 entries and 46 nested Mach-O files. The
  local manifest is `local-ad-hoc`, `localOnly: true`, with `-` identity;
  release acceptance is `not-claimed` and notarization is `not-run`.
- Changed validation owner: `scripts/lib/macos-package-signing.mjs` owns
  explicit mode parsing, exact certificate resolution, entitlement
  canonicalization, signing order, signature evidence, hardened-runtime and
  Team ID checks, and acyclic post-signature metadata. The package assembler
  uses this owner. `scripts/validate-macos-package.mjs` validates all 46
  nested Mach-O files and the outer app.
- M7F4-R1-001 closure: release identity resolution now accepts only an exact
  observed `Developer ID Application` leaf. Package self-validation keeps the
  original human-supplied identity; only the resolved SHA-1 is passed to
  `codesign`. Each final image independently extracts leaf certificate DER
  from its exact signature and derives SHA-1 and SHA-256 evidence. The
  manifest binds requested and resolved identity, observed leaf, certificate
  evidence, and Team ID, including the Team ID encoded by the resolved
  certificate identity. It rejects Apple Development, Apple Distribution,
  ad-hoc, ambiguous, mismatched, wrong-Team, missing, and per-image
  certificate-mismatch cases. The positive structural fixture uses synthetic
  `Developer ID Application: Meetless (ABCDE12345)` / Team ID `ABCDE12345`
  evidence and does not use a credential.
- M7F4-R1-002 closure: owner and signed entitlement plists are converted to
  canonical JSON with sorted object keys. Raw owner and signed digests remain
  separate from canonical digests. Equivalent formatting passes. Missing,
  extra, or changed keys and values fail. No production entitlement was
  selected.
- M7F4-R1-003 closure: `@loader_path` uses the loading image;
  `@executable_path` uses the graph main executable; `@rpath` uses declared
  and inherited run paths. Same-basename fallback is removed. Targets must be
  regular files or internal symlinks to regular files. Exact Electron
  Framework, Squirrel, ReactiveObjC, and Mantle edges pass; missing exact
  targets and directory targets fail.
- M7F4-R1-004 closure: argument parsing splits only at the first `=`.
  Identity and entitlement values keep later `=` characters. A mode with an
  extra `=` is rejected as an invalid mode.
- Positive proof: local package assembly twice produced the same artifact
  digest `c73f44c8fc9e0ceb07ce230a248d92c8c2c1137f4d8be525625d0a7866d9d40e`.
  The validator passed with 46/46 individual signatures and outer deep/strict
  verification. The signing/package boundary tests passed 45 tests; the M7
  regression set passed 99 tests in 8 files. `npm run typecheck`,
  `npm run test:focused` (49 files, 397 tests), and `git diff --check` passed.
  `npm run prove:package:macos` passed. `npm run prove:package:acceptance`
  passed and wrote F3 evidence SHA-256
  `f76324e615730648fcf6fb130bf951f91ff3db302d3790e5df119acc1b09ed6b`.
- Negative proof: missing explicit mode, release mode without identity,
  release mode without entitlements, invalid mode with `=`, non-Developer-ID
  signer classes, ambiguous or mismatched signer, wrong Team ID, missing leaf
  fingerprint, entitlement semantic drift, unsigned nested Mach-O, missing
  runtime flag, post-signature mutation, invalid `@rpath`, unrelated
  same-basename fallback, bad `@loader_path`/`@executable_path`, directory
  targets, and non-outer-last order are rejected by tests or commands.
  `check:distribution-readiness` remains fail-closed for the same 11
  Human/legal gates.
- Enforcement: local validation and package/proof commands are present and
  passed. No optional hook is present or was installed. No checked-in CI
  invocation exists (`.github/` is absent), and no CI was added. Branch
  protection is unverified; no external state was changed.
- Cleanup and limits: the exact proof runtime, owned host/capture processes,
  and proof lock state were absent after cleanup. No real Developer ID
  signing, credential access, timestamp request, notarization, upload,
  publication, clean-install TCC reset, real provider call, or release claim
  was made. Remaining Human/external gates are owner-provided production
  entitlements and Developer ID credentials, real hardened-runtime and
  notarization proof, clean-install TCC behavior, production packaging and
  release acceptance, and the 11 Human/legal decisions.

### LEAD_DECISION v1 — M7-F4-DEVELOPER-ID-HARDENED-RUNTIME-PREP

- Decision: `ACCEPT`.
- Review closeout: `CLOSEOUT_CLEAR`.
- Accepted findings closed: `M7F4-R1-001..004`.
- Accepted HEAD: `bb678fa59674aa0292f56ada3beb57290faaf540`.
- Accepted Paseo commit: `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- Accepted package-source:
  `d2752eff76d3306ac006d34670ebf84c6df95bb8be641906917376df2524a077`.
- Accepted package-input:
  `ab8088c6bf184533738d6e306744dd155766ebee6b93f5af17fc55881171b8b3`.
- Accepted artifact-input:
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`.
- Accepted artifact:
  `c73f44c8fc9e0ceb07ce230a248d92c8c2c1137f4d8be525625d0a7866d9d40e`.
- Accepted signature-state:
  `5413bf084a1c647053217ba0d5212d2cacf85d78b18dc751ba677d9409d879bf`.
- Accepted F3 evidence:
  `f76324e615730648fcf6fb130bf951f91ff3db302d3790e5df119acc1b09ed6b`.
- Accepted artifact shape: 13,774 entries, 46 nested Mach-O files, and the
  outer `Meetless.app` signed last.
- Lead checks passed: package-source and evidence hashes, exact local-ad-hoc
  validator source/artifact binding, explicit `localOnly` manifest state,
  signature-state binding, and `git diff --check`.

### PLAN_RECONCILIATION v1 — M7-F4-ACCEPTANCE

- M7-F1 package composition, M7-F2 license guard, M7-F3 controlled packaged
  lifecycle, and M7-F4 release-signing preparation are accepted.
- F4 encodes a local guard and credential-free structural proof only. It does
  not prove real Developer ID signing, timestamping, hardened-runtime
  execution, notarization, clean-install TCC behavior, publication, real
  calls, audible output, release acceptance, or legal clearance.
- Enforcement levels: local validator passed; no optional hook is present; no
  checked-in CI invocation exists; branch protection is unverified. No
  external state changed.
- M7 remains open.
- Minimum owner inputs to unlock real signing validation:
  1. The exact human-supplied `Developer ID Application` identity or its
     certificate SHA-1, plus the expected Team ID.
  2. The matching Developer ID certificate, private key, and certificate
     chain in an owner-controlled signing keychain available to `codesign`.
  3. The owner-approved entitlement plist, supplied unchanged. No production
     entitlement values will be selected by the implementation.
  4. Owner authorization for one real signing-validation run in that
     credentialed environment.
- Apple account or notarization credentials are not required for the first
  signature-validation run, but are required for later notarization and
  publication gates. Clean-install TCC and Human/legal decisions remain
  separate external gates.
- No further writable release-signing frontier is authorized until these
  minimum owner inputs are supplied.
- Next frontier: `M7-F5-OWNER-INPUT-HANDOFF`.

### OWNER_INPUT_HANDOFF v1 — M7-F5-OWNER-INPUT-HANDOFF

- Status: `DEPENDENCY_REQUEST`.
- Authority: the owner-provided environment state and Lead ruling for
  `M7-F5-OWNER-INPUT-HANDOFF`. The state is owner-provided and read-only;
  Xcode reported the certificate present locally in the owner-controlled
  Keychain on 2026-08-25. No Keychain or Xcode inspection was repeated.
- Authoritative current identity state: `Developer ID Application: Long Le
  (63M98WD275)`, certificate SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, embedded Team ID
  `63M98WD275`. The previously reported Apple Development identity was under
  Team `335C7MY4H4`.
- Owner decision: Team `63M98WD275` is the official Meetless release
  authority. This closes only the Team-authority mismatch. It does not
  authorize real signing, notarization, credential export, private-key access,
  timestamp or network requests, package mutation, or approval or use of an
  entitlement plist.
- Exact blocker: no owner-approved production entitlement plist exists, and
  there is no owner authorization for one real signing-validation run.
  Release signing remains fail-closed. All other release gates remain closed.
- Data-handling limit: do not export, share, request, record, print, or place
  private-key material in chat or the repository. No credentials or Keychain
  state were changed by this work.
- Resumption condition: the owner-approved production entitlement plist and
  owner authorization for one real signing-validation run. Until then, the
  accepted F1-F4 identities and evidence remain unchanged, M7 remains open,
  and no package, artifact, evidence, runtime, or app state may be changed.

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
