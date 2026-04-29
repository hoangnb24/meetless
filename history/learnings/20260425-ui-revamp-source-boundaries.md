---
date: 2026-04-25
feature: meetless-ui-ux-revamp
categories: [pattern, decision, failure]
severity: critical
tags: [ui-revamp, swiftui, source-boundaries, layout, verification, beads]
---

# Learning: Shell-First Revamps Need Explicit File Ownership

**Category:** pattern
**Severity:** critical
**Tags:** [ui-revamp, swiftui, beads]
**Applicable-when:** Running a multi-screen UI refresh where several views share navigation, spacing, toolbar, or design-token changes.

## What Happened

The Meetless revamp finished cleanly by landing the shared app shell before polishing individual screens. Phase 1 created the sidebar shell, visual primitives, and existing-view embedding; Phase 2 rebuilt Record/Recording; Phase 3 rebuilt Saved Sessions/Detail. The story maps also assigned sequential file ownership, for example shell routing before primitives before feature embedding, and History before Detail before saved warnings.

## Root Cause / Key Insight

SwiftUI screen revamps are tightly coupled: root composition, design tokens, feature views, and view-model display helpers often live close together. Treating that work as fully parallel creates same-file conflicts and inconsistent visual language. A shell-first order gives every later story a stable frame and makes review easier because behavior preservation and visual polish are separated.

## Recommendation for Future Work

When revamping multiple app screens, first create the shared shell and tokens, then move the primary daily-use flow into it, then polish secondary surfaces. Assign explicit file ownership and dependency order for every phase; do not parallelize beads that touch the same SwiftUI root or feature view unless the write scopes are truly disjoint.

---

# Learning: Preserve Behavior Services During Visual Revamps

**Category:** decision
**Severity:** standard
**Tags:** [ui-revamp, behavior-preservation, swiftui]
**Applicable-when:** Existing product behavior is already working and the requested change is visual or interaction restructuring.

## What Happened

The revamp preserved `AppModel`, view models, recording services, session repository, capture, whisper, and persistence behavior while replacing the user-facing SwiftUI surfaces. The nine implementation commits from `2022672` through `fbf4459` stayed scoped to the shell, view composition, design primitives, and UI-facing display helpers. Review could therefore focus on the four user-facing surfaces and the V1 contract rather than revalidating the recorder engine.

## Root Cause / Key Insight

The risk in a product UI revamp is accidentally turning style work into a behavior migration. By keeping proven services intact, the team preserved Start/Stop, permission repair, live transcript, saved history, detail loading, and delete behavior while still making the app feel materially different.

## Recommendation for Future Work

For visual revamps over verified behavior, start by naming the services and view models that must stay stable. Require validation before changing recording, persistence, capture, sync, or domain services; prefer small display adapters over service rewrites.

---

# Learning: Hiding Internal Model Labels Requires Full Display-Path Audit

**Category:** failure
**Severity:** critical
**Tags:** [source-boundaries, ux-copy, review]
**Applicable-when:** The UI must hide or translate internal domain labels while preserving the underlying data model.

## What Happened

The revamp removed primary `Meeting` / `Me` source-lane cards and transcript badges, but review found a remaining saved-detail notice path where persisted text could still say `Me lane ...`. `SessionDetailViewModel.sanitizedSourceText` replaced strings like `Meeting source`, `Me source`, and `Meeting`, but missed standalone persisted wording forms. This became P2 follow-up `bd-ugr` instead of blocking the finished revamp.

## Root Cause / Key Insight

The UI contract was checked against visible labels and obvious row badges, but user-facing text can also come from notices, warning details, persisted messages, previews, and generated descriptions. A display shim that only replaces the most obvious labels is fragile when underlying persisted text remains intentionally source-aware.

## Recommendation for Future Work

When hiding internal model terms from the primary UI, audit every user-facing display path: titles, subtitles, row labels, warnings, notices, empty states, previews, persisted detail text, and generated status messages. Prefer building explicit display copy from state over broad string replacement when the wording has to satisfy a product contract.

---

# Learning: Fixed-Column macOS Rows Need Minimum-Width Budgeting

**Category:** failure
**Severity:** standard
**Tags:** [layout, swiftui, review]
**Applicable-when:** Building compact table-like rows inside a fixed-minimum macOS window or custom app shell.

## What Happened

Review found that the compact Saved Sessions row was slightly wider than the app canvas at the declared minimum window width. The app declares `minWidth: 960`, the shell uses a 190-point sidebar and 28-point horizontal content padding, and the History table combines fixed column widths plus gaps that require about 718 points before row padding. The available canvas at minimum width is about 713 points, so the row can clip or squeeze at a supported size.

## Root Cause / Key Insight

Each layout decision was locally reasonable, but the full width equation was not checked against the shell's minimum size. SwiftUI may compress or clip quietly, so a build/test pass is not enough to prove compact table rows fit.

## Recommendation for Future Work

For fixed-column rows, calculate the width budget before review: window minimum minus sidebar, dividers, content padding, fixed columns, gaps, and action controls. Add a minimum-width screenshot or manual smoke check when the UI uses table-like rows inside a custom shell.

---

# Learning: Native macOS Visual Smoke May Need Human UAT When Automation Permissions Block

**Category:** failure
**Severity:** standard
**Tags:** [verification, macos, uat]
**Applicable-when:** Verifying native macOS SwiftUI UI flows from an agent environment with unknown Accessibility or Assistive Access permissions.

## What Happened

Worker runs could not fully complete scripted native UI navigation and screenshot smoke checks because macOS automation hit Assistive Access limits. The team still ran `xcodebuild test -project Meetless.xcodeproj -scheme Meetless -destination 'platform=macOS'`, reviewed artifacts, and completed human UAT for all four surfaces.

## Root Cause / Key Insight

Native macOS UI automation depends on local permissions that may not be granted to the agent process. Build/test verification can prove compile and model-level behavior, but it cannot prove visual fit or interaction feel when automation cannot drive the app.

## Recommendation for Future Work

When macOS UI automation is blocked by permissions, record that limitation explicitly and pair automated build/test with targeted human UAT. Do not imply screenshot or navigation verification happened if the automation could not actually drive the app.
