# Knowledge And Citations

> **Current direction — 2026-09-18:** [Desktop Managed AI](desktop-managed-ai.md)
> replaces existing-provider selection/reuse below with subscription-managed
> Ask for this phase. Meeting-scoped evidence, segment-ID citations, and durable
> history remain required. Provider attempts below are historical, not a task to
> resume. Current bounded E2 execution authority is recorded in ADR0008.

> **Current status — 2026-09-16:** The meeting evidence and existing-provider
> experience below remain accepted product intent, while V1/App Store
> development is paused pending a shutdown-or-pivot decision. The Apple
> distributed provider path is not accepted: TestFlight build 1.0 (6) did not
> produce a working Ask response. No new proof of concept or implementation is
> authorized. See [ADR0007](../decisions/0007-stop-v1-pending-product-direction.md).

The user selects a meeting from a sidebar and opens a detail screen containing
the complete ordered transcript. Transcript timestamps remain connected to the
audio ranges accepted in Milestone 3.

From that meeting screen, the user selects an existing Paseo-supported
coding-agent provider and model, including Codex, and starts or continues a chat
scoped only to the open meeting. Transcription starts only when the user selects
**Transcribe** for that saved recording; chat is also user initiated.

## Existing coding-agent configuration

The accepted product intent, recorded on 2026-09-13, is that on first
installation and on a new machine Meetless discovers and uses the user's
existing coding-agent configuration and authentication through the lookup
mechanisms already supported by Paseo. The reference is the real user's
provider configuration, not an empty provider home created inside Meetless's
app container. This applies to supported providers, including Codex, Claude
Code, and OpenCode. This intent is retained while its Store execution remains
unproven and paused.

Provider-specific paths, explicit configuration-directory overrides and
precedence belong to Paseo/the provider. Do not replace them with a second
Meetless-maintained list of guessed folder names. Existing credentials remain
provider-owned; a separate Meetless-specific provider login is not the default
solution for a provider that is already configured on the machine.

Meetless's recordings, transcripts, chat records and isolated Paseo runtime
state remain in their accepted app-owned locations. Reusing provider
configuration does not relocate that product state. The previous MAS attempt
requested provider folders and then a Codex executable through the macOS system
chooser, preserving security-scoped bookmarks and passing an absolute path
through Paseo's command override. TestFlight 1.0 (6) still did not establish
executable access, model loading, or an Ask response; the chooser was cancelled
after the existing symlink and canonical executable were rejected. The attempt
is retained as failed evidence, and its implementation authority is suspended.

The boundary is precise: a dynamic user-selected bookmark grants scoped file
access, but does not grant `process-exec` for an external executable. A symlink
is only another path to the same target and does not add that permission. Apple
also documents static locations and temporary exceptions that can technically
permit execution in narrower cases; Meetless has not tested those paths, a
child still inherits sandbox limits, and Mac App Store review is uncertain. See
Apple's [sandbox file-access documentation](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox),
[symbolic-link guidance](https://developer.apple.com/documentation/security/migrating-your-app-s-files-to-its-app-sandbox-container),
[DTS guidance on static execution](https://developer.apple.com/forums/thread/746478),
and [DTS guidance on temporary exceptions](https://developer.apple.com/forums/thread/709333).

The product does not bundle or download Codex/Claude, modify the user's shell
configuration or global PATH, guess installation directories, copy credentials,
grant the whole home directory, or add a second Meetless provider login. A
future implementation would need new owner authority and fresh acceptance
criteria; ADR0007 authorizes no new proof of concept.

## Meeting evidence and chat history

Meeting chat history is durable. Leaving the meeting or restarting the app does
not discard the thread; reopening the meeting restores its previous messages so
the user can continue the conversation.

A question scoped to one meeting is intended to return cited support or say the
meeting does not contain enough evidence. Clicking a meeting citation opens the
player and seeks to a small interval around the cited segment. The cited Ask
behavior remains product intent; no Apple-distributed Ask response has been
accepted.

The application accepts only known transcript segment IDs as citation
authority. Model-written timestamps are display text, not citation identity.
Automatic summaries, decision extraction, action-item extraction, and artifact
accept/dismiss workflows are deferred from this V1 sequence.

Cross-meeting retrieval and explicitly allowlisted document folders are
post-MVP work. That later work will add bounded meeting/document search and
fetch tools, document citations, and source-location navigation. A deleted or
no-longer-allowlisted document must disappear from future retrieval.

The sidebar and chat surfaces may reuse Paseo layout and UI primitives, but
meetings and durable meeting chat threads are not mapped to Paseo workspace or
agent records.
