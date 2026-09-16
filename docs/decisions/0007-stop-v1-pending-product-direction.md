# 0007 Pause V1 And App Store Development Pending Product Direction

Date: 2026-09-16

## Status

Accepted: current V1 and Mac App Store development is paused pending the
owner's final decision to shut down or pivot.

## Context

Meetless's core product promise is a small Mac meeting recorder and evidence
workspace that can reuse a user's existing Paseo-supported Codex or Claude Code
configuration and account with minimal setup. The product does not want a
second Meetless provider login, copied credentials, a bundled provider, or
manual shell/PATH changes to make Ask work.

The project produced useful bounded evidence before this decision. The owner
confirmed on TestFlight build 1.0 (4) that recording permissions and a meeting
recording worked, a monthly Apple Sandbox purchase completed, and audio
transcription completed. Those observations preserve the recording, billing,
and managed-transcription work as historical product evidence. They do not
prove App Review, public release, or the core provider-reuse path.

The actual-consumer result for TestFlight build 1.0 (6) is the stopping signal.
The app reached the existing meeting, but the host-owned chooser/bookmark
attempt did not establish executable access to the existing Codex installation.
The existing symlink and its canonical executable were rejected by the
attempted flow; the chooser was cancelled, and no executable grant, model
launch, or actual Ask response was accepted. The same result means the
attempted Store integration is unaccepted. It does not establish that every
possible way to connect a sandboxed Store app to an existing provider is
impossible.

## Decision

1. Pause current V1 and Mac App Store development. The related execution issues
   may be closed as not planned and their project cards archived, but closure
   must not be represented as passing their unfinished acceptance criteria.
2. Suspend the release promise and continuation of
   [ADR0005](0005-mac-app-store-and-revenuecat.md). Its approved premium,
   entitlement, quota, privacy, receipt, credential, and fail-closed boundaries
   remain historical product and safety constraints. They do not authorize a
   new build, upload, production deployment, App Review submission, or external
   service change while product direction is pending.
3. Retain the product intent to reuse the user's existing Codex/Claude account
   and provider configuration with minimal setup. Retain the existing
   Meetless/Paseo ownership and credential boundaries. Do not choose or
   authorize a bundled provider, a separately installed companion/daemon, a
   direct-distribution replacement, or another provider architecture in this
   decision.
4. Record the sandbox finding accurately:

   - A security-scoped bookmark obtained from a dynamic user-selected file
     chooser grants scoped file access. It does not by itself grant
     `process-exec` for an external executable.
   - A symlink is another path to the same target. Placing one inside the app
     container does not give the target new permissions.
   - Apple documents static executable locations and temporary file exceptions
     that can technically permit execution in narrower cases. Meetless has not
     tested those options. A child still inherits sandbox limits, and the Mac
     App Store review outcome for such exceptions is uncertain.

   The primary references are Apple's [sandbox file-access documentation](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox),
   [symbolic-link guidance](https://developer.apple.com/documentation/security/migrating-your-app-s-files-to-its-app-sandbox-container),
   [DTS guidance on running developer tools from a sandboxed app](https://developer.apple.com/forums/thread/746478),
   and [DTS guidance on temporary exceptions](https://developer.apple.com/forums/thread/709333).
5. No new proof of concept is authorized by this ADR. Further technical work
   requires a later owner decision after shutdown versus pivot is settled.

This ADR overrides continuation and release direction only. It does not revoke
accepted safety, privacy, data-retention, host-ownership, recording lifecycle,
or billing invariants in ADR0001–ADR0006 and the product contract.

## Alternatives Considered

1. Continue the existing chooser/bookmark implementation: rejected because the
   actual TestFlight consumer result did not establish executable provider use.
2. Treat a symlink or a file-access bookmark as the fix: rejected because the
   documented permission boundary does not support that conclusion.
3. Immediately bundle Codex, install a separate provider companion, or switch
   to direct distribution: not selected. Each would change product intent or
   architecture and requires a new owner decision.
4. Shut down the project now: left open for the owner's final decision.
5. Pivot the product: left open for the owner's final decision.

## Consequences

- The current V1/App Store release path has no active delivery commitment.
- The confirmed recording, Sandbox purchase, transcription, and repository
  evidence remain available for review and are not erased by issue closure.
- Ask remains an unaccepted product capability for the Apple-distributed path.
- Existing credentials, provider accounts, local meeting evidence, billing
  safety, and runtime ownership must not be changed merely to close the work.
- Resuming work requires a new scoped direction, refreshed acceptance criteria,
  and an explicit owner decision. It must not infer authorization from this
  ADR's historical alternatives or from the closed issue statuses.

## Follow-Up

- The owner decides whether Meetless is shut down or pivoted.
- If the project resumes, update the product contract and add a new scoped plan
  before implementation; re-evaluate distribution and provider architecture
  against the chosen direction.
- Keep historical build and validation evidence linked from the retained plans;
  do not relabel failed Ask evidence as release acceptance.
