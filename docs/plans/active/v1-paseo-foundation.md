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
- [`0002-direct-notarized-macos-dmg.md`](../../decisions/0002-direct-notarized-macos-dmg.md)
  owns the macOS distribution path. V1 uses a directly downloaded `.dmg`, not
  the Mac App Store.
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
4. Verify the exact downloadable DMG through Developer ID signing, hardened
   runtime, required entitlements, secure timestamp, notarization, stapling,
   production packaging, and clean-machine Gatekeeper and first-run UX. Verify
   permission attribution and persistence across an update or replacement.
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
- Developer ID signing, hardened runtime, required entitlements, secure
  timestamp, DMG packaging, notarization, stapling, license notices, and
  clean-machine Gatekeeper, first-run, and permission behavior remain open
  release gates.

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

### PEER CANDIDATE — M7-F5-ENTITLEMENT-MAP-CONTRACT

- Status: Peer candidate; pending independent DEEP review. The writer does
  not self-accept this candidate and does not claim release readiness.
- Authority: the owner-approved entitlement proposal v1, items 1..5. This
  candidate replaces only the invalid single outer-app entitlement premise.
  M7-F1, M7-F2, M7-F3, and the remaining M7-F4 signing guard stay unchanged.
  TCC ownership, Info.plist behavior, real signing, notarization, and release
  acceptance remain separate fail-closed gates.
- Candidate identity: observed workspace HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source snapshot
  `e67a62c992d4c104359f68d5f0fd177c6d987261836b510642d9eab286eaa01a`;
  package-input `4451411155a72adb54721700ad29ffe972d89f58f78e069a9c49cbfa66680b0a`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  local artifact
  `016a9ae7e8bd977b9c9ae720d82b89e5481974b54fd2dde5a6760d94bee8ff2e`;
  signature-state
  `53c9ad3da0c83b243fa202c3351a6a48023abe9810ab0870b1049958e85201a1`.
  The artifact has 13,774 entries and 46 nested Mach-O files. The local
  manifest is `local-ad-hoc`, `localOnly: true`, and has no entitlement
  policy or signed entitlement bytes. `Meetless.app` is signed last.
- Changed validation owner: `scripts/lib/macos-package-signing.mjs` owns
  the checked-in policy path, exact map, plist canonicalization, source and
  observed digests, per-image entitlement keys, explicit signing modes,
  certificate evidence, hardened-runtime flags, and acyclic post-signature
  metadata. `scripts/package-macos.mjs` applies a plist only to its exact
  approved nested executable and omits `--entitlements` for every other
  object and for the outer app. `scripts/validate-macos-package.mjs` reads
  every final signature and validates all 46 nested Mach-O files plus the
  outer app.
- Source-policy owner and exact inputs:
  `scripts/macos-entitlements/entitlement-map.json` is the deterministic
  `MEETLESS_MACOS_ENTITLEMENT_MAP v1` authority. Its raw SHA-256 is
  `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462` and
  its canonical JSON SHA-256 is
  `5d62d8668c6808489018178e919d4d6c80d897035efa3d6da6ec65ae0ad48b52`.
  `scripts/macos-entitlements/entitlements/jit.plist` contains exactly:

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
  </dict>
  </plist>
  ```

  Its raw SHA-256 is
  `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a` and
  its canonical SHA-256 is
  `6f0a9b4f19e49ab2c95c62b5012d87edc50fb74a76df2b364fdcb0a9dc929e30`.
  `scripts/macos-entitlements/entitlements/audio-input.plist` contains
  exactly the same plist form with the one key
  `com.apple.security.device.audio-input` set to `true`. Its raw SHA-256 is
  `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee` and
  its canonical SHA-256 is
  `82052f68fb90e288554c67b08bdcb3403699ac396387a93d37f3b397c3e9f064`.
- Exact mapping:
  - `jit` / `jit.plist`: `Contents/Resources/meetless/runtime/node`.
  - `jit` / `jit.plist`:
    `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron`.
  - `jit` / `jit.plist`:
    `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`.
  - `jit` / `jit.plist`:
    `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)`.
  - `audio-input` / `audio-input.plist`:
    `Contents/Resources/meetless/native/macos-capture/meetless-capture`.
  Every other executable code object, including MeetlessHost, generic and
  Plugin Helpers, Crashpad, ffmpeg/ffprobe, native tools, provider binaries,
  frameworks, dylibs, and `.node` modules, is mapped to no entitlement and
  receives no `--entitlements` argument. The outer app is also unentitled.
  No union plist is accepted. The map is exact, so a new inventory path does
  not inherit an entitlement.
- Metadata contract: release metadata binds the map raw and canonical
  digests, both owner plist raw and canonical digests, each approved path and
  policy class, and observed raw/canonical signed entitlement digests and
  keys for every final image. The signature-state digest excludes the
  manifest artifact digest. Equivalent plist formatting and key order pass;
  semantic drift fails. Local ad-hoc metadata binds no policy and requires
  empty signed entitlements for every final image.
- Candidate identities: local proof uses ad-hoc identity `-`. The structural
  release fixture uses synthetic, credential-free evidence
  `Developer ID Application: Meetless (ABCDE12345)`, Team ID `ABCDE12345`,
  certificate SHA-1 `1111111111111111111111111111111111111111`, and synthetic
  certificate SHA-256 `2222222222222222222222222222222222222222222222222222222222222222`.
  The owner-provided real release identity remains
  `Developer ID Application: Long Le (63M98WD275)`, SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it was not inspected again and
  was not used for signing.
- Positive proof: exact map and both plist inputs parse and canonicalize.
  The structural Developer ID fixture passes without a credential and reads
  each image's signed plist independently. The signing tests pass 30 tests,
  including deepest-first and outer-last order, deterministic acyclic
  metadata, per-image certificate evidence, equivalent plist semantics, and
  exact allowlist negatives. Two final local ad-hoc rebuilds from the same
  candidate matched artifact digest
  `016a9ae7e8bd977b9c9ae720d82b89e5481974b54fd2dde5a6760d94bee8ff2e`.
  The validator passed 46/46 individual signatures and outer deep/strict
  verification. Typecheck passed. The focused suite passed 49 files and 407
  tests. F1 passed with the final artifact. F3 passed with evidence SHA-256
  `c6340d372c15e583fe481d0297117ce8a47f4af10dbbcda1c2aea99b22775a44`.
- Negative proof: release mode rejects a missing map, a single outer-app
  plist, and ad-hoc or non-Developer-ID signer evidence. The map and policy
  tests reject JIT on host or other unapproved paths, audio input on any
  other path, missing approved entitlements, union/false/extra/changed/risky
  keys, unmapped entitlement-bearing images, stale map or plist digests, and
  observed/supplied semantic mismatch. Existing tests still reject wrong
  Team ID, mismatched or missing per-image certificate evidence, missing
  runtime flags, unsigned nested Mach-O, post-signature mutation, invalid
  `@rpath` and path resolution, and non-outer-last order. CLI values retain
  all text after the first `=`; a signing mode containing another `=` is
  invalid. The local package reports no entitlement keys on all 47 final
  code objects.
- Regression and enforcement: `npm run typecheck`, the focused suite,
  `git diff --check`, local package validation, F1, and F3 passed.
  `npm run check:distribution-readiness` failed closed with exit 1 for the
  same 11 Human/legal gates. Local validation is present and passed. No
  optional hook is installed. No checked-in CI invocation exists; `.github/`
  is absent and no CI was added. Branch protection is unverified. No release
  command, Keychain inspection, real Developer ID signature, timestamp or
  network request, notarization, upload, publication, TCC reset, or release
  claim was made.
- Cleanup and remaining gates: F1/F3 proof processes stopped, proof lease
  roots were removed, the canonical package identity was restored, and the
  default store and exports were unchanged. TCC ownership and
  clean-install attribution remain unresolved. Remaining owner/external
  gates are authorization for one real signing-validation run using the
  owner-controlled `63M98WD275` certificate, real hardened-runtime behavior,
  notarization and publication decisions, production packaging/release
  acceptance, and the same 11 Human/legal decisions. This candidate does
  not claim any of those gates.
- Next frontier: `M7-F5-OWNER-INPUT-HANDOFF` remains the owner gate for
  authorization of one real signing-validation run. M7 remains open.

### PEER CORRECTION CANDIDATE — M7-F5-CORRECTION-R1

- Status: Peer candidate; pending independent DEEP review. The writer does
  not self-accept this correction and does not claim release readiness.
- Authority and scope: Lead accepted findings `M7F5-R1-001..003` authorize
  only the local entitlement guard, authoritative Mach-O executable typing,
  and the pinned checked-in map path. The approved JIT/audio values and five
  executable paths above are unchanged. TCC, Info.plist, real signing,
  notarization, and release acceptance remain separate fail-closed gates.
- Candidate identity: observed workspace HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source snapshot
  `a456e41a47338dcf98e5672bfc2f60d30b89275a23591d9ddb171848d4402515`;
  package-input `7d5d0b246c37e2b1befe52b6b93e6bd69a20654d3631778c5135ff2cd759ac5c`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact
  `fe8a71a15e9cfbcb426f17e1a5bf9e20502e373cda3f30c250d6eed90424e587`;
  signature-state
  `1c07152b83fe16cb6a4e0dd3479626f5859ce2181a5465aedb57375a9c0830ba`.
  The artifact has 13,774 entries and 46 nested Mach-O files.
- M7F5-R1-001 closure: local validation now rejects every nested or outer
  image with non-empty entitlement keys or non-null raw/canonical entitlement
  digests. The final local manifest records null raw/canonical digests and
  empty keys for all 47 final code objects. The diagnostic names the image
  path and requires removing `--entitlements` and rebuilding local proof.
- M7F5-R1-002 closure: `scripts/lib/macos-package-inventory.mjs` carries
  `otool -hv` file type and architecture evidence. Before signing and again
  during validation, each approved path must be a regular arm64 `MH_EXECUTE`.
  Metadata carries the same evidence in each nested signature record. Dylib,
  bundle, object, symlink, directory, missing, and non-arm64 fixtures fail
  with the path, observed type, expected policy class, and replacement action.
- M7F5-R1-003 closure: production release resolution always loads
  `scripts/macos-entitlements/entitlement-map.json`; `--entitlement-map` is
  not a supported production option, and programmatic release overrides are
  rejected. Map and plist parents and final files must be non-symlink and
  realpath-contained inside the repository authority. Traversal, absolute
  escape, external realpath, parent symlink, and final-file symlink fixtures
  fail. Direct policy-loader fixtures remain test-level only.
- Exact unchanged policy: `jit.plist` contains only
  `com.apple.security.cs.allow-jit=true`; `audio-input.plist` contains only
  `com.apple.security.device.audio-input=true`. JIT applies only to
  `runtime/node`, Electron, Electron Helper (Renderer), and Electron Helper
  (GPU); audio input applies only to `native/macos-capture/meetless-capture`.
  The outer app and every other code object remain entitlement-free.
- Positive proof: signing tests passed 33/33; package tests passed 25/25;
  focused tests passed 49 files and 410 tests; typecheck passed. Two local
  ad-hoc builds matched artifact
  `fe8a71a15e9cfbcb426f17e1a5bf9e20502e373cda3f30c250d6eed90424e587`.
  The validator passed 46/46 nested signatures and outer deep/strict checks.
  F1 passed with this artifact. F3 passed with evidence SHA-256
  `34bd2cf28c1f55783ccb79a52290d2a8b27dfdb480f8de6008fbf7ee36d2ed98`.
- Negative and regression proof: local risky/non-empty entitlement evidence,
  all five wrong Mach-O types, symlink/traversal/external authority paths,
  CLI override, and prior union/extra/false/risky/stale/missing/unapproved
  entitlement cases fail. Existing signer, certificate, hardened-runtime,
  dyld-closure, signing-order, mutation, and CLI-equals tests remain green.
  F2 remains fail-closed for the same 11 Human/legal gates.
- Enforcement: local validator passed. No optional hook is installed. No
  checked-in CI invocation exists and `.github/` is absent. Branch protection
  is unverified. No hook, CI, or external setting was changed.
- Cleanup and limits: F1/F3 processes stopped; proof state and temporary
  roots were cleaned; default store and exports remain unchanged. No real
  Developer ID signing, Keychain inspection, credential/private-key access,
  timestamp/network request, notarization, upload, publication, TCC reset,
  clean-install acceptance, or release claim was made. The owner-provided
  identity remains `Developer ID Application: Long Le (63M98WD275)` with
  SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it was not inspected or
  used. Remaining gates are independent review, explicit authorization for
  one real signing-validation run, real hardened-runtime behavior, TCC and
  clean-install validation, notarization/publication decisions, legal
  clearance, and release acceptance. M7 remains open.

### PEER_DISPOSITION v1 — M7-F5-CORRECTION-R1B

- Status: Candidate only; pending independent DEEP review. The writer does
  not self-accept and does not claim release readiness.
- Authority and scope: Lead authorized closure of `M7F5-R1-002` only.
  `M7F5-R1-001` local-empty validation and `M7F5-R1-003` canonical policy
  path validation remain closed. The approved entitlement values, exact five
  paths, TCC separation, signing mode contract, and release authority are
  unchanged. No real signing, credential, Keychain, timestamp, notarization,
  upload, publication, TCC, or release action is authorized here.
- Candidate identity: workspace HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source snapshot
  `ed3d72a005e7a646ece7435fdeeaaea95d10a451f3fef4d0cc09987a9c52a785`;
  package-input `93eca578d4a09988b3a9d1882adc47ea195165b79ea27ad05404ffb81f369792`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  local artifact
  `39428c03b370603eedeca18e9a33dcd395198e9e1e3e131f2f2d08966962d6ab`;
  signature-state
  `99d5e668b209bdf74652e50ff164a6619097d1b57b054cfee4e6c659191cc270`;
  F3 evidence
  `441609bb222b141a0c9bd5759fb898ac7ba4f59d1c5756bd4699d3490da7a923`.
  The candidate has 13,774 entries and 46 nested Mach-O objects.
- Changed validation owner: `scripts/lib/macos-package-inventory.mjs`
  parses every authoritative `otool -hv` Mach-O header and carries a sorted
  `machOSlices` set. `scripts/lib/macos-package-signing.mjs` normalizes that
  set into signature metadata and requires each approved entitlement path to
  contain exactly one regular `arm64` `MH_EXECUTE` slice. The package
  assembler performs this pre-sign guard before the first entitlement-bearing
  `codesign` call. The final validator checks the same evidence after signing;
  its existing arm64 file-output check remains defense in depth.
- Changed files in this candidate: `scripts/lib/macos-package-inventory.mjs`,
  `scripts/lib/macos-package-signing.mjs`, `scripts/package-macos.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `packages/runtime/test/macos-package-signature.test.ts`. The generated
  `release/macos/composition-manifest.json` records the candidate metadata;
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` records the
  refreshed F3 proof. No package, runtime, native, product, CI, hook, or
  external-state file was added outside the accepted scope.
- All-slice evidence: the five approved paths each report exactly
  `[arm64 MH_EXECUTE]` in the generated candidate metadata:
  `Contents/Resources/meetless/runtime/node`, Electron,
  `Electron Helper (Renderer)`, `Electron Helper (GPU)`, and
  `Contents/Resources/meetless/native/macos-capture/meetless-capture`.
  No first-header-only result is accepted. Duplicate or ambiguous slices
  fail before signing.
- Exact unchanged policy: `jit.plist` contains only
  `com.apple.security.cs.allow-jit=true`; `audio-input.plist` contains only
  `com.apple.security.device.audio-input=true`. The raw map/plist digests
  remain `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`,
  `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`, and
  `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`.
  The five-path mapping is unchanged. Local ad-hoc output remains
  entitlement-free and `localOnly`.
- Candidate identities: local proof uses ad-hoc identity `-`. The structural
  release fixture uses credential-free synthetic evidence
  `Developer ID Application: Meetless (ABCDE12345)`, Team ID `ABCDE12345`,
  certificate SHA-1 `1111111111111111111111111111111111111111`, and synthetic
  certificate SHA-256
  `2222222222222222222222222222222222222222222222222222222222222222`.
  The owner-provided release identity is
  `Developer ID Application: Long Le (63M98WD275)`, SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it was not inspected or used.
- Positive proof: signing tests passed 34/34, package tests 25/25, focused
  tests 49 files and 411 tests, and typecheck passed. Thin arm64
  `MH_EXECUTE` passes. The five live approved targets report exact single
  slices. Two local ad-hoc builds matched artifact
  `39428c03b370603eedeca18e9a33dcd395198e9e1e3e131f2f2d08966962d6ab`.
  The validator passed 46/46 individual signatures and outer deep/strict
  verification. F1 passed. F3 passed with the evidence hash above.
- Negative proof: structural pre-sign tests reject universal arm64+x86_64,
  universal arm64+arm64e, arm64e-only, x86_64-only, and multi-header dylib
  slices. The rejection includes the path, observed slice set, expected
  policy, and action. The test keeps its `codesign` counter at zero after
  pre-sign rejection. R1-001 local risky/non-empty entitlement and R1-003
  symlink, traversal, absolute, external, and CLI override tests remain
  green. Existing entitlement, signer, certificate, hardened-runtime, dyld,
  signing-order, mutation, and CLI-equals negatives remain green.
- Enforcement: local validator passed. No optional hook is installed. No
  checked-in CI invocation exists; `.github/` is absent. Branch protection is
  unverified. No hook, CI, branch setting, or external state was changed.
- Cleanup and residual gates: F1/F3 proof processes stopped; runtime proof
  roots and the empty proof-export directory were removed; default store and
  exports remain unchanged. F2 remains fail-closed for the same 11
  Human/legal gates. Remaining gates are independent DEEP review, explicit
  authorization for one real signing-validation run, real hardened-runtime
  behavior, TCC and clean-install validation, notarization/publication
  decisions, legal clearance, and release acceptance. M7 remains open.

### PEER_DISPOSITION v1 — M7-F5-CORRECTION-R1C

- Status: Candidate only; pending independent DEEP review. The writer does
  not self-accept and does not claim release readiness. This correction closes
  `M7F5-R1-002` only. `M7F5-R1-001` local-empty validation and
  `M7F5-R1-003` canonical policy-path validation remain closed.
- Candidate identity: workspace HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source snapshot
  `0e185083790cbff9c8ea8f9dd6cb3c3fb6c7d6b97e53c85c8064f1e9e9d40bad`;
  package-input `d1e79c34be7b82390556d2c9bf14bd961a42162b75abe2bcb6d2502aa36b2e74`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact `9110e6d0d65646e6c916250e855da54609ecb0e4baf58b92b1fd4e728f6cb3cc`;
  signature-state
  `c34876fbea33183c895dbb01c299fbdb563366d39286fc3a4d1c3cfc84a084e0`;
  F3 evidence SHA-256
  `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`.
  The candidate contains 13,774 entries and 46 nested Mach-O files.
- Changed validation owner: `scripts/lib/macos-package-inventory.mjs` now
  invokes `otool -arch all -hv` for every Mach-O inspection, parses every
  returned header block, preserves CPU subtype, rejects duplicate or
  malformed blocks, and carries a deterministic full slice list.
  `scripts/lib/macos-package-signing.mjs` requires each approved entitlement
  path to be one regular arm64 `MH_EXECUTE` slice with subtype `ALL` before
  the first entitlement-bearing `codesign` call, and checks the same slice
  evidence after signing. The direct integration tests are in
  `packages/runtime/test/macos-package-signature.test.ts`. Package and
  validator wiring remain in their existing owners. Generated manifest and
  F3 evidence were refreshed. No runtime, native, product, TCC, CI, hook, or
  external state was changed.
- Root cause and fix: native `otool -hv /usr/bin/file` exposed only the
  native ARM64 subtype `E`, while `otool -arch all -hv /usr/bin/file`
  exposed x86_64, arm64, and arm64e. The old parser collapsed subtype `E` to
  arm64. The new path normalizes ARM64/ALL to `arm64`, ARM64/E to `arm64e`,
  and keeps other architectures distinct.
- Actual-command integration proof: inventory of `/usr/bin/file` observed
  the normalized slices `[x86_64/ALL/MH_EXECUTE, arm64/ALL/MH_EXECUTE,
  arm64e/E/MH_EXECUTE]` and rejected the universal image. An actual arm64e
  thin fixture observed `[arm64e/E/MH_EXECUTE]` and was rejected. An actual
  thin arm64 fixture observed `[arm64/ALL/MH_EXECUTE]` and passed. The
  universal rejection occurred before signing and recorded zero codesign
  calls. Parser-only fixtures remain supplementary coverage.
- Exact unchanged policy: `scripts/macos-entitlements/entitlement-map.json`
  remains the sole authority. `jit.plist` contains only
  `com.apple.security.cs.allow-jit=true`; `audio-input.plist` contains only
  `com.apple.security.device.audio-input=true`. JIT applies only to runtime
  Node, Electron, Electron Helper (Renderer), and Electron Helper (GPU).
  Audio input applies only to `meetless-capture`. All other code objects and
  the outer app remain entitlement-free. TCC and Info.plist requirements stay
  outside this map.
- Candidate identities: local proof uses ad-hoc identity `-` and remains
  `localOnly`. Credential-free structural release proof uses synthetic
  `Developer ID Application: Meetless (ABCDE12345)`, Team ID `ABCDE12345`,
  certificate SHA-1 `1111111111111111111111111111111111111111`, and synthetic
  certificate SHA-256
  `2222222222222222222222222222222222222222222222222222222222222222`.
  The owner-provided identity is `Developer ID Application: Long Le
  (63M98WD275)`, SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it was not
  inspected or used.
- Positive and regression proof: focused signing tests passed 35/35 and
  package tests passed 25/25. The focused suite passed 49 files and 412
  tests on its passing rerun; an earlier run had two unrelated readiness
  failures before the rerun passed. Typecheck passed. Two deterministic local
  ad-hoc builds matched artifact
  `9110e6d0d65646e6c916250e855da54609ecb0e4baf58b92b1fd4e728f6cb3cc`.
  The validator passed all 46/46 nested signature checks and outer deep/strict
  verification. F1 passed. F3 passed with the evidence hash above. F2
  remains fail-closed for the same 11 Human/legal gates.
- Negative proof: universal, arm64e-only, x86_64-only, mixed, duplicate, and
  non-`MH_EXECUTE` Mach-O evidence fails before signing. R1-001 local
  non-empty/risky entitlements, R1-003 symlink/traversal/absolute/external
  authority paths, and the prior entitlement, signer, hardened-runtime,
  dyld-closure, signing-order, mutation, and CLI-equals regressions remain
  green. Exact plist bytes and the five-path mapping are unchanged.
- Enforcement: local validator passed. No optional hook is installed. No
  checked-in CI invocation exists and `.github/` is absent. Branch protection
  is unverified. No hook, CI, branch setting, or external state was changed.
- Cleanup and residual gates: F1/F3 processes stopped; temporary proof roots
  were cleaned; default store and exports remain unchanged. No real Developer
  ID signing, Keychain inspection, credential/private-key access,
  timestamp/network request, notarization, upload, publication, TCC reset,
  clean-install acceptance, or release claim was made. Remaining gates are
  independent DEEP review, explicit authorization for one real
  signing-validation run, real hardened-runtime behavior, TCC and
  clean-install validation, notarization/publication decisions, legal
  clearance, and release acceptance. M7 remains open.

### LEAD_DECISION v1 — M7-F5-ENTITLEMENT-MAP-CONTRACT

- Decision: `ACCEPT`; review closeout `CLOSEOUT_CLEAR`. Findings
  `M7F5-R1-001..003` are closed. F1–F4 remain accepted. F5 is technically
  accepted as a per-executable entitlement contract. The single outer-plist
  premise is replaced by the exact repository-pinned map.
- Accepted candidate: HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`. Package-source
  `0e185083790cbff9c8ea8f9dd6cb3c3fb6c7d6b97e53c85c8064f1e9e9d40bad`;
  package-input `d1e79c34be7b82390556d2c9bf14bd961a42162b75abe2bcb6d2502aa36b2e74`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  artifact `9110e6d0d65646e6c916250e855da54609ecb0e4baf58b92b1fd4e728f6cb3cc`;
  signature-state
  `c34876fbea33183c895dbb01c299fbdb563366d39286fc3a4d1c3cfc84a084e0`;
  F3 evidence
  `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`.
  The accepted package has 13,774 entries and 46 Mach-O objects.
- Exact policy authority and hashes:
  `scripts/macos-entitlements/entitlements/jit.plist` is
  `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`;
  `scripts/macos-entitlements/entitlements/audio-input.plist` is
  `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`;
  `scripts/macos-entitlements/entitlement-map.json` is
  `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`.
  The exact map remains the sole production policy authority.
- Exact mapping: JIT is the only entitlement in `jit.plist` and applies to
  `Contents/Resources/meetless/runtime/node`,
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron`,
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`,
  and
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)`.
  Audio input is the only entitlement in `audio-input.plist` and applies
  only to
  `Contents/Resources/meetless/native/macos-capture/meetless-capture`.
  Every other code object has no entitlement and receives no
  `--entitlements` argument. No union plist is allowed.
- Identity and proof limits: local proof uses ad-hoc identity `-` and is
  `localOnly`. Structural release proof uses synthetic
  `Developer ID Application: Meetless (ABCDE12345)`, Team ID `ABCDE12345`,
  certificate SHA-1 `1111111111111111111111111111111111111111`, and synthetic
  certificate SHA-256
  `2222222222222222222222222222222222222222222222222222222222222222`.
  The owner-provided identity is `Developer ID Application: Long Le
  (63M98WD275)`, SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it was not
  inspected or used. The contract proof is credential-free. No real
  entitlement application, Developer ID signing, private-key access,
  timestamp, notarization, upload, publication, launch, legal clearance, or
  release acceptance claim exists.
- Accepted evidence: exact plist bytes and five-path mapping matched;
  package-source and evidence hashes matched; local-ad-hoc validation passed
  for the exact source and artifact; and `git diff --check` passed. The
  validator passed 46/46 nested signatures and outer deep/strict checks.
  TCC and Info.plist ownership remain separate fail-closed gates. F2 remains
  fail-closed for the same 11 Human/legal gates.
- Enforcement: local validator passed; no optional hook is installed; no
  checked-in CI invocation exists; branch protection is unverified. No
  enforcement or external state was changed. M7 remains open.
- Next owner gate: the owner must approve the exact three policy files and
  hashes above for production use. This is the smallest next approval
  request. It does not authorize signing or credential use. Only after that
  approval may Lead request separate authorization for one real,
  no-timestamp signing-validation run. TCC, clean-install behavior,
  hardened-runtime execution, notarization, publication, legal clearance,
  and release acceptance remain separate gates.

### OWNER_DECISION v1 — M7-F5-ENTITLEMENT-POLICY-FINAL-APPROVAL

- Decision: `APPROVE`. The owner-approved entitlement-policy gate is closed.
  The accepted F1–F5 candidate identities, code, tests, policy files,
  package, artifact, evidence, runtime state, and external state are
  unchanged. M7 remains open.
- Approved policy files and hashes:
  `scripts/macos-entitlements/entitlements/jit.plist` —
  `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`;
  `scripts/macos-entitlements/entitlements/audio-input.plist` —
  `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`;
  `scripts/macos-entitlements/entitlement-map.json` —
  `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`.
- Approved mapping: `com.apple.security.cs.allow-jit` applies only to
  packaged Node, Electron main, Electron Helper (Renderer), and Electron
  Helper (GPU). `com.apple.security.device.audio-input` applies only to
  `Contents/Resources/meetless/native/macos-capture/meetless-capture`.
  All other code objects have no entitlements. No union plist is approved.
- Authority limits: this approval covers the exact entitlement policy only.
  It does not authorize real signing, Keychain or private-key access/export,
  timestamp or network requests, package mutation, launch, TCC action,
  notarization, upload, publication, or release acceptance. The owner-provided
  identity remains `Developer ID Application: Long Le (63M98WD275)`, SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; it has not been inspected or
  used. No private key may be exported or shared.
- Next exact gate: separate owner authorization for one real no-timestamp
  signing-validation run using that Developer ID Application identity. The
  run must exclude private-key export, launch, TCC action, notarization,
  upload, publication, and release acceptance. Hardened-runtime behavior,
  clean-install/TCC validation, legal clearance, notarization, and release
  acceptance remain separate gates.

### PEER_DISPOSITION v1 — M7-F6-REAL-NO-TIMESTAMP-SIGNING-VALIDATION

- Status: `DEPENDENCY_REQUEST`. The owner authorized one real validation run.
  Preflight passed, but no signed candidate was produced. The first
  certificate-backed `codesign` call remained blocked on the nested target
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`.
  The proof-owned signing process was stopped safely. The signing sequence was
  not retried.
- Authorized identity: `Developer ID Application: Long Le (63M98WD275)`;
  certificate SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`; Team ID `63M98WD275`.
  No private-key data was requested, printed, copied, exported, or handled.
  No completed signed image exposed certificate SHA-256 evidence.
- Candidate state before mutation was verified against the accepted local
  candidate: HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`; package-source
  `0e185083790cbff9c8ea8f9dd6cb3c3fb6c7d6b97e53c85c8064f1e9e9d40bad`;
  package-input `d1e79c34be7b82390556d2c9bf14bd961a42162b75abe2bcb6d2502aa36b2e74`;
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  local artifact `9110e6d0d65646e6c916250e855da54609ecb0e4baf58b92b1fd4e728f6cb3cc`;
  local signature-state
  `c34876fbea33183c895dbb01c299fbdb563366d39286fc3a4d1c3cfc84a084e0`.
  The baseline contained 13,774 entries and 46 Mach-O objects and remained
  local-ad-hoc/local-only.
- Authorized policy hashes were verified before signing:
  `jit.plist` `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`;
  `audio-input.plist` `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`;
  `entitlement-map.json` `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`.
  The run used release mode, the certificate SHA-1 selector, the checked-in
  map, `--options runtime`, and `--timestamp=none`. Package dependency
  resolution was offline.
- Real validation result: signed candidate, certificate SHA-256 evidence,
  per-image signer/Team/runtime/entitlement counts, approved entitlement
  readback, arm64 slice readback, individual verification, outer deep/strict
  verification, and real manifest/signature-state consistency are all not
  available because the first signing call did not complete. No release or
  notarization claim is made.
- Evidence: non-secret record
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`, SHA-256
  `d5f51561c1cc7199f62e5e7dbf641dc1203930565bc9ead43a901a05b900efa8`.
  It contains no private-key data, Keychain path, password, token, cookie, or
  environment dump.
- Restoration: proof-owned journaled restoration passed. The release artifact
  fingerprint returned to
  `22ff5d810971128744069667e01c3889f9dc34587f89a9ae2426887dda3162d1`.
  The composition manifest SHA-256 returned to
  `c0b690983cab907514cc6da5b5feb7bc235ce3e693c5a4d09ea0ac924a9950d6`.
  The canonical installed bundle, default runtime/store, exports, host
  identity, and existing F3 evidence were unchanged. No owned process or
  lock remained. Proof-owned backup, journal, logs, and temporary script were
  removed.
- Next dependency: owner action is required to allow certificate-backed
  `codesign` use of the existing private key in the owner-controlled Keychain.
  Do not export or share the key. A future run requires a separate explicit
  owner authorization; this run is not retried automatically. TCC, launch,
  clean-install, notarization, upload/publication, legal clearance, and
  release acceptance remain closed. M7 remains open.

### PEER_DISPOSITION v1 — M7-F6-REAL-NO-TIMESTAMP-SIGNING-VALIDATION-ATTEMPT-2

- Status: `REOPEN_REQUEST`; attempt 2 of 2 is final. No package assembler,
  `codesign`, Keychain, timestamp, or network signing action ran in attempt 2.
- Preflight found a source-identity contract mismatch. Authorized package
  source was
  `0e185083790cbff9c8ea8f9dd6cb3c3fb6c7d6b97e53c85c8064f1e9e9d40bad`.
  The live `node scripts/candidate-snapshot.mjs --mode=package-source`
  result was
  `50db08a850a67462eca3743063d58961403d6689d437728be6e51dcb00802cdd`.
  The snapshot excludes only
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json`; it includes
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  Therefore the current evidence file changes the source identity after the
  accepted candidate was recorded.
- Baseline was not mutated. The accepted HEAD remains
  `af5f1817191ba5fd634c750e9345de7d575ba704`; the local artifact remains
  `9110e6d0d65646e6c916250e855da54609ecb0e4baf58b92b1fd4e728f6cb3cc` with
  fingerprint
  `22ff5d810971128744069667e01c3889f9dc34587f89a9ae2426887dda3162d1`;
  the manifest remains SHA-256
  `c0b690983cab907514cc6da5b5feb7bc235ce3e693c5a4d09ea0ac924a9950d6`.
  No backup, journal, lock, process, artifact, manifest, policy, runtime,
  default, or external state remains from attempt 2.
- Evidence preserves attempt 1 and records attempt 2 in
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  Current evidence SHA-256 is
  `d5f51561c1cc7199f62e5e7dbf641dc1203930565bc9ead43a901a05b900efa8`.
- Decision required: reopen the source-snapshot authority so this evidence
  path is excluded, or accept the observed source identity as a new candidate
  baseline. Do not sign until one decision supplies an exact source identity.
  The owner’s Developer ID identity and Keychain authorization were not used.
  No automatic retry remains. TCC, launch, clean-install, notarization,
  publication, legal clearance, and release acceptance remain closed. M7
  remains open.

### PEER_DISPOSITION v1 — M7-F6-EVIDENCE-IDENTITY-CORRECTION

- Status: `CANDIDATE`; independent DEEP review is required. This correction
  changes the package-source identity boundary only. It does not authorize or
  perform Developer ID signing.
- The package-source mode is
  `node scripts/candidate-snapshot.mjs --mode=package-source`. It excludes
  exactly these two generated evidence files:
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` and
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  The default snapshot still includes and reports both files. No broad
  `test/evidence` exclusion is used.
- Candidate HEAD is
  `af5f1817191ba5fd634c750e9345de7d575ba704`; Paseo remains
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- Fresh identities:
  - package-source: `ae92efe77158e4e161440383f477da9f022f08886b906ce5355f5cc6b7d61f13`
  - package-input: `bfd8f421fe6499a4b29d5a0e227c3b7a05b252d3ee794421795061f88d4b3ad4`
  - artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`
  - artifact: `30b6d3f267e4605e5571d1f4c1b0b65bbb5f675b805f51564b804b4b55d3a698`
  - signature-state: `676b3a5e6cc91afc6870d1c0e3f86f1d4f6d90fccdfa150755536d5d24fffcf7`
  - generated manifest SHA-256:
    `9ad443578eb610f34ecfea402e975380499cefc70b8a8a9aa3cc93dcce3596fd`
- The regenerated package has 13,774 entries and 46 nested Mach-O files.
  It is explicitly `local-ad-hoc`, `localOnly: true`, and
  `releaseAcceptance: not-claimed`. All 46 nested images and the outer app
  are ad-hoc, all 47 images have empty entitlements, and the outer app is last
  in the signing order.
- Positive proof:
  - Two live package-source snapshots matched the source identity above.
  - The identity tests prove that editing either exact excluded evidence file
    changes the default snapshot but not package-source, package-input, or
    derived artifact identity. The default snapshot lists both evidence paths.
  - The package-source test keeps an unrelated evidence file in scope. It also
    rejects broad evidence exclusion and a stale manifest with only one
    excluded path.
  - Two local-ad-hoc package builds matched every identity and count. The
    package validator passed with the fresh source and artifact identities.
- Negative and regression proof:
  - Focused package and signing tests passed: 61 tests. They retain the prior
    package-input mutation, policy, signing, and local-empty negative guards.
  - `npm run typecheck` passed. `node scripts/check-macos-distribution-readiness.mjs`
    exited 1 with the same 11 unresolved Human/legal gates.
  - F1/F3 launch proof was not rerun. The frontier forbids launch/TCC tests;
    accepted prior F1/F3 evidence is preserved. The F3 evidence bytes remain
    unchanged, SHA-256
    `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`.
  - F6 attempts 1 and 2 remain historical and unchanged. There is no signing
    attempt 3. F6 evidence SHA-256 remains
    `d5f51561c1cc7199f62e5e7dbf641dc1203930565bc9ead43a901a05b900efa8`.
- Policy and authority remain unchanged. The approved entitlement files keep
  their existing hashes: JIT
  `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`, audio
  `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`, and
  map `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`.
  No Keychain or security inspection occurred.
- Changed scope for this frontier: `scripts/candidate-snapshot.mjs`, the
  package identity tests in `packages/runtime/test/macos-package.test.ts`,
  generated `release/macos/composition-manifest.json`, and this plan. Existing
  dirty M7 work was preserved. No F3/F6 evidence file was rewritten.
- Cleanup: proof-owned temporary paths and the package/validator process are
  absent. The generated local-ad-hoc artifact and manifest remain as the fresh
  candidate baseline. No credential, private-key data, Keychain data,
  timestamp request, network signing request, notarization, launch, TCC,
  upload, publication, or release action occurred.
- Enforcement:
  - local: package assembler and `node scripts/validate-macos-package.mjs
    --signing-mode=local-ad-hoc release/macos/composition-manifest.json`
    passed;
  - optional hook: absent; no hook installed;
  - checked-in CI: absent; `.github/` is absent and no CI was added;
  - branch protection: unverified; no external state changed.
- Smallest next owner request: no new signing authorization is requested for
  this correction. After independent review, any real signing validation must
  receive a separate explicit owner authorization. M7, TCC/clean-install,
  notarization, publication, release acceptance, and the 11 Human/legal gates
  remain open.

### PEER_DISPOSITION v1 — M7-F6-EVIDENCE-IDENTITY-CORRECTION-R1

- Status: `CANDIDATE`; reviewer for FAST CLOSEOUT:
  `9730d766-edd0-4234-8817-e1d425093c84`. Finding `M7F6-R1-001` is encoded;
  independent review remains required.
- `scripts/candidate-snapshot.mjs` now parses
  `git status --porcelain=v1 -z` as NUL-delimited records. Rename and copy
  records consume the current path and the following historical path as one
  record. Only the current path is sorted, lstat, read, and hashed.
  `previousPath` is structural metadata only. Repeated current paths and
  malformed or incomplete records fail with the authority and repair action.
- The exact F3 and F6 package-source exclusions remain unchanged. Default mode
  includes both evidence files. The identity graph remains acyclic.
- Correction base: package-source `ae92efe77158e4e161440383f477da9f022f08886b906ce5355f5cc6b7d61f13`,
  package-input `bfd8f421fe6499a4b29d5a0e227c3b7a05b252d3ee794421795061f88d4b3ad4`,
  artifact `30b6d3f267e4605e5571d1f4c1b0b65bbb5f675b805f51564b804b4b55d3a698`.
- New candidate identities:
  - HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`
  - Paseo: `c81cb84735043c281a5a2d23d456d3708ce5d94e`
  - package-source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`
  - package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`
  - artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`
  - artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`
  - signature-state: `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`
  - manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`
  - default snapshot: `9b607646f28310ce16da6dff11283a26c6c9108194b8e36b8d448069d1bec482`
- Positive proof:
  - An isolated tracked Git rename produced `R  current\0historical\0`.
    The parser returned one current-path entry and did not bind the historical
    path as a file. A copy pair, ordinary modified record, and untracked record
    also parsed correctly.
  - Two local-ad-hoc builds matched all candidate identities and counts.
    The package has 13,774 entries and 46 nested Mach-O files. It remains
    `local-ad-hoc`, `localOnly: true`, and `releaseAcceptance: not-claimed`.
  - The package validator passed with the new source and artifact identities.
- Negative and regression proof:
  - Focused package and signing tests passed: 65 tests.
  - Missing NUL termination, missing rename/copy history, malformed status
    separators, and repeated current paths fail with an actionable diagnostic.
  - Broad evidence exclusion, stale one-path manifests, unrelated evidence
    mutation, source mutation, package-input mutation, and prior signing-policy
    negatives remain covered.
  - `node --check scripts/candidate-snapshot.mjs`, `npm run typecheck`, and
    `git diff --check` passed.
  - F2 exited 1 with the same 11 unresolved Human/legal gates. F1/F3 launch
    proof was not run because this correction does not change runtime/package
    composition and launch/TCC proof is forbidden here. F6 attempts 1 and 2
    remain preserved; there is no attempt 3.
- F3 evidence SHA-256 remains
  `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`.
  F6 evidence SHA-256 remains
  `d5f51561c1cc7199f62e5e7dbf641dc1203930565bc9ead43a901a05b900efa8`.
- Changed scope: `scripts/candidate-snapshot.mjs`,
  `packages/runtime/test/macos-package.test.ts`, generated
  `release/macos/composition-manifest.json`, and this plan. Existing dirty M7
  work was preserved. No policy, runtime, artifact evidence, credential, or
  external state was changed outside the generated local candidate.
- Cleanup: isolated Git fixtures were removed by the test cleanup. No owned
  package/validator process, proof lock, or temporary signing state remains.
  No Developer ID signing, Keychain/security inspection, credential access,
  timestamp/network request, notarization, launch, TCC, capture,
  upload/publication, or release action occurred.
- Enforcement:
  - local: focused tests, package assembler, and local package validator passed;
  - optional hook: absent; no hook installed;
  - checked-in CI: absent; `.github/` is absent and no CI was added;
  - branch protection: unverified; no external state changed.
- Next owner action: FAST CLOSEOUT review of `M7F6-R1-001`. No new real-signing
  authorization or attempt-3 record is requested.

### LEAD_DECISION v1 — M7-F6-EVIDENCE-IDENTITY-CORRECTION-ACCEPTANCE

- Decision: `ACCEPT`.
- Review closeout: `CLOSEOUT_CLEAR` from reviewer
  `9730d766-edd0-4234-8817-e1d425093c84`.
- Finding `M7F6-R1-001` is closed. The accepted candidate is:
  - HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`
  - Paseo: `c81cb84735043c281a5a2d23d456d3708ce5d94e`
  - package-source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`
  - package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`
  - artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`
  - local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`
  - signature-state: `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`
  - manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`
  - F3 evidence: `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`
  - F6 evidence: `d5f51561c1cc7199f62e5e7dbf641dc1203930565bc9ead43a901a05b900efa8`
- The package-source mode excludes exactly:
  `test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json` and
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  Default snapshot mode includes and reports both files.
- Closeout proof records NUL-safe rename/copy pair parsing, one current-path
  binding, historical-path metadata only, and fail-closed malformed-record
  handling. Package tests passed: 30. Safe signing tests passed: 33; two real
  signing tests were skipped. All 47 local code objects were ad-hoc signed and
  entitlement-free. No attempt 3 occurred.
- M7 remains open. TCC, launch, notarization, publication, legal, and release
  gates remain closed. The prior two-attempt signing authorization is exhausted.
- Next exact gate: a new, separate owner authorization for exactly one real
  no-timestamp signing-validation run against this accepted candidate. That
  authorization must not include private-key export, launch, TCC, notarization,
  upload, publication, or release acceptance.

### PEER_DISPOSITION v1 — M7-F6-REAL-NO-TIMESTAMP-SIGNING-VALIDATION-CYCLE-2

- Status: `DEPENDENCY_REQUEST`. Overall historical attempt 3; cycle 2 attempt
  1 of 1. This authorization is exhausted. No second attempt occurred.
- Read-only preflight matched the accepted candidate: HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`, package-source
  `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`,
  package-input
  `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`,
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`,
  local artifact
  `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`, and
  signature-state
  `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`.
  The manifest was SHA-256
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`.
  The baseline had 13,774 entries, 46 nested Mach-O files, 47 ad-hoc
  entitlement-free code objects, and the exact two package-source evidence
  exclusions.
- The one offline package command ran with the SHA-1 selector
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, expected Team ID `63M98WD275`,
  `--options runtime`, and `--timestamp=none`. It reached the first
  certificate-backed `codesign` process for
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`.
  One codesign process was observed; zero signing calls completed. The run
  timed out at the proof stop boundary and the owned process group was stopped.
  No terminal Keychain prompt text was observable. No retry occurred.
- No signed candidate was published. Therefore there is no real 47-image
  signer, Team ID, certificate, hardened-runtime, entitlement, arm64-slice,
  46/46 strict-verification, or outer deep/strict result. The authorized
  public identity remains `Developer ID Application: Long Le (63M98WD275)`,
  SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, Team ID `63M98WD275`.
- Evidence was updated at
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  Evidence SHA-256 is
  `6025d57391eff39ca71ee133427d7f9510258c38bd8b7fa1f9fcfe3de528e934`.
  Attempts 1 and 2 remain preserved. No private-key, Keychain path,
  password, token, cookie, or environment dump is recorded.
- Restoration passed after the command stopped. The local artifact fingerprint
  was restored to
  `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e` and the
  manifest to SHA-256
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`.
  The canonical installed bundle, default runtime/store/exports, host identity,
  and F3 evidence remained unchanged. The proof-owned backup, journal, lock,
  and temporary state were removed; no owned process remains. A temporary
  restoration-verifier bookkeeping error was corrected by a cleanup-only
  check; this did not invoke signing again.
- Enforcement: local release validation did not complete because codesign was
  blocked; the accepted local-ad-hoc baseline remained intact. Optional hook:
  absent. Checked-in CI: absent. Branch protection: unverified. F2 remains
  fail-closed for the same 11 Human/legal gates.
- Dependency request: owner action is required to make the authorized
  Developer ID private-key use available to `/usr/bin/codesign` for the exact
  first target. Do not export or share private-key material. TCC, launch,
  clean-install, notarization, upload, publication, legal clearance, release
  acceptance, and real runtime/audible-call gates remain closed. M7 remains
  open.

### FRONTIER_BRIEF v1 — M7-F6-KEYCHAIN-OWNER-STATE

- The owner reports that `/usr/bin/codesign` is an allowed application for the
  Developer ID Application private-key item in the owner-controlled Keychain.
- This is owner-reported environment state. No standalone Keychain/security
  inspection command was run by the project for this confirmation.
- No private-key material, password, ACL dump, or Keychain path was requested
  or recorded.
- This confirmation does not authorize a signing retry. Attempt 3 / cycle-2
  attempt 1 remains consumed and failed before any codesign call completed.
- A new explicit owner authorization is required for exactly one new
  no-timestamp signing-validation run.
- Launch, TCC, timestamp/network, notarization, upload, publication,
  distribution, legal clearance, and release acceptance remain closed.

### PEER_DISPOSITION v1 — M7-F6-REAL-NO-TIMESTAMP-SIGNING-VALIDATION-CYCLE-3

- Status: `DEPENDENCY_REQUEST`. Overall historical attempt 4; cycle 3 attempt
  1 of 1. No second attempt occurred.
- Owner-provided state was treated as input: `/usr/bin/codesign` is allowed on
  the matching Developer ID Application private-key item. No Keychain or
  security inspection was run by the project. No private-key material,
  password, ACL dump, or Keychain path was requested or recorded.
- Read-only preflight matched the accepted candidate: HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`, package-source
  `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`,
  package-input
  `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`,
  artifact-input
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`,
  local artifact
  `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`, and
  signature-state
  `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`.
  The baseline contained 13,774 entries, 46 nested Mach-O files, and 47
  entitlement-free ad-hoc code objects. The approved Developer ID identity was
  `Developer ID Application: Long Le (63M98WD275)`, SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, Team ID `63M98WD275`.
- The one offline package command ran with the approved map, hardened runtime,
  SHA-1 selector, Team ID, and `--timestamp=none`. It observed the first
  certificate-backed `codesign` target:
  `Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`.
  One codesign process was observed; zero signing calls completed. The bounded
  first-target wait stopped the owned process group. No interactive prompt text
  was observable. No command or target retry occurred.
- No signed candidate exists. The 47-image signer, Team ID, certificate,
  hardened-runtime, entitlement, arm64-slice, 46/46 strict, and outer
  deep/strict validation requirements were not reached.
- Evidence was updated at
  `test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json`.
  Evidence SHA-256 is
  `dc859fa59775cea9623b4a0f017f6c105ff0a71fff62f731657f459c501d3ff9`.
  Attempts 1–3 remain preserved.
- Restoration passed. The local artifact fingerprint is
  `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`; the
  manifest SHA-256 is
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`.
  The canonical installed app, default runtime/store/exports, host identity,
  and F3 evidence remained unchanged. The proof-owned backup, journal,
  temporary root, process, and lock were removed.
- Enforcement: the local release validation did not complete because the first
  codesign target remained blocked; the local-ad-hoc baseline is intact.
  Optional hook: absent. Checked-in CI: absent. Branch protection: unverified.
  F2 remains fail-closed for the same 11 Human/legal gates.
- Residual gate: a new owner decision is required before any further signing
  run. Launch, TCC, timestamp/network, notarization, upload, publication,
  distribution, legal clearance, and release acceptance remain closed. M7
  remains open.

### FRONTIER_BRIEF v1 — M7-F6-INTERACTIVE-KEYCHAIN-PROBE-EVIDENCE

- The owner reports one disposable interactive diagnostic run in an owner-open
  native Terminal. It used a copy of `/usr/bin/true` under a unique `mktemp`
  directory, selected the public identity SHA-1
  `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, and passed `--options runtime`,
  `--timestamp=none`, and `--dryrun` to `/usr/bin/codesign`.
- macOS displayed an interactive Keychain prompt. The owner selected `Allow`
  once, not `Always Allow`. The owner reports exit code 0 and output showing
  replacement of the existing signature and a signed universal Mach-O
  (`x86_64 arm64e`) with identifier `com.apple.true`. The disposable
  directory was cleaned up in the owner-run block.
- No repository package, artifact, or installed app was targeted. No project
  package, signing, security, or Keychain command was run for this evidence.
  No private-key material, password, ACL dump, or Keychain path was requested
  or recorded.
- This proves only that `/usr/bin/codesign` can use the private key in the
  owner’s interactive Terminal after one user approval. It does not prove
  headless package signing, 47-image signing, entitlement mapping, final
  validation, TCC, notarization, or release.
- Inference: repeated headless first-target stalls are consistent with an
  unavailable interactive user-presence prompt. This is diagnostic evidence,
  not proof of a completed release signing run.
- No new package signing authorization exists. The next owner decision is:
  - Recommended: owner-run one-shot interactive package signing with bounded
    backup, validation, restoration, and manual `Allow`.
  - Separate broader authorization: persistent `Always Allow` or ACL change
    for `/usr/bin/codesign`.
  Do not infer approval of either path. Launch, TCC, timestamp/network,
  notarization, upload, publication, distribution, legal clearance, and
  release acceptance remain closed.

### PEER_DISPOSITION v1 — M7-F7-OWNER-INTERACTIVE-SIGNING-RUNNER-R1

- Status: `CANDIDATE` for independent review only. This is preparation code.
  It is not a signed release and does not change release acceptance.
- Foundation route:
  `repository candidate + later owner authorization -> exact lock and marker
  -> one private mkdtemp child -> one package/signing child group -> validation
  -> bounded evidence outside the root -> root absence -> F6 evidence CAS ->
  final lock release`.
  The canonical `release/macos` artifact/manifest, installed app, default
  runtime/store/exports, and F3 evidence are read-only preservation checks.
  No backup, replacement, journal replay, stale recovery, or caller output
  root exists.
- Changed files for this correction:
  - `scripts/run-macos-owner-signing.mjs`
  - `scripts/lib/macos-owner-signing.mjs`
  - `scripts/lib/macos-package-assembly.mjs`
  - `scripts/package-macos.mjs`
  - `packages/runtime/test/macos-package.test.ts`
  - `packages/runtime/test/macos-package-signature.test.ts`
  - this plan
  Prior M7 changes in the snapshot, inventory, signing, validator, F3
  evidence, F6 evidence, policy files, runtime, native, product, and app
  state were preserved. No commit was made.
- Accepted baseline preserved exactly:
  - HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`
  - Paseo: `c81cb84735043c281a5a2d23d456d3708ce5d94e`
  - package-source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`
  - package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`
  - artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`
  - local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`
  - signature-state: `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`
  - manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`
  - artifact fingerprint: `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`
- Current review identities:
  - package-source: `32e90c86b9ee94b56c53777add45fbd8694bbc2d034057a9ea4baa2e588e9c84`
  - runner digest: `070a320d88bec158783f37b2d909054504a088f00f0320eebb7008e2d3d6cbd8`
  - no new package-input, artifact, or signature-state was generated.
- Public signing and policy inputs remain exact:
  - `Developer ID Application: Long Le (63M98WD275)`
  - certificate SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`
  - Team ID `63M98WD275`
  - `jit.plist`: `958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`
  - `audio-input.plist`: `289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee`
  - `entitlement-map.json`: `6a98936fb517ddfdd3fbf445633b686b38e2ae36d6656ba47a5ee979aa355462`
- Exact commands:
  - plan, run twice: `/Users/tubakhuym/.hermes/node/bin/node scripts/run-macos-owner-signing.mjs --plan`
  - future execute, not run:
    `/Users/tubakhuym/.hermes/node/bin/node scripts/run-macos-owner-signing.mjs --execute --expected-package-source=32e90c86b9ee94b56c53777add45fbd8694bbc2d034057a9ea4baa2e588e9c84 --signing-identity=D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561 --team-id=63M98WD275 --authorization-id=<owner-issued-run-id> --owner-ack=M7-F7-OWNER-INTERACTIVE-SIGNING-RUNNER`
  - no recovery command exists.
- Execute boundary:
  - `--execute`, exact current source, exact certificate SHA-1, Team ID,
    fresh single-use authorization ID, and owner acknowledgement are required.
  - The runner requires a native local Terminal boundary on macOS arm64.
    Child stdio is inherited. The child environment uses fixed absolute tools,
    no `PATH`, no Node/preload/loader injection, and offline npm settings.
    If macOS shows the matching Keychain prompt, the owner selects `Allow`
    once only. No UI automation or `Always Allow` action is part of this flow.
  - One package command and one owned process group are allowed. The package
    uses the checked-in map, hardened runtime, and `--timestamp=none`.
    Local-ad-hoc and ordinary release callers cannot enable this behavior.
- Reduced mutation boundary:
  - The runner creates one internal mode-0700 `mkdtemp` child under the
    approved system temporary parent. It writes one exact marker and one exact
    lock. The package output is only
    `<proof-root>/release/macos`.
  - The runner validates the temporary signed copy, captures bounded public
    facts outside the root, waits for observed child-group absence, and removes
    only the exact marker-bound root. It publishes CANDIDATE only after root
    absence and evidence compare-and-swap. If cleanup or CAS is uncertain, it
    keeps the lock/root, prints the exact retained root, and publishes only
    failure/dependency evidence.
  - The lock is held through evidence publication. Unknown or stale lock,
    changed marker, owner/mode/type, realpath, symlink, parent/equal/escape,
    or process absence checks fail closed. No broad deletion or automatic
    recovery is implemented.
- Finding closure:
  - R1-001: later owner authorization binds exact source, runner digest,
    identity, signer, Team ID, policy hashes, expected old F6 hash, and one run
    ID. Extra fields are rejected and only public fields are copied to result
    evidence. The current source digest is not hardcoded into source.
  - R1-002: fixed absolute toolchain and sanitized child environment.
  - R1-003/R1-005: exact private root, marker/token, mode/owner/realpath and
    path-boundary checks before the one deletion.
  - R1-004: one detached child group; SIGINT, SIGTERM, and SIGHUP stop it;
    cleanup waits for observed absence and reports observed polls.
  - R1-006: native Terminal, tty, ancestry, SSH, and multiplexer checks with
    explicit non-cryptographic threat limits.
  - R1-007: only validated, baseline-preserved, cleaned results can be
    candidate evidence.
  - R1-008: one exact lock and one evidence publication claim through CAS.
  - R1-009: interactive mode requires owner lock/capability and explicit
    release; local-ad-hoc and ordinary release paths reject it.
- Credential-free proof:
  - plan mode ran twice with identical output;
  - focused package/signing/transaction tests pass: 76/76;
  - tests cover interruption with child-group wait, retained non-candidate
    evidence, exact-root cleanup, unknown lock ownership, root boundary and
    symlink protection, second-child rejection, evidence publication order,
    no output-root API, no generalized recovery exports, policy/signing
    regressions, and existing package checks;
  - syntax checks pass for the changed owner runner, helper, assembly helper,
    and package script. No local-ad-hoc rebuild was needed; the accepted
    canonical local baseline remains unchanged.
- Negative proof includes wrong source/identity/Team/acknowledgement, non-TTY
  and remote/multiplexed Terminal facts, injection variables, duplicate or
  unknown flags, caller output roots, local-ad-hoc interactive mode, lock
  collision or mutation, symlink/path escape, incomplete child absence,
  second child invocation, and candidate publication before cleanup.
- Cleanup: preparation created no persistent runner root, lock, process, or
  evidence. Test-only roots were removed by the focused test cleanup. No
  canonical artifact, manifest, installed app, default state, F3 evidence, or
  F6 evidence was changed by this correction.
- Verification personally run:
  - `node --check` passed for the changed owner, runner, assembly, and
    package scripts;
  - plan mode passed twice;
  - final owner-runner/package test passed 37/37; the broader focused
    package/signing/transaction set passed 76/76 before this final evidence
    guard was added;
  - `npm run typecheck` passed;
  - `git diff --check` passed.
  The existing signature-fixture test used temporary ad-hoc signing of a
  disposable Mach-O; it did not use the Developer ID identity or Keychain.
  No owner `--execute` or release package-signing command was run.
- Enforcement:
  - local: plan mode, focused tests, syntax checks, and source-bound
    validation passed; no execute path was run;
  - optional hook: absent; none installed;
  - checked-in CI: absent; none added;
  - branch protection: unverified; no external state changed.
- Proof limits and residual gates: no real signing, private-key access,
  Keychain/security inspection, timestamp/network request, launch, TCC,
  notarization, upload, publication, distribution, legal clearance, or
  release acceptance was performed. A fresh owner authorization must bind the
  current source/runner/policy and authorize exactly one execute run. F2
  remains fail-closed for the same 11 Human/legal gates. Independent Lead
  review and closeout are required; the writer does not self-accept.

### PEER_DISPOSITION v1 — M7-F7-OWNER-INTERACTIVE-SIGNING-RUNNER-R2

- Status: `CANDIDATE` for the same reviewer FAST closeout only. This is a
  credential-free preparation candidate. It does not authorize or claim a
  real signing run, release, notarization, or acceptance.
- Authority: `M7-F7-OWNER-INTERACTIVE-SIGNING-RUNNER-R2`, accepted findings
  `M7F7-R2-001..003`, correction base package-source
  `32e90c86b9ee94b56c53777add45fbd8694bbc2d034057a9ea4baa2e588e9c84`, and
  reviewer `2189f542-d8bd-4790-be37-6af579d23630`. The R2 design keeps the
  owner-requested one-shot isolated flow. It adds no generalized tool
  attestation, backup/restore, journal replay, stale recovery, transaction
  manager, or output manager.
- Final candidate identities:
  - HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`
  - Paseo `c81cb84735043c281a5a2d23d456d3708ce5d94e`
  - package-source `3be2bb4a3e3b929d4c8337d811134dcfe9ac3ad3a22f30e8134bb7fbd1d9b365`
  - runner digest `0b36454bae284b047a08e58f27fb3c4da2e2e72f3a4907c617759e9e69fd560b`
  - accepted package-input `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`
  - accepted artifact `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`
  - accepted signature-state `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`
  No new package, artifact, signature-state, F3, or F6 evidence was
  generated. The accepted local-ad-hoc baseline remains unchanged.
- R2-001 closure: execute preflight reads
  `release/macos/composition-manifest.json` before the package snapshot,
  lock, or proof root. It accepts only the manifest-declared
  `Contents/Resources/meetless/runtime/node`, verifies regular executable
  file type, non-symlink realpath containment, size `112258144`, and
  SHA-256 `5b757bd79195542961f8db2401ec45b23426cffaa3c40fba180ba4f07ee82b7c`.
  Plan mode uses the current Node. The future execute command and its child
  package use the exact packaged Node; execute refuses any other
  `process.execPath`. Fixed absolute Apple tools and a fixed npm CLI are used.
  `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, preload, SSH, multiplexer,
  and unapproved npm variables are rejected or absent. The threat limit is
  honest: the manifest binds the packaged Node; fixed paths bind tool names;
  no generalized tool hash registry is claimed.
- R2-002 closure: `outputRoot` is absent from lock, marker, authorization,
  and caller input. The only package output is derived as
  `<proofRoot>/release/macos` in code. The capability binds the canonical
  proof-root path, derived output path, run ID, owner token, current source,
  runner digest, authorization digest, packaged-Node evidence, and fixed npm
  path. The child recomputes the path. Strict mode/owner/non-symlink/realpath
  checks run before package writes and cleanup. A lock/marker redirection
  fixture fails before child invocation. The canonical release path is not
  reachable through this owner capability.
- R2-003 closure: new owner-run evidence accepts only neutral statuses:
  `validated-observation`, `dependency-request`, `reopen-request`,
  `interrupted`, or `failure`. It has no candidate/acceptance/release status
  or field. Signal checks cover pre-CAS, pre-rename, post-rename, and the
  final return boundary. A raced observation is atomically replaced with
  `interrupted` under the held lock and current-file hash, or the lock is
  retained on uncertainty. A successful neutral observation still requires
  exact validation, child absence, root absence, lock ownership, and evidence
  CAS. Lead review owns any later candidate or acceptance decision.
- Owner-review commands:
  - Plan, run twice, non-mutating:
    `/Users/tubakhuym/.hermes/node/bin/node scripts/run-macos-owner-signing.mjs --plan`
  - Future execute command, not run:
    `/Users/tubakhuym/projects/supervisors/meetless/release/macos/Meetless.app/Contents/Resources/meetless/runtime/node scripts/run-macos-owner-signing.mjs --execute --expected-package-source=3be2bb4a3e3b929d4c8337d811134dcfe9ac3ad3a22f30e8134bb7fbd1d9b365 --signing-identity=D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561 --team-id=63M98WD275 --authorization-id=<owner-issued-run-id> --owner-ack=M7-F7-OWNER-INTERACTIVE-SIGNING-RUNNER`
  The future command requires a new exact one-use owner authorization. It
  must run in an owner-open native Terminal. The owner may select `Allow`
  once if macOS displays the prompt. No UI automation or `Always Allow`
  action is included.
- R2 changed surface: four owner-runner/package/test files plus this plan
  were touched for the correction; current line counts are helper 860,
  runner 279, package 851, and focused package test 1023. The removed broad
  machinery is the old owner toolchain registry and all lock/marker output
  routing. No generalized recovery API was added. Existing dirty M7 source,
  policy, F3/F6 evidence, runtime, app, and artifact work was preserved.
- Positive proof:
  - plan output was identical twice and reported the exact packaged Node and
    future execute command;
  - focused package/runner tests passed `43/43`;
  - selected credential-free signing-boundary regressions passed `21/21`,
    and the actual `otool -arch all` inventory fixture passed `1/1`;
  - tests cover neutral evidence, all three CAS signal boundaries, exact
    derived output, lock/marker redirection, packaged-Node replacement,
    sanitized environment, fixed tools, no second child, and root cleanup;
  - syntax checks, `npm run typecheck`, and `git diff --check` passed.
- Negative proof includes changed/replaced packaged Node, wrong fixed tool,
  PATH/Node/loader injection, output-root override, lock/marker redirection,
  candidate-like evidence status/fields, pre-CAS/rename/post-rename signal,
  local-ad-hoc interactive mode, non-native Terminal facts, stale/changed
  lock, symlink/path escape, and second child invocation. The two focused
  tests that perform disposable ad-hoc `codesign` were not run in this
  correction. No `--execute`, Developer ID `codesign`, `security`, Keychain,
  package-signing, launch, TCC, timestamp/network, notarization, upload, or
  publication command was run.
- Cleanup: plan/tests created no persistent proof root, lock, process, or
  evidence. No canonical release artifact, manifest, installed app, default
  runtime/store/exports, policy, F3 evidence, or F6 evidence was changed.
- Enforcement:
  - local: deterministic plan and focused credential-free validation passed;
  - optional hook: absent; none installed;
  - checked-in CI: absent; none added;
  - branch protection: unverified; no external state changed.
- Residual gates: a fresh owner authorization for this exact source and
  runner, one real no-timestamp signing-validation run, public per-image
  signer/Team/certificate/runtime/entitlement/slice/strict proof, and Lead
  review remain open. Launch, TCC/Info.plist ownership, timestamp/network,
  notarization, upload, publication, distribution, legal clearance, F2's
  same 11 Human/legal gates, release acceptance, and self-acceptance remain
  closed.

### PEER_DISPOSITION v1 — M7-F7-RETIREMENT-ACCEPTANCE

- Lead decision: `ACCEPT` retirement and cancellation of the M7-F7
  owner-interactive signing runner. All unaccepted M7-F7 code and tests are
  removed. This is not a signing, release, or release-acceptance result.
- No F7 execute or signing run occurred. Reviewer findings `M7F7-R3-001..004`
  remain recorded evidence for cancellation and are closed as a route
  decision, not open corrections. No third same-family correction is
  authorized.
- Lead cancellation follows final closeout findings `M7F7-R3-001..004`:
  child authority was unsafe, no-follow leaf writes were unsafe, final
  evidence lifecycle was unsafe, and authorization was not acyclic. The
  earlier exploratory findings `M7F7-R1-001..009` and closeout findings
  `M7F7-R2-001..003` remain in this plan as history. No F7 `--execute` run,
  real signing, or signing attempt occurred.
- Retirement changed only the unaccepted F7 route:
  - deleted `scripts/run-macos-owner-signing.mjs`;
  - deleted `scripts/lib/macos-owner-signing.mjs`;
  - deleted `scripts/lib/macos-package-assembly.mjs`;
  - removed the F7 interactive/output-root/owner-runner hunks from
    `scripts/package-macos.mjs` and the two focused package/signing tests;
  - removed the F7 trusted-tool dependency from the existing snapshot,
    inventory, signing, and validator files. Their accepted F5/F6 behavior
    remains. `package.json` had no F7 delta and was unchanged.
  Accepted F5 entitlement files, signing/inventory/validator rules, F6
  snapshot parsing, F3 evidence, F6 evidence, package, artifact, runtime,
  installed app, defaults, and external state were not replaced.
- Restored identities:
  - HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`;
  - Paseo: `c81cb84735043c281a5a2d23d456d3708ce5d94e`;
  - package-source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`;
  - package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`;
  - artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
  - local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`;
  - signature-state: `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`;
  - manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`;
  - artifact fingerprint: `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`;
  - F3 evidence: `d0c45d9948599d77a9d0e0139c2d894a7a363d15c1fcc54c7a6c23257cdf2c35`;
  - F6 evidence: `dc859fa59775cea9623b4a0f017f6c105ff0a71fff62f731657f459c501d3ff9`.
- Observed restoration proof:
  - `node scripts/candidate-snapshot.mjs --mode=package-source` returned
    `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d` and
    the exact F3/F6 exclusions;
  - manifest, artifact, F3 evidence, and F6 evidence hashes returned the
    identities listed above;
  - all three F7 files are absent; scoped temporary-root, lock, and process
    checks returned no F7 state; no new F7 evidence file exists;
  - `packages/runtime/test/macos-package.test.ts`: 30/30 passed;
  - pre-F7 signing tests: 33 passed, 2 disposable real-`codesign` tests
    skipped;
  - syntax checks for the five affected scripts, `npm run typecheck`, and
    `git diff --check` passed.
  No package build, `codesign`, `security`, Keychain, launch/TCC,
  timestamp/network, notarization, upload, or publication command was run.
- Enforcement: local restoration and focused validation passed. Optional hook:
  absent. Checked-in CI: absent. Branch protection: unverified. No hook, CI,
  or external setting was changed.
- Next route proposal only; not authorized and not implemented:
  - owner creates a fresh explicit temporary full-workspace copy;
  - all package signing runs at that copy's fixed `release/macos` path with
    the accepted package command;
  - an owner-open native Terminal exposes the Keychain `Allow once` prompt;
  - the canonical workspace artifact is never moved or replaced;
  - exactly one attempt runs, with no retry;
  - the signed temporary artifact and manifest remain for independent Lead and
    reviewer inspection;
  - only the explicit temporary copy is deleted after review and owner
    decision. No new runner or generic subsystem is proposed.
- This next route is read-only planning context. It does not authorize package
  mutation, signing, Keychain action, or any external release action.
- M7 remains open. TCC/Info.plist ownership, launch, notarization, publication,
  distribution, legal clearance, release acceptance, and the F2 11
  Human/legal gates remain closed. Any future signing run needs a separate
  owner authorization.

### M7-F11 — Artifact-only re-sign foundation candidate

Frontier: M7-F11-ARTIFACT-RESIGN-FOUNDATION

Status: CANDIDATE. The writer does not self-accept this change. Independent
DEEP review and Lead acceptance are required.

Authority:

- The frontier brief fixes the accepted F5 entitlement policy, F6 identity
  boundary, source/artifact identities, and allowed signing-bound mutations.
- Lead accepted **/_CodeSignature/CodeResources as signing-bound metadata.
- The transform cites this plan as its technical authority.

Accepted baseline identities:

- Paseo: c81cb84735043c281a5a2d23d456d3708ce5d94e
- package-source: d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d
- package-input: f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402
- artifact-input: 81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1
- local artifact: fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa
- signature-state: 217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184
- composition manifest SHA-256:
  03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b
- accepted shape: 13,774 entries, 46 nested Mach-O files, 10 CodeResources
  files, and 47 total signed code objects including the outer app.

Implementation candidate snapshot:

- HEAD: af5f1817191ba5fd634c750e9345de7d575ba704
- current implementation source snapshot observed by
  node scripts/candidate-snapshot.mjs --mode=package-source:
  5717929a2bf865d2fc0b592fc051519701ceec8b89a8dea5caf3bf4608661a7b
- The accepted transform input remains bound to package-source
  d3db4c8f...; the current workspace snapshot includes this foundation and
  pre-existing dirty M7 work.

Changed scope:

- package.json: added resign:macos:artifact.
- scripts/lib/macos-artifact-resign.mjs: added the fail-closed boundary,
  classifier, signing order, rebinds, metadata evidence, and diagnostics.
- scripts/resign-macos-artifact.mjs: added the explicit-stage transform.
- scripts/validate-macos-package.mjs: added artifact-only input validation
  and signing-bound CodeResources checks.
- packages/runtime/test/macos-artifact-resign.test.ts: added disposable
  synthetic and credential-free positive/negative proof.
- This plan records the authority, candidate identity, proof, and limits.
  Existing dirty files outside this list were preserved.

Transform sequence:

1. Require one realpath staging root outside the repository and release root.
   The root may contain only Meetless.app, composition-manifest.json, and
   .meetless-artifact-stage.json.
2. Verify the marker, accepted source/package/artifact/signature identities,
   exact app entry closure, 46 Mach-O paths, 10 CodeResources paths, F5 map,
   arm64 executable shape, and non-signing bytes before the first codesign.
3. Sign the 46 nested Mach-O files with the existing deepest-first order,
   exact five-path entitlement map, hardened runtime, and timestamp=none.
4. Rebind package-input and license-inventory metadata. The outer
   CodeResources file contains the packaged license inventory, so the
   inventory must be written before the final outer sign. This avoids a
   digest cycle while keeping the outer app as the final signing operation.
5. Sign Meetless.app last. Observe each final image and its certificate,
   regenerate the external composition manifest, and validate the retained
   staged candidate with the artifact-only validator.

The owner creates the marker and copies the accepted app and manifest. The
transform does not copy, delete, lock, retry, recover, publish, or update
owner status. A marker records the accepted baseline fields above and the
exact map/plist evidence returned by createStagePolicyEvidence.

Proof personally run:

- npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1:
  8/8 passed.
- npx vitest run --config vitest.config.ts packages/runtime/test/macos-package-signature.test.ts packages/runtime/test/macos-package.test.ts --maxWorkers=1:
  65/65 passed.
- npm run typecheck: passed.
- node --check for the foundation module, command, and validator: passed.
- git diff --check: passed.
- Read-only baseline inspection: 13,774 entries, 46 Mach-O files, 10
  CodeResources files, and all accepted identities matched.
- Artifact-only validator against the retained local baseline: passed.
- Canonical manifest stayed at SHA-256
  03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b;
  its artifact, package-input, artifact-input, and signature-state identities
  stayed at the accepted values.
- Local enforcement discovery found no executable project hook, checked-in
  CI workflow, or .husky policy for this command. No enforcement state was
  changed.

Fixture negatives cover changed ordinary payload, notice/license text,
symlink target, package member and component mapping, missing/extra
CodeResources, wrong F5 path/key, stale baseline, canonical target, post-sign
mutation, and invalid signing order. No Developer ID identity, security,
Keychain, timestamp/network, launch, TCC, notarization, upload, or publication
command was run. The existing signing regression used only disposable ad-hoc
fixture codesign with timestamp=none. The normal canonical validator is
expected to report the current dirty workspace snapshot mismatch; the
artifact-only validator is the proof for this route.

Remaining risk: no real signed staged candidate exists yet. Owner
authorization, one real signing attempt, retained-candidate inspection,
independent DEEP review, and Lead acceptance remain open.

### M7-F11-CORRECTION-R1 — Frozen review closure candidate

Frontier: M7-F11-ARTIFACT-RESIGN-FOUNDATION

Status: CANDIDATE. This writer does not self-accept. The frozen F11-R1-001..008
closures require the same reviewer's independent FAST closeout and Lead
acceptance.

The correction keeps the artifact-only route and changes no product policy.
The accepted authority remains this plan, the F5 map, the F6 identity boundary,
and the Lead ruling that every `**/_CodeSignature/CodeResources` file is
signing-bound metadata.

Implemented closures:

- Mach-O binding parses thin and fat Mach-O headers, requires one bounded
  `LC_CODE_SIGNATURE` range per slice, and hashes all other bytes. The marker
  binds the accepted canonical payloads. Pre-sign, nested-sign, outer-sign,
  and retained validation gates compare the precise payload digest, not only
  path or file type.
- The staged root, bundle, marker, manifest, and every staged descendant are
  checked for current-uid ownership and private write permissions. Every
  writable regular file must be a realpath regular file with one link. The
  full validator rejects a symlink `Meetless.app` root.
- One fixed adjacent capability file uses exclusive no-follow creation. The
  command rechecks marker bytes, baseline manifest bytes and identities,
  inventory bytes, app entries, Mach-O payloads, policy evidence, realpaths,
  ownership, modes, and hardlinks immediately before the first codesign.
  A failed gate does not call codesign.
- Inventory and manifest JSON use same-directory private no-follow temporary
  files, file and directory fsync, and atomic rename. The target inode and
  digest are checked again before rename. Interruption and replacement races
  preserve the prior file when the transform owns the failure.
- The explicit `retainedArtifactOnly` validator mode uses embedded signing,
  rebound F5 evidence, the stage marker, and codesign observation. It does not
  resolve a Keychain identity or read repository verified-upstream or owner
  resolution evidence. The normal source/package validator path remains
  separate.
- Package-input artifact digest, inventory artifact-entry digest, manifest
  binding, and the final entry set are recomputed and must agree.
- Final F11 mode requires the artifactResign schema and authority, all accepted
  baseline identities and shape counts, precise signing-bound descriptor,
  marker digest/evidence, and package/inventory/signature rebind identities.
- Package entry enumeration now rejects FIFO, socket, device, and other
  unsupported `lstat` types with authority and next action. Files, symlinks,
  and directories retain their existing behavior.

Correction candidate identity:

- HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`
- package-source snapshot: `10173eff919c482f222dd3722a0b505d9a0ac71bf4c36daed2d1c45d3fc75921`
- accepted source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`
- accepted package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`
- accepted artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`
- accepted local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`
- accepted manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`
- accepted shape: 13,774 entries, 46 Mach-O files, 10 CodeResources files,
  and 47 signed code objects including the outer app.

Changed files in the one writer scope:

- `package.json`
- `scripts/lib/macos-artifact-resign.mjs`
- `scripts/resign-macos-artifact.mjs`
- `scripts/validate-macos-package.mjs`
- `scripts/lib/macos-package-inventory.mjs`
- `packages/runtime/test/macos-artifact-resign.test.ts`
- this plan file

Personally observed proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`: 17/17 passed.
- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts packages/runtime/test/macos-package-signature.test.ts packages/runtime/test/macos-package.test.ts --maxWorkers=1`: 82/82 passed.
- `npm run typecheck`: passed.
- `node --check scripts/lib/macos-artifact-resign.mjs scripts/resign-macos-artifact.mjs scripts/validate-macos-package.mjs`: passed as separate checks.
- `git diff --check`: passed.
- Read-only Mach-O binding of the canonical artifact: 46/46 parsed; a disposable
  ad-hoc `codesign --timestamp=none` fixture changed only the signature data
  while its normalized payload digest stayed equal.
- Read-only canonical validator: passed with 13,774 entries and 46 Mach-O
  files. Canonical manifest SHA and accepted artifact identities remained
  unchanged.
- No Developer ID identity, `security`, Keychain, network/timestamped sign,
  package build/install, launch/TCC, notarization, upload, or publication was
  run. The only signing observation used a disposable ad-hoc fixture.

Enforcement discovery: the local command and tests are available and passed;
no optional hook, checked-in CI invocation, or verified branch-protection rule
was found. No hook, CI, or external enforcement state changed.

Remaining limits: no real signed staged candidate exists. Owner copy/retention
status, one authorized signing attempt, independent FAST closeout, and Lead
acceptance remain open. Existing unrelated dirty F5/F6 files and evidence were
preserved and are not part of this correction scope.

### M7-F11 — Lead acceptance and closeout

Frontier: `M7-F11-ARTIFACT-RESIGN-FOUNDATION`

Disposition: `ACCEPT`. Review closeout: `CLOSEOUT_CLEAR`.

Lead accepted candidate `10173eff919c482f222dd3722a0b505d9a0ac71bf4c36daed2d1c45d3fc75921`.
The independent reviewer was `626d5cc5-6290-4e90-b630-4a69d2d400f6`; the
reviewer model was not supplied in the ruling. The accepted shape is 13,774
entries, 46 Mach-O files, 10 CodeResources files, and 47 signed code objects.
The canonical manifest SHA-256 remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`.

F11-R1-001..008 are closed:

- `001`: Mach-O payload binding excludes each bounded `LC_CODE_SIGNATURE`
  range and is checked before, during, and after signing.
- `002`: staged ownership, modes, realpaths, regular-file types, hardlinks,
  and symlink bundle-root rejection are enforced.
- `003`: the narrow exclusive stage capability and immediate pre-sign
  baseline/policy/realpath/hash gate prevent a mutation from reaching
  `codesign`.
- `004`: inventory and manifest writes use private same-directory no-follow
  temporary files, fsync, atomic rename, and directory fsync.
- `005`: retained artifact-only validation uses embedded/rebound evidence and
  codesign observation without Keychain or source-evidence resolution.
- `006`: package-input, inventory, manifest, and final-entry binding digests
  are recomputed and must be equal.
- `007`: final F11 validation requires the artifactResign schema, accepted
  baseline, signing-bound descriptor, stage evidence, and rebind lifecycle.
- `008`: unsupported `lstat` types fail with an actionable authority and next
  action; regular files, symlinks, and directories retain their behavior.

Proof: 82/82 focused package/signature/artifact tests passed; typecheck,
syntax checks, and `git diff --check` passed. Positive and negative fixture
proof covered the accepted ordinary-payload, notice/license, symlink,
package-member, component-mapping, CodeResources, entitlement, baseline,
canonical-target, post-sign, and signing-order violations. The read-only
canonical validator observed 13,774 entries and 46 Mach-O files.

Encode-invariant enforcement levels:

- local: command, validator, and focused tests are present and passed;
- optional hook: no hook was found;
- CI: no checked-in CI invocation was found;
- branch protection: not verified.

Canonical preservation and limits: the canonical app and manifest remained
byte-for-byte unchanged; no generated artifact or evidence was changed. No
real candidate signing, Developer ID signing, Keychain/security access, owner
staging/copy, launch/TCC, network or timestamped signing, notarization,
upload, or publication occurred. Tests used disposable fixtures only,
including an ad-hoc timestamp-disabled signing observation. No external
enforcement state changed. A real owner-staged signed candidate, one
authorized signing attempt, and copy/retention lifecycle remain outside F11
and move to the next frontier: `M7-F12-OWNER-STAGED-RESIGN-PROPOSAL`.

This is a plan-only acceptance record; this turn changed only this plan file.

### M7-F13 — Owner re-sign lifecycle implementation candidate

Architecture authority: Lead `ACCEPT` for
`M7-F13-OWNER-RESIGN-LIFECYCLE-FOUNDATION`. The read-only architecture review
was by `16ca088a-5cef-4baa-af82-a4c4845369eb`; the reviewer model was not
supplied. The accepted decision keeps the existing artifact re-sign command as
the one state and process owner. A prompt-only wrapper and a separate prepare
command were not added.

Implementation frontier: `M7-F13-OWNER-RESIGN-LIFECYCLE-IMPLEMENTATION`.
Status: `CANDIDATE`; this writer does not self-accept. Independent DEEP review
and Lead acceptance remain required.

Candidate identities:

- accepted F11 package-source input:
  `10173eff919c482f222dd3722a0b505d9a0ac71bf4c36daed2d1c45d3fc75921`;
- deterministic current package-source snapshot:
  `25a405d8fc1a43d1bc992f407863655f52384c822eb9ad8b7a47f598292a4cf4`;
- HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`;
- accepted source: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`;
- accepted package-input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`;
- accepted artifact-input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
- accepted local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`.

The owner identity SHA-1 `D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561` and Team
ID `63M98WD275` remain evidence inputs only. They were not used for real
codesign or Keychain access.

Encoded lifecycle:

- No `--stage-root` selects the owner mode in the existing
  `resign:macos:artifact` command. Supplying `--stage-root` retains the direct
  F11 transform. No wrapper or second prepare command exists.
- Owner preparation validates the canonical release root, app, manifest,
  source types, realpaths, hardlinks, internal relative symlinks, accepted
  manifest identities, full entry closure, Mach-O payloads, inventory, and F5
  policy before copying. It creates one private realpath owner root outside
  the repository, copies regular bytes and symlink targets verbatim, prints
  the root immediately, and retains it on every outcome.
- The marker, `.meetless-artifact-resign-status.json`, and optional
  `.meetless-artifact-resign-evidence.json` are the only owner metadata. Status
  transitions are `prepared` -> `preflight` -> `consumed` -> one retained
  terminal state. `consumed` is written atomically before release identity
  resolution or the first codesign child. Consumed and terminal stages cannot
  be reused.
- Production signing spawns `/usr/bin/codesign` directly with inherited
  stdin/stdout/stderr. Owner mode requires all three native TTY streams and
  rejects remote or multiplexed Terminal facts. One child is owned at a time;
  INT, TERM, and HUP terminate and wait, with bounded SIGKILL escalation.
- Status and terminal evidence use private no-follow temporary files, file and
  directory fsync, atomic rename, and bounded non-secret diagnostics. The
  accepted F11 nested-first/outer-last signing, digest, inventory, validator,
  entitlement, and retained-artifact behavior remains the transform owner.

F12-R1-001..007 are absorbed by executable lifecycle proof:

- `001`: one existing command owns preparation, state, signing, validation, and
  retention; no prompt-only or prepare-only route was introduced.
- `002`: fresh private roots, canonical boundary checks, exact copy rules, and
  staged-closure revalidation are enforced.
- `003`: the status file and atomic consume transition enforce one attempt and
  reject consumed or terminal reuse.
- `004`: direct inherited-stdio child ownership, signal termination, wait, and
  bounded escalation are encoded.
- `005`: all success, failure, interruption, and pre-consume failures retain
  the exact root and bounded terminal evidence without automatic cleanup.
- `006`: status and evidence writes use the existing atomic metadata writer
  with no-follow creation and compare-and-swap identity checks.
- `007`: owner mode has no caller-controlled tool path, stage root, wrapper,
  or second preparation command; the checked-in F5/F11 owners remain fixed.

Proof personally run:

- Owner and F11 artifact tests: 30/30 passed.
- Combined artifact, package, and signature regressions: 95/95 passed.
- `npm run typecheck`: passed.
- `node --check scripts/lib/macos-artifact-resign.mjs scripts/resign-macos-artifact.mjs`:
  passed.
- `node scripts/candidate-snapshot.mjs --mode=package-source`: passed and
  produced the candidate identity above.
- `git diff --check`: passed.
- Disposable synthetic stages were created by tests and removed. No owner
  stage was retained after testing.

Canonical preservation: the canonical app and external manifest remained
byte-for-byte unchanged. The manifest SHA-256 remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`; its
shape remains 13,774 entries, 46 Mach-O files, and 10 CodeResources files. No
canonical artifact, generated evidence, package identity, or policy file was
changed by this frontier. Unrelated dirty F5/F6 work was preserved.

Encode-invariant enforcement:

- local: focused owner/lifecycle tests, direct regressions, syntax, typecheck,
  and snapshot validation passed;
- optional hook: none found or installed;
- checked-in CI: no invocation was found;
- branch protection: unverified.

Limits: no real Developer ID signing, Keychain/security access, network or
timestamped signing, owner staging outside disposable tests, launch, TCC,
notarization, upload, publication, or external enforcement change occurred.
No live native-Terminal one-attempt run or retained signed candidate exists.
The candidate requires independent DEEP review and Lead acceptance before any
owner-authorized signing attempt.

### M7-F13-CORRECTION-R1 — Owner lifecycle hardening candidate

Lead ruling: `CONTINUE` for
`M7-F13-OWNER-RESIGN-LIFECYCLE-IMPLEMENTATION`. The DEEP exploratory review was
by `c0d8cf98-6879-4286-8e32-8e256da6f755`; the reviewer model was not supplied.
F11 remains the accepted artifact transform. This correction absorbs and
closes `M7F13-R1-001..005` by executable proof. Status: `CANDIDATE`; this
writer does not self-accept. The same reviewer FAST closeout and Lead
acceptance remain required.

Candidate identities:

- accepted F11 package-source input:
  `10173eff919c482f222dd3722a0b505d9a0ac71bf4c36daed2d1c45d3fc75921`;
- deterministic correction package-source snapshot:
  `015ff68677e13443f9b836b726a0651cb64afe7b250e2fc4c99edcacf9bf7185`;
- HEAD:
  `af5f1817191ba5fd634c750e9345de7d575ba704`;
- accepted source:
  `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`;
- accepted package-input:
  `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`;
- accepted artifact-input:
  `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
- accepted local artifact:
  `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`.

Correction closure:

- `R1-001`: owner signing, inventory, and artifact-only validation use fixed
  absolute `/usr/bin` tool paths and a reduced environment. The owner tests
  place `file` and `otool` shims on `PATH`; no shim call is observed. Direct
  non-owner modes keep their existing command path behavior.
- `R1-002`: owner preparation reads each source regular file through an
  `O_NOFOLLOW` handle bound to the validated inode, size, link count, and mode.
  It compares the expected source snapshot before writing, writes the staged
  file through a no-follow exclusive handle, and verifies destination bytes and
  mode before retention. Internal relative symlinks are validated and copied
  verbatim. Changed source bytes fail before they become accepted input.
- `R1-003`: the temporary parent is realpath-resolved and checked outside the
  repository and release root before `mkdtemp`. A parent inside the workspace
  creates zero entries, and stage output is emitted only after successful root
  creation and realpath resolution.
- `R1-004`: one
  `.meetless-artifact-resign-status.json` record now owns state and bounded
  terminal evidence. `consumed` is durable, explicitly `inDoubt`, and
  permanently non-reusable until one terminal record is atomically committed.
  The owner signal controller remains installed across identity resolution,
  all signing children, metadata regeneration, retained validation, and the
  terminal commit. INT/TERM/HUP terminate and wait for the child before a
  terminal interruption record is written.
- `R1-005`: the owner root/status parent is bound to its realpath, device,
  inode, uid, and private 0700 mode. The binding is rechecked before the
  temporary write, after file fsync, immediately before rename, and after
  rename plus directory fsync. Parent replacement fails without candidate
  output. No native `openat` helper, generic transaction/recovery framework,
  cleanup command, or malicious same-uid race protection is claimed. The
  calibrated threat model is one owner-controlled 0700 sole writer; a
  same-uid process can still race between separate Node syscalls.

Changed implementation and proof scope is limited to the accepted correction
owners: `scripts/lib/macos-artifact-resign.mjs`,
`scripts/resign-macos-artifact.mjs`,
`scripts/lib/macos-package-inventory.mjs`,
`scripts/lib/macos-package-signing.mjs`, `scripts/validate-macos-package.mjs`,
and `packages/runtime/test/macos-artifact-resign.test.ts`. Unrelated dirty F5
and F6 work was preserved. The owner command remains the one short command:
`npm run resign:macos:artifact -- --signing-identity=<...> --team-id=<...>`.
There is no shell wrapper or second preparation command. The existing F11
deepest-first/outer-last signing, exact 47 code objects, five entitlement
paths, rebound metadata, and ordinary validator remain the owners of those
rules.

Proof personally run:

- focused correction suite: 34/34 passed;
- combined artifact, package, and signature regressions: 99/99 passed;
- `npm run typecheck`: passed;
- `node --check` for the changed JavaScript modules: passed;
- `node scripts/candidate-snapshot.mjs --mode=package-source`: passed with
  correction identity `015ff68677e13443f9b836b726a0651cb64afe7b250e2fc4c99edcacf9bf7185`;
- `git diff --check`: passed, including no-index checks for new files.

Positive and negative fixture proof covers fixed-tool authority and zero PATH
shim calls, private no-follow copy, changed-source rejection, temporary-parent
boundary and no false stage output, in-doubt consume-once state, inherited
TTY child ownership, signal kill/wait across lifecycle boundaries, atomic
status interruption/race preservation, parent replacement, canonical bundle
symlink rejection, unsupported package lstat types, ordinary payload and
notice/license preservation, symlink targets, package members, component
mapping, CodeResources shape, F5 policy, stale baseline, canonical target,
post-sign mutation, and invalid signing order.

Encode-invariant enforcement levels:

- local: focused owner correction tests, F11/F5 package-signature regressions,
  typecheck, syntax, snapshot, and diff checks passed;
- optional hook: no hook was found or installed;
- checked-in CI: no invocation was found; `.github/` is absent;
- branch protection: not verified.

Canonical preservation and limits: the canonical external manifest SHA-256 is
still `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`,
with 13,774 entries, 46 Mach-O files, and 10 CodeResources files. The
canonical app and manifest remained byte-for-byte unchanged. Tests used only
disposable temporary fixtures; no owner root remained after tests. No real
Developer ID signing, Keychain/security access, external staging, timestamped
signing, network, package build/install, launch, TCC, notarization, upload,
publication, or external enforcement change occurred. No native helper was
added. A live owner TTY run and retained signed candidate remain unattempted
pending independent FAST closeout and Lead acceptance.

### M7-F13-CONVERGENCE-CORRECTION — Snapshot-bound owner copy closeout candidate

Convergence authority: `CONVERGENCE_RECONCILIATION v1` for review family
`M7-F13-owner-resign-lifecycle`. The reviewed candidate was
`015ff68677e13443f9b836b726a0651cb64afe7b250e2fc4c99edcacf9bf7185`.
Closeout result was `CLOSEOUT_FINDINGS`; the decision was a bounded correction
with no new design. This correction is limited to
`scripts/lib/macos-artifact-resign.mjs`,
`packages/runtime/test/macos-artifact-resign.test.ts`, and this plan record.
Status: `CANDIDATE`; this writer does not self-accept. Final FAST closeout by
the independent reviewer and Lead disposition remain required.

Encoded closure:

- The accepted source snapshot now enumerates the bundle root, every directory,
  every regular file, and every symlink. `copyOwnerTree` requires that exact
  snapshot before it can create a destination entry.
- Each source entry must have the exact expected relative path and type before
  destination inspection or creation. Added regular files, symlinks,
  directories, and unsupported lstat types fail with an actionable discard and
  restore diagnostic.
- Symlinks must match the expected target and SHA-256 target digest before
  creation, then pass the existing internal-relative-target check. Regular
  files retain the existing no-follow handle, inode, size, link-count, mode,
  and byte binding before copy and destination verification.
- Traversal requires every expected entry to be observed. Missing expected
  entries fail, and the retained preparation-failure root contains no
  unaccepted added entry. The lifecycle, state, tool authority, parent
  binding, and R1-001/003/004/005 boundaries are unchanged.

Proof personally run:

- focused owner artifact-resign suite: 40/40 passed, including positive
  internal symlink copy, retargeted symlink rejection, added regular/symlink/
  directory/unsupported-entry rejection, and missing-entry rejection with
  retained-root absence checks;
- direct artifact, package, and signature regressions: 105/105 passed;
- `npm run typecheck`: passed;
- `node --check scripts/lib/macos-artifact-resign.mjs
  scripts/resign-macos-artifact.mjs`: passed;
- `node scripts/candidate-snapshot.mjs --mode=package-source`: passed with
  deterministic correction candidate
  `71e624d81f724fcbdcbd7c191520fb6612a5ad3461e201c2fbff06fca617e5b4` at HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`;
- `git diff --check` and scoped no-index checks for new files: passed.

Encode-invariant enforcement levels:

- local: focused and direct tests, typecheck, syntax, deterministic snapshot,
  and diff checks passed;
- optional hook: no hook was found or installed;
- checked-in CI: no invocation was found; `.github/` is absent;
- branch protection: not verified.

Canonical preservation and limits: the canonical app and external manifest
remain byte-for-byte unchanged. The canonical manifest SHA-256 remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`, with
13,774 entries, 46 Mach-O files, and 10 CodeResources files. Tests used only
disposable temporary fixtures; no real Developer ID signing, Keychain/security
access, staging outside fixtures, package build/install, launch/TCC, network,
timestamped signing, notarization, upload, publication, or external
enforcement change occurred. A live owner TTY signing attempt and retained
signed candidate remain unattempted pending FAST closeout and Lead acceptance.

### M7-F13-OWNER-RESIGN-LIFECYCLE-ACCEPTANCE — Lead acceptance record

Lead ruling: `ACCEPT` for candidate
`71e624d81f724fcbdcbd7c191520fb6612a5ad3461e201c2fbff06fca617e5b4`.
Independent FAST closeout: `CLOSEOUT_CLEAR` by
`c0d8cf98-6879-4286-8e32-8e256da6f755`; review model:
`codex-review/gpt-5.6-luna`.

Acceptance closes `M7F13-R1-001..005`, including the final bounded
`M7F13-R1-002` snapshot-bound source-copy correction. The accepted evidence
remains the 40/40 focused tests, 105/105 direct artifact/package/signature
regressions, typecheck, syntax checks, deterministic candidate snapshot, and
diff checks recorded above. The accepted threat-model limit remains one
owner-controlled private 0700 sole writer; protection against a malicious
same-UID process racing between separate Node syscalls is not claimed. No
native helper, generalized transaction/recovery framework, or cleanup command
was added.

The canonical app and external manifest remain byte-for-byte unchanged. The
canonical manifest SHA-256 remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`, with
13,774 entries, 46 Mach-O files, and 10 CodeResources files. No real
Developer ID signing, Keychain/security access, owner stage outside disposable
fixtures, timestamped signing, network, package build/install, launch, TCC,
notarization, upload, publication, or release acceptance occurred.

This accepts the lifecycle foundation only. It does not authorize a real
owner stage or signing attempt. The next exact gate is one owner-reviewable
plan/output for the accepted command
`npm run resign:macos:artifact -- --signing-identity=<...> --team-id=<...>`.
After that gate, a separate owner authorization is required for exactly one
native-Terminal, no-timestamp Developer ID signing validation. Launch, TCC,
notarization, upload, publication, and release acceptance remain out of scope.

This is a plan-only acceptance record. No implementation, test, artifact,
evidence, app, or external state was changed by this record.

### PLAN_RECONCILIATION — F11/F13 accepted route and current frontier

This compact reconciliation records the accepted route after F7, F8, and F12
cancellation and lifecycle reopen.

Absorbed and accepted:

- F11 artifact-only re-sign foundation;
- F13 owner-owned stage, one-attempt, child-ownership, validation, and
  evidence lifecycle candidate
  `71e624d81f724fcbdcbd7c191520fb6612a5ad3461e201c2fbff06fca617e5b4`.

Cancelled or retired routes remain in this plan as history, but are not active:

- F7 generic runner;
- F8 full-workspace copy;
- F12 shell-wrapper procedure.

The active route has no dependency on copying `.meetless-runtime` or the full
workspace. It uses the accepted app and external manifest only, with the
owner lifecycle metadata permitted by its explicit schema.

Current ordered frontier:

1. Read-only owner-reviewable F13 command/output proposal.
2. Explicit owner authorization for exactly one native-Terminal,
   no-timestamp Developer ID run.
3. Retained staged candidate review and Lead disposition.
4. Later separate launch/TCC, notarization, legal, publication, and
   release-acceptance gates.

No real stage or signing authorization exists. F2's 11 Human/legal gates and
all F3/F5 limits remain binding and unchanged. No other dependency reorder is
needed.

This is a plan-only reconciliation record. No implementation, test, artifact,
evidence, app, or external state was changed.

### M7-F15 — Mach-O signing-derived metadata correction candidate

Authority: the owner-provided M7 signing attempt ended in retained failure with
`attempt=1` and `inDoubt=false`. The retained stage at
`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-0tcL30`
was not read, copied, validated, modified, or otherwise accessed. The accepted
F11/F13 artifact-only contract and this plan remain the policy owners.
Status: `CANDIDATE`; this writer does not self-accept.

Observed failure evidence: `Contents/MacOS/MeetlessHost` changed outside its
`LC_CODE_SIGNATURE` data. The file grew from 311840 to 312064 bytes;
`dataoff` stayed 292992; `datasize` grew from 18848 to 19072; and
`__LINKEDIT.filesize` grew from 148000 to 148224. No other load-command
difference was observed. The pre-signature byte differences were the signing-
derived size fields.

Encoded invariant:

- The normalizer now parses bounded thin and fat slices and fails closed for
  unsupported CPU types, truncated commands, invalid slice or segment ranges,
  overlaps, and missing, extra, or duplicate signature commands.
- Exactly one `LC_CODE_SIGNATURE` and one `__LINKEDIT` segment are required per
  slice. The signature must end at the slice end; `__LINKEDIT.filesize` must be
  the exact slice-end minus `fileoff`; and `__LINKEDIT.vmsize` must be the exact
  page-rounded `filesize` (`0x4000` for arm64, `0x1000` for x86/x86_64).
- Only `LC_CODE_SIGNATURE.datasize`, derived `__LINKEDIT.filesize`, derived
  `__LINKEDIT.vmsize`, and fat-architecture slice `size` are canonicalized.
  `dataoff`, slice offsets and architecture fields, segment identity/layout,
  executable bytes, all other headers/load commands, and path/symlink closure
  remain bound by the normalized digest and metadata comparison.
- The lifecycle, canonical artifact, F5 policy, one-attempt state, and owner
  command are unchanged.

Proof personally run:

- focused artifact-resign suite: 55/55 passed;
- direct package regressions: 30/30 passed;
- direct non-signing package-signature regressions: 35/35 passed. The two
  existing tests that invoke real ad-hoc `codesign` were not run under this
  frontier's prohibition;
- read-only canonical parser proof: 13,774 package entries, 46 Mach-O files,
  and 46 bounded Mach-O slices accepted;
- `npm run typecheck`: passed;
- JavaScript syntax checks: passed;
- deterministic package-source snapshot passed twice with candidate identity
  `611645e3d821e9581cc11f0276da6fb11c78e1ed42eaeb60925212aac5545fec` at HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`;
- canonical read-only hashes remain manifest
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
  artifact fingerprint
  `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

Positive proof covers signature bytes plus legitimate signature growth with
derived `datasize` and `__LINKEDIT.filesize` changes. Negative proof covers
payload bytes, moved `dataoff`, inconsistent `datasize`, `filesize`, or
`vmsize`, changed `__LINKEDIT` identity/layout/protections, non-`__LINKEDIT`
fields, slice/header/load-command mutation, duplicate or missing signatures,
and truncated, overlapping, or out-of-slice ranges. Thin and fat fixtures are
disposable and deterministic.

Residual uncertainty: no live retry or second owner signing attempt occurred,
and no observed live case crossed an arm64 `__LINKEDIT.vmsize` page boundary.
The accepted rule is proven by the canonical arm64 layout and synthetic thin/
fat bounds; live signing behavior remains unattempted and requires the existing
owner authorization gate.

No real or ad-hoc codesign, Keychain/security access, signing retry, retained
stage access, launch/TCC, network/timestamp, notarization, upload,
publication, cleanup, commit, or external state change occurred.

### M7-F15-CORRECTION-R1 — Mach-O parser validation candidate

Authority: Lead accepted F15-R1-001 and F15-R1-002 as one parser-validation
batch. Correction base package-source digest:
`611645e3d821e9581cc11f0276da6fb11c78e1ed42eaeb60925212aac5545fec`.
Status: `CANDIDATE`; writer does not self-accept.

Encoded correction:

- Every Mach-O load-command `cmdsize` must remain within the existing bounds and
  be divisible by four. The failure names the command, value, authority, and
  compliant next action.
- FAT CPU type and subtype are cross-bound to the inner Mach header as exact
  unsigned 32-bit bit patterns. The documented key is
  `0x########:0x########`; no signed conversion or capability-bit masking is
  applied. FAT table order and bounded slice order remain deterministic.
- Duplicate FAT architecture keys fail closed before normalization. Distinct
  supported arm64 subtype keys remain accepted.
- Existing signature-derived field rules, thin behavior, payload closure,
  lifecycle, F5 policy, and one-attempt semantics remain unchanged.

Proof personally run:

- focused artifact-resign suite: 56/56 passed;
- direct package regressions: 30/30 passed;
- direct non-signing package-signature regressions: 35/35 passed. The two
  existing tests that invoke real ad-hoc `codesign` were not run under this
  frontier's prohibition;
- read-only canonical parser proof: 13,774 package entries, 46 Mach-O files,
  and 46 bounded Mach-O slices accepted;
- `npm run typecheck`, JavaScript syntax checks, and `git diff --check` passed;
- deterministic package-source snapshot passed twice with candidate identity
  `b80828220fa58d19aad09b1b3e48a68fcfa3af079830033547d49e0bb3d35dec` at HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`;
- canonical read-only hashes remain manifest
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
  artifact fingerprint
  `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

Positive fixtures cover aligned thin Mach-O, signature growth, valid distinct
FAT architecture keys, and prior page/closure behavior. Negative fixtures cover
`cmdsize=73`, FAT CPU-type mismatch, subtype mismatch, duplicate key, payload,
header, load-command, range, truncation, overlap, and signature metadata
violations.

No retained-stage access, codesign, Keychain/security access, signing retry,
network/timestamp, launch/TCC, notarization, upload, publication, cleanup,
commit, or external state change occurred. Local validation is the enforced
level; only sample Git hooks are present, no checked-in `.github` workflow was
found, and branch-protection enforcement is unverified.

### M7-F15 — Lead acceptance and closeout

Lead decision: `ACCEPT` candidate
`b80828220fa58d19aad09b1b3e48a68fcfa3af079830033547d49e0bb3d35dec`.
Independent review: `CLOSEOUT_CLEAR` by
`626d5cc5-6290-4e90-b630-4a69d2d400f6`; review model actual:
`codex-review/gpt-5.6-luna`.

F15-R1-001 and F15-R1-002 are closed. The accepted comparator contract
normalizes only exact codesign-derived `LC_CODE_SIGNATURE`, `__LINKEDIT`, and
FAT slice-size fields. All unrelated payload, header, load-command,
architecture, segment-layout, path, and symlink state remains bound. Aligned
load commands and exact FAT CPU type/subtype cross-binding are required.

Recorded proof remains: focused artifact-resign `56/56`; direct package
regressions `30/30`; direct non-signing package-signature regressions `35/35`;
typecheck, syntax, and `git diff --check` passed. The canonical manifest and
artifact fingerprint remain unchanged at
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

This acceptance authorizes only a read-only audit of the already-retained
stage. It does not authorize a retry, stage or lifecycle modification, cleanup,
Keychain/security access, launch/TCC, network, notarization, upload,
publication, or release acceptance.

### M7-F16 — Retained-stage audit disposition

Lead technical disposition: `ACCEPT` the read-only audit as `VERIFIED`
evidence only. This is not artifact acceptance. Comparator candidate:
`b80828220fa58d19aad09b1b3e48a68fcfa3af079830033547d49e0bb3d35dec`.
Auditor: `c0d8cf98-6879-4286-8e32-8e256da6f755`. Review model actual:
`codex-review/gpt-5.6-luna`.

Exact audited retained stage:
`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-0tcL30`.
The retained state is `retained-failure`, `attempt=1`, `inDoubt=false`.
It is not promotable or reusable. No cleanup is authorized.

Recorded audit identities and shape:

- source snapshot: `d3db4c8fbb2d97a1c1657aceca5e1390d807a6c16b01b5c5de6272307769409d`;
- package input: `f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`;
- artifact input: `81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`;
- accepted local artifact: `fbda82d2c76318afa2022f331ba7d37d621f84568c10c1dd0718d73658dcb4fa`;
- accepted signature state: `217e1edfc29521b67604230b5b2dfc173b328aad0c21c0151b6e3513f85a0184`;
- composition manifest SHA-256: `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`;
- canonical artifact fingerprint: `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`;
- package shape: 13,774 entries, 46 nested Mach-O files, 10 CodeResources
  files, and 47 code objects.

Signature audit result: 46/46 nested strict checks and outer deep/strict checks
passed. The 47 objects reported the Developer ID identity
`Developer ID Application: Long Le (63M98WD275)`, certificate SHA-1
`D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`, Team ID `63M98WD275`, and hardened
runtime. The exact entitlement map was observed: four JIT paths (`runtime/node`,
Electron, Electron Helper (Renderer), and Electron Helper (GPU)) and one
audio-input path (`native/macos-capture/meetless-capture`); all other code
objects are entitlement-free. No signed-byte defect was found.

The failure is stale pre-rebind lifecycle and metadata only. The canonical app,
external manifest, and recorded canonical identities remain unchanged. The
next owner gate is explicit authorization for exactly one fresh owner
stage/run using the accepted comparator, followed by independent review.
There is no current authorization for a retry or new run, Keychain/security
access, cleanup, launch/TCC, timestamp/network activity, notarization, upload,
publication, legal review, or release acceptance.

### M7-F17 — Fresh owner re-sign authorization directive

Owner directive, recorded exactly:

- The owner personally executes one fresh native-Terminal invocation:
  `npm run resign:macos:artifact -- --signing-identity=D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561 --team-id=63M98WD275`.
- Exactly one fresh stage and one signing attempt are allowed.
- The accepted command enforces `--timestamp=none`.
- The owner may select Keychain `Allow` once; `Always Allow` is forbidden.
- No retry is allowed.
- Retain both the old and new stages.
- No cleanup, launch/TCC, notarization, upload, publication, release
  acceptance, or unrelated Keychain changes are allowed.
- Lead and agents must not run the command on the owner's behalf.
- Wait for owner-provided terminal evidence.

This is an owner directive record only. No command was run and no stage, app,
evidence, Keychain, code, test, or external state was changed by this record.

### M7-F18 — Signed-entitlement extraction correction candidate

Authority: accepted finding `F18-R1-001` states that signed-entitlement
inspection requested codesign's abstract output instead of plist output. The
accepted F15 candidate is the correction base:
`b80828220fa58d19aad09b1b3e48a68fcfa3af079830033547d49e0bb3d35dec`.
Candidate package-source identity:
`a354341cffc47752ec696c27191555aefa78045a4b1a3de72b8594c92e077822` at
HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`. Status: `CANDIDATE`; this
writer does not self-accept. Independent review and Lead disposition remain
required.

Owner evidence supplied a retained-failure stage at
`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-5LCWCP`;
it was not read, validated, copied, modified, deleted, or cleaned up. The
approved JIT input plist remains identified by SHA-256
`958648f799e436860b51eaf55ec8f92d2c62da17001e23d96bc05ffc748f2a2a`; the
defect was extraction format, not that input.

Encoded correction, limited to
`scripts/lib/macos-package-signing.mjs` and its deterministic signature tests:

- Owner-mode signed-entitlement inspection uses the existing absolute
  `/usr/bin/codesign` authority with the exact argv
  `-d --entitlements - --xml <binary>`. The deprecated `:-` form is not used.
- Only XML plist output is canonicalized. Empty stdout keeps the existing
  no-entitlement result (`null` raw and canonical digests, with no keys).
  Abstract or other non-plist output fails as a signed-entitlement
  extraction-format defect and does not direct the owner to replace the
  approved input plist. No abstract-output fallback parser was added.
- Per-image observation, exact raw-output and canonical plist digests,
  entitlement key extraction, signer/Team/certificate evidence, hardened
  runtime, and the exact F5 entitlement map remain unchanged.

Proof personally run:

- focused signed-entitlement proof: 3/3 passed;
- credential-free package-signature regressions: 37/37 passed; the two
  existing real ad-hoc `codesign` tests were excluded by the prohibition;
- artifact-resign regression: 56/56 passed;
- package regression: 30/30 passed;
- deterministic mocks prove the exact XML invocation, independent JIT/audio
  plist observation, empty stdout semantics, equivalent-XML digest equality,
  abstract-output and malformed-XML rejection, and absence of `:-`;
- existing F5 tests continue to reject extra, risky, wrong, missing, and
  unmapped entitlement keys;
- `node --check scripts/lib/macos-package-signing.mjs`, `npm run typecheck`,
  and `git diff --check` passed;
- two package-source snapshots produced the same candidate identity above;
- canonical read-only identities remain manifest
  `03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
  artifact fingerprint
  `c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

Enforcement level: local production signing evidence now mechanically requests
XML and rejects non-plist extraction; deterministic focused tests enforce the
positive and negative boundary. No Git hook, CI workflow, branch protection,
or external enforcement was changed; only sample hooks are present, no
checked-in `.github` workflow was found, and branch-protection enforcement is
unverified.

No retained stage was accessed. No real or ad-hoc codesign, Keychain/security
access, signing retry, network/timestamp, launch/TCC, notarization, upload,
publication, cleanup, commit, or external state change occurred. The candidate
does not authorize a signing attempt or change the owner lifecycle.

### M7-F18 — Lead acceptance and closeout

Lead decision: `ACCEPT` candidate
`a354341cffc47752ec696c27191555aefa78045a4b1a3de72b8594c92e077822`.
Independent review: `CLOSEOUT_CLEAR` by
`949e965f-db17-45d3-adab-00d2f3598dba`; review model actual:
`codex-review/gpt-5.6-luna`.

`F18-R1-001` is closed. The accepted extraction contract uses owner
`/usr/bin/codesign` with exact arguments
`-d --entitlements - --xml <binary>`. The deprecated `:-` form is not used.
Only XML plist output is canonicalized. Empty output means no entitlements.
Abstract or malformed output fails closed with an extraction-specific
diagnostic. The per-image evidence, raw and canonical digests, F5 entitlement
map, signer, Team, certificate, and hardened-runtime checks remain binding.

Recorded proof remains: focused entitlement tests `3/3`; credential-free
package-signature regressions `37/37`; artifact-resign regressions `56/56`;
package regressions `30/30`; typecheck, syntax, and `git diff --check` passed;
and two package-source snapshots matched. The two existing real ad-hoc
`codesign` tests were excluded by the prohibition. Canonical identities remain
manifest SHA-256
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
artifact fingerprint
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

This acceptance authorizes only a read-only audit of the new retained stage.
It does not authorize a retry, stage or lifecycle modification, cleanup,
Keychain/security access, launch/TCC, network, notarization, upload,
publication, or release acceptance.

### M7-F19 — Fresh-stage read-only audit disposition

Frontier: `M7-F19-FRESH-STAGE-READ-ONLY-AUDIT`. Audit status:
`TECHNICAL_FAILURE`. Candidate:
`a354341cffc47752ec696c27191555aefa78045a4b1a3de72b8594c92e077822`. HEAD:
`af5f1817191ba5fd634c750e9345de7d575ba704`. Auditor:
`c0d8cf98-6879-4286-8e32-8e256da6f755`; review model:
`codex-review/gpt-5.6-luna`.

The supplied verified disposition identifies the new retained stage as
`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-5LCWCP`,
mode `0700`, owner `501:20`, device/inode `16777234/38204659`. Its status SHA
is `3286130b0507205ef7437f5b93514bb86989dd2d4b907f9f1df1ec112f76af3a`, marker
SHA is `6df54133578d1e0b2aea88850b66ee6f2a293854012d920d0c87b4cf0f122566`,
staged manifest SHA is
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`, staged
inventory SHA is
`94dd1d49ba3425cacc6b06665a52ae4017b9e0073d3827cf7c16ce818c1a3516`, and
staged app fingerprint is
`020458017ea48ff3b63a6f24fd0802250672a0bba5c1b01729352aca73bfcde9`.
Lifecycle state is `retained-failure`, attempt `1`, outcome `failure`, and
`inDoubt=false`.

The exact closure was 13,774 entries, 46 Mach-O files, 10 CodeResources
files, and 47 code objects, with no missing, extra, type, symlink, or
unsupported-entry violations. Signature evidence was 46/46 nested strict and
outer deep/strict; all 47 objects reported Developer ID Application Long Le,
Team `63M98WD275`, hardened runtime `47/47`, and certificate SHA-1
`D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561`. Entitlement extraction with
`--xml` parsed 47/47 objects and matched the exact F5 map: one audio-input
object, four JIT objects, and 42 entitlement-free objects. Audio raw/canonical
SHA-256 values are
`15f20773327637e1e3896c2bd530db7e483d00e71014e73ec19d6c06f32032f2` /
`82052f68fb90e288554c67b08bdcb3403699ac396387a93d37f3b397c3e9f064`;
JIT raw/canonical values are
`84ea240cae1d3d70098e6bfe66ed4cf2e991a14ef6e66978af7b5813d2d17176` /
`6f0a9b4f19e49ab2c95c62b5012d87edc50fb74a76df2b364fdcb0a9dc929e30`.

F15 payload closure passed 46/46; immutable payload differences were `0`,
ordinary payload differences were none, and the F5 source policy was exact.
Nested and outer signing completed and rebound inventory was written, but
final signature extraction failed before final manifest generation. The
manifest has no `artifactResign`; package input remains
`f560e082a5e3a01322b6d00bdd5e1ac08f89de8d9badc7ad555956dd95bb1402`, artifact
input remains
`81739d31180e9e356dd677d83c3e1e7ecf98ea2864f90d9ff4794d4ad55eade1`, and the
manifest inventory digest remains
`3d0a0af0ecbe8162df9c7382070052c2b8934721ef50e21bffed25004270ba3c`. The
staged inventory digest is
`94dd1d49ba3425cacc6b06665a52ae4017b9e0073d3827cf7c16ce818c1a3516`; its
binding is `3742d334d3937b9ce758d88dab296d5dadefcfbe850da7dd7f0aa0fb9badf238`,
while recomputed final binding is
`05dc47ef510e07a4faa1a009a82ed55e8484c69aa7d913c16be13198b5b24766`.

There is no signed-byte defect. The signed bytes are valid, but final metadata
is incomplete/stale and does not bind the outer-signed artifact. The stage is
not promotable, reusable, or repairable. Both retained stages remain
preserved and unchanged. Canonical manifest SHA
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b` and
canonical artifact fingerprint
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e` remain
unchanged. No lifecycle change occurred.

Reconciled next frontier:

1. Complete credential-free end-to-end proof of the post-extraction rebind and
   final-validation path.
2. Only if that proof is clear, request separate owner authorization for one
   new fresh run.
3. Independently review the retained candidate.
4. Apply external gates later.

No current run or retry authorization exists. No cleanup is authorized. This
record does not authorize Keychain/security access, launch/TCC,
timestamp/network activity, notarization, upload, publication, legal review,
or release acceptance. Neither retained stage was accessed by this plan-only
record.

### M7-F20 — Command-level rebind proof (superseded history)

Frontier: `M7-F20-COMMAND-LEVEL-REBIND-PROOF`. Peer disposition: `CANDIDATE`; the
writer does not self-accept. Candidate package-source snapshot before this
plan record:
`2edb5c8dadda72a6812a56ed3d4789750c35e7ce721a0c23da4fcbf5f2ad20d9`.

The existing exported `run()` command now has one explicit test-only command
seam. It accepts deterministic stage preparation, package snapshot, signing
target/evidence, certificate, validator, lifecycle-event, and interruption
collaborators only with `testOnly: true`. Production calls use the existing
canonical stage preparation, `/usr/bin/codesign` authority, package inventory,
retained validator, atomic metadata writes, and owner lifecycle. No wrapper,
second lifecycle, or fallback was added. `scripts/lib/macos-artifact-resign.mjs`
was not changed.

Changed scope is exactly:

- `scripts/resign-macos-artifact.mjs` — command seam and lifecycle event points;
- `packages/runtime/test/macos-artifact-resign.test.ts` — disposable command
  integration fixtures and proof;
- this plan record.

The success fixture invokes exported `run()` with a private disposable stage
copied from the accepted app and manifest. It records this order:

`nested signing complete -> inventory rebound -> inventory atomic write ->
outer sign complete -> 47 signature observations -> signing metadata rebound ->
inventory reread -> manifest build/validate/write -> retained artifact-only
validation -> retained-success`.

The fixture proves 47 signing calls, 46 nested objects deepest-first, outer
`Meetless.app` last, `--timestamp=none`, 47 certificate observations, exact
`/usr/bin/codesign` evidence authority, and exact XML entitlement extraction
arguments `-d --entitlements - --xml <binary>`. Final metadata is internally
consistent: 13,774 entries, 46 Mach-O files, 10 CodeResources files, 47 code
objects, the exact five-path F5 map, Developer ID signer/Team/certificate and
hardened-runtime evidence, package-input/artifact-input/inventory binding,
`artifactResign`, `signatureStateDigest`, and `artifactDigest`. The terminal
status is `retained-success`, attempt `1`, `inDoubt=false`; a transition from
the terminal state is rejected.

The interruption fixture injects an error after the rebound inventory atomic
write and before manifest write. It proves the old manifest remains without
success metadata, rebound inventory may remain, no retained validator or
success terminal event runs, and the stage ends `retained-interrupted`, attempt
`1`, `inDoubt=false`. The stage cannot be reused. A retained-validator failure
fixture similarly ends `retained-failure` and cannot publish success. Existing
F11/F13 tests continue to cover malformed/stale binding, F5, atomic-write,
signal, child ownership, and lifecycle negative cases.

Proof passed:

- command-level focused tests: `4/4`;
- complete artifact re-sign test file: `60/60`;
- package/signature/transaction regressions: `69/69`;
- `npm run typecheck`;
- JavaScript syntax checks for the changed command and accepted transform;
- `git diff --check`;
- package-source snapshot: two identical digests as recorded above.

Encode-invariant enforcement is local only: the command, focused tests, direct
regressions, and actionable production diagnostics are present. No hook, CI
check, branch protection, or external enforcement was changed or inferred.

Only disposable test fixtures were created and cleaned. No real Developer ID
signing, Keychain/security access, owner stage, signing retry, timestamp,
network, launch/TCC, notarization, upload, publication, legal, or release
acceptance action occurred. The canonical manifest SHA remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`; the
canonical artifact fingerprint remains
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

Residual limit: the command proof uses deterministic test collaborators for
the expensive package snapshot, signing child, codesign evidence, certificate
observation, and retained validator. It proves orchestration and binding, not
a new live owner run or Keychain result. Production defaults remain the
accepted owners. Independent review and Lead disposition are still required;
this candidate does not authorize a new owner run or retry.

The record above is retained as history only. Its ordinary `testOnly` collaborator
seam and fake full-command success claim are superseded by the correction below;
neither is an active dependency or acceptance claim.

### M7-F20-CORRECTION-R1-ACYCLIC-REBIND — Phase-split metadata graph correction

Frontier: `M7-F20-CORRECTION-R1-ACYCLIC-REBIND`. Status:
`IMPLEMENTED_PENDING_INDEPENDENT_REVIEW`; the writer does not self-accept.
Candidate package-source snapshot:
`57673b210000c2e20d2e1c64c718c59d61dadcec5bf94569edca60d80e2080d3`.
Correction base:
`2edb5c8dadda72a6812a56ed3d4789750c35e7ce721a0c23da4fcbf5f2ad20d9`.

This correction closes `M7F20-R1-001` (final descriptor mismatch) and
`M7F20-R1-002` (forgeable command test seam). Changed scope is exactly
`scripts/lib/macos-artifact-resign.mjs`, `scripts/resign-macos-artifact.mjs`,
`scripts/validate-macos-package.mjs`,
`packages/runtime/test/macos-artifact-resign.test.ts`, and this plan. Unrelated
dirty F5/F6 work remains outside this correction.

The accepted phase-split architecture is encoded with
`MEETLESS_MACOS_ARTIFACT_RESIGN v2` and
`MEETLESS_MACOS_SIGNING_BOUND_PATHS v2`:

- The `pre-outer` descriptor owns all 46 normalized nested Mach-O payloads,
  the nine nested CodeResources paths, the ordinary pre-outer artifact-input
  closure, and the unchanged inventory legal/component/notice projection.
- `packageInputs.signingBound` and the in-app inventory binding are one exact
  pre-outer descriptor. They do not bind outer CodeResources bytes, outer
  signature state, or `signatureStateDigest`.
- The `final` descriptor owns the final 46 normalized payloads and all ten
  CodeResources paths. It is separate from the pre-outer inventory owner.
- `artifactResign.preOuter` and `artifactResign.final` keep the two scopes
  distinct. The external manifest records the final entry set, 47 signature
  observations, `signatureStateDigest`, and the acyclic final `artifactDigest`.
- Final validation compares each field with its owner and rejects old
  single-phase evidence. It does not require inventory descriptors to equal
  the post-outer descriptor. No app write follows the outer sign.

The exported production `run()` now accepts no caller replacement for stage
preparation, TTY facts, signing, snapshots, codesign evidence, certificate
evidence, validation, lifecycle, or status authority. The only accepted caller
input beyond command arguments is an observation-only `onLifecycleEvent` hook;
it cannot supply outcomes, skip work, or change production authority. The
production command uses its fixed existing owners. Deterministic graph proof
is in pure helpers called by production code. Lower-level credential-free
tests remain narrow and do not stand in for a real signing run.

Proof completed:

- pure phase-graph and lifecycle-order tests prove pre-outer versus final
  scope separation, schema versioning, equal package/inventory binding,
  separate final CodeResources/signature/artifact identities, old-schema
  rejection, post-outer mutation rejection, and phase identity cross-binding;
- the focused artifact re-sign suite passed `65/65`;
- package and transaction regressions passed `32/32`;
- safe package-signature/F5/F15/F18 regressions passed `37/37`; the two tests
  that invoke real codesign were not run;
- `npm run typecheck` passed;
- `node --check` passed for the artifact transform, command, and validator;
- `git diff --check` passed;
- two package-source snapshots matched exactly at the candidate identity above.

Encode-invariant enforcement is repository-local at the command, pure graph,
validator, focused-test, direct-regression, and actionable-diagnostic levels.
No CI, hook, branch-protection, or external enforcement was changed.

Only disposable test fixtures were used. No retained owner stage was accessed.
No real Developer ID signing, Keychain/security access, signing retry, new
owner stage, network or timestamp activity, launch/TCC, notarization, upload,
publication, cleanup, or release acceptance occurred. The canonical manifest
remains SHA-256
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`; the
canonical artifact fingerprint remains
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

Residual real-run gate: this correction proves metadata graph wiring and
production authority boundaries only. It does not prove Developer ID,
Keychain, CMS, native TTY, or a new retained-stage outcome. Existing F17/F19
retained evidence remains historical evidence through its prior failure points;
it is not repaired or reused. A later Lead/owner decision must separately
authorize exactly one fresh native-Terminal no-timestamp run, followed by
independent review. This candidate authorizes no run, retry, stage/lifecycle
mutation, cleanup, Keychain/security access, launch/TCC, network activity,
notarization, upload, publication, legal review, or release acceptance.

### M7-F20-ACYCLIC-REBIND-ACCEPTANCE — Lead closeout

Lead disposition: `ACCEPT` for candidate
`57673b210000c2e20d2e1c64c718c59d61dadcec5bf94569edca60d80e2080d3`.
Independent review: `CLOSEOUT_CLEAR` by
`c0d8cf98-6879-4286-8e32-8e256da6f755`; review model:
`codex-review/gpt-5.6-luna`.

`M7F20-R1-001` and `M7F20-R1-002` are closed. The accepted M7-F21 architecture
is the v2 pre-outer inventory/package-input scope, with the outer sign as the
last app write. The external manifest owns the final 47 signature records, ten
CodeResources paths, final entry set, `signatureStateDigest`, and acyclic
`artifactDigest`. Old single-phase evidence is rejected. Production `run()`
uses fixed authorities; only observation-only lifecycle hooks are allowed.

Closeout proof is the recorded `66/66` artifact re-sign tests, `32/32`
package/transaction regressions, `37/37` safe package-signature/F5/F15/F18
regressions, typecheck, syntax checks, `git diff --check`, and two matching
deterministic package-source snapshots. The two tests that invoke real
`codesign` were not run. The canonical manifest remains
`03553448d9789b3579187a740a37d51aea55f43e1e5460f3715e1ac4029bb28b`; the
canonical artifact fingerprint remains
`c05bc61e6e80628cb08f1d32fbbdeff2aabf472cd22181f17049ca500e11786e`.

This accepts the metadata and command foundation only. No current owner run
authorization exists. Both old retained stages remain preserved and are
non-reusable. No cleanup, Keychain change, launch/TCC, notarization, upload,
publication, legal review, or release acceptance is authorized.

Next gate: separate owner authorization for exactly one fresh native-Terminal
no-timestamp run, followed by independent retained-candidate review. No retry
or other external action is included in this acceptance.

### M7-F22-ARTIFACT-VALIDITY-EVIDENCE-COMPLETENESS-RULING — Lead ruling

Frontier: `M7-F22-ARTIFACT-VALIDITY-EVIDENCE-COMPLETENESS-RULING`.
Candidate: `57673b210000c2e20d2e1c64c718c59d61dadcec5bf94569edca60d80e2080d3`.
Audit: `c0d8cf98-6879-4286-8e32-8e256da6f755`.

Lead ruling: `ACCEPT` for the retained-success artifact technical result.
The F22 evidence enhancement is `NO_ACTION` for the current M7 signing
acceptance. The final-byte, signature, entitlement, digest, payload,
preservation, and validator evidence verifies the artifact technical result.

Evidence completeness remains `PARTIAL`. Preserve `M7F22-R1-001` as a bounded,
non-blocking gap: `preOuter.entrySetDigest` cannot be independently recomputed
from the retained evidence. No new signing run is needed for this finding.
This classification does not change the accepted F20/F21 authority or require
implementation work.

All three retained stages remain unchanged, preserved, and non-reusable. This
ruling does not claim full M7 acceptance, notarization, TCC, legal,
distribution, or release acceptance. No stage access, stage mutation or
deletion, cleanup, signing run, retry, Keychain/security access, launch,
notarization, upload, or publication occurred or is authorized.

Smallest next owner decision: separately choose whether to authorize the next
external gate. This ruling itself authorizes no owner run or other external
action.

### Current direct-DMG release route

The accepted distribution decision is now direct download of a macOS `.dmg`.
Historical no-timestamp signing records remain evidence for their bounded
technical claims only. They are not release candidates and do not close the
secure-timestamp gate.

Remaining release gates, in dependency order:

1. authorize and produce one fresh release candidate from the accepted source;
2. complete Developer ID signing with hardened runtime, required entitlements,
   and secure timestamp, then verify the exact signed bytes;
3. create and verify the final DMG;
4. notarize the exact distributed artifact, staple its ticket, and verify both;
5. complete license, notice, Corresponding Source, build/install material, and
   owner/legal clearance for direct binary distribution;
6. verify Gatekeeper, install, first launch, permissions, relaunch, update or
   replacement, and core UX from the exact DMG on a clean supported Mac; and
7. record final release acceptance, then obtain separate owner authorization
   for upload and publication.

The smallest next owner decision is whether to authorize one fresh
release-candidate preparation and Developer ID signing run with secure
timestamp. No such run is authorized by this plan update.

### PEER_DISPOSITION v1 — M7-F23-DIRECT-DMG-INSTALL-CONTRACT-RECOVERY

- Status: superseded by accepted correction `M7-F23-CORRECTION-R1`. This
  record does not claim full M7, Developer ID signing, notarization,
  publication, or release acceptance.
- Candidate identity: workspace HEAD
  `af5f1817191ba5fd634c750e9345de7d575ba704`; package-source snapshot
  `b24c9f4d4e9a28872bbcacb8591536743d55ecbc61903154a8d2c1d9203780e7`; 30
  snapshot files; accepted Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- Authority: accepted
  `docs/decisions/0002-direct-notarized-macos-dmg.md`, product recording and
  experience contracts, and the plain-data owner
  `scripts/lib/macos-package-contract.json`.
- Correction delta: Swift preflight diagnostics now include the actual bundle,
  resource label, and resource path. DMG construction and validation accept an
  explicit absolute `--output-dir`; DMG and sidecar writes are rejected when
  they would enter the source bundle. The focused test covers the exact
  app-plus-`Applications -> /Applications` layout, alternate launch guidance
  ordering, bundle containment, support-root state, recordings path, and
  output-path rejection. Existing dirty M7 work remains preserved.
- Verification: `npm run build:native` passed; `npm run typecheck` passed;
  `node --check` passed for the changed DMG, package, validator, and snapshot
  scripts; focused package/host/signature tests passed `83/83`; runtime path
  suites passed `40/40`; direct-DMG proof passed `11/11`; and `git diff --check`
  passed.
- Isolated DMG proof: a disposable copy of the preserved app was created under
  `/private/tmp/meetless-f23-dmg-layout.XXXXXX`; `hdiutil create` and
  `node scripts/validate-macos-dmg.mjs --output-dir=<disposable-root>` passed.
  DMG SHA-256 was
  `52ba5e3d61f09eb2f92ab3fb852cda0477df5d4827d14af1daa7f7b775a9c4cd`;
  layout SHA-256 was
  `1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`;
  source fingerprint was unchanged at
  `3c91a5aaff00850d1acfcd9584f8fd4eaa7fca38271c3ceef30a30f5afbd7f4e`.
  Disposable roots were removed.
- Limit: the preserved `release/macos/Meetless.app` has no
  `release/macos/composition-manifest.json`. The repository DMG wrapper was
  run with an isolated output directory and stopped before writing with this
  missing-manifest error. The retained app was not rebuilt or changed. The
  direct DMG proof validates layout and hdiutil integrity only; it does not
  replace package-manifest validation or any release gate.
- Enforcement: local validation is available and passed as listed; no optional
  hook was found; no checked-in CI invocation was found; branch protection is
  unverified. No external state was changed.
- Lead disposition: `CONTINUE` through the frozen correction set
  `M7F23-R1-001..004`. The next release gates remain separately owned.

### PLAN_RECONCILIATION v1 — M7-F23-CORRECTION-R1

plan_ref: `docs/plans/active/v1-paseo-foundation.md`
frontier: `M7-F23-CORRECTION-R1`
lead_ruling: `M7-F23-DIRECT-DMG-INSTALL-CONTRACT-REVIEW` — `REVISE_PLAN`
accepted_findings: `M7F23-R1-001`, `M7F23-R1-002`, `M7F23-R1-003`,
`M7F23-R1-004` (frozen)
correction_base: `b24c9f4d4e9a28872bbcacb8591536743d55ecbc61903154a8d2c1d9203780e7`
next_frontier: `M7-F23-CORRECTION-R1` then FAST closeout of the frozen findings
status: `ACCEPTED`; this is the technical direct-DMG foundation only. It is not
full M7 or release acceptance.

The correction keeps the existing dirty worktree and uses one explicit,
external disposable proof root. It does not change the retained
`release/macos` stage. The package-source candidate is now HEAD
`af5f1817191ba5fd634c750e9345de7d575ba704` with snapshot
`52a7ea41a74fb9e8a63eca83b81801dc0fede698e0f4f55ee4b68515b19a76da` and
Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

Correction evidence:

- R1-001: `attestMacOSDmgLayout` attaches the actual image read-only and
  non-browsing at an isolated mount point, enumerates real top-level entries,
  applies the exact layout validator, and detaches/removes the mount root in
  a finally path. The adversarial DMG fixture declares the expected layout but
  contains `Applications -> /Users/not-the-Applications-folder`; actual
  mounted attestation rejects it. The final actual image contained only
  `Applications -> /Applications` and `Meetless.app`.
- R1-002: output-root validation rejects a root symlink and any resolved
  existing root or ancestor that enters the source `Meetless.app`. The direct
  suite includes the symlinked-output fixture.
- R1-003: `--proof-root` is threaded through package assembly, manifest, app,
  DMG, sidecar, and validator. Local/ad-hoc package and DMG proof commands
  fail closed without it; the DMG wrapper uses `--build-package` and does not
  invoke the fixed release pre-script. The retained `release/macos` fingerprint
  was `8f88051fa4e10f01f0bfd253ada823207e32ca93787ab5ea28f4446c1e70876c`
  before and after proof. The disposable proof root was removed.
- R1-004: production launch now uses the native `MeetlessLaunchCoordinator`.
  Native fixtures cover mounted, alternate, symlinked, and canonical paths.
  Rejected paths produce exactly location plus guidance events and zero later
  identity, lock, capability, or runtime effects.

Changed correction files: `package.json`, `native/macos-host/MeetlessHost.swift`,
`native/macos-host/TranscriptionCapabilityTests.swift`,
`packages/runtime/test/direct-dmg-contract.test.ts`,
`scripts/lib/macos-dmg-contract.mjs`, `scripts/package-macos.mjs`,
`scripts/package-macos-dmg.mjs`, `scripts/validate-macos-dmg.mjs`, and
`scripts/validate-macos-package.mjs`.
Other existing M7 changes remain preserved.

Final isolated proof used root
`/private/tmp/meetless-f23-r1-final.WzDZyG`:

- `node scripts/package-macos.mjs --signing-mode=local-ad-hoc
  --proof-root=/private/tmp/meetless-f23-r1-final.WzDZyG` — passed; 13,775
  entries, 46 Mach-O entries; artifact digest
  `05c3f22e0557f305dc79f92b5cdc3d52527d862b8397de4e7573b9fe2f2c2348`.
- `node scripts/package-macos-dmg.mjs
  --proof-root=/private/tmp/meetless-f23-r1-final.WzDZyG` — passed; app
  fingerprint `f1162ecbba4ec96f297f5099376165c5f28d6157e25b9e1623e9c01e19ac0164`,
  DMG SHA-256
  `b564b8b862cfdb64a9d8dd646a1a62d6a1dcb621f4473e5ac509a18a8e989cea`,
  layout SHA-256
  `1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`.
- `node scripts/validate-macos-dmg.mjs
  --proof-root=/private/tmp/meetless-f23-r1-final.WzDZyG` — passed actual
  mounted-layout attestation and `hdiutil verify`; local-only true and
  release acceptance not claimed. Manifest SHA-256 is
  `a11a395c5868be621b262af05a057cb47afac64be50a129b2ceacfbad4f31ad7`;
  sidecar SHA-256 is
  `5b05b09c58d7fc3594c9ea149d25a0fe0ec321b6639135dc32528a9473e56238`.
- `npm run build:native`, `npm run typecheck`, focused Vitest (`6 files / 114
  tests`), Node syntax/JSON checks, and `git diff --check` passed. Two
  candidate-snapshot runs matched exactly at the snapshot above.
- Expected fail-closed checks passed: local-ad-hoc package without
  `--proof-root`, DMG package without `--proof-root`, and DMG validation
  without `--proof-root` all refused to touch or validate `release/macos`.

During correction, one native compile required explicit `self` captures and
one DMG build exposed a staging-layout scope error; both were fixed before the
final proof. A standalone direct-file TypeScript check was not a valid project
check and exposed existing project-context typing noise; repository-native
`npm run typecheck` passed. No app launch, signing, secure timestamp,
notarization, Keychain/security operation, TCC reset, upload, publication,
promotion, retained-stage mutation, full-M7 claim, or release acceptance was
made.

### LEAD_RULING v1 — M7-F23-CORRECTION-R1

- Decision: `ACCEPT` for package-source snapshot
  `52a7ea41a74fb9e8a63eca83b81801dc0fede698e0f4f55ee4b68515b19a76da`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, and Paseo commit
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.
- Independent closeout: `CLOSEOUT_CLEAR` from reviewer
  `01b341c4-8d81-4736-a29f-fc643d3556f5` in `FAST`/`CLOSEOUT` mode for frozen
  findings `M7F23-R1-001..004`, correction base
  `b24c9f4d4e9a28872bbcacb8591536743d55ecbc61903154a8d2c1d9203780e7`.
- Lead verification: candidate identity matched; retained `release/macos`
  fingerprint remained
  `8f88051fa4e10f01f0bfd253ada823207e32ca93787ab5ea28f4446c1e70876c`;
  `npm run build:native` passed; the direct-DMG suite passed `16/16`; Node
  syntax checks and `git diff --check` passed.
- Accepted boundary: exact `/Applications/Meetless.app` runtime location;
  mounted, symlinked, and alternate paths show guidance and stop before
  identity, lock, capability, or runtime effects; immutable resources remain
  bundle-relative; writable state remains under
  `~/Library/Application Support/Meetless`; recordings remain under
  `~/Documents/meetings`; actual mounted DMG layout and disposable-root
  isolation are mechanically checked.
- Enforcement: repository-local validation passed. No optional hook or
  checked-in CI invocation was found. Branch protection remains unverified.
- Limits: no app launch, Developer ID signing, secure timestamp, notarization,
  Gatekeeper/TCC validation, upload, publication, promotion, retained-stage
  mutation, full-M7 acceptance, or release acceptance occurred.

## Decisions

- 2026-08-24: The owner authorized the documentation reorganization.
  `docs/product/` now owns all accepted consumer behavior and UX. `design/` is
  only the visual implementation contract and evidence package. Exact duplicate
  product and prototype copies were removed, and completed M0–M6/new-design
  history was separated from this active M7 plan without removing evidence.
- 2026-08-24: Post-MVP cross-meeting Q&A and document-folder indexing remain
  outside M7.
- 2026-08-26: The owner selected direct macOS distribution as a downloadable
  `.dmg`. The intended release path is Developer ID signing with hardened
  runtime, required entitlements, and secure timestamp; notarization; stapling;
  and clean-machine Gatekeeper and first-run UX verification of the exact DMG.
  Mac App Store sandboxing, App Store Connect submission, and App Review are
  out of scope. No build, signing, timestamp, notarization, upload,
  publication, retained-stage mutation, or release acceptance occurred in
  recording this decision.

## Validation

Record exact candidate identities, commands, manifests, target versions,
observed failures, cleanup, and owner decisions here as M7 proceeds. Completion
requires executable or observable evidence; this plan is not proof by itself.

### PLAN_RECONCILIATION v1 — M7-F23 direct-DMG install contract

plan_ref: `docs/plans/active/v1-paseo-foundation.md`
frontier: `M7-F23-DIRECT-DMG-INSTALL-CONTRACT`
authority: owner directive, ADR 0002, and the accepted M7 package/signing
foundations
parallel_frontier: `SERIAL`
dependency_changes: none; this foundation consumes the accepted package and
signing boundaries and does not change the bundle ID, TCC owner, or entitlement
map

The historical `~/Applications` premise is stale for this route. The exact
supported production location is `/Applications/Meetless.app`. A mounted
`/Volumes/...` app and every alternate path stops before lock, socket, runtime,
child, or identity state and gives drag-to-Applications guidance.

The old builder-home, source-checkout, and `/private/tmp` packaged-runtime
premise is stale. Immutable resources are bundle-relative. Writable runtime,
store, logs, sockets, staging, Electron user data, and host identity are under
`~/Library/Application Support/Meetless`; final recording exports remain
`~/Documents/meetings`.

Native host ownership is explicit: after exact-path and packaged-resource
attestation, the host publishes first-run identity under Application Support
before child startup. An update may refresh identity only when exact path,
`com.meetless.app`, and the stable designated requirement remain unchanged;
other drift fails closed. The owner-deferred unclassified runtime-error item
remains open and is not classified or closed by M7-F23.

The outer DMG contract is exactly `Meetless.app` plus an `Applications` symlink
to `/Applications`. DMG construction uses disposable staging and must not
mutate or re-sign the app. Local ad-hoc output is non-release evidence.

#### M7-F23 observed proof

The first `npm run package:macos:dmg` attempt stopped at the package-input
validator because the validator reconstructed the content-addressed Paseo
bundle as the whole bundle directory. The in-scope input-boundary fix reuses
the exact source path recorded in the manifest. The rerun completed the local
ad-hoc package and DMG commands. A final direct package regeneration bound the
manifest to the deterministic snapshot after the build outputs settled, then
`node scripts/package-macos-dmg.mjs` rebuilt the final outer artifact.

Final generated paths:

- `release/macos/Meetless.app`
- `release/macos/composition-manifest.json`
- `release/macos/Meetless.dmg`
- `release/macos/Meetless.dmg.json`

Final identities:

- candidate snapshot: `b24c9f4d4e9a28872bbcacb8591536743d55ecbc61903154a8d2c1d9203780e7`
- candidate HEAD: `af5f1817191ba5fd634c750e9345de7d575ba704`
- composition artifact digest: `1cd290f0c85391941639a014eea8394dcb8530c751b68e48ee35ce9168ca1de4`
- app fingerprint: `3b178cf12e7337275202d8b0f9c984812ac34c11f5ad758b583c27b48ff1d0c6`
- DMG SHA-256: `b86fcd1ff54e1f5835a13a65912fed25033d4637364162e66a2e1a9af4455625`
- DMG sidecar SHA-256: `1b29be9906cca5b8ead0580c74efa96828fcc339eed197b66498f8f7200bbeb6`
- composition manifest SHA-256: `3902cbfb4757692c08dabeb2dc8409c2d0e4d870aff94bdc0c762f307fad3910`
- layout SHA-256: `1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`

The sidecar records equal source app fingerprints before and after DMG
construction. It records `localOnly: true` and `releaseAcceptance:
not-claimed`. The DMG validator ran `hdiutil verify`; no DMG attach or app
launch was used.

Commands and results:

- `npm run package:macos:dmg` — local ad-hoc build and structural DMG command
  completed after the input-boundary fix; the package build also passed native,
  Paseo, Meetless, and app build stages.
- `node scripts/package-macos.mjs --signing-mode=local-ad-hoc` — final app
  composition passed with 13,775 entries, 46 Mach-O entries, and the artifact
  digest above.
- `node scripts/package-macos-dmg.mjs` — final DMG passed exact layout and
  source mutation checks.
- `node scripts/validate-macos-package.mjs --signing-mode=local-ad-hoc` —
  passed against the exact generated app.
- `npm run validate:macos:dmg` — passed against the exact generated DMG and
  sidecar.
- `npx vitest run --config vitest.config.ts packages/runtime/test/direct-dmg-contract.test.ts packages/runtime/test/isolation.test.ts packages/runtime/test/host.test.ts packages/runtime/test/media-closure.test.ts --maxWorkers=1` — 4 files, 36 tests passed.
- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-package.test.ts packages/runtime/test/macos-package-signature.test.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1` — 3 files, 133 tests passed.
- `npm run typecheck` — passed.
- `node --check` for all changed M7-F23 `.mjs` files and `git diff --check` —
  passed.
- Two `node scripts/candidate-snapshot.mjs --mode=package-source` runs matched
  exactly at the candidate snapshot above.

Enforcement is repository-local at contract helpers, native preflight,
positive/negative tests, package validation, DMG validation, and actionable
diagnostics. No F23 hook or checked-in CI invocation was found. Local branch
configuration points `main` to `origin`; remote branch-protection state was not
queried or changed.

No retained signed stage was inspected or changed. No Developer ID signing,
secure timestamp, notarization, upload, publication, promotion, app launch,
TCC reset, or TCC automation occurred. This local candidate is not release
acceptance. `plan_updated: yes`.

### PLAN_RECONCILIATION v1 — M7-F24 secure-timestamp foundation

plan_ref: `docs/plans/active/v1-paseo-foundation.md`
frontier: `M7-F24-SECURE-TIMESTAMP-FOUNDATION`
status: `FOUNDATION_READY`
authority: owner directive, ADR 0002, accepted F20/F21 lifecycle, and accepted
M7-F23 package-source snapshot `52a7ea41a74fb9e8a63eca83b81801dc0fede698e0f4f55ee4b68515b19a76da`

The final deterministic package-source snapshot is
`e52984271a575fefa4e372f49559a6f65d8f67ed78eb2fcb2ef452bcc869e2c5` at HEAD
`af5f1817191ba5fd634c750e9345de7d575ba704`. It records Paseo commit
`c81cb84735043c281a5a2d23d456d3708ce5d94e`. The fresh local baseline records
the accepted F23 snapshot as `sourceAncestorSnapshotDigest`, rather than
reusing the old F23 artifact or manifest digests.

#### M7-F24 prepared proof

The fresh credential-free package root is
`/private/tmp/meetless-f24-final-package-proof.U7Duji`.

The local package command passed with 13,775 entries and 46 Mach-O entries.
The local signature state recorded `timestamp: none` for all 47 code objects,
zero secure timestamps, and no release identity. The prepared baseline is:

- package input digest: `55f24bf6f9369e944a1f331fdd12203188f51bee00fb6d8b23e8dc69186b2a76`
- artifact input digest: `e28b3579bd1f931c8200499eec35a69707184dfabe1940df05e5e2a97c600956`
- local artifact digest: `5baede98fc145c22825b15f49e822f52079dcc51be6cb8b302e81fa90a6c6d18`
- local signature-state digest: `5559e4e3190797a818d2d253212928d204c33f2bf5d6003e54e8f389a30e1e5c`
- manifest SHA-256: `f972bc56800104fca8e918a9df19ffec544544be774a4aa1cc3c6375a31e0af3`
- closure: 46 nested Mach-O, 10 CodeResources, 47 code objects

The one fresh retained owner stage is:

`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-BAtOoJ`

Its marker is `.meetless-artifact-stage.json`. Its only lifecycle owner is
`.meetless-artifact-resign-status.json`, with state `prepared`, attempt `0`,
and no terminal outcome. Source and staged app fingerprints are both
`6ffb2d0ba6907f4be70d9175230b360fab12bbde3745a8b87391c66cb2f0d2f2`.
Preparation did not consume attempt 1.

The exact future native-Terminal owner command is:

`npm run resign:macos:artifact -- --stage-root=/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-BAtOoJ --signing-identity=D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561 --team-id=63M98WD275`

This command was not run. Release mode now requires the owner Team,
certificate SHA-1, hardened runtime, exact per-executable entitlement map,
`--timestamp`, and secure non-empty timestamp evidence on every final code
object. Local mode requires `--timestamp=none` and does not resolve an
identity or inspect the Keychain.

#### DMG proof and boundaries

The local DMG package and validator both passed from the final external
package root. The DMG SHA-256 is
`f4b765f6bb82d98fe54da9b892bfd80cc1c7c5cd4671f4aa68e18cbf39234f47`; the
layout digest is
`1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`. The
mounted layout is exactly `Meetless.app` plus `Applications -> /Applications`.
The sidecar binds the app, manifest, artifact, signature state, DMG, and
layout identities. Retained-release DMG mode requires the future
`retained-success` stage and an explicit external sibling output; it was not
run because the owner attempt is prohibited in this foundation pass.

#### M7-F24 verification

- focused F24 tests: 3 files, 122 tests passed
- `npm run typecheck`: passed
- `node --check` for all eight changed M7-F24 `.mjs` files: passed
- `git diff --check`: passed
- two final `node scripts/candidate-snapshot.mjs --mode=package-source` runs:
  exact digest and HEAD match
- release root before/after fingerprint:
  `8f88051fa4e10f01f0bfd253ada823207e32ca93787ab5ea28f4446c1e70876c`
- release app before/after fingerprint:
  `3b178cf12e7337275202d8b0f9c984812ac34c11f5ad758b583c27b48ff1d0c6`
- runtime data before/after fingerprint:
  `972b906c260641320d8eab42c4974eb98f4dffd3c0ce6a38035f6e06c61b712b`

Earlier failed external proof roots were preserved. No repository release bytes,
prior retained stage, Keychain, Developer ID signing, secure timestamp,
notarization, install, launch, TCC, upload, publication, promotion, or
retained-stage/evidence cleanup was performed. Normal disposable mount and
build-staging cleanup occurred. The deferred unclassified runtime error remains
open and separate.

`plan_updated: yes`.

### PLAN_RECONCILIATION v1 — M7-F26-FRESH-RELEASE-CANDIDATE

frontier_id: `M7-F26-FRESH-RELEASE-CANDIDATE`
plan_ref: `docs/plans/active/v1-paseo-foundation.md`
lead_ruling: `REVISE_PLAN then CONTINUE`

The prior expected package-source digest `95806cb9252356cd34fe818bbeb8830e9a121a45fa74f8f439a1b8876bfc8469` was the accepted dirty-workspace representation based on HEAD `118089d546731ff9b1160a90b4189b16f2903a3b`. Exact reconstruction from that HEAD plus the four accepted F25 files — `scripts/validate-macos-package.mjs`, `scripts/resign-macos-artifact.mjs`, `scripts/lib/macos-artifact-resign.mjs`, and `packages/runtime/test/macos-artifact-resign.test.ts` — and their committed `1fe7bff` bytes reproduced that digest. Commit `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf` contains those bytes and the plan record. Two clean current snapshot runs reproduced the revised digest `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`.

Reopen decision: accept `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d` as the clean committed package-source digest at HEAD `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`. The digest change is representation reconciliation, not source drift. The current snapshot had no published evidence files. Paseo expected and gitlink commit remained `c81cb84735043c281a5a2d23d456d3708ce5d94e`; its bundle was `vendor/paseo-bundles/0cd59fbf0a2437c943c6fa10a63567260c8ab665bcefa975c50d593b705016b3.bundle`, 78,982,401 bytes, SHA-256 `0cd59fbf0a2437c943c6fa10a63567260c8ab665bcefa975c50d593b705016b3`.

### PEER_CANDIDATE v1 — M7-F26-FRESH-RELEASE-CANDIDATE

frontier_id: `M7-F26-FRESH-RELEASE-CANDIDATE`
status: `CANDIDATE`
candidate_required: `deterministic-snapshot`

Repository gate: start state was clean and synchronized at HEAD `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`; `origin/main` matched and divergence was `0 0`. The accepted clean package-source snapshot was verified immediately before packaging with `node scripts/candidate-snapshot.mjs --mode=package-source`.

External proof root: `/private/tmp/meetless-m7-f26-proof.bD2Zkr`.

Final package command:

    npm_config_include=optional node scripts/package-macos.mjs --signing-mode=local-ad-hoc --proof-root=/private/tmp/meetless-m7-f26-proof.bD2Zkr

The final package was produced at `/private/tmp/meetless-m7-f26-proof.bD2Zkr/release/macos/Meetless.app` with manifest `/private/tmp/meetless-m7-f26-proof.bD2Zkr/release/macos/composition-manifest.json`. Package result: artifact digest `4669f897ac2a36b01022df2a2b3512c95edac4da215a775ee5db43b5d242a543`; package-input digest `988e64287cdafd85d762c1b76714e70d5fd081d15f0ce75b9b4aaad3187a423c`; artifact-input digest `cf8a4e7bdcec5fdede7ac2dd742d61130954d46c1cd29e6d4d40f2c83abb207d`; signature-state digest `ee7fa253119f78a144e3663403967b1f8c9cb57483653eac04620b8cf85128b0`; manifest SHA-256 `6b69b384ce13ef77e02932fc81b8f50e4eefb3b67e9cf4aede0dc80a7c6ddf24`; entries `13,795`; Mach-O files `46`; CodeResources files `10`; code objects `47`; signing mode `local-ad-hoc`; local-only `true`; release acceptance `not-claimed`; notarization `not-run`.

The first package assembly in this same proof root failed because npm did not reify the required optional Darwin package `@anthropic-ai/claude-agent-sdk-darwin-arm64`. No candidate was accepted from that partial result. The successful rerun used the standard npm resolver setting `npm_config_include=optional`; the package validator then passed. No second proof root was created.

Package validation command:

    node scripts/validate-macos-package.mjs --signing-mode=local-ad-hoc /private/tmp/meetless-m7-f26-proof.bD2Zkr/release/macos/composition-manifest.json

Validation passed and bound candidate snapshot digest `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`, Paseo commit `c81cb84735043c281a5a2d23d456d3708ce5d94e`, and the package and artifact digests above.

Exactly one new owner stage was prepared from that external package:

    `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60`

Preparation command:

    node scripts/resign-macos-artifact.mjs --prepare --source-root=/private/tmp/meetless-m7-f26-proof.bD2Zkr/release/macos

Stage paths: bundle `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60/Meetless.app`; manifest `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60/composition-manifest.json`; marker `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60/.meetless-artifact-stage.json`; status `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60/.meetless-artifact-resign-status.json`.

Stage evidence: source package fingerprint and staged app fingerprint both `0abfc011c6f436b2ca88e132f575a188e23b2c453ed0c7692e70ee601a8f1f60`; source and staged manifest SHA-256 both `6b69b384ce13ef77e02932fc81b8f50e4eefb3b67e9cf4aede0dc80a7c6ddf24`; marker SHA-256 `bc422810d41a40b42287377c3c910a3d767423f0e47a0e047de25dc3225574b9`; status SHA-256 `501482b9bb680236c159660dcba6b1ca222577516b28fccbd4c34e6808bd845d`. The root contained only `Meetless.app`, `composition-manifest.json`, `.meetless-artifact-stage.json`, and `.meetless-artifact-resign-status.json`.

The marker baseline recorded source ancestor snapshot `52a7ea41a74fb9e8a63eca83b81801dc0fede698e0f4f55ee4b68515b19a76da`, source snapshot `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`, source HEAD `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`, Paseo `c81cb84735043c281a5a2d23d456d3708ce5d94e`, artifact digest `4669f897ac2a36b01022df2a2b3512c95edac4da215a775ee5db43b5d242a543`, `46` Mach-O files, `10` CodeResources files, and `47` code objects.

The independent `validateArtifactStageRoot` check passed. Status schema `MEETLESS_MACOS_ARTIFACT_RESIGN_STATUS v1` was `state: prepared`, `attempt: 0`, `outcome: null`, `inDoubt: false`, and `terminal: null`. Marker schema was `MEETLESS_MACOS_ARTIFACT_STAGE v1`. The generated owner command was printed exactly and was not executed:

    npm run resign:macos:artifact -- --stage-root=/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60 --signing-identity=D3CA2AEA2DCBF578D27CFC3557BFFCB41E370561 --team-id=63M98WD275

Verification and limits: no old retained stage was accessed. No `release/macos` mutation occurred. No Keychain, `security`, private key, Developer ID signing, timestamp service, notarization, DMG build, install, launch, TCC, upload, or publication action occurred. The package and stage roots are preserved. One interrupted diagnostic `npm install` was mistakenly started at the repository root; it exited with code `130` before output, and tracked repository status remained clean. The final package command required `npm_config_include=optional` in this npm `10.9.8` environment; this is a toolchain reproducibility risk and no repository policy or code was changed to hide it. The prepared stage is retained for the single Human native-Terminal owner attempt; do not rerun preparation or execute any alternate command.

Final repository proof: `git diff --check` passed; only this active plan file is modified. No commit was created.

`plan_updated: yes`.

### LEAD_RULING v1 — M7-F26-FRESH-RELEASE-CANDIDATE

frontier_id: `M7-F26-FRESH-RELEASE-CANDIDATE`
decision: `ACCEPT`
candidate: HEAD `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`; clean
package-source snapshot
`4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`;
artifact digest
`4669f897ac2a36b01022df2a2b3512c95edac4da215a775ee5db43b5d242a543`;
owner stage
`/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60`.

The package manifest SHA-256 is
`6b69b384ce13ef77e02932fc81b8f50e4eefb3b67e9cf4aede0dc80a7c6ddf24`.
The stage marker SHA-256 is
`bc422810d41a40b42287377c3c910a3d767423f0e47a0e047de25dc3225574b9`.
The stage status SHA-256 is
`501482b9bb680236c159660dcba6b1ca222577516b28fccbd4c34e6808bd845d`.
The status is exactly `prepared`, attempt `0`, with no outcome or terminal
evidence. The source and staged app fingerprint is
`0abfc011c6f436b2ca88e132f575a188e23b2c453ed0c7692e70ee601a8f1f60`.

Independent review `9a8a58f6-d94e-4392-b1c3-ad4275d884f9` returned `PASS`
in `DEEP`/`EXPLORATORY` mode for the exact-artifact pre-owner boundary. Its
six checks covered source identity, manifest and stage equality, private
attempt-0 lifecycle state, exact F5 policy, clean recovery from the earlier
partial package run, and safety of the exact Human command. The status hash
in the review disposition footer contained a transcription error; the review
narrative, original candidate, and direct artifact hash all match the value
recorded above.

Lead inspection passed: the plan is the only repository change;
`git diff --check` passed; direct stage validation passed; marker, status, and
manifest hashes matched; and the actual stage binds 13,795 entries, 46 Mach-O
files, 10 CodeResources files, and 47 code objects. The package and stage are
accepted only as the fresh pre-owner release candidate. They do not establish
Developer ID signing, secure timestamping, DMG, notarization, legal,
Gatekeeper/TCC, publication, or V1 release acceptance.

The only next mutation is the exact one-shot Human command already recorded
for this stage. It must run directly in a native local Terminal. Do not rerun
preparation or use an alternate command. If it fails or is interrupted, retain
the stage and report the complete result; do not retry it.

next_frontier: `M7-F27-EXACT-RETAINED-SUCCESS-VALIDATION`, conditional on the
Human command producing `retained-success`.

`plan_updated: yes`.

### M7-F25 R1-001 exported generic-writer closure

frontier: `M7-F25-R1-001-EXPORTED-GENERIC-WRITER-CLOSURE`
authority: owner-approved bounded correction
correction base: package-source
`8cf15fedc5cdeb615f15efd0dccae0eff6cae7d22fe4fea84481cc10968ebd2f`
status: `PEER_CANDIDATE`

The generic atomic JSON primitive is now private to the owner lifecycle module.
It is absent from the lifecycle export surface. The module exposes only two
narrow write operations: artifact metadata writes reject the fixed owner status
target, and owner failure-status writes validate and accept only retained
preparation-failure, failure, or interruption documents. Shared evidence,
status, and transition helpers continue to reject success.

`commitRetainedMacOSPackageSuccess` uses a validator-module-private atomic
status writer. That writer requires the exact owner parent binding and current
consumed identity, rechecks retained artifact evidence before commit, applies
the signal decision immediately before synchronous rename, and is not exported.
The end-to-end operation remains the only retained-success commit path and still
re-reads and verifies the exact committed result before return.

Export accounting:

- lifecycle generic writer export: absent;
- lifecycle write exports: `writeArtifactMetadataAtomically` and
  `writeOwnerFailureStatusAtomically` only;
- direct lifecycle exports that invoke the private atomic primitive:
  `createOwnerStage`, `transitionOwnerStatus`,
  `writeArtifactMetadataAtomically`, and
  `writeOwnerFailureStatusAtomically`; each fixes or validates non-success data;
- validator success-commit export: `commitRetainedMacOSPackageSuccess` only;
- private success builder, status builder, transition, and atomic writer:
  absent from the validator export surface.

Focused proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 72 tests.
- Structural proof checks the complete relevant export surfaces, the four direct
  private-writer callers, and the private end-to-end success composition.
- Negative proof shows that schema-valid retained-success data is rejected by
  the metadata writer, failure writer, evidence builder, status builder, and
  transition helper without changing consumed status bytes.
- Existing positive proof covers non-status atomic replacement and interruption
  behavior, marker and manifest writes, failure/interruption lifecycle behavior,
  external retained-success restriction, result and identity binding, fixed
  owner tools, canonical F5 authority, and success commit ordering.
- Syntax checks passed for `scripts/resign-macos-artifact.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `scripts/lib/macos-artifact-resign.mjs`.
- `npm run typecheck` passed.
- `git diff --check` passed.
- Two deterministic package-source snapshots matched: digest
  `735a9adbddfb50269b19dc1046a916b1097364d366feb58fa336875bc4fa0592`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

No broad validation ran. No retained stage was accessed or changed. No
operational stage was created. No signing, Keychain, timestamp network,
installation, launch, TCC, notarization, upload, publication, promotion,
cleanup, retry, or deferred runtime-error action occurred. Focused tests used
only isolated synthetic fixtures. This record does not claim signing, release,
or owner acceptance.

`plan_updated: yes`.

### M7-F25 R1-001 exported success-helper closure

frontier: `M7-F25-R1-001-EXPORTED-SUCCESS-HELPER-CLOSURE`
authority: owner-approved additional bounded correction
correction base: package-source
`6227c4a43e4832c0a584ac39dc7161fe867d694713b4cdd6821de14520c22399`
status: `PEER_CANDIDATE`

The shared lifecycle API now rejects success creation and commit. The exported
terminal-evidence builder rejects outcome `success`. The exported status builder
rejects retained-success state, success outcome, and terminal success evidence.
The exported transition helper rejects retained-success state, success outcome,
and terminal success evidence before it reads or writes the status file.

`commitRetainedMacOSPackageSuccess` remains the sole success operation. Its
success evidence builder, success status builder, and consumed-to-success
transition are private to the package validator module. That operation still
owns full retained artifact, signature, timestamp, F5, and owner-tool
validation; exact consumed identity; atomic commit; committed status re-read;
and final exact-result verification. Shared failure and interruption creation
and transition remain available and valid. Public retained validation continues
to require exact retained-success.

Focused proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 72 tests.
- Negative proof supplies schema-valid success evidence. The exported evidence,
  status, and transition helpers all reject it. The consumed status bytes remain
  unchanged after the rejected transition.
- Structural proof verifies that the private success builders and transition are
  absent from the module export surface. It also verifies that the end-to-end
  operation owns full validation, private success commit, committed re-read,
  exact result verification, and return ordering.
- Existing focused tests pass for failure, interruption, external
  retained-success restriction, status replacement, result drift, signal commit
  timing, fixed owner tools, and private canonical F5 validation.
- Syntax checks passed for `scripts/resign-macos-artifact.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `scripts/lib/macos-artifact-resign.mjs`.
- `npm run typecheck` passed.
- `git diff --check` passed.
- Two deterministic package-source snapshots matched: digest
  `8cf15fedc5cdeb615f15efd0dccae0eff6cae7d22fe4fea84481cc10968ebd2f`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

No broad validation ran. No retained stage was accessed or changed. No stage was
created or prepared outside isolated test fixtures. No signing, Keychain,
timestamp network, installation, launch, TCC, notarization, upload, publication,
promotion, cleanup, retry, or deferred runtime-error action occurred. This
record does not claim signing, release, or owner acceptance.

`plan_updated: yes`.

### M7-F25 R1-001 strict end-to-end correction

frontier: `M7-F25-R1-001-STRICT-END-TO-END`
authority: owner strict contract option 1
correction base: package-source
`7cec316a14f0addd4e59f835792cb88856d6e658f9b148436d5af8718b7f3c6c`
status: `PEER_CANDIDATE`

The exported pre-success artifact-evidence capability was removed. The retained
signing-policy evidence helper is also private. One exported operation now owns
the complete success boundary: exact consumed state and identity, full retained
artifact/signature/timestamp validation, exact validator-result binding, atomic
retained-success commit, committed-status re-read, and exact retained-success
verification. It returns validation output only after the committed status has
passed that final verification.

The production re-sign command calls this operation with the canonical
repository root, captured consumed status identity, owner signal controller, and
candidate result. It emits retained-validation-complete and terminal success
only after the operation returns. The remaining terminal helper accepts only
failure or interruption. Generic retained validation still requires exact
retained-success. Existing fixed owner tools, status race, external result, and
canonical F5 closures remain in force.

Focused proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 71 tests.
- Structural proof inspects the real module graph and export surface. It permits
  only the end-to-end operation to call the private pre-success validation core.
  It proves consumed identity input, full validation before transition, atomic
  transition before committed status re-read, exact success verification before
  return, and production success events after return.
- Negative operation proof covers missing status, prepared status, and replaced
  consumed status before artifact validation. Existing focused proof covers
  result-field drift, forbidden external lifecycle states, fixed owner tools,
  canonical F5 authority, and both sides of the signal commit boundary.
- Syntax checks passed for `scripts/resign-macos-artifact.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `scripts/lib/macos-artifact-resign.mjs`.
- `npm run typecheck` passed.
- `git diff --check` passed.
- Two deterministic package-source snapshots matched: digest
  `6227c4a43e4832c0a584ac39dc7161fe867d694713b4cdd6821de14520c22399`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

No broad validation ran. No retained stage was accessed or changed. No stage was
prepared. No signing, Keychain, timestamp network, installation, launch, TCC,
notarization, upload, publication, promotion, retained-evidence cleanup, or
deferred runtime-error action occurred. This record does not claim signing,
release, or owner acceptance.

`plan_updated: yes`.

### M7-F25 R1 reconciliation correction

frontier: `M7-F25-RETAINED-VALIDATION-CORRECTION-R1`
reconciliation evidence: `M7F25-CLOSEOUT-9ea50222`
correction base: package-source
`9ea502223899cc58e20b5c046e5e6606dd3c01e9340ad0bfde5b657a4608fd72`
status: `PEER_CANDIDATE`

The bounded reconciliation closes `M7F25-R1-001` and `M7F25-R1-003`.
Closures `M7F25-R1-002`, `M7F25-R1-004`, and `M7F25-R1-005` remain
unchanged.

- The retained-evidence-only symbol and its exported wrapper were removed.
  The production command exports only `run`. Its private composition checks the
  exact consumed status and identity around a lifecycle-neutral artifact
  evidence check. Generic retained validation still requires retained-success.
- A success request now requires the exact expected consumed status identity.
  Missing, unreadable, or replaced status fails before terminal success.
- Retained-success linearizes at the synchronous atomic rename of the owner
  status file. The signal decision occurs immediately before that rename in the
  same event-loop turn. A signal handled before the check prevents the rename.
  A signal handled after the rename is post-commit.
- The caller validates the returned terminal state, outcome, and exact artifact
  result before it emits `terminal-retained-success` or returns the candidate.
- Existing status identity, manifest/artifact result, fixed owner tool, canonical
  F5, and structural-production-wiring checks remain enforced.

Focused credential-free proof:

- `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 71 tests.
- Syntax checks passed for `scripts/resign-macos-artifact.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `scripts/lib/macos-artifact-resign.mjs`.
- `npm run typecheck` passed.
- `git diff --check` passed.
- Two deterministic package-source snapshots matched: digest
  `7cec316a14f0addd4e59f835792cb88856d6e658f9b148436d5af8718b7f3c6c`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

No broader suite was run. No retained stage was accessed or changed. No stage
was prepared. No signing, Keychain, timestamp network, launch, installation,
notarization, upload, publication, promotion, or deferred runtime-error action
occurred. This record does not claim signing, release, or owner acceptance.

`plan_updated: yes`.

### M7-F25 retained-validation correction R1 candidate

frontier: `M7-F25-RETAINED-VALIDATION-CORRECTION-R1`
correction_base: package-source
`51020294a74eae93f929ccd6108c62d1b1cb4f41997e72b00d55526bac8a3407`
status: `PEER_CANDIDATE`
accepted_findings: `M7F25-R1-001..005`

The correction uses one private production composition and the existing owner
lifecycle. It does not add a lifecycle or compatibility path.

- `M7F25-R1-001`: removed exported internal lifecycle constants, assertions,
  and the consumed-attempt validator. The production `runPreparedStage` function
  now owns the private exact-consumed assertion. Generic validator options and
  public exports cannot select the consumed lifecycle.
- `M7F25-R1-002`: every retained artifact validation forces owner mode. Tool
  execution uses fixed `/usr/bin` owner paths and the sanitized owner environment
  even when a caller omits or disables `ownerMode`.
- `M7F25-R1-003`: status identity capture uses one no-follow file handle, stable
  before/after file facts, exact path inode, and byte digest. Retained validation
  returns that identity to terminal transition. Before success rename, the
  manifest identity, status identity, and complete artifact entry hashes are
  rechecked under the one stage capability. Requested success is also compared
  with the exact validator result.
- `M7F25-R1-004`: external retained validation first requires exact
  `retained-success`, attempt `1`, `inDoubt=false`, outcome `success`, and terminal
  evidence. It then compares every terminal result field with the current
  manifest and artifact result. Stale state or any changed digest/count fails.
- `M7F25-R1-005`: retained validation loads the checked-in F5 map and both plists
  from the canonical repository with fixed owner `plutil`. It compares map,
  canonical map, plist, source, key, and executable bindings exactly with the
  embedded signing evidence.

#### M7-F25 R1 proof

- Focused credential-free test:
  `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 69 tests.
- Structural composition proof parses the real production entrypoint. It proves
  consumed transition precedes status capture, status capture precedes retained
  validation, canonical repository root is passed, and terminalization receives
  the validated status identity and artifact binding. It also proves no exported
  consumed/internal lifecycle selector exists and retained mode forces owner
  tools.
- Positive proof covers exact retained-success result, canonical F5 authority,
  fixed owner tool lookup with an unusable ambient `PATH`, and matching status
  identity.
- Negative proof covers prepared, preflight, consumed, preparation-failure,
  failure, and interrupted external states; status inode replacement; every
  terminal result digest/count; embedded F5 drift; wrong repository root; and
  caller lifecycle collaborator replacement.
- `npm run typecheck`: passed.
- Syntax checks passed for `scripts/resign-macos-artifact.mjs`,
  `scripts/validate-macos-package.mjs`, and
  `scripts/lib/macos-artifact-resign.mjs`.
- `git diff --check`: passed.
- Two deterministic package-source snapshots matched: digest
  `9ea502223899cc58e20b5c046e5e6606dd3c01e9340ad0bfde5b657a4608fd72`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

A broader credential-free three-file macOS test run observed 124 passes and 13
failures. All 13 failures originate in the pre-existing
`macos-package.test.ts` local ad-hoc fixture because it lacks the F24-required
`timestamp: none` evidence. That fixture is outside this correction write scope.
The focused correction test and typecheck pass.

Local enforcement is the focused Vitest file and package validator. No project
hook or checked-in CI invocation was found for this focused guard. Branch
protection remains unverified.

No retained stage was accessed or changed. No stage was prepared. No Keychain,
signing, timestamp network, launch, installation, notarization, upload,
publication, promotion, or deferred runtime-error action occurred. This record
does not claim signing, release, or owner acceptance.

`plan_updated: yes`.

### M7-F25 retained-validation correction candidate

frontier: `M7-F25-RETAINED-VALIDATION-CORRECTION`
status: `PEER_CANDIDATE`
authority: owner correction directive and the accepted F24 owner lifecycle and
retained-promotion rules in this plan

The production re-sign command now passes the canonical repository root to one
dedicated internal retained validator. That internal contract accepts only
`consumed`, attempt `1`, `inDoubt=true`, with no outcome or terminal evidence.
The normal retained-artifact validator remains the external contract. It accepts
only `retained-success`, attempt `1`, `inDoubt=false`, outcome `success`, with
terminal evidence. The internal contract is module-private to the dedicated
production entry point. Normal validator options cannot select it.

Missing or wrong repository authority fails before retained artifact inspection.
Prepared, preflight, retained failure, retained interruption, and the wrong side
of the consumed/success boundary fail with an authority and next-action
diagnostic. The existing production catch path remains the only terminal owner:
validation failure during a consumed attempt becomes `retained-failure`, an
observed interruption becomes `retained-interrupted`, and success is written
only after retained validation completes and lifecycle order passes.

#### M7-F25 proof

- Focused credential-free test:
  `npx vitest run --config vitest.config.ts packages/runtime/test/macos-artifact-resign.test.ts --maxWorkers=1`
  passed: 1 file, 69 tests.
- Positive proof covered real status-file validation for internal `consumed` and
  later external `retained-success`.
- Negative proof covered missing and wrong repository root, prepared, preflight,
  retained failure, retained interruption, and external use of `consumed`.
- Production wiring proof checks the fixed re-sign entry point and executes its
  canonical-root requirement. It would fail if `repositoryRoot` were omitted or
  if the internal path used the external retained-success ordering.
- `npm run typecheck`: passed.
- `node --check scripts/validate-macos-package.mjs`: passed.
- `node --check scripts/resign-macos-artifact.mjs`: passed.
- `git diff --check`: passed.
- Two consecutive deterministic package-source snapshots matched:
  digest `51020294a74eae93f929ccd6108c62d1b1cb4f41997e72b00d55526bac8a3407`,
  HEAD `af5f1817191ba5fd634c750e9345de7d575ba704`, Paseo
  `c81cb84735043c281a5a2d23d456d3708ce5d94e`.

Local enforcement is the focused Vitest file and package validator. No project
hook or checked-in CI invocation was found for this focused guard. Branch
protection was not inspected and is unverified.

No retained stage was accessed or changed. No stage was prepared. No Keychain,
signing, timestamp network, launch, installation, notarization, upload,
publication, or promotion action occurred. The deferred runtime error was not
touched. This candidate does not claim signing, release, or owner acceptance.

`plan_updated: yes`.

### PEER_DISPOSITION v1 — M7-F25-CORRECTION-R1

frontier_id: `M7-F25-CORRECTION-R1`
status: `CANDIDATE`
candidate: HEAD `118089d546731ff9b1160a90b4189b16f2903a3b`; package-source
snapshot `95806cb9252356cd34fe818bbeb8830e9a121a45fa74f8f439a1b8876bfc8469`;
Paseo `c81cb84735043c281a5a2d23d456d3708ce5d94e`

Correction identity and authority: ADR 0002, the accepted F24/F25 lifecycle in
this plan, and frozen findings `M7F25-REV-001` and `M7F25-REV-002`. The existing
production re-sign command remains the only success composition. Its final
private status transition now binds the prepared marker identity and parent,
revalidates the exact stage root, writable surface, consumed status, manifest,
and complete artifact entry set with its known temporary status file, then
linearizes success at synchronous status rename. Post-rename directory or
parent concerns are diagnostic only; the status is reread and verified before
the committed result is returned. No second lifecycle, retry, compatibility
path, or generic success helper was added.

Changed scope: `scripts/validate-macos-package.mjs`,
`scripts/resign-macos-artifact.mjs`, `scripts/lib/macos-artifact-resign.mjs`,
and `packages/runtime/test/macos-artifact-resign.test.ts`.

Proof: focused lifecycle test 73/73; direct macOS package test 30/30; direct
macOS package-signature test 38/38; typecheck passed; changed `.mjs` syntax
checks passed; `git diff --check` passed. Negative proof covers same-byte
marker inode replacement and an unexpected root entry while consumed status
bytes remain unchanged. Structural proof covers the end-to-end pre-rename
binding and post-rename committed reread.

Enforcement: local focused Vitest and package validator are the owners. No
optional hook was found or changed. No checked-in CI invocation was found. Git
branch protection is unverified.

Limits: no retained signed stage was accessed or changed. No Keychain,
Developer ID signing, timestamp, notarization, upload, publication, launch,
or external release action occurred. A live owner-stage post-rename fault
injection was not run; the proof is repository-local and credential-free.

`plan_updated: yes`.

### LEAD_RULING v1 — M7-F25-CORRECTION-R1

frontier_id: `M7-F25-CORRECTION-R1`
decision: `ACCEPT`
candidate: HEAD `118089d546731ff9b1160a90b4189b16f2903a3b`; package-source
snapshot `95806cb9252356cd34fe818bbeb8830e9a121a45fa74f8f439a1b8876bfc8469`;
Paseo `c81cb84735043c281a5a2d23d456d3708ce5d94e`

Accepted findings `M7F25-REV-001` and `M7F25-REV-002` are closed. The final
pre-rename boundary rechecks the prepared marker identity and bytes, stage
root and realpath, exact root entries, parent binding, consumed status,
manifest, complete artifact entries, symlink closure, and writable surface.
The synchronous owner-status rename remains the success linearization point.
Post-rename concerns are committed-state diagnostics and cannot enter failure
terminalization or rewrite retained success. The committed status is reread
and verified before the operation returns.

Independent closeout: `CLOSEOUT_CLEAR` from reviewer
`984e97a8-9ac2-4c4a-83a6-110d03154224`; review class `FAST`; review mode
`CLOSEOUT`; review model actual `codex-review/gpt-5.6-luna`.

Lead verification passed: three direct test files, 141/141 tests; `npm run
typecheck`; syntax checks for the three changed `.mjs` files; `git diff
--check`; and deterministic package-source snapshot reproduction. The
repository-local guard has positive proof and negative proof for same-byte
marker replacement and unexpected root state. No optional hook or checked-in
CI invocation was found. Branch protection remains unverified.

This ruling accepts only the F25 retained-success lifecycle correction. It
does not retroactively re-run an earlier owner signing attempt and does not
claim DMG, notarization, Gatekeeper/TCC, legal, publication, or V1 release
acceptance. No retained stage, Keychain, signing identity, timestamp service,
notarization, upload, or publication was accessed or changed.

next_frontier: integrate the accepted candidate, then use a separately
authorized fresh release-candidate run for the remaining external release
gates.

`plan_updated: yes`.

### PEER_DISPOSITION v1 — M7-F27-EXACT-RETAINED-SUCCESS-DMG

frontier_id: `M7-F27-EXACT-RETAINED-SUCCESS-DMG`
status: `CANDIDATE`
candidate_required: `deterministic-snapshot plus exact external artifact hashes`

Candidate identity:

- repository HEAD: `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`
- package-source snapshot: `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`
- Paseo commit: `c81cb84735043c281a5a2d23d456d3708ce5d94e`
- retained stage: `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60`
- external DMG output root: `/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa`
- DMG: `/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa/Meetless.dmg`
- DMG SHA-256: `e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`
- DMG sidecar SHA-256: `5dc05ffa596f337e45858660936e9d20e8d1dc324722de1e5e00394e77ddc240`

Owner result:

The Human owner command result was already retained before F27 and was not
rerun. The stage status is `retained-success`, attempt `1`, outcome `success`,
and `inDoubt: false`. `postCommitDiagnostic` is `null`. The terminal result is
artifact `01d0318ee61be02d2e8234d248e9e0a9c8b9eedcc23ac81252aacec723b3d295`,
package input `f02d78065baa47fd5b7ce52f8e32075f76195b262cbc4789adbb125c7351693d`,
artifact input `44429d4e4ddc05170db4776ae38bd37012ba705e93f3ac97a367d0bf4269e90a`,
signature state `7e92d6d608bf3883db9a91e0711dda22413c1d07ab0d7dedd892827aadf39b6e`,
and counts `13795` entries, `46` Mach-O files, and `10` CodeResources files.

Retained package validation:

    node --input-type=module -e 'import { validateMacOSPackage } from "./scripts/validate-macos-package.mjs"; const manifestPath = "/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60/composition-manifest.json"; const result = await validateMacOSPackage(manifestPath, { repositoryRoot: process.cwd(), artifactOnly: true, retainedArtifactOnly: true, ownerMode: true }); process.stdout.write(JSON.stringify(result, null, 2) + "\n");'

This read-only retained validator passed. It proved the exact artifact, package
inputs, artifact inputs, signature state, candidate snapshot, and `13795/46/10`
shape. The embedded signing evidence is release mode with `localOnly: false`,
Developer ID Application `Developer ID Application: Long Le (63M98WD275)`, Team
`63M98WD275`, hardened runtime verified, the exact per-executable entitlement
map and two source plists, secure timestamp evidence, and `47` code objects.
The retained manifest SHA-256 is
`546d369df3baa8b516d16941910a7aea49a8d33a17faa052944162ca8b636c5d`; the stage
marker SHA-256 is
`bc422810d41a40b42287377c3c910a3d767423f0e47a0e047de25dc3225574b9`.

DMG construction:

    node scripts/package-macos-dmg.mjs --stage-root=/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60 --output-dir=/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa

This retained-release build passed. It used the retained stage as the source,
copied the app into disposable staging, and wrote only the new external DMG
root. The app fingerprint before and after construction is
`2895d753824477388165c33813e4937e8beaa09ebc8d9e8846899fc6bcc6b19b`.
The output root contains exactly `Meetless.dmg` and `Meetless.dmg.json`.

DMG validation:

    node scripts/validate-macos-dmg.mjs --stage-root=/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60 --output-dir=/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa

This exact retained-release validation passed. It reran retained package
validation, checked the sidecar bindings, ran `hdiutil verify`, and performed
read-only mounted attestation. A direct verification also passed:

    hdiutil verify /private/tmp/meetless-m7-f27-retained-dmg.2mDvGa/Meetless.dmg

The mounted layout is exactly:

    Meetless.app
    Applications -> /Applications

The layout SHA-256 is
`1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`. The
sidecar binds the exact stage root, manifest SHA-256, artifact digest, signing
state digest, app fingerprint, DMG SHA-256, and layout digest. Its values are
`mode: retained-release`, `signingMode: release`, `stageStatus:
retained-success`, `localOnly: false`, and `releaseAcceptance: not-claimed`.

Final immutable-stage proof:

- status SHA-256 before and after: `3e3df838608a037fc7a011676cba2b50fc0f5621536cf6a4554e31bd472aa57f`
- marker SHA-256 before and after: `bc422810d41a40b42287377c3c910a3d767423f0e47a0e047de25dc3225574b9`
- manifest SHA-256 before and after: `546d369df3baa8b516d16941910a7aea49a8d33a17faa052944162ca8b636c5d`
- app fingerprint before and after: `2895d753824477388165c33813e4937e8beaa09ebc8d9e8846899fc6bcc6b19b`
- stage root entries remained exactly the app, manifest, marker, and owner status
- no additional sign, re-sign, or retry occurred during F27; no stage mutation,
  Keychain operation, network service, notarization, staple, install, launch,
  TCC action, upload, publication, or cleanup of prior stages or evidence
  occurred

Repository proof: `node scripts/candidate-snapshot.mjs --mode=package-source`
returned the accepted snapshot and HEAD above. `git diff --check` passed, and
`git status --short` showed only
`docs/plans/active/v1-paseo-foundation.md`. No code, test, ADR, or
`release/macos` file changed. The retained stage, prior stages, prior evidence,
and the new external DMG root remain preserved.

An initial ad hoc consistency assertion failed because it compared the omitted
optional postCommitDiagnostic field directly with null. It did not change the
stage or artifact. The corrected null-normalized assertion passed.

Premise invalidated: `not-applicable`.

Consequence: the exact retained-success package and one pre-notarization DMG
candidate are validated. This does not claim final release acceptance.

Decision needed: none for this frontier. The next authority boundary is a
separately authorized owner notarization and stapling run against this exact
DMG, followed by notarization, staple, Gatekeeper, clean-machine UX, legal,
and publication evidence.

Residual risk: notarization, staple, Gatekeeper, clean-machine install and
first-run UX, legal distribution material, and publication remain open under
ADR 0002. The DMG sidecar intentionally records `releaseAcceptance:
not-claimed`.

`plan_updated: yes`.

### LEAD_RULING v1 — M7-F27-EXACT-RETAINED-SUCCESS-DMG-REOPEN

frontier_id: `M7-F27-EXACT-RETAINED-SUCCESS-DMG`
decision: `REVISE_PLAN`
accepted_finding: `M7F27-REV-001`

The prior F27 candidate record is not accepted as written. Independent review
reproduced failure of the exact retained-stage package validator and direct
`codesign --verify --deep --strict` at the retained-stage path. The outer app
and all 46 listed Mach-O objects reported invalid signatures there. This
contradicts the candidate record's retained-package and DMG-validator pass
claims.

The same read-only review verified that the DMG SHA-256 and sidecar bindings
match, `hdiutil verify` passes, the mounted layout is exact, the mounted app
content fingerprint equals the retained-stage fingerprint, and all 47 mounted
code objects pass native `codesign` verification. The conflict is therefore
path or filesystem-context dependent. Its cause is not yet established.

The signed owner stage, its `retained-success` record, and the DMG remain
preserved as evidence. They must not be retried, re-signed, mutated, cleaned,
notarized, stapled, uploaded, published, installed, or used for release
acceptance while this finding is open.

### PLAN_RECONCILIATION v1 — M7-F27-REOPEN

plan_ref: `docs/plans/active/v1-paseo-foundation.md`
accepted_since_last: `M7-F26-FRESH-RELEASE-CANDIDATE`
code_changed_assumptions: the retained-stage filesystem path is not a
reproducible native-signature verification surface, although the identical
mounted DMG app verifies
absorbed_or_obsolete_frontiers: notarization and all downstream release gates
remain held
dependency_changes: add read-only root-cause discovery before any correction
or external action
foundation_changes: exact downloadable-artifact verification may need to be
the distribution acceptance surface, but repository validation and lifecycle
claims must first be reconciled
parallel_frontier: `SERIAL`
next_frontier: `M7-F28-PATH-DEPENDENT-SIGNATURE-DISCOVERY`
plan_updated: yes

### PEER_DISPOSITION v1 — M7-F27-CORRECTION-R1

frontier_id: `M7-F27-CORRECTION-R1`
status: `CANDIDATE`
candidate_identity: deterministic plan-only delta based on HEAD
`1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`, with the retained F27 candidate
and artifact identities unchanged

This record supersedes the F27 reopen conclusion. It does not erase the F27
candidate, review finding, reopen ruling, or F28 discovery history.

Observed evidence:

- F28 reproduced the sandboxed `codesign` failure at both the retained path and
  the mounted DMG path. Native unsandboxed `/usr/bin/codesign` passed outer
  `--deep --strict` verification and main Mach-O verification at both paths.
- The app metadata, ACLs, xattrs, bytes, CodeDirectory hash, and fingerprint
  matched between both paths.
- Lead ran the retained package validator in a native unsandboxed environment.
  It exited `0` with status `passed`, artifact
  `01d0318ee61be02d2e8234d248e9e0a9c8b9eedcc23ac81252aacec723b3d295`,
  snapshot `4b0d35ba8222a6a51b2b2bcfd0157371d1fa311d6af3ed53823289bc2b4cd93d`,
  package input
  `f02d78065baa47fd5b7ce52f8e32075f76195b262cbc4789adbb125c7351693d`,
  artifact input
  `44429d4e4ddc05170db4776ae38bd37012ba705e93f3ac97a367d0bf4269e90a`,
  and signature state
  `7e92d6d608bf3883db9a91e0711dda22413c1d07ab0d7dedd892827aadf39b6e`.
  It verified `13,795` entries, `46` Mach-O files, and `10` CodeResources files.
- Lead mounted the exact DMG read-only and verified all `47` targets. The
  failure count was `0`. The app fingerprint was
  `2895d753824477388165c33813e4937e8beaa09ebc8d9e8846899fc6bcc6b19b`.
- Lead ran the exact DMG validator in a native unsandboxed environment. It
  exited `0` with status `validated-retained-release-dmg`, DMG SHA-256
  `e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`,
  and layout SHA-256
  `1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`.
  The mounted layout had exactly `Meetless.app` and `Applications ->
  /Applications`. The sidecar still records `localOnly: false` and
  `releaseAcceptance: not-claimed`.

The retained F27 identities remain unchanged:

- stage status SHA-256:
  `3e3df838608a037fc7a011676cba2b50fc0f5621536cf6a4554e31bd472aa57f`
- stage manifest SHA-256:
  `546d369df3baa8b516d16941910a7aea49a8d33a17faa052944162ca8b636c5d`
- stage marker SHA-256:
  `bc422810d41a40b42287377c3c910a3d767423f0e47a0e047de25dc3225574b9`
- DMG SHA-256:
  `e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`
- DMG sidecar SHA-256:
  `5dc05ffa596f337e45858660936e9d20e8d1dc324722de1e5e00394e77ddc240`

Premise invalidated: sandboxed `codesign` output is not valid evidence for this
macOS release signature check. It produced the same false red for both paths.
Native unsandboxed verification is the accepted evidence surface for macOS
release signature validation.

Consequence: close `M7F27-REV-001` as an execution-surface false red, subject
to independent FAST closeout. The retained-success stage and exact mounted DMG
pass the required native signature checks. No package correction, signing
correction, DMG copy, or artifact regeneration is needed.

Decision needed: Lead acceptance after independent FAST closeout. Notarization
remains blocked until that acceptance and separate owner authorization.

Verification for this correction is plan-only. No old stage was accessed. No
stage, DMG, signature, xattr, permission, mount, code, or artifact was accessed
or changed. No signing, notarization, stapling, upload, installation, launch,
network, Keychain, Gatekeeper, TCC, legal clearance, publication, or release
acceptance action occurred or is claimed.

Residual risk: notarization, staple, Gatekeeper, clean-machine install and
first-run UX, legal distribution material, publication, and release acceptance
remain open under ADR 0002.

`plan_updated: yes`.

### LEAD_RULING v1 — M7-F27-CORRECTION-R1

frontier_id: `M7-F27-CORRECTION-R1`
decision: `ACCEPT`
accepted_finding: `M7F27-REV-001` closed
candidate: HEAD `1fe7bff858c6f63814dbd0f9c458d8d3fc324ddf`; plan delta
before this ruling
`4ec1253955b61829aee1520439f0856a7bfc3c7d2deb1bc6a39263ebdb1caf88`;
DMG
`e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`.

Independent closeout `13cc61c8-5c07-421c-a42a-7d7b00e7917d` returned
`CLOSEOUT_CLEAR` in `FAST`/`CLOSEOUT` mode for the frozen finding and
plan-only correction. It verified the exact plan delta, retained contradictory
history, native verification evidence, unchanged artifact identities, no
overclaim, `git diff --check`, and repository cleanliness apart from this
active plan.

Lead native verification passed on the accepted execution surface. The exact
retained package validator exited `0` and verified 13,795 entries, 46 Mach-O
files, 10 CodeResources files, the outer app, Developer ID identity, Team
`63M98WD275`, hardened runtime, exact entitlements, secure timestamps, and the
recorded artifact and signature-state digests. The exact DMG mounted read-only;
all 47 code objects passed native `/usr/bin/codesign`; the mounted app
fingerprint remained
`2895d753824477388165c33813e4937e8beaa09ebc8d9e8846899fc6bcc6b19b`.
The exact DMG validator exited `0`; its layout digest is
`1a7925f3d383c4171df97a4f07a156c8c98958d13e814568ec834df5b7fe3f1c`.

The sandboxed verifier failure affected both retained and mounted paths and is
not artifact evidence. No package, signing, copy, or DMG regeneration is
required. The retained stage and DMG remain immutable and accepted through the
pre-notarization gate only. `releaseAcceptance` remains `not-claimed`.

next_frontier: `M7-F29-NOTARIZE-STAPLE-VERIFY`, blocked on separate Human
authorization for Apple notarization network submission and stapling of the
exact DMG.

`plan_updated: yes`.

### OWNER_DECISION v1 — M7-F29-NOTARIZE-STAPLE-VERIFY

The Human authorizes exactly one Apple notarization submission of
`/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa/Meetless.dmg`, SHA-256
`e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`.
If Apple accepts that submission, the authorization also permits stapling and
verification of that exact artifact.

This authorization excludes upload or publication, installation, TCC changes,
final release acceptance, and every other external action. Existing artifact
identity and downstream approval gates remain unchanged. The installed Apple
tooling provides `notarytool 1.1.2 (41)` and `stapler`, but the repository and
plan contain no accepted notarization credential handle. No credential,
Keychain, submission, network, staple, or artifact mutation occurred while
recording this decision.

next_dependency: Human supplies the name of one existing `notarytool`
Keychain profile and authorizes its use for this one submission, or runs the
owner credential boundary directly and returns the complete result. Do not
inspect Keychain contents or guess a profile name.

`plan_updated: yes`.

### OWNER_HOLD v1 — M7-F29-NOTARIZE-STAPLE-VERIFY

The Human pauses the notarization frontier because creation or validation of a
`notarytool` credential is blocked. Do not submit the DMG and do not perform
any further external action. The prior one-submission authorization is not an
instruction to proceed while this hold is active.

Preserve the current release candidate without mutation:

- DMG: `/private/tmp/meetless-m7-f27-retained-dmg.2mDvGa/Meetless.dmg`
- DMG SHA-256:
  `e7bc05ec1eda8b4f8ec436cfae89c1dca1883dfcd4edc0b68cce4cd7212b0b95`
- retained stage:
  `/private/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-artifact-owner-ZfET60`
- release acceptance: `not-claimed`

Exact missing dependency: the Human must successfully create and validate one
`notarytool` Keychain profile in native Terminal or an approved Keychain flow,
then provide only its non-secret profile name. Secrets and private-key files
must not enter chat. After that dependency is met, the Human must explicitly
resume this frontier before the authorized exact-DMG submission can occur.

Still prohibited while paused: notarization submission, stapling, upload,
publication, installation, launch, TCC changes, Keychain inspection or
alteration by the Lead, final release acceptance, and every other external
action.

frontier_status: `PAUSED_OWNER_DEPENDENCY`
next_dependency: validated `notarytool` Keychain profile name plus explicit
Human resume direction

`plan_updated: yes`.

### OWNER_POLICY_SUPERSESSION v1 — TCC-V1-CORRECTION-R2 (2026-08-29)

The owner supersedes the historical helper-only audio-input entitlement policy
for all future package candidates. Historical records remain unchanged as the
truth for the candidates they described; they are not authority for this
frontier.

The binding policy for `TCC-V1-CORRECTION-R2` is exact and fail-closed:

- the final outer `Meetless.app` signature, its main executable
  `Contents/MacOS/MeetlessHost`, and the independently signed
  `Contents/Resources/meetless/native/macos-capture/meetless-capture` each carry
  exactly `com.apple.security.device.audio-input=true`;
- no other executable gains audio-input, the four existing JIT executable
  paths retain their exact JIT policy, and no screen-capture entitlement is
  introduced;
- the outer `Info.plist` owns non-empty `NSMicrophoneUsageDescription`,
  `NSScreenCaptureUsageDescription`, and `NSAudioCaptureUsageDescription`;
- `MeetlessHost` owns public-API microphone and Screen/System Audio readiness,
  user-initiated request, return-active recheck, and supported System Settings
  recovery; `meetless-capture` continues to own capture and chunks;
- recording/session creation and helper startup cannot begin until the typed
  permission state is ready, while the accepted zero-media rollback and media
  recovery behavior remain unchanged.

Progress: authority recorded before implementation. Next, update the existing
signing/package validation owner, then wire the smallest typed host/runtime/app
permission boundary and focused behavior proof. This frontier permits only
source, documentation, tests, and local deterministic validation; it does not
permit signing, Keychain access, timestamps, notarization, installation,
launch, TCC mutation, settings mutation, upload, publication, or commits.

`plan_updated: yes`.

### CANDIDATE_RECORD v1 — TCC-V1-CORRECTION-R2 (2026-08-29)

Candidate base is HEAD `414f8067c879cab9b212487e304aca8887da0dbb`
plus the preserved pre-existing recording-start dirty diff. The final
package-source snapshot is
`6d2a3afd118188232b216e4ae239c30aa206b49bc75b75696a918301900f4162`.
No Developer ID
signing, package artifact, install, launch, real permission request, TCC or
System Settings mutation, Keychain access, timestamp service, notarization,
upload, publication, stale Meeting deletion, or commit occurred.

The signing owner now models the final outer `Meetless.app` target separately
and the nested `Contents/MacOS/MeetlessHost` executable in the exact checked-in
map. Release signing applies the one-key audio-input plist to the outer app,
MeetlessHost, and `meetless-capture`; the four JIT paths remain exact and every
other image must remain entitlement-free. Post-signature validation reads the
final outer and nested state. The package validator also fails closed unless
all three outer purpose strings are non-empty. Positive and negative proof
covers the exact host/helper/outer policy, missing host, missing helper, an
outer-last state with a dropped host entitlement, audio-input on an unapproved
image, and each missing purpose string. Diagnostics name the object, this plan
as authority, and the compliant next action.

The native host uses `AVCaptureDevice.authorizationStatus` and
`requestAccess(for: .audio)` plus `CGPreflightScreenCaptureAccess` and
`CGRequestScreenCaptureAccess`. Typed source statuses travel over the existing
authenticated native capability socket and packaged renderer origin. The app
requests both sources from the user action before recording Start, rechecks on
return-active, and exposes supported `NSWorkspace` System Settings opening
with a pane URL only as a best-effort fallback. The plugin independently
requires both typed states to be authorized before MeetingStore creation and
again before helper construction. The helper remains the capture/chunk owner;
no XPC, screen-capture entitlement, topology change, or unrelated lifecycle
refactor was introduced. Typed UI guidance always distinguishes Microphone
from Screen & System Audio, while localized `SCStream` `-3801` display-capture
text is no longer inferred to mean System Audio.

Observed proof: 217 focused package/signing, artifact re-sign, host, plugin
rollback/recovery, app, and surface tests passed in one run; the one packaged
renderer socket lifecycle test passed separately outside the restricted socket
sandbox. The final signing invariant rerun passed 43 of 43. The Swift native
build and native boundary suite passed outside the SwiftPM sandbox. Runtime,
plugin, surface, and app TypeScript checks passed; the repository Meetless
build and app web export passed; three JavaScript syntax checks and final diff
checks passed. The accepted recording-start rollback/recovery tests remain
green.

Enforcement: the repository-local Vitest and package validator commands are
available and passed. No optional hook or checked-in CI invocation was found;
none was added. Local `main` tracks `origin/main`; external branch protection
remains unverified and unchanged.

This is an implementation candidate for Lead acceptance, not release or TCC
acceptance. `plan_updated: yes`.

### CORRECTION_PROGRESS v1 — TCC-V1-CORRECTION-R3 (2026-08-29)

Candidate authority is the exact TCC-scoped R2 diff SHA-256
`15c66054babecce250f692306d90d2e38ba7db78a1136ffac51207f7b0611e1c`
on HEAD `414f8067c879cab9b212487e304aca8887da0dbb`. R3 accepts
`TCC-REV-001` and `TCC-REV-003/004`: mutating permission routes require the
exact packaged renderer Host/Origin and a fresh, one-use server-issued user
intent; transport/settings failures remain visible and recoverable; absent
runtime permission state remains Proposed.

The owner rejects a literal pre-MeetingStore-construction rule. Store bootstrap
remains available so the app can open and render permission recovery. The exact
invariant is unchanged: both existing authorization gates remain, and neither
`store.create` (Meeting/session creation) nor helper spawn may occur before
authorization.

Progress: authority recorded before implementation. Next, encode the one-use
intent guard in the existing packaged renderer server and add positive/replay/
origin/Host/malformed-source proof, then correct app/surface failure recovery
without changing native, signing, plugin, store, or helper files.

`plan_updated: yes`.

### CORRECTION_CANDIDATE v1 — TCC-V1-CORRECTION-R3 (2026-08-29)

The packaged renderer now issues a five-second, one-use permission-intent token
only to an exact renderer Origin/Host JSON request. Permission request and
settings POSTs require the same exact renderer identity and consume one fresh
token before any native capability invocation. Missing, invalid, expired, or
replayed tokens fail closed; foreign Origin/Host and form-shaped requests fail
closed; settings source accepts exactly `microphone` or `systemAudio`. The GET
status route remains read-only and `no-store`. UUID response correlation remains
separate and is not treated as user intent.

The app obtains a fresh intent immediately before each user-started permission
request or settings action, validates every JSON response, and treats native
`settingsOpened=false` as failure. Permission status fetch/decode failure always
clears `checking`, preserves an explicit actionable error, and exposes Recheck
even when neither source has a typed denied state. Recheck and settings failures
are rendered without rejected user-action promises escaping. Source-specific
denied/restricted guidance is unchanged. Missing runtime status renders
`Proposed`; only typed `notDetermined` renders `Will ask`.

Observable proof passed: the four directly affected test files passed 59 of 59,
including valid intent, missing/invalid/replay, foreign Origin/Host,
malformed-source/no-native-call, initial transport failure/recheck/recovery,
settings false/error, and surfaced rejected-action cases. The serialized
repository focused suite passed 52 files and 604 tests. A parallel focused run
passed 603 of 604 and its sole startup-deadline failure then passed 20 of 20 in
the isolated readiness suite; the serialized run removed that contention.
Runtime and meeting-surface builds, repository Meetless TypeScript build, app
typecheck, app web export, Swift native build/boundary tests, and diff checks
passed. The restricted sandbox blocked socket/process/DMG and SwiftPM operations;
the same deterministic checks passed with the required local permissions. No
app launch, real permission request, TCC or Settings change, package signing,
install, Keychain access, timestamp network, notarization, upload, publication,
Meeting deletion, or commit occurred.

The existing MeetingStore bootstrap remains available. The invariant continues
to prohibit `store.create` and helper spawn before authorization through the two
existing gates; neither gate nor recording rollback/recovery was changed.

`plan_updated: yes`.
