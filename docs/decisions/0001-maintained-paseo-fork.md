# 0001 Maintain Paseo Separately And Pin It In Meetless

Date: 2026-08-16

## Status

Accepted

## Context

Time to Results is the primary adoption goal. Paseo already supplies the Expo,
Electron, daemon, protocol, transport, and coding-agent infrastructure Meetless
needs. Those workspaces are coupled through the monorepo build graph. Selective
copying or premature package extraction would create a second integration and
update problem before the meeting loop is proven.

Paseo and Meetless are independently developed products. Meetless needs Paseo
capabilities, but its meeting product code, release history, issues, and version
lifecycle must remain isolated from Paseo development.

Meetless will be distributed as open source compatible with Paseo's
AGPL-3.0-or-later obligations.

## Decision

Use two repositories with independent Git histories:

1. a maintained Paseo fork that preserves the complete Paseo monorepo and
   workspace graph; and
2. this Meetless repository, which owns only Meetless product/domain code and
   integration adapters.

Meetless must not become a branch of the Paseo fork, and Meetless product code
must not be committed into the Paseo repository. For the initial Time to Results
path, Meetless consumes the Paseo fork at `https://github.com/hoangnb24/paseo`
as the `vendor/paseo` Git submodule pinned to an exact revision. The initial
accepted integration revision is:

```text
ee3420e80d93f7f0c875fcd45e816a5a9d06188f
```

The immutable compatibility tag `meetless-v1-base-2026-08-16` resolves to that
commit. This fork revision incorporates upstream Paseo revision
`16120ebff1918f5c22b9d018ac301be9b70c3ce9` while retaining the fork's prior
history. In a Paseo maintainer checkout, use `origin` for the owned fork and
`upstream` for the original Paseo project. The Meetless submodule URL must stay
on the owned GitHub fork, never a local filesystem path or the moving upstream
branch.

The Paseo maintainers own its fork remote, monorepo lockfile, upstream merges,
conflict resolution, and Paseo validation. Meetless maintainers own the
submodule pointer, Meetless lockfiles, integration adapters, and Meetless
release validation. The same people may hold both roles, but the repositories
and change histories remain separate.

Keep meeting and knowledge policy in the Meetless repository. Reuse Paseo
runtime infrastructure through explicit integration adapters without
representing meetings as coding workspaces or agents. Never copy Meetless policy
into the submodule or make Meetless depend on an unreviewed moving Paseo branch.

Updates flow in one direction:

1. merge and validate upstream Paseo changes in the Paseo fork;
2. select a reviewed Paseo fork commit;
3. update only Meetless's submodule pointer in a dedicated integration change;
4. run affected build, typecheck, focused tests, protocol compatibility checks,
   desktop smoke, and the accepted recording proof before accepting the bump.

## Alternatives Considered

1. Make Meetless itself the Paseo fork: rejected because Meetless product code
   and history would become coupled to Paseo development.
2. Copy or vendor Paseo source into Meetless without separate Git history:
   rejected because provenance and updates become manual.
3. Extracted or published packages: deferred until a proven neutral seam reduces
   the integration surface without duplicating state or compatibility behavior.

## Consequences

Positive:

- Paseo keeps its existing package graph and integration paths.
- Upstream provenance and merge history stay visible.
- Meetless product history and release cadence stay isolated.
- Meetless can reach the first meeting loop before package-extraction work.

Tradeoffs:

- A checkout includes the complete Paseo submodule even though some coding
  product packages are outside Meetless product scope.
- Cross-repository contract changes require coordinated Paseo and Meetless
  commits; the submodule pointer makes that coordination explicit.
- AGPL and third-party obligations apply to distribution and network use.

## License Findings And Limits

The Paseo root and desktop manifests declare `AGPL-3.0-or-later`.
`packages/expo-two-way-audio` declares MIT and includes its own `LICENSE`.

A package-lock production-closure scan found 988 dependency names. It was mostly
MIT, ISC, BSD, and Apache, with MPL and choice-license entries; 28 names lacked
license metadata in the lockfile. This is not complete clearance. It does not
fully inspect native artifacts, speech models, provider binaries, generated
NOTICE requirements, or every dependency's shipped license text.

Before any binary release, generate and review the complete production
dependency/native/model inventory, preserve required notices, publish
Corresponding Source and build/install scripts, expose appropriate legal/source
notices, and review AGPL network-interaction obligations. This is engineering
due diligence, not legal advice.

## Follow-Up

- The owned fork URL, reviewed SHA, compatibility tag, and pinned submodule are
  recorded. Upstream sync PR #2 merged only after all required GitHub checks
  passed.
- Complete the release license/NOTICE review before distributing binaries.
- Reconsider package extraction only after measured fork-update pain identifies
  a stable neutral seam.
