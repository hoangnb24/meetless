# Source Project Context

This design-system workspace was created from an existing Open Design project. Treat the copied project files as the primary source evidence for the generated design system.

## Source project

- Source project id: ae91ec19-7755-45b8-bda5-5d0fe64227dd
- Source project name: Web Prototype
- New design-system project id: e9b017e6-dbd2-468a-ada9-9e5e1c02d621
- New design-system id: user:web-prototype-design-system
- Source skill id: (none)
- Source design system id: linear-app

## Source metadata

```json
{
  "kind": "prototype",
  "fidelity": "wireframe",
  "nameSource": "prompt",
  "localCatalogScopes": {
    "designSystem": {
      "workspaceId": "voqns9dl45z8so9va0g8droq",
      "workspaceMemberId": "wrj7ltrinrdnc2cnzetc3qf0"
    }
  }
}
```

## Original copied files

- meetless-prototype.html
- PRODUCT.md

The prototype is retained once at `../examples/meetless-prototype.html`.
The product spec moved to `../../docs/product/experience.md`, which is now the
sole product and UX authority. Exact duplicate package copies were removed on
2026-08-24 without changing their content.

## Skipped files

- (none)

## Generation contract

- Read this file before editing design-system outputs.
- Read the retained prototype and current product authority directly; they are
  source evidence, not generated design-system output.
- Preserve high-signal assets, source examples, UI surfaces, copy, tokens, typography, and interaction patterns from the copied project.
- Generate a reusable Open Design design-system package in this same project:
  DESIGN.md, README.md, SKILL.md, colors_and_type.css, context/provenance,
  focused preview cards, preserved assets and fonts when available, and
  ui_kits/app/.
- Before final response, run `"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings` and fix every actionable issue.
