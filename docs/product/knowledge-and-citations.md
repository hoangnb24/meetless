# Knowledge And Citations

The user selects a meeting from a sidebar and opens a detail screen containing
the complete ordered transcript. Transcript timestamps remain connected to the
audio ranges accepted in Milestone 3.

From that meeting screen, the user selects an existing Paseo-supported
coding-agent provider and model, including Codex, and starts or continues a chat
scoped only to the open meeting. Transcription is automatic; chat is user
initiated.

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

V1 later expands retrieval across selected meetings and explicitly allowlisted
document folders. Meeting citations resolve to transcript segments and audio
ranges. Document citations resolve to indexed chunks and source locations. A
deleted or no-longer-allowlisted document must disappear from future retrieval.

Agents receive bounded meeting/document search and fetch tools. The sidebar and
chat surfaces may reuse Paseo layout and UI primitives, but meetings and durable
meeting chat threads are not mapped to Paseo workspace or agent records.
