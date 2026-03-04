# Session-End Hygiene Checklist

Purpose: make modernization-session closeout deterministic so future sessions inherit
status, evidence, and risks without rediscovery.

This checklist is the operational reference for `bd-397a` and should be used for any
session that changes modernization code, docs, benchmarks, or governance artifacts.

## When To Use This

Use this checklist whenever a session does one or more of the following:

- changes code or docs tied to the modernization program
- runs or analyzes benchmark/gate evidence
- updates bead status, dependencies, or follow-up scope
- hands work off mid-task to another agent/session

## Required Closeout Sequence

1. Confirm issue truth.
   - Every touched bead is either still `in_progress`, moved back to `open` with context,
     or `closed` with a concrete reason.
   - Any newly discovered residual work has its own bead instead of living only in prose.

2. Capture validation truth.
   - Record exactly which commands were run for the touched surface.
   - Record the outcome in one line each: `pass`, `fail`, or `not run`.
   - If a command was intentionally skipped, say why.

3. Link artifact truth.
   - For every benchmark, gate, manifest, JSONL, or report referenced in conclusions,
     include the exact artifact path.
   - If a conclusion depends on a prior run rather than a fresh run, say that explicitly.

4. Link code/doc truth.
   - List the files changed for the session.
   - If behavior claims depend on a specific contract/test/doc file, link that file too.

5. Record residual risk and next step truth.
   - State what remains unresolved.
   - State whether the next step is implementation, validation, benchmark rerun, or docs.
   - Link the follow-up bead id for each non-trivial residual item.

6. Sync and communicate.
   - Run `br sync --flush-only` after issue updates.
   - Post a thread update in MCP Agent Mail with scope, validation, evidence, risks, and
     next steps.
   - Release file reservations that are no longer needed.

## Evidence Ledger Template

Use this structure in issue-thread completion or handoff notes:

```text
Scope
- Completed:
- In progress:

Validation
- `<command>` -> pass|fail|not run ; key result

Artifacts
- `<absolute-or-repo-relative artifact path>` ; why it matters

Files
- `<path>`

Residuals
- `<risk or remaining task>` -> `bd-xxxx`

Next step
- `<next concrete action>`
```

## Minimum Bar By Session Type

### Docs-only session

- updated bead status
- changed file list
- note whether code/test validation was not required
- linked docs used as authority

### Code-change session

- updated bead status
- changed file list
- relevant tests/build/lint commands
- artifact paths if runtime/gates were involved
- residual risks and follow-up beads

### Benchmark or gate-analysis session

- updated bead status
- exact run command or reused baseline source
- exact artifact roots (`summary.csv`, `status.txt`, `runtime.manifest.json`, `runtime.jsonl`)
- interpretation note distinguishing observed fact from inference

## Evidence-Linking Rules

- Do not say "validated" without naming the command or artifact.
- Do not say "benchmarks look good" without naming the exact run root.
- Do not say "follow-up later" without a bead id unless the work is trivial and immediate.
- Do not close a bead if the key evidence only exists in local reasoning and not in docs,
  tests, artifacts, or thread history.

## Handoff Expectations

If a task is incomplete at session end, the mail-thread update must answer:

1. What was finished?
2. What is partially done?
3. What files/artifacts should the next agent trust?
4. What files/reservations should the next agent avoid or can now safely take?
5. What is the single best next action?

## Modernization-Specific Reminders

- Benchmark conclusions must distinguish compatibility, buffered-no-drop, and induced
  drop-path lanes.
- Contract-safety conclusions should link the specific contract doc/test/schema, not just
  a general statement that "contracts passed".
- Closeout and go/no-go artifacts should reference evidence docs directly instead of
  restating them from memory.
