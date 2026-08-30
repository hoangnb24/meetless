# Execution Plan: Chat Overlay And Scroll Foundation

Date: 2026-08-30

## Status

Active

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
- [ ] Complete independent foundation judgment.
- [ ] Freeze the overlay/scroll contract and dispatch one writer.
- [ ] Accept focused and built-artifact proof.
- [ ] Install and launch the accepted signed package.

## Decisions

- 2026-08-30: Treat the repeated clipping/scroll regressions as one presentation
  foundation defect, not separate Model and Thinking bugs.
- 2026-08-30: Preserve all chat selection and backend contracts; only overlay
  presentation, lifecycle composition, scroll ownership, and proof may change.

## Validation

- Focused proof: pure geometry plus interaction tests for model, thinking, and
  feature-select consumers; sidebar scrollbar behavior remains covered.
- Integration or end-to-end proof: emitted web/macOS surface bounding boxes at
  390px, 877px, and 1440px, with anchors near viewport edges.
- Repository-required checks: meeting-surface tests/typecheck/build, app
  typecheck/build/export, `git diff --check`, signed-package verification.

## Result

Pending implementation and acceptance.
