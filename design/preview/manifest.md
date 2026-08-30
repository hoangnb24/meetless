# Preview manifest — Meetless Design System

Review cards render the bound token contract and load the preserved source evidence.
Start reviewers at **Applied UI surface** (live prototype), then **Color** and
**Typography**.

## Preview cards (in `preview/`)

| Card | File | Loads |
|---|---|---|
| Applied UI surface | `app-surface.html` | **live iframe** of `examples/meetless-prototype.html` |
| Ask composer | `provider-model-controls.html` | **live iframe** of `examples/provider-model-controls.html` |
| Color | `colors-primary.html` | `tokens.css` + `colors_and_type.css` |
| Typography | `typography-specimens.html` | `tokens.css` + `colors_and_type.css` |
| Spacing · Radius · Elevation | `spacing-tokens.html` | `tokens.css` |
| Components | `components-buttons.html` | `tokens.css` (app shapes) |
| Brand | `brand-assets.html` | `assets/meetless-mark*.svg`, raster marks, apple-touch-icon |

## Gallery

- `index.html` — navigable preview library (sidebar + embedded cards / package docs).

## Source evidence

- `../examples/meetless-prototype.html` — full preserved interaction prototype, embedded
  by the applied-surface card.
- `../examples/provider-model-controls.html` — focused Ask composer prototype
  with a Paseo-aligned model picker, Thinking menu, Fast feature, and responsive
  desktop/mobile popup states.
- `../../docs/product/experience.md` — accepted product and UX authority outside
  this visual package.

## Synchronization

Update this manifest whenever cards are added/renamed or package docs change. Current
package structure: DESIGN.md, README.md, SKILL.md, tokens.css, colors_and_type.css,
assets/, fonts/, context/, examples/, preview/, ui_kits/app/.
