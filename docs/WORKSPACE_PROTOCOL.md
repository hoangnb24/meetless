# Workspace Collaboration Protocol

This is repository-local collaboration guidance. The repository remains the
system of record for work, decisions, artifacts, and evidence. This document
is not a parallel task database, Paseo runtime configuration, or role
provisioning mechanism.

## Before delegation

The Lead inspects the repository and current room state and reads this
protocol before assigning work. Each moving write scope has one owner.
At most one active writable Peer may exist. A delegation brief states the
bounded outcome,
dependencies, exact write scope, stable contract and invariants, acceptance
evidence, and reopen conditions.

While a Peer owns a moving scope, the Lead does not edit that scope.

## Events and handback

The Lead waits for the relevant Paseo or collaboration event: finish, error,
attention/permission, or a requested decision. Paseo's agent surface supports
finish/error and attention/permission notifications and waiting; a decision is
resolved by its responsible Human or Lead and must not be invented from a
status snapshot. The Lead does not repeatedly poll unchanged Peer status.

Resolve every permission or attention event from its exact request. Unchanged
status is not progress, and a timeout or missing notification is not
completion.

A Peer returns exactly one of `DONE`, `REOPEN_REQUEST`,
`DEPENDENCY_REQUEST`, or `BLOCKED`. Every handback includes evidence, the
consequence, and the decision needed. A handback is not acceptance.

## Acceptance and decision ownership

The Lead inspects the exact artifact or candidate and explicitly `ACCEPTS` or
`REJECTS` it with a reason. Events, status, and handback text coordinate work;
they do not prove implementation quality.

Production acceptance evidence must follow the
[`patterns/production-evidence.md`](patterns/production-evidence.md) pattern.
The Lead inspects the exact bytes or immutable snapshot and production call
path, then explicitly `ACCEPTS` or `REJECTS` it with a reason. Handback text,
status, or green tests do not substitute for that decision.

Product, cost, external-effect, and irreversible-risk decisions remain
Human-owned. Technical route and ownership decisions remain Lead-owned.

## Reopen conditions

Return `REOPEN_REQUEST` with evidence, consequence, and decision needed when
repository authority conflicts, the exact artifact or scope cannot be
inspected, or the requested event behavior is not supported by Paseo. Keep
event wording tool-accurate and do not infer quality or completion from an
event alone.
