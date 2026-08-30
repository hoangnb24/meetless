# Meetless Design System

> Web Prototype Design System — dark neutral UI with a restrained Linear-blue action accent
> Surface: web · Container: locally-run application
> Source: Open Design project `Web Prototype` (ae91ec19) · bound system `linear-app`

The Meetless design system is the visual contract for a local-first meeting recorder
and knowledge tool. It carries the calm, dense, dark-neutral language of Linear onto an
app whose job is capturing, transcribing, and grounding Q&A on one user's own meetings.
One high-contrast indigo action is the only strong color; the rest of the canvas stays
neutral so long transcripts and trusted evidence stay readable and calm.

This document is the visual contract for generated surfaces. Bind its tokens;
do not invent hex values or typefaces outside the system. It does not define
product behavior. See [`docs/product/`](../docs/product/README.md) for accepted
consumer behavior and UX.

---

## Source context

- **Source project:** Web Prototype · `ae91ec19-7755-45b8-bda5-5d0fe64227dd` · kind `prototype` ·
  fidelity `wireframe` · design-system project `e9b017e6-…`
- **Bound system:** `linear-app` (Linear dark-neutral; accent indigo `#5e6ad2`).
- **Evidence:** `examples/meetless-prototype.html` preserves the full interaction
  prototype. [`docs/product/experience.md`](../docs/product/experience.md) describes Meetless — a local-first meeting
  recorder: desktop captures mic + system audio to a local MP3, transcribes privately
  after one-time consent, and grounds Ask answers only on the open meeting transcript
  with validated citation playback.
- **Fidelity note:** the source ships no raster imagery (wireframe-grade); generated
  surfaces keep the neutral shell and vector marks.

---

## 1. Visual theme & atmosphere

- **Mood:** calm, private, recoverable, lightly technical. The user must always know
  *what is happening*, *whether their recording/meeting is safe*, and *what to do next*.
- **Canvas:** near-black neutral (#08090a) with hairline `<div class="hairline">` chrome.
  Raised wells, sheets and surfaces are barely-lighter neutrals separated by borders, not
  heavy shadow.
- **Accent:** one indigo (#5e6ad2) reserved for the primary action and the active
  selection. It appears at most twice per screen.
- **Density:** dense but readable. Meeting rows, transcript segments and chat turns use
  compact rhythm with clear row spacing, never crowded.
- **Fidelity context:** the source prototype is wireframe-grade — components carry no
  raster imagery. Generated surfaces should preserve the calm neutral shell and use
  supported vector marks, not invented photographic content.

## 2. Color

| Token | Role | Value |
|---|---|---|
| `--bg` | app canvas | `#08090a` |
| `--surface` | sheets, wells, modals | `#191a1b` |
| `--fg` | primary text | `#f7f8f8` |
| `--fg-2` | secondary text | `#d0d6e0` |
| `--muted` | tertiary text / hints | `#8a8f98` |
| `--meta` | metadata, timeline | `#62666d` |
| `--border` | structural border | `rgba(255,255,255,.08)` |
| `--border-soft` | faint divider | `rgba(255,255,255,.05)` |
| `--accent` | primary action | `#5e6ad2` |
| `--accent-hover` | hover / links | `#828fff` |
| `--accent-active` | pressed | `#4752c4` |
| `--accent-on` | text on accent | `#ffffff` |
| `--success` | ready, host online | `#27a644` |
| `--warn` | needs attention | `#eab308` |
| `--danger` | destructive | `#dc2626` |

**Rules**

- Contextually derived colors are made with `color-mix(in oklch, ...)` off a token —
  never hand-picked hex.
- Danger *text* is lightened to `color-mix(in oklch, var(--danger) 74%, var(--fg))`
  because raw `--danger` sits at ~4.13:1 on the canvas. Keep it ≥4.5:1.
- `--accent` appears at most twice per screen (primary action + active selection). All
  other emphasis is hierarchy via `--fg`/`--fg-2`/`--muted`.
- Hover raises a surface by moving its background **0.06–0.12 on the OKLch L channel**,
  never by washing the foreground toward the canvas.
- Disabled is the only state allowed to reduce contrast (`opacity .45`).
- **`--meta` is a read-only caption token.** At ~3.45:1 it does not clear WCAG AA for *normal*
sized text, so it must only be used for large/decorative metadata: mono timestamps in
transcript segments, the recording-strip elapsed clock, and timeline labels. Never render
`--meta` as body or normal-size text; use `--muted` (≥4.5:1) for anything the user must read.
If a consuming surface needs the metadata felt in smaller or body-weight, derive a lighter
tier with `color-mix(in oklch, var(--meta), var(--fg) 14%)` instead of hand-picking hex.

## 3. Typography

The source is a data-dense app, so a single sans family (Inter Variable / Inter) carries
both display and body per the system's utilitarian exemption. A distinct mono
(Berkeley Mono) is reserved for time codes, identifiers, metadata and tabular numerals —
this is the "second face" that gives the system its character.

| Role | Stack | Notes |
|---|---|---|
| Display | `--font-display` (Inter Variable) | weights 510, tight `-0.022em` tracking |
| Body | `--font-body` (Inter Variable) | 14–16px, `line-height 1.5` |
| Code / mono | `--font-mono` (Berkeley Mono) | timestamps, ids, labels, tabular-nums |
| Caption | Inter 12px, muted | hints, sub-rows |
| Overline | Berkeley Mono 11px uppercase | pane titles, section labels |

- Weight cap `590`; Linear never go heavier. Bold text uses a synthetic 590.
- Body does not use a pure `--bg` scale ramp jump: use `--fg → --fg-2 → --muted → --meta`.
- Display always lets the column: letter-spacing is tight, but sizes respect the available
  measure (never cut by `white-space: nowrap`).

## 4. Spacing, density, radius, rhythm

- **Base unit 4px.** Scale: 4, 8, 12, 16, 20, 24, 32, 48, 80.
- **Density:** rows pad 9–12px vertical; panes 24px; compact surfaces 14px.
- **Radius:** `--radius-sm 6px` (buttons, chips, rows), `--radius-md 8px` (cards), `--radius-lg 12px` (panels, sheets), `--radius-pill` (status chips, segments).
- **Section rhythm:** desktop 80px, tablet 48px, phone 32px vertical section spacing.
- **Touch:** buttons 44px min on phone; hover/focus states always ≥4.5 target.

## 5. Layout & composition

The app is a **three-tier responsive shell**.

| Tier | Width | Behavior |
|---|---|---|
| **Desktop** | ≥1120px | top bar + rec strip, `272px` library sidebar, transcript\|ask split |
| **Tablet** | 640–1119px | library stays, detail shows one task under a stable header |
| **Phone** | ≤639px | full-screen list, sidebar hidden, tab switch, back to list |

- **App shell:** top bar 52px (brand + host chip) → optional recording strip 56px
  (route-independent) → main row (sidebar + content).
- **Library** (wide): grouped by day, compact rows with title, date, duration, status dot.
- **Detail:** persistent meeting header; wide shows Transcript (1.28fr) | Ask (1fr) panes.
- The **recording control** stays visible independent of navigation — never framed as a
  per-meeting control.
- On phone the transcription/ask content never scrolls horizontally; it re-flows.

## 6. Components

- **Buttons:** primary (accent), secondary (surface chip), ghost, danger-text. Sizes
  sm 30 / base 36 / lg 42px. One primary CTA per single action.
- **Brand mark:** 18px rounded indigo square with inset cutout; mono word inside/next.
- **Host chip:** status pill (dot + label) reflecting `Host online/offline/starting`.
- **Recording strip:** live pulsing dot, title, mono elapsed clock, then Pause/Stop;
  Paused keeps one dominant Resume and fades the live dot. Never disappears mid-navigation.
- **Meeting row:** title (13.5), second line metadata + duration + status dot.
- **Status dot/state:** Ready (green), Transcribing (pulsing indigo), Needs attention
  (amber), Saving audio (indigo), offline (muted).
- **Panel / sheet / modal:** centered canvasless sheet (bg `--surface`), used for setup,
  saving, pairing and model picker.
- **Source row (recording setup):** name + description + proposed tag + state dot, or a
  repair action (Open System Settings / Recheck).
- **Transcript segment:** mono timestamp + body cell; hover, selected, played,
  and highlight states. Citation evidence shows the validated range and a
  **Play from here** action.
- **Ask thread:** distinct user turn (indigo bubble) vs assistant turn (plain);
  citations chips beside claims; evidence card with validated segment + "Play from here".
- **Playback state:** show the selected or played segment and bounded range as
  text. Do not show playback Pause, Stop, seek, or progress controls.
- **Field/input:** 44px field, `--border`, focus accent ring; invalid → danger border.

### Chat popup and scroll contract

- Model, thinking-level, dynamic feature-select, and legacy provider/model
  popups use one shared presentation owner. Consumer data, selection state, and
  callbacks remain outside that owner.
- On desktop and tablet, chat popups render in one fixed viewport layer. Their
  measured content stays at least 12px from every viewport edge, uses an 8px
  trigger gap, prefers placement above the trigger, and falls below when the
  measured content cannot fit above.
- Popup height is constrained by available viewport space. Overflow scrolls
  inside the popup; a popup must not create page-level scrolling, clipped rows,
  trailing blank space, or an independent browser scrollbar.
- On phone, the same presenter renders a viewport-bounded bottom sheet with a
  dismissal backdrop and 44px minimum interaction targets.
- Outside interaction and Escape dismiss every chat popup. Focus remains within
  the open popup, returns to its initiating trigger on close, and open popups
  reposition after viewport resize.
- A chat popup must not own independent absolute/downward-only geometry or a
  duplicate dismissal/focus lifecycle. The Paseo-aligned reference behavior is
  `design/examples/provider-model-controls.html`; implementation recovery is
  tracked by `docs/plans/active/chat-overlay-scroll-foundation.md`.

## 7. Motion & interaction

- **Timing:** `--motion-fast 150ms`, `--motion-base 200ms`, `cubic-bezier(.2 0 0 1)`.
- **Loops:** `pulse` (record dot / starting), `pulse-work` (transcribing / now-step),
  `spin` (spinner).
- **Focus:** every focusable control shows the indigo ring (`--focus-ring`); the
  `:focus-visible` state always raises text contrast, never lowers it.
- **Interaction:** hover/active adjust the surface L by 0.06–0.12, or swap border/shadow.
  Focus always shows the indigo ring. Active on buttons shifts 1px.
- **Reduced motion:** media query kills all loops and transforms.
- **Recovery concurrency:** the Transcript and Ask states animate in place (answer
  location), not a detached global spinner.
- Bounded playback can mark the segment played after the interval ends.

## 8. Voice & brand

- **Tone:** calm, private, recoverable; always one-person local ownership, never marketing.
- **Terminology (locked uppercase labels):** **Meeting**, **Transcript**, **Ask**,
  **Pause**, **Stop**, **Resume**, **Host offline**, **Retry**, **Try again**,
  **Record meeting**, **Saving local audio**, **Needs attention**.
- **State-as-language:** replace raw lifecycle values with meaningful task language —
  *Saving audio*, *Transcribing*, *Ready*, *Needs attention*.
- **Reassurance:** every error states that a saved recording remains safe; every
  destructive exit names the discard; offline is a distinct state, never an "empty" list.
- Copy stays short, imperative, and does not expose daemon/provider/request/technical
  counts.

## 9. Interaction & state rules

- One recording entry — do not keep a separate "create meeting" task in the library.
- `Stop` transitions straight to *local saving*; only a destructive discard requires a
  guard.
- The meeting list stays stable on wide while the detail changes.
- Ask is **meeting-scoped**: answers are grounded only on the open meeting's transcript.
  Progress reads in the answer location ("Searching transcript…", "Checking evidence…").
- Citations sit beside claims; activating one reveals the validated transcript segment
  and a **Play from here** action — never a model-invented timestamp.
- Failure stays attached to its operation (retry only that citation / question / save);
  valid prior content is preserved.
- Companion offline is explicit: known rows visible but disabled; validation required
  before actions re-enable.

## 10. Anti-patterns

Do **not**:

- Use a second primary CTA for the same action in one viewport, or a gradient wash on the
  base canvas.
- Treat the recording as an independent "Create meeting" + "Start recording" pair — one
  action.
- Hoist host/daemon/provider/model/request lifecycle text
  over user content.
- Expose the full model inventory as rows of buttons; keep provider/model compact.
  chip.
- Label source readiness as fact when the runtime cannot truthfully report it (mark as
  **Proposed**).
- Render host-offline as a valid empty meeting list — keep known rows, mark offline.
- Send the transcript behind raw status (`DRAFT`, `PROCESSING`); use task language.
- Cover a citation claim with model-written timestamps as trusted identity.
- Use warm beige, or emoji as functional icons, or hand-drawn surfaces where the calm
  accent system suffices.

---

## Provenance

- Source project: **Web Prototype** `ae91ec19-7755-45b8-bda5-5d0fe64227dd`
- Bound system: `linear-app` (Linear dark-neutral; accent indigo `#5e6ad2`).
- Source artifact: `examples/meetless-prototype.html` (full interaction prototype).
- Product detail: [`docs/product/experience.md`](../docs/product/experience.md)
  preserves the full accepted UX spec sourced from the original project.
- Derived token set: `tokens.css` (verbatim), `colors_and_type.css` (production), bound
  into `ui_kits/app/*` and `preview/*`.
- Assets: `assets/*` contains vector and raster marks; `fonts/README.md` describes the
  Inter / Berkeley Mono pairing.
