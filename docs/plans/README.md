# Execution Plans

Execution plans are Git-native working memory for complex tasks. They preserve
enough context for another agent or human to resume work without reconstructing
intent from chat history or a partial diff.

## When To Create A Plan

Use an ephemeral plan for bounded, single-session work.

Create one durable plan when work spans sessions, coordinates contributors, has
meaningful dependencies or ordering, requires recovery steps, or would be unsafe
to resume from the diff alone.

Use `docs/templates/exec-plan.md` and place the file under `active/`.
For an explicitly authorized baseline-to-rerun Harness experiment, use
`docs/templates/harness-improvement.md` instead.

## Lifecycle

```text
docs/plans/active/<slug>.md
  -> update progress and decisions during implementation
  -> record final validation and result
  -> move to docs/plans/completed/<slug>.md
```

The plan is the primary task artifact. Promote a lasting product or architecture
decision into `docs/decisions/`; keep task-local choices in the plan.

## Active Plans

- [Meetless V1](active/v1-paseo-foundation.md) — #12 closed by owner scope
  decision; remaining real quota validation is deferred to #19 (P2 / Later).
  #13 (P1) is next, after the current commit and workspace cleanup.

## Historical Evidence — Read Only When Needed

Current instructions live in the active plan and decision documents. Historical
briefs, pending actions and command sequences below are not instructions to resume.

- [Issue #8 save validation, 2026-09-12](history/issue-8-save-validation-2026-09-12.md)
  — exact source/artifact results and the failed legacy recovery attempt.

- [Meetless V1 through 2026-09-12](history/v1-paseo-foundation-through-2026-09-12.md)
  — exact pre-cleanup active plan, including unfinished work; historical
  evidence, not completion or current execution authority.

## Completed Harness Improvements

- [Correlated Electron recording proof](completed/post-m3-electron-harness-improvement.md)
  — kept after a materially equivalent fresh-agent rerun exercised the bounded
  POC capability without owner intervention.

## Completed Product History

- [Meetless V1 foundation, M0–M6, and new design](completed/v1-paseo-foundation-m0-m6.md)
  — accepted decisions, candidates, validation, recovery evidence, and the
  authority-path reorganization record before M7.
- [Meetless V1 release-readiness and TCC history](completed/v1-paseo-foundation-m7-accepted-history.md)
  — absorbed M7/TCC execution ledger preserved as evidence after plan
  reconciliation.
- [Meetless V1 MAS UI closeout history](completed/v1-paseo-foundation-mas-ui-history.md)
  — full superseded execution record through the accepted visible/interactable
  MAS development UI handoff.
- [Meeting library and chat implementation history](completed/meeting-library-chat-controls-implementation-history.md)
  — absorbed implementation, deletion, chat/design, and owner-retest evidence.
- [Meeting library and chat owner acceptance](completed/meeting-library-chat-controls.md)
  — final installed-UI acceptance for stale failed-Recording deletion.
