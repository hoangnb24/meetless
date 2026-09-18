# Meetless Product Contract

> **Current status — 2026-09-18:** The owner approved E1 policy for the desktop
> managed-AI pivot. [Desktop Managed AI](desktop-managed-ai.md) takes precedence
> over conflicting V1 behavior below. Bounded E2 execution is now authorized;
> Human selected `gpt-5.6-luna`, accepted disclosed OpenAI retention, and authorized
> Sandbox deploy/config. Production remains unchanged. See
> [ADR0008](../decisions/0008-desktop-managed-ai-pivot.md).

This directory is the sole authority for accepted consumer behavior and UX:

- [Desktop Managed AI](desktop-managed-ai.md): current pivot scope, access,
  consent, retention, superseded V1 requirements, and remaining decisions.

- [Overview](overview.md): audience, complete workflow, scope, and product boundary.
- [Recording](recording.md): capture, recovery, export, and transcription behavior.
- [Knowledge And Citations](knowledge-and-citations.md): transcript reading, meeting chat, retrieval, and evidence behavior.
- [Platforms](platforms.md): recording-host and companion-client matrix plus
  historical desktop UI and bounded verification status.
- [Experience](experience.md): accepted end-to-end UX, screen behavior, states,
  copy, responsive behavior, and design implementation guidance.
- [Premium And Monetization](monetization.md): free and paid capabilities,
  subscription offer, trial, purchase, and restore behavior.

The active execution plan tracks delivery. When behavior changes, update the
owning product document first, then the plan and executable proof.
