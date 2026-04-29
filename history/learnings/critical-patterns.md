# Critical Patterns

Promoted learnings from completed features. Read this file at the start of every
planning Phase 0 and every exploring Phase 0. These are the lessons that cost the
most to learn and save the most by knowing.

---

## [20260425] Shell-First Revamps Need Explicit File Ownership
**Category:** pattern
**Feature:** meetless-ui-ux-revamp
**Tags:** [ui-revamp, swiftui, beads]

The Meetless UI revamp completed cleanly because the shared shell and visual primitives landed before individual screens were polished. SwiftUI revamps often touch the same root, token, and feature-view files, so future multi-screen UI work should sequence shell first, then primary flow, then secondary surfaces, with explicit file ownership and dependency order for every bead.

**Full entry:** history/learnings/20260425-ui-revamp-source-boundaries.md

## [20260425] Hiding Internal Model Labels Requires Full Display-Path Audit
**Category:** failure
**Feature:** meetless-ui-ux-revamp
**Tags:** [source-boundaries, ux-copy, review]

The revamp removed obvious `Meeting` / `Me` source-lane UI, but review found a saved-detail notice path where persisted text could still expose `Me lane ...`. When a UI must hide or translate internal model labels, audit every user-facing path: badges, notices, previews, warnings, generated descriptions, and persisted detail text. Prefer explicit display copy from state over partial string replacement.

**Full entry:** history/learnings/20260425-ui-revamp-source-boundaries.md
