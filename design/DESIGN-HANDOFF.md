# e9b017e6-dbd2-468a-ada9-9e5e1c02d621 implementation handoff

This archive is the visual implementation contract and evidence package. Start
from `preview/index.html`, then preserve the visual system, responsive behavior,
and interactions found in the exported files. Accepted product behavior and UX
live in [`docs/product/`](../docs/product/README.md); this archive does not
override them.

## Implementation target
- Build production UI from the exported design, not a loose reinterpretation.
- Preserve typography scale, spacing rhythm, color tokens, border radii, shadows, motion timing, and component states.
- Replace static placeholders only when the target app has real data or functional equivalents.
- Keep generated product UI free of Open Design chrome, preview labels, or design-process annotations.
- Treat this handoff as a visual contract only. If exported visual behavior
  conflicts with `docs/product/`, `docs/product/` wins. Match exported pixels
  and interactions only inside the accepted product behavior.

## Source map
- Primary entry: `preview/index.html`
- HTML screens detected: 14
- Stylesheets detected: 3
- Script/component files detected: 0
- Supporting assets detected: 22

## Responsive contract
Validate the implementation across this 2025–2026 viewport matrix:
- Mobile compact: 360×800
- Mobile standard: 390×844
- Mobile large: 430×932
- Foldable / small tablet: 600×960
- Tablet portrait: 820×1180
- Tablet landscape: 1024×768
- Laptop: 1366×768
- Desktop: 1440×900
- Wide desktop: 1920×1080

For responsive web exports, treat these as a modern breakpoint system for one adaptive web experience, not three fixed screenshots. Do not split responsive web into unrelated native app screens unless the project explicitly includes native targets. Use semantic layout thresholds, fluid `clamp()` type/spacing, and container queries where component width matters more than viewport width. Preserve any CSS media queries, container queries, fluid `clamp()` scales, and layout changes already present in the exported files.

## Design fidelity contract
- Extract reusable tokens before writing components: background, surface, foreground, muted text, border, accent, radius, shadow, spacing, type scale, and motion duration/easing.
- Map product screens, in-app modules/components, optional landing page, and optional OS widget surfaces before coding. Keep these surfaces separate in the target architecture.
- Match layout geometry: max-widths, gutters, grid columns, card proportions, sticky/fixed elements, and viewport-specific navigation.
- Preserve real copy, labels, and data shown in the export. Do not replace specific text with generic marketing filler.
- Preserve interactive affordances: hover, focus, pressed, disabled, loading, validation, copy/share, tab/accordion, modal/sheet, and keyboard states where present.
- Preserve accessibility semantics when converting: headings stay hierarchical, controls remain buttons/links/inputs, focus states stay visible.
- Do not keep prototype-only annotations, frame labels, or Open Design chrome in the production UI.

## CJX-ready UX contract
- Use `DESIGN-MANIFEST.json` as the machine-readable map for screens, app modules, OS widgets, landing pages, tokens, interactions, and viewport checks.
- Screen-file-first: when multiple user-facing surfaces exist, implement each HTML screen as its own route/file. Treat `index.html` as a launcher/overview when the manifest marks it that way, not as a combined final UI.
- If `landing.html`, app screens, platform screens, or OS widget files exist, preserve those boundaries in the target app instead of merging them into one page.
- A single self-contained `preview/index.html` is acceptable only when the export truly contains one user-facing screen and its CSS/JS are structured enough to extract tokens, components, states, and behavior.
- If separate `css/` or `js/` files exist, use them as the visual reference for
  tokens, components, and interactions before porting to React, Vue, SwiftUI,
  Compose, or another target stack.
- In-app modules/components are product UI blocks inside the app. OS widgets are home-screen/lock-screen/quick-access surfaces outside the app. Do not merge those concepts.

## Color and brand contract
- Use the exported design tokens as the color contract. Use product context only
  to understand the visual examples.
- Do not introduce warm beige / cream / peach / pink / orange-brown background washes unless they are already explicit brand/reference colors in the export.
- A stylesheet or design/token file was detected; inspect it for canonical color variables before choosing framework theme tokens.

## Implementation sequence for AI coding tools
1. Open `preview/index.html` and `DESIGN-MANIFEST.json`; identify every screen file, launcher/overview file, app module, and interaction before coding.
2. If multiple HTML screens exist, map them to separate routes/surfaces first; do not merge `landing.html`, product app screens, platform screens, or OS widgets into one route.
3. Extract a token table from CSS/root styles and inline styles before building framework components.
4. Build product screens and domain-specific in-app modules from largest layout regions down to controls; avoid starting with isolated atoms that lose spatial intent.
5. Port responsive behavior across the modern viewport matrix and test each semantic breakpoint before cleanup.
6. Port interactions and states, then replace static placeholders only with real app data or functional equivalents.
7. Keep optional landing page and OS widget surfaces as separate surfaces if present.
8. Compare final screenshots against the export at 360×800, 390×844, 430×932, 820×1180, 1024×768, 1366×768, 1440×900, and 1920×1080 before declaring done.

## Entry points
- `examples/meetless-prototype.html`
- `preview/app-surface.html`
- `preview/brand-assets.html`
- `preview/colors-primary.html`
- `preview/components-buttons.html`
- `preview/index.html`
- `preview/spacing-tokens.html`
- `preview/typography-specimens.html`
- `ui_kits/app/detail.html`
- `ui_kits/app/index.html`
- `ui_kits/app/library.html`
- `ui_kits/app/pairing.html`
- `ui_kits/app/recording.html`
- `ui_kits/app/sources.html`

## Styles
- `colors_and_type.css`
- `tokens.css`
- `ui_kits/app/app.css`

## Scripts/components
- None detected

## Assets and supporting files
- `assets/apple-touch-icon.png`
- `assets/assets.md`
- `assets/favicon-16.png`
- `assets/favicon-32.png`
- `assets/meetless-mark-128.png`
- `assets/meetless-mark-16.png`
- `assets/meetless-mark-192.png`
- `assets/meetless-mark-256.png`
- `assets/meetless-mark-32.png`
- `assets/meetless-mark-48.png`
- `assets/meetless-mark-512.png`
- `assets/meetless-mark-64.png`
- `assets/meetless-mark-light.svg`
- `assets/meetless-mark.svg`
- `context/provenance.md`
- `context/source-context.md`
- `DESIGN.md`
- `fonts/README.md`
- `preview/manifest.md`
- `README.md`
- `SKILL.md`
- `ui_kits/app/README.md`

## Coding checklist for AI tools
1. Inspect `preview/index.html` and `DESIGN-MANIFEST.json` first and identify reusable components before coding.
2. Implement each user-facing screen file as its own route/surface; keep launcher, landing, app, platform, and OS widget files separate.
3. Extract design tokens into the target stack: colors, type scale, spacing, radius, shadows, and motion.
4. Implement layout with real 2025–2026 responsive breakpoints, fluid type/spacing, and container-query-aware component behavior; test with no horizontal overflow.
5. Preserve interactive controls, hover/focus/pressed states, form behavior, validation, and copy actions where present.
6. Implement domain-specific in-app modules with real states; do not flatten them into generic cards.
7. Keep landing page, product screens, and OS widget/quick-access surfaces separate when present.
8. Confirm the production result visually matches the exported design before refactoring internals.
9. Reject implementation shortcuts that flatten the design into generic cards, generic gradients, placeholder stats, or framework-default typography.
10. If a detail is ambiguous, check `docs/product/` first. Keep exported
    HTML/CSS/JS behavior only when it does not conflict with product authority.
