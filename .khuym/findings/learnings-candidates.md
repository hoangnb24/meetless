# Learnings Candidates — native-macos-meeting-recorder

Date: 2026-04-23
Source beads: bd-34x, bd-2lr, bd-1l8, bd-19s, bd-12m

## Candidate 1: Fail-soft local session indexing
- Beads: `bd-34x`
- Pattern summary: Local history loading should isolate corrupt bundles and preserve healthy rows, never fail the full screen on one malformed session.
- Why it compounds: This prevents a recurring UX regression for any future schema/persistence changes and creates a durable degradation policy for file-backed data.
- Suggested rule: Repository list/read paths must return partial success + warning channel for per-item decode failures.

## Candidate 2: Public-log privacy boundary with release-safe fault injection
- Beads: `bd-2lr`, `bd-1l8`
- Pattern summary: Keep absolute paths and test fault toggles out of shipping runtime/public logs; test injection should be debug/test-only.
- Why it compounds: This guards the local-first privacy promise and prevents future hardening regressions as logging and diagnostics evolve.
- Suggested rule: Any log string derived from `error.localizedDescription` or filesystem paths must be sanitized before `.public`; runtime fault-injection environment switches must be compile-gated from release.

## Candidate 3: Decoder/input hardening requires malformed-fixture tests
- Beads: `bd-12m`
- Pattern summary: Parser/decoder entry points must reject malformed payloads with explicit errors instead of trapping.
- Why it compounds: Input-shape edge cases recur across audio/transcript pipelines; a shared expectation reduces crash-class regressions.
- Suggested rule: For every binary decoder path, add at least one truncated/odd-length fixture test that asserts a typed error path.
