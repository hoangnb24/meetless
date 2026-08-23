# fonts/

The Meetless design system uses the Linear-family type pairing below. No font files are
bundled because the source project loads them from Google Fonts; these stacks are the
public contract.

## Stack (from `tokens.css`)

| Role | Stack |
|---|---|
| Display | `"Inter Variable", "Inter", "SF Pro Display", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif` |
| Body | `"Inter Variable", "Inter", "SF Pro Display", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif` |
| Mono | `"Berkeley Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace` |

## Loading (source-faithful)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap" rel="stylesheet" />
```

Use **Inter Variable** when the runtime offers it (axes: weight + width); the static
Inter file above is the source's own loading choice and fans out the same `--font-body`.

## Licensing note

- Inter (SIL Open Font License) and Berkeley Mono (SIL OFL, by Sam Berkhout) are both
  OFL-licensed — self-hosting is permitted. If you self-host, place the `.woff2`/`.ttf`
  files under this `fonts/` directory and `@font-face` them before tokens.
- No font bytes ship here; the source did not self-host. See `context/provenance.md`.