# assets/

Vector brand assets for the Meetless design system. The source project is
wireframe-fidelity (CSS-only mark, no raster output), so all assets here are faithful
vector re-renders of the source's declared shapes.

## Files

| File | Use |
|---|---|
| `meetless-mark.svg` | Brand mark — 18px (scaled) indigo rounded square with dark inset cutout, as defined by the prototype's `.brand .mark` rule. Use at 16–20px in app chrome; `border-radius:5px` quality preserved via `rx="18"` at 64px export. |
| `meetless-mark-light.svg` | Identical mark for light-field preview surfaces and documentation. The mark reads on both canvases because the accent square carries the brand.
| `meetless-mark-512.png` | Raster brand mark — the primary vector mark rasterizes.
| `meetless-mark-*.png` | 16/32/48/64/128/256 icon-size raster set (from the vector geometry).
| `favicon-16.png` / `favicon-32.png` | Standalone favicon-sized marks for linkage.
| `apple-touch-icon.png` | 180px iOS/app-icon tile from `meetless-mark-192.png`. |

## Usage

```html
<img src="../../assets/meetless-mark.svg" alt="Meetless" width="18" height="18"/>
```

Keep the cutout ratio at roughly 44% insets as in the source. Do not recolor the mark;
`#5e6ad2` and `#08090a` come from the token contract (`--accent`, `--bg`).

## Notes

- No photographic or raster brand imagery exists in the source artifact; the vector mark
  is the captured brand evidence. Provenance: `context/provenance.md`.
- App-chrome icons (play, pause, record, pairing, etc.) live in `../build/icons.svg`, not
  here.