# Knowledge And Citations

The user selects a meeting from a sidebar and opens a detail screen containing
the complete ordered transcript. Transcript timestamps remain connected to the
audio ranges accepted in Milestone 3.

From that meeting screen, the user selects an existing Paseo-supported
coding-agent provider and model, including Codex, and starts or continues a chat
scoped only to the open meeting. Transcription starts only when the user selects
**Transcribe** for that saved recording; chat is also user initiated.

## Existing coding-agent configuration

Owner decision, 2026-09-13: on first installation and on a new machine, Meetless
must discover and use the user's existing coding-agent configuration and
authentication through the lookup mechanisms already supported by Paseo.
The reference is the real user's provider configuration, not an empty provider
home created inside Meetless's app container. This applies to the supported
providers, including Codex, Claude Code, and OpenCode.

Provider-specific paths, explicit configuration-directory overrides and
precedence belong to Paseo/the provider. Do not replace them with a second
Meetless-maintained list of guessed folder names. Existing credentials remain
provider-owned; a separate Meetless-specific provider login is not the default
solution for a provider that is already configured on the machine.

Meetless's recordings, transcripts, chat records and isolated Paseo runtime
state remain in their accepted app-owned locations. Reusing provider
configuration does not relocate that product state. The MAS implementation must
also establish actual access through an App-Sandbox-compatible mechanism:
correctly naming a path alone is not proof that the provider can use it.
The specific external-folder permission interaction is not yet accepted or
implemented; it remains an implementation prerequisite in the active plan.

## Meeting evidence and chat history

Meeting chat history is durable. Leaving the meeting or restarting the app does
not discard the thread; reopening the meeting restores its previous messages so
the user can continue the conversation.

A question scoped to one meeting returns cited support or says the meeting does
not contain enough evidence. Clicking a meeting citation opens the player and
seeks to a small interval around the cited segment.

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
