# Execution Plan: Chat Agent Controls

Date: 2026-08-30

## Status

Completed

## Outcome

Correction outcome: resolve accepted production review blockers F1–F4 on the existing CHAT-CONTROLS-F1 candidate: atomic selection persistence, malformed feature fail-closed behavior, executable-only profiles, and late initial-controls race protection.


Implement the approved Paseo-aligned model, thinking, Fast, profile, feature,
durability, snapshot, and fixed Meetless execution/evidence behavior in
production meeting Q&A, with compatibility for legacy provider discovery and
attempt readers.

## Context

- Frontier authority: `CHAT-CONTROLS-F1-CORRECTION` in the user-provided
  `FRONTIER_BRIEF v1` and `FOUNDATION_CHECK v1`.
- Product authority: `docs/product/experience.md`,
  `docs/product/knowledge-and-citations.md`, and the accepted product decisions
  in the frontier brief.
- Visual authority: `design/examples/provider-model-controls.html` and the
  six supplied Paseo-aligned reference images.
- Engineering authority: `docs/WORKFLOW.md`,
  `docs/patterns/encoding-invariants.md`, and the canonical references under
  `/Users/tubakhuym/projects/unclebob/references`.

## Scope

In scope:

- The repository-relative ownership granted by the frontier brief:
  `packages/meeting-contracts/**`, `packages/meeting-domain/**`,
  `packages/meeting-store/**`, `packages/meetless-plugin/**`,
  `packages/meetless-client/**`, `packages/meetless-app/**`,
  `packages/meeting-surface/**`, `test/composition/**` when needed, and this
  active plan plus its completed successor.
- Contract, domain/store, plugin adapter, client, app, surface, and
  composition proof needed for the outcome.

Out of scope:

- `design/**`, `vendor/**`, lockfiles, scripts, runtime/distribution, and
  unrelated packages.
- New product policy beyond the frontier’s accepted binding decisions.

## Approach

1. Inspect current meeting Q&A contracts, persistence, Paseo adapter, client,
   app state, controlled surface, tests, and native validation commands.
2. Preserve legacy RPC/readers while introducing the smallest versioned
   capability carrying validated transport-neutral selections, projected
   profiles, feature discovery, and host-global persistence.
3. Materialize and validate complete selections at the plugin boundary; keep
   Meetless-owned prompt, transcript MCP, tools, output, archive, execution
   root, and Codex options fixed and non-injectable.
4. Add migration-safe global selection and complete immutable attempt snapshots,
   then wire reconnect/meeting-switch/late-response behavior through one app
   selection source of truth.
5. Implement the approved desktop/phone control hierarchy and prove policy,
   adapter, composition, and user-visible behavior proportionately.

## Risks And Recovery

- Existing runtime or persisted schemas may differ from the proposed shape;
  retain legacy readers and use repository-native migration patterns. Recovery
  is to revert only the owned files while preserving existing user-owned design
  changes.
- Paseo catalog/profile data may be stale, malformed, or expose internal
  fields; reject at the plugin boundary and surface an explicit unavailable or
  update-required state.
- Async feature discovery may arrive after selection/connection changes; bind
  requests to canonical selection identity and connection epoch.
- UI work can accidentally create a second durable state; keep durable
  selection in app state and presentation-only state in the surface.
- Fixed evidence-boundary fields must not be altered by provider/mode/profile
  data; add negative proof for injection attempts.

## Progress

- [x] Read repository workflow, local instructions, plan template, invariant
  guidance, and canonical engineering references.
- [x] Inspect current implementation, authority, tests, and validation commands.
- [x] Finalize task-local API and migration decisions from repository evidence.
- [x] Implement contracts, persistence, plugin capability, client, app, and
  controlled surface changes.
- [x] Add focused, negative, restart, async, and composition proof.
- [x] Run focused checks, repository-required checks, and record exact results.
- [x] Reprove F1–F4 with focused tests, typecheck, build, composition, and diff checks.
- [x] Record correction result and move this plan to `docs/plans/completed/` after proof.

## Correction Authority

- F1: the new-path validated selection and attempt creation/retry must commit in one store mutation; legacy provider/model paths remain compatible.
- F2: malformed successful feature responses must be `update_required` or `unavailable`; only an explicit empty array is ready-empty.
- F3: profiles are actionable only after complete provider/model/mode/thinking/feature validation; stale profiles are omitted without failing the catalog.
- F4: initial controls responses must be guarded by the same selection/request and connection identity as later responses.

## Decisions

- 2026-08-30: Treat the frontier brief’s FOUNDATION_CHECK decisions as the
  accepted authority for all externally observable selection, profile,
  persistence, execution, and UX semantics; repository names remain
  provisional until inspection.
- 2026-08-30: Keep the complete transport-neutral selection as the only
  durable app configuration source; domain/store/surface remain Paseo-free.
- 2026-08-30: Keep persisted store schema version 4 and add optional normalized
  selection fields so existing v1-v4 fixtures and legacy attempts remain
  readable; newly written attempts always carry the complete selection.
- 2026-08-30: Make the plugin adapter the only Paseo interpretation boundary.
  It projects only safe profile/catalog/feature fields, revalidates every
  complete selection against a fresh catalog, rejects stale feature IDs/types,
  and assembles the fixed Meetless evidence envelope at execution time.
- 2026-08-30: Keep legacy provider/chat RPCs available for old callers, while
  the production app/client use only the versioned controls, selection,
  feature, ask, and retry RPCs when those methods are present.

## Correction Progress

- [x] Reopen the completed plan and inspect current F1–F4 seams and existing proof.
- [x] Implement atomic store/service selection persistence and restart proof.
- [x] Make feature response shape validation fail closed and preserve explicit empty success.
- [x] Reconcile and filter stale profiles without failing the controls catalog.
- [x] Guard initial controls hydration against newer local/user selection.
- [x] Run correction validation and move this plan back to `docs/plans/completed/`.

## Validation

- Focused proof: `./node_modules/.bin/vitest run
  packages/meeting-contracts/test/chat-controls-contracts.test.ts
  packages/meeting-domain/test/chat.test.ts
  packages/meeting-store/test/chat-store.test.ts
  packages/meetless-plugin/test/chat-service.test.ts
  packages/meetless-client/test/client.test.ts
  packages/meetless-plugin/test/contribution.test.ts
  packages/meeting-surface/test/new-design.test.tsx
  packages/meetless-app/test/transcript-selection.test.tsx --maxWorkers=1`
  passed 8 files and 105 tests before the correction pass.
- Correction-focused proof: `./node_modules/.bin/vitest run --config
  vitest.config.ts packages/meeting-store/test/chat-store.test.ts
  packages/meetless-plugin/test/chat-service.test.ts
  packages/meetless-app/test/transcript-selection.test.tsx --maxWorkers=1`
  passed 3 files and 54 tests. This covers atomic start/retry restart
  persistence, service routing through atomic methods, explicit empty feature
  readiness, malformed feature failure, provider/model/mode/thinking/feature
  stale profile omission, and the delayed initial-controls selection race.
- Final F4 convergence proof: `./node_modules/.bin/vitest run
  packages/meetless-app/test/transcript-selection.test.tsx --maxWorkers=1`
  passed 22 tests. The meeting-open controls request now snapshots the
  selection request epoch at the start of `openTranscript`, so a selection
  completed while transcript/chat restoration is in flight cannot be replaced
  by the older controls response. App typecheck and `git diff --check` passed.
- Composition proof: `npm run test:composition` passed 4 files and 5 tests.
- Type/build proof: `npm run typecheck` passed Paseo type builds, Meetless
  TypeScript builds, and app typecheck. `npm run build:meetless` passed.
- Hygiene proof: `git diff --check` passed; all writes remained in the
  granted Meetless/package and plan scopes. Existing dirty `design/**`
  changes were preserved.
- Repository-wide test: `./node_modules/.bin/vitest run --config
  vitest.config.ts --maxWorkers=1` passed 64/65 files and 676/678 tests.
  The only failures were the two existing
  `packages/runtime/test/macos-artifact-resign.test.ts` assertions
  (`rejects a symlink bundle root...` and `does not let retained
  artifact-only mode...`); both fail on the repository's candidate-snapshot
  binding error before the asserted manifest/symlink contract. Runtime is
  outside this frontier's write scope and was not changed.
- `pnpm` was not used because this checkout has no pnpm workspace metadata;
  repository npm scripts and the checked-in Vitest binary were used.

## Result

`CHAT-CONTROLS-F1-CORRECTION` is accepted. The store
now commits validated global selection and new-path attempt creation/retry in a
single mutation; the adapter rejects malformed feature success payloads,
filters profiles against the complete current executable bundle, and the app
guards both initial and meeting-open controls hydration with selection/request
and connection identity. The
fixed evidence envelope, full Paseo bundle, legacy callers/readers, and
selection-bound feature behavior remain unchanged. Phone targets meet the
44px requirement.
