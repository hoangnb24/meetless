# Execution Plan: Chat Overlay And Scroll Foundation

Date: 2026-08-30

## Status

Completed

## Outcome

Every transient chat control follows one viewport-safe overlay contract instead
of implementing its own positioning. Model, thinking-level, and dynamic feature
menus remain fully visible and usable at phone, tablet, and desktop widths. The
meeting sidebar and overlay content follow explicit scroll ownership so padding,
blank space, clipping, and browser scrollbars do not reappear per component.

## Context

- `design/examples/provider-model-controls.html` is the accepted Paseo-aligned
  interaction reference. It renders model and thinking surfaces through one
  fixed popup layer and one positioning path.
- `packages/meeting-surface/src/index.tsx` currently applies viewport geometry
  only to the model picker; thinking and feature menus still use an absolute
  downward `chatMiniMenu`.
- `packages/meeting-surface/test/new-design.test.tsx` proves model-picker
  geometry but not composed bounds for every overlay consumer.
- `docs/WORKFLOW.md` requires real-interface proof for user-visible behavior.

## Scope

In scope:

- Define the durable overlay and scroll-container presentation contract.
- Use one geometry/lifecycle owner for model, thinking, and feature-select menus.
- Preserve provider/model/thinking/feature selection behavior and backend data.
- Preserve the accepted hidden-sidebar-scrollbar behavior.
- Add focused geometry, interaction, responsive, and built-artifact acceptance
  proof at 390px, 877px, and 1440px, including edge anchors.
- Build, sign, install, launch, and inspect the real macOS app after acceptance.

Out of scope:

- Provider/model catalog contents, including Pi availability.
- Chat execution, persistence, recording, deletion, and runtime lifecycle.
- A repository-wide component library unrelated to the affected chat surface.

## Approach

1. Obtain independent foundation judgment on the smallest reusable boundary.
2. Freeze the presentation contract and exact consumer/validation scope.
3. Give one writer exclusive ownership of the coherent surface change.
4. Inspect the immutable candidate and run focused plus built-artifact proof.
5. Record the lasting rule at its design authority, complete this plan, and
   install the accepted Developer-ID build.

## Risks And Recovery

- A generic abstraction could add indirection without isolating variation.
  Keep the boundary only if all three real consumers use one geometry/lifecycle
  path and consumer-specific selection logic remains outside it.
- React Native web fixed-position behavior can differ from unit style objects.
  Require browser/Electron bounding-box evidence from the emitted artifact.
- Overlay state changes can regress Escape, outside dismissal, or focus return.
  Preserve and test these interactions for every consumer family.
- Revert the bounded candidate and reinstall the last accepted signed package if
  composed acceptance fails.

## Progress

- [x] Reproduce the architectural mismatch from source and accepted prototype.
- [x] Complete independent foundation judgment.
- [x] Record and freeze the overlay/scroll contract at design authority.
- [x] Dispatch one writer for the atomic consumer migration and invariant proof.
- [x] Accept focused and built-artifact proof.
- [x] Install and launch the accepted signed package.

## Decisions

- 2026-08-30: Treat the repeated clipping/scroll regressions as one presentation
  foundation defect, not separate Model and Thinking bugs.
- 2026-08-30: Preserve all chat selection and backend contracts; only overlay
  presentation, lifecycle composition, scroll ownership, and proof may change.
- 2026-08-30 `FOUNDATION_CHECK v1`: use a reusable presentation owner because
  four real consumers share geometry and lifecycle while their data and
  selection semantics vary independently. Migrate model, thinking,
  feature-select, and legacy ProviderPicker atomically; do not leave an
  absolute-position fallback under the claimed standard.
- 2026-08-30: `design/DESIGN.md` now owns the exact externally observable chat
  popup and scroll rule. Repository-native surface tests must provide positive
  and negative proof before the implementation is accepted.
- 2026-08-30 close-out: F-001, F-003, and F-004 were confirmed resolved. The
  original F-002 false-positive was also resolved because the emitted proof now
  rejects the reproduced 121px/63px stale-height case. A proposed assertion for
  exact 420px/402px fixture dimensions was not accepted: those values are an
  implementation detail, while the durable contract is useful expansion,
  viewport bounds, and presenter-owned internal scrolling.

## Validation

- Focused proof: pure geometry plus interaction tests for model, thinking, and
  feature-select consumers; sidebar scrollbar behavior remains covered.
- Integration or end-to-end proof: emitted web/macOS surface bounding boxes at
  390px, 877px, and 1440px, with anchors near viewport edges.
- Repository-required checks: meeting-surface tests/typecheck/build, app
  typecheck/build/export, `git diff --check`, signed-package verification.

Implementation evidence observed on 2026-08-30:

- `npx vitest run --config vitest.config.ts packages/meeting-surface`: 61 tests
  passed, including all four shared-presenter routes, geometry, lifecycle,
  selection behavior, phone targets, and retained sidebar scrolling.
- Recoverable negative mutation: restoring the thinking popup as an absolute
  downward-only menu failed the named shared-popup invariant; restoring the
  presenter made the same focused test pass.
- `npm run proof:chat-popup-overlay`: passed against a deterministic temporary
  Expo export built from emitted `packages/meeting-surface/dist/index.js` at
  390px, 877px, and 1440px for modern model, thinking, select-feature, and
  legacy provider/model popups. Observed fixed bounds, 12px margins, exact 8px
  above/below gaps where available, internal overflow, unchanged page height,
  phone sheets, 44px targets, Escape dismissal, and focus return.
- Meeting-surface typecheck/build, app typecheck/build, and app Expo web export
  passed. `git diff --check` passed. Design contract coordination digest stayed
  `b39addfab13fe8f350033f289e2bce1085d492c43a0937d73c9c80d19b654cbd`.

Correction evidence observed on 2026-08-30 against base `f269bf0`:

- The focused correction regressions first failed 4/4 against the original
  presenter: no unconstrained content measurement node, query rerender focused
  the first control again, model close stole focus from thinking, and the
  non-web path still emitted fixed web geometry. After correction,
  `npx vitest run --config vitest.config.ts packages/meeting-surface` passed all
  65 tests.
- The presenter now measures its unconstrained content container and owns the
  only picker `ScrollView`; the consumer model lists no longer impose a nested
  340px scroll constraint. Deterministic non-web tests prove visible absolute
  desktop and phone fallbacks, numeric bounded geometry, and presenter-owned
  scrolling. Physical-device proof was not run.
- `npm run proof:chat-popup-overlay` passed from a fresh emitted Expo fixture.
  At both 877px and 1440px, the 40-model drilldown expanded the root popup from
  109px to 420px, exposed a 402px presenter viewport over 1825px of scrollable
  content, and kept page height at 900px. At 390px the sheet remained 366px by
  820px. Direct model-to-thinking and model-to-feature switches left the
  replacement popup open with focus inside it at all three widths.
- Meeting-surface typecheck/build, app typecheck/build/export, and
  `git diff --check` passed. The design contract coordination digest remains
  `b39addfab13fe8f350033f289e2bce1085d492c43a0937d73c9c80d19b654cbd`.

## Result

Accepted at `facc81070a65e19e020a1a3576e0625e429c4e83`. Lead reran all 65
meeting-surface tests, the emitted-artifact popup proof at 390px, 877px, and
1440px, meeting-surface and app typecheck/build, and the app Expo export. The
Developer-ID package passed deep strict code-signature verification with Team
ID `63M98WD275`, was installed transactionally at `/Applications/Meetless.app`,
and launched successfully. Runtime evidence showed bootstrap completion, the
server listening on `127.0.0.1:16777`, the Meetless plugin loaded, and the
Electron renderer connected from `127.0.0.1:18082`.

Physical-device native behavior remains unverified; native fallback coverage is
deterministic composition and style proof.
