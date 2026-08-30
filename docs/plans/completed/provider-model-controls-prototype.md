# Execution Plan: Paseo-Aligned Ask Controls Prototype

Date: 2026-08-30

## Status

Completed — R1 provider-selection correction

## Outcome

Deliver a reviewable Meetless-native Ask composer prototype whose compact
controls row follows the observed Paseo interaction shape while preserving the
meeting-first hierarchy. The model pill opens a narrow desktop picker or a
full-width compact sheet with named coding-agent profiles, provider/model
drill-down, model-specific Thinking choices, and a benign Fast feature.

## Context

- `docs/product/experience.md` requires provider/model selection to remain
  compact and secondary, with full choices expanded only on change or invalid
  selection.
- `design/DESIGN.md` and `design/SKILL.md` define the Meetless dark-neutral
  tokens, typography, component shapes, responsive tiers, and self-contained
  example/audit expectations.
- `design/preview/manifest.md`, `design/README.md`, and
  `design/DESIGN-MANIFEST.json` define preview/package synchronization.
- `design/examples/meetless-prototype.html` and `design/ui_kits/app/detail.html`
  provide the existing meeting-first Ask shell and composer shapes.
- Paseo reference captures supplied for this frontier are in
  `/private/tmp/paseo-profile-ux-capture/`, including the default composer,
  profile-first model picker, profile materialization, provider models,
  Thinking menu, and feature controls states.

## Scope

In scope:

- Rewrite the dedicated static example at
  `design/examples/provider-model-controls.html` as the compact Ask composer
  row and model-picker flow.
- Keep illustrative local data for Quick answers, Meeting analyst, and Deep
  review profiles; profile application copies the complete bundle immediately
  without mutating the saved profile.
- Add provider search/drill-down/back, committed-model-only selection
  presentation, immediate model selection, capability-filtered Thinking, Fast
  toggle, Escape/outside close, and popup focus containment/restore.
- Preserve the synchronized preview wrapper, launcher label, package manifest,
  and package documentation with the new wording.
- Capture and inspect desktop and compact states; run browser, file://,
  self-contained, link, manifest, JavaScript, and scope checks.

Out of scope:

- Production package/runtime changes, Paseo component dependencies, network,
  daemon, provider-request, or persisted integration.
- Permission modes, Full access, tool permissions, workspace controls, Plan,
  or provider request counts.
- The preserved full meeting prototype and unrelated UI-kit screens.

## Approach

1. Keep the existing Meetless meeting/Ask shell and replace only the rejected
   provider-first modal surface with compact composer pills.
2. Render a one-column Profiles-before-Providers picker on desktop, with a
   provider/model drill-down, and use a full-width bottom sheet at 390px.
3. Keep active model/thinking/Fast values explicit in the composer; profiles
   and model rows apply immediately, with no persistent profile label or large
   footer controls.
4. Keep the example fully self-contained by inlining the canonical token
   contract and using inline SVG icons/local JavaScript only.
5. Synchronize the smallest preview/gallery/manifest/doc surface and prove the
   behavior at 1440×900, 390×844, and file:// before completion.

## Risks And Recovery

- The inventory could regain visual priority over Ask; keep the picker closed
  by default, narrow on desktop, and secondary to the composer/question.
- A provider drill-down could imply a model change before the user chooses one;
  show a selected row only when its providerId/modelId match the committed
  composer state, and leave every other provider's rows unselected.
- A profile could appear permanently bound; show its materialized model,
  Thinking, and Fast values after immediate copy, never its name as the primary
  label, and leave saved profile data unchanged.
- Mobile rows or popup content could overflow; use full-width bottom-sheet
  layout, bounded internal scrolling, 44px minimum targets, and viewport
  assertions at 390×844.
- If validation fails, revert only the owned example, preview integration,
  package documentation/manifest, and this plan; preserve unrelated changes.

## Progress

- [x] Read repository, product, design-system, workspace, and canonical
      engineering authority.
- [x] Inspect Paseo captures, existing prototype/UI-kit, preview, and package
      synchronization files.
- [x] Reopen the prior completed plan as the single active recovery plan.
- [x] Replace the rejected large modal/cards with the Paseo-aligned composer
      row, root picker, provider drill-down, Thinking menu, and Fast feature.
- [x] Keep provider-entry selection derived only from the committed provider
      and model while retaining immediate model-row apply semantics.
- [x] Synchronize the preview wrapper, gallery, manifest, and README wording.
- [x] Run the R1 desktop/mobile regression and the proportionate picker,
      Thinking, Fast, and focus checks.
- [x] Refresh and inspect the non-committed-provider drill-down screenshots.
- [x] Run final file://, inline-script, local-target, manifest, whitespace,
      diff, and scope checks, then move this plan to completed.

## Decisions

- 2026-08-30: Make the combined model pill in the Ask composer the only
  primary entry point; do not persist a selected profile as the visible label.
- 2026-08-30: Put compact named profiles before providers in a narrow,
  one-column picker; provider rows expose only quiet readiness/model-count
  metadata and a chevron.
- 2026-08-30: Profile selection immediately copies model, Thinking, and Fast
  values, closes the picker, and leaves the saved profile definition immutable.
- 2026-08-30: Provider entry marks a row only when its provider and model match
  the committed composer state; opening another provider never materializes a
  first-model selection, while a chosen model still applies immediately and
  closes.
- 2026-08-30 correction: R1 removes the false selected/`aria-pressed` state
  from non-committed provider rows and preserves the committed composer when
  browsing, closing, or escaping that provider view.
- 2026-08-30: Render Thinking only when the active model advertises choices;
  render Fast as the sole adjacent feature control and omit permission/mode
  controls from this meeting Q&A prototype.
- 2026-08-30: Use desktop anchored popovers and a compact full-width mobile
  bottom sheet, with Escape/outside close, contained focus, and opener restore.
- 2026-08-30: Inline the canonical token root and SVG icons in the dedicated
  example so file:// review has zero external resource dependency.

## Validation

- The pre-R1 v2 browser proof passed 71 assertions at 1440×900 and 44
  assertions at 390×844, including the accepted compact picker, profile,
  provider/model, Thinking, Fast, focus, responsive, and overflow behavior.
- Post-R1 Playwright Chromium regression against
  `http://127.0.0.1:4173/design/examples/provider-model-controls.html` passed
  56 assertions at 1440×900 and 56 assertions at 390×844, with zero console,
  page, or failed-request errors. It proves that a non-committed Anthropic
  drill-down has zero selected rows and no `Selected` copy, outside/Escape
  preserve OpenAI/GPT-4.1, the committed provider marks exactly GPT-4.1, and
  Claude Sonnet applies immediately with compatible Thinking.
- The R1 run refreshed and inspected
  `/private/tmp/paseo-aligned-provider-models.png` and
  `/private/tmp/paseo-aligned-mobile-provider-models.png`; both show Anthropic
  model rows without a false selected state while the composer remains
  OpenAI/GPT-4.1.
- A post-R1 Playwright file:// regression passed at 1440×900 and 390×844,
  with one local document request per page, zero errors, zero non-committed
  selected rows, and Claude Sonnet applying with Thinking available.
- A preview integration run selected the new `preview/index.html` gallery
  entry, loaded `preview/provider-model-controls.html`, resolved its nested
  example iframe, opened the picker, and verified Profiles then Providers.
- Final post-R1 `git diff --check`, `jq empty
  design/DESIGN-MANIFEST.json`, inline JavaScript parsing for the three changed
  HTML surfaces, local reference checks, manifest target checks (41 targets),
  trailing-whitespace checks, and authorized write-scope checks passed. The
  dedicated example continues to have no href/src references and no obsolete
  `controlsSheet`, `profile-card`, or Apply copy.
- `design-system-package-audit`, `html5validator`, `html-validate`, and
  `linkchecker` were unavailable (`command -v` found none). `/usr/bin/tidy`
  is Apple HTML Tidy 2006, not an HTML5 validator; it reported its known
  HTML5-element/Unicode diagnostics and was not treated as package-audit proof.

## Result

Completed. R1 derives selected presentation only from the materialized
committed provider/model; browsing another provider does not mutate or imply
the first model. Outside/Escape preserve the committed composer, model rows
still apply immediately when chosen, and no production, vendor, lockfile, or
runtime files changed.
