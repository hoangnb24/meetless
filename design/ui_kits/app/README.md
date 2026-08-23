# ui_kits/app — Applied interface kit

A working, token-bound interface kit for the **Meetless** design system. It reuses the
component shapes from the preserved prototype (`examples/meetless-prototype.html`) as
clean, static surfaces you can remix into real app UI.

## Reuse guide

1. Open `index.html` — sidebar + live iframe of each screen. **Start here.**
2. Copy a screen (`library.html`, `detail.html`, etc.) into your own shell.
3. Keep the topbar + optional recording strip as persistent chrome on wide; swap the
   transcript|ask split for one task at a time below 1120px.
4. Replace sample rows/chips with your data — tokens and `app.css` carry the styling.

## Source basis

Rebuilt from the preserved source prototype (`examples/meetless-prototype.html`) on the
same `linear-app` dark-neutral tokens. `index.html` loads `colors_and_type.css` and the
screens load `app.css`; all load `tokens.css`.


## Files

| File | Purpose |
|---|---|
| `index.html` | Kit launcher — sidebar + live iframe of each screen. **Start here.** |
| `app.css` | Shared component styles (topbar, rec strip, buttons, sidebar, rows, panes, transcript, ask, evidence, fields, sheets). Token-bound; import after `tokens.css`. |
| `library.html` | Desktop meeting library (shell + sidebar + empty state). |
| `detail.html` | Wide detail — Transcript \| Ask split with citations + evidence card. |
| `recording.html` | Route-independent recording strip + setup panel. |
| `sources.html` | Recording source rows — ready + blocked states, Proposed tag, repair action. |
| `pairing.html` | Companion encrypted-relay pairing with Direct LAN fallback. |
| `README.md` | This guide. |

## How to use

1. Link `tokens.css` (from package root) then `app.css`.
2. Paste a surface into your own shell; keep the topbar + optional recording strip as the
   persistent chrome on wide.
3. Follow `DESIGN.md` for layout tiers and voice; clone shapes here before inventing new
   ones.

## Layout tiers

- **Desktop ≥1120:** sidebar library + split detail (transcript \| ask).
- **Tablet 640–1119:** library retained; one task at a time under a stable meeting header.
- **Phone ≤639:** full-screen list; tab Transcript/Ask; `App`-shell reflows, never scrolls
  horizontally.

## Component map

Each screen composes named components (shell/sidebar/turn/evidence). When you extend the
kit, keep each reusable component file under `components/` and continue importing `app.css`.

- Buttons: `.btn-primary/.secondary/.ghost` + `.btn-sm 30 / .btn-lg 42`.
- `.host-chip` status pill, `.rec-strip` (live dot, mono clock, Pause/Stop).
- `.meet-row` + `.st` status dot; `.source-row` + `.proposed-tag`.
- `.turn user/assistant`, `.cite`, `.evidence`, `.ask-composer`.
- `.panel`, `.field`, `.input`, `.notice`, `.sheet`.

## Sync

Keep `README.md` aligned with the file set above and with the package README/preview
manifest whenever screens are added or renamed.