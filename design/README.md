# Meetless Design System (Web Prototype)

A reusable Open Design design-system package derived from the **Web Prototype** project
and its bound **Linear-app** system, applied to **Meetless** — a local-first meeting
recorder and grounded-Q&A tool.

This package defines visual implementation and preserves visual evidence only.
It does not define product behavior. The accepted consumer behavior and UX live
in [`docs/product/`](../docs/product/README.md).

## Visual context

The prototype depicts a personal, local-first meeting recorder and knowledge tool. Designed
for a focused local-work control surface, the desktop host records Zoom/Google Meet,
keeps a local MP3, transcribes it privately (after one-time cloud-consent), and grounds
answers only on the open meeting's timed transcript.
The core loop is `Record → Process → Read transcript → Ask → Check and play evidence`.
Primary surfaces: meeting library, recording setup + route-independent recording strip,
wide/narrow meeting detail (Transcript | Ask), citation evidence + **Play from here**, and
companion pairing / host-offline recovery.

## Visual summary

Calm dark-neutral canvas with one restrained indigo action (a Linear-derived language).
Dense but readable rows; a distinct mono face for time codes and metadata; clear
recovery-focused voice. See **DESIGN.md** for the complete visual contract.

## Package Contents

```
.
├── DESIGN.md            Visual contract — theme, color, type, spacing, layout, components, motion, voice
├── tokens.css           Verbatim :root token contract (paste first)
├── colors_and_type.css  Self-contained colors + typography
├── README.md            This file
├── SKILL.md             Generation guidance (YAML frontmatter)
├── context/             Source context and provenance
├── assets/meetless-mark.svg   Vector brand mark (dark + light)
├── fonts/README.md      Font pairing + licensing note
├── examples/            Preserved source prototype + focused Ask composer example
├── preview/             Review cards + gallery + manifest
└── ui_kits/app/         Applied interface kit (library, detail, recording, sources, pairing)
```

## Reuse workflow

1. **Review** — open `preview/index.html`. Start with **app-surface.html** (the preserved
   prototype loads live), then **color**, **typography**, **components**.
2. **Read** — `DESIGN.md` (visual language), `context/provenance.md` (traceability).
3. **Build** — paste `tokens.css` first, link `colors_and_type.css`, clone component
   shapes from `ui_kits/app/`.
4. **Verify** — run `design-system-package-audit --path . --fail-on-warnings` before
   delivery.

## Preview manifest

| Card | File |
|---|---|
| Applied UI surface | `preview/app-surface.html` |
| Ask composer · model picker | `preview/provider-model-controls.html` |
| Color | `preview/colors-primary.html` |
| Typography | `preview/typography-specimens.html` |
| Spacing · Radius · Elevation | `preview/spacing-tokens.html` |
| Components | `preview/components-buttons.html` |
| Brand | `preview/brand-assets.html` |

Gallery: `preview/index.html`.

## Source & provenance

From Open Design source project **Web Prototype**
(`ae91ec19-7755-45b8-bda5-5d0fe64227dd`, kind `prototype`, fidelity `wireframe`), bound
system `linear-app`. Source evidence preserved under `examples/` and `context/`. See
`context/provenance.md` for per-token traceability.

## Authoring rules (short form)

- Bind tokens; never introduce hex outside `tokens.css`/`colors_and_type.css`. Derive
  contextual color with `color-mix(in oklch, ...)`.
- One indigo accent per action surface; weight cap 590; Berkeley Mono for timecodes.
- One primary CTA per action; hover lifts surface L by 0.06–0.12, never the foreground
  toward the canvas.
- Keep the interface calm, private, recoverable, and always meeting-scoped.
