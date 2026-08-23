---
name: meetless-design-system
version: 1.0.0
image: Web Prototype
user-invocable: true
description: Reusable Open Design package for a calm dark-neutral, Linear-family web UI for local-first meeting recording, transcription, grounded Q&A, and companion pairing. Sources tokens from tokens.css / colors_and_type.css.
---

# Meetless Design System — Skill

This skill directs how to generate surfaces with the **Meetless** design system (a
Linear-derived dark-neutral web prototype language). Read `DESIGN.md` first, then bind the
package as described here.

## What is inside

- **`tokens.css`** — verbatim token contract (paste first).
- **`colors_and_type.css`** — self-contained colors + typography (Inter Variable /
  Berkeley Mono).
- **`DESIGN.md`** — authority: theme, color, type, spacing, layout, components, motion,
  voice, anti-patterns.
- **`ui_kits/app/`** — applied interface kit (library, detail, recording, sources, pairing).
- **`preview/`** — review cards (color, typography, spacing, components, brand, applied
  surface).
- **`assets/`, `build/`, `fonts/`** — preserved vector mark, icon sprite, font pairing.
- **`examples/`** — the full preserved source prototype.

## Source context

Derived from Open Design project **Web Prototype**
(`ae91ec19-7755-45b8-bda5-5d0fe64227dd`, kind `prototype`, wireframe fidelity), bound
system **`linear-app`**. The copied evidence (prototype + product spec) describes
**Meetless** — a local-first meeting recorder owning local audio, private transcription,
meeting-scoped Ask, and cited playback. See `context/source-context.md` and
`context/provenance.md`.

### Reusable product block (drop into any consumer project)

Copy the following constraints verbatim when binding this system elsewhere; they are
domain-evidence, not re-derived assumptions:

- **Local-first.** The host owns the MP3 on this computer; capture uploads nothing until the
  one-time cloud-consent path is taken. Never imply server-side files.
- **One meeting owner.** A solo local workflow, not a team project surface.
- **Ask is meeting-scoped.** Answers ground only on the open meeting's transcript; progress
  and failures read in the answer location — never as a global spinner or detached toast.
- **Citations are trusted.** Activating a claim reveals the *validated* transcript segment
  and a **Play from here** action. Never attach a model-invented timestamp as identity.
- **State-as-language.** Use *Saving audio*, *Transcribing*, *Ready*, *Needs attention* —
  never raw lifecycle values (`PROCESSING`, `DRAFT`) or host/provider/daemon/request counts.
- **Offline is distinct, not empty.** Keep known rows visible and disabled while companion
  HTTPS and validation recover — never show an empty list.
- **One recording action.** There is no separate "Create meeting" + "Start recording" pair.

## When to use

- Any web surface for a personal, local-first meeting product: recording, transcript,
  grounded Q&A, playback, companion pairing.
- Any prototype that should speak the calm, dense Linear-family dark-neutral language
  with a single restrained indigo action.

## How to use

1. Read `DESIGN.md` from this package.
2. Start generated HTML with a `<style>` whose first block is a verbatim copy of
   `tokens.css`. Do not re-author the palette.
3. Link `colors_and_type.css` for production type/color classes, or copy its rules in.
4. Clone component shapes from `ui_kits/app/` before building new ones.
5. Set up layout by the three tiers (desktop ≥1120 / tablet 640–1119 / phone ≤639).

## Design-system highlights

- **One indigo action** (`#5e6ad2`) at most twice per screen; neutral dark canvas
  (`#08090a`) with hairline chrome.
- **Type & interaction:** Inter Variable display+body (weight cap 590), Berkeley Mono for
timecodes, IDs and metadata.
- **Layout:** dense 4px unit, 9–12px rows, route-independent recording strip.
- **Recovery voice:** state-as-language (Saving audio, Ready, Needs attention), never
host-offline as an empty list.

## Anti-patterns to avoid

- Two primary CTAs for one action in a viewport; gradient wash on canvas.
- A separate "Create meeting" entry alongside Record meeting.
- Host/daemon/provider/model/request counts leaked into user content.
- Full model inventory as primary buttons.
- Source readiness stated as fact unless runtime-backed (**Proposed** tag).
- Host-offline rendered as an empty meeting list.
- Raw lifecycle statuses instead of task language.
- Model-invented timestamps presented as citation identity.

## Reduced motion

Support `@media (prefers-reduced-motion: reduce)` — kill `pulse`, `pulse-work`, `spin`
loops and button press transforms.

## Verification

Before delivery, run the package audit:

```bash
"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings
```

Fix every error and actionable warning; keep README/DESIGN/preview manifest/ui_kits kit
synchronized with the final file structure.