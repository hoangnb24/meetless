# Beads Governance Guide

This document defines how we decompose work, model dependencies, and preserve decision traceability for this repository.

## 1) Scope and Source of Truth

- Use `br` (beads_rust) as the issue and status source of truth.
- Use MCP Agent Mail for coordination, ownership signaling, and handoff context.
- Use `bv --robot-*` commands for prioritization and dependency-aware triage.
- Keep issue ids stable in coordination artifacts:
  - mail `thread_id`: issue id (for example `bd-3ib`)
  - mail subject prefix: `[bd-3ib] ...`
  - file reservation reason: `bd-3ib`
  - commit message: include issue id

Note: legacy `bd` commands appear in older docs. For active work in this repository, use `br` and `bv --robot-*`.

## 2) Work Item Hierarchy

Use this hierarchy consistently:

- Program: top-level initiative and global success criteria.
- Epic: phase or domain-level objective.
- Task: concrete implementation or documentation unit that can be completed in one focused session.

Model hierarchy with `parent-child` dependencies; do not use free-form text to imply hierarchy.

## 3) Decomposition Rules

Create tasks so they are:

- Executable: clear implementation scope, no hidden prerequisites.
- Measurable: acceptance criteria can be verified with commands, tests, or artifacts.
- Independent: minimal file-surface overlap with sibling tasks.
- Traceable: includes links to the artifacts or docs that prove completion.

Prefer splitting by one dominant axis:

- Runtime stage (`capture`, `vad`, `asr`, `merge`, `cleanup`)
- Artifact type (`docs`, `benchmarks`, `schema`, `runbook`)
- Operational surface (`makefile`, `packaging`, `tcc`, `sandbox`)

## 4) Dependency Practices

Use dependency types intentionally:

- `parent-child`: taxonomy and rollup progress.
- `blocks`: strict sequencing where downstream work cannot be completed yet.

Dependency quality checks:

- A task should not be blocked by broad epics unless there is no narrower blocker.
- Avoid circular `blocks` relationships.
- Prefer many small actionable tasks over one large bottleneck task.
- Re-run `bv --robot-triage` after major status changes.

## 5) Acceptance Criteria Quality

Every task should define criteria that are:

- Observable: output can be seen in terminal, files, or CI/test results.
- Deterministic: repeated runs give comparable outcomes.
- Bounded: explicitly states what is out of scope.

Example pattern:

- `1)` implementation behavior
- `2)` validation command(s)
- `3)` artifact/doc update

## 6) Evidence Linking Conventions

When completing work, include explicit evidence references:

- Command evidence: command plus key output summary.
- Artifact evidence: exact path (for example `artifacts/bench/<run>.json`).
- Code evidence: file path(s) and relevant line references.
- Decision evidence: ADR id and linked benchmark/experiment artifact.

Use this lightweight mapping:

- Task completion note links to files changed and validation commands run.
- ADRs link to the exact issue ids and benchmark artifacts used as authority.
- Benchmark docs include timestamp and commit linkage.
- Session handoff/checkpoint notes should use the evidence ledger in
  [`docs/session-end-hygiene-checklist.md`](./session-end-hygiene-checklist.md) so
  validation, artifact roots, residual risks, and follow-up issue ids are always linked
  in the same shape.

## 7) ADR Escalation Policy

Escalate a change to an ADR when any of the following is true:

- It changes a non-trivial architectural boundary.
- It introduces a new fallback/degradation policy.
- It changes SLO interpretation or benchmark authority.
- Reversal cost is significant.

ADR minimum content:

- Decision statement
- Alternatives considered
- Evidence used (issues, benchmarks, experiments)
- Trigger conditions for fallback/revisit

## 8) Multi-Agent Execution Protocol

For each claimed task:

- Set issue status to `in_progress`.
- Reserve exact files before editing.
- Announce start in Agent Mail thread with scope.
- Post completion summary with validation results.
- Release file reservations.

If unsure what to do next:

- Run `bv --robot-triage` first, then `br ready --json`.
- Choose highest-impact unblocked task that does not conflict with active reservations.

## 9) Onboarding Checklist

For new contributors/agents:

1. Read `AGENTS.md`, `README.md`, and this guide.
2. Run `br ready --json` and `bv --robot-triage`.
3. Register/announce via Agent Mail and check active agents.
4. Claim one ready task and reserve files before edits.
5. Execute task with validation evidence.
6. Close/update issue status, run `br sync --flush-only`, and provide handoff context.

## 10) Session Close Standard

Before ending a session:

1. File follow-up issues for discovered residual work.
2. Run relevant quality gates (tests/lint/build) for changed surfaces.
3. Update issue statuses (`in_progress` to `closed` where complete).
4. Run `br sync --flush-only`.
5. Post handoff summary in the issue thread (scope, evidence, risks, next steps).

Use the operational checklist and templates in
[`docs/session-end-hygiene-checklist.md`](./session-end-hygiene-checklist.md) when
the session touches modernization work, benchmarks, gate evidence, or closeout docs.
