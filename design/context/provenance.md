# Provenance — Meetless / Web Prototype Design System

This document records exactly where every token, asset, and component in this package
came from, so reviewers can trust the system's fidelity to the source.

## Source project

- **Source project id:** `ae91ec19-7755-45b8-bda5-5d0fe64227dd`
- **Source project name:** Web Prototype
- **kind:** `prototype` · **fidelity:** `wireframe`
- **Bound design system id:** `linear-app`
- **New design-system project:** `e9b017e6-dbd2-468a-ada9-9e5e1c02d621`

## Copied source files (evidence)

| File | Role | Preserved as |
|---|---|---|
| `meetless-prototype.html` | Full interaction prototype (1321 lines) | `examples/meetless-prototype.html` |
| `PRODUCT.md` | Product UX spec (record → process → read → ask → evidence) | `context/product-source.md` |

Both were copied verbatim from the source workspace and remain source evidence, not
generated output.

## Token traceability

The entire color/type/spacing/radius/elevation/motion contract in `tokens.css` is lifted
verbatim from the source prototype's `:root` block, which its original author bound
directly from the `linear-app` design system.

| Token family | Source |
|---|---|
| Dark neutrals `--bg` `--surface` `--fg` `--fg-2` `--muted` `--meta` | Linear dark shell |
| `--border` / `--border-soft` hairlines | Linear chrome |
| `--accent` `#5e6ad2` + hover/active/on | Linear indigo action |
| `--success` `#27a644` `--warn` `#eab308` `--danger` `#dc2626` | state semantics |
| `--font-display`/`body` Inter Variable, `--font-mono` Berkeley Mono | Linear type pairing |
| Radius 6/8/12/pill, 4px spacing, 150/200ms motion | Linear rhythm |

`colors_and_type.css` re-exports the contract as production classes; it adds no new
palette values.

## Asset provenance

- `assets/meetless-mark.svg` — reconstructed vector for the source prototype's brand mark
  (18px rounded indigo square with inset cutout, brand word). The source defines the mark
  only in CSS, so the SVG is a faithful vector re-render of that same shape, not a new logo.
- `assets/meetless-mark-light.svg` — same mark on a light field for preview palettes.
- `build/icons.svg` — a semantic icon sprite for app chrome (recording, mic, system,
  play, pause, stop, link, cite, back). The source uses text/glyph markers, so this icon set
  is a designed rebuild of the *roles* the prototype conveys, not an extracted asset.
- No raster imagery exists in the source (wireframe fidelity); therefore `assets/` holds
  vectors only. This is a documented limitation, not a loss.

## Fonts

- Display + body: **Inter Variable / Inter** (loaded via Google Fonts by the source).
- Mono: **Berkeley Mono** (fallback `ui-monospace`). See `fonts/README.md`.

## Assumptions recorded

- The source has no product logo file, animation files, or photographic assets; the
  package preserves the captured vector-equivalent marks and icon sprite in their place.
- Colors were read directly from `tokens.css`-equivalent values in the prototype; nothing
  was invented.