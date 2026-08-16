# Knowledge And Citations

The user selects an existing Paseo-supported coding-agent provider, including
Codex, for meeting analysis and question answering. Analysis is user initiated;
transcription is automatic.

Meeting summaries contain decisions and proposed action items. Missing owners
or deadlines remain unspecified. Factual claims resolve to known transcript
segment IDs. Model-written timestamp strings are display text, not citation
authority.

A question scoped to one meeting returns cited support or says the meeting does
not contain enough evidence. Clicking a meeting citation opens the player and
seeks to a small interval around the cited segment.

V1 later expands retrieval across selected meetings and explicitly allowlisted
document folders. Meeting citations resolve to transcript segments and audio
ranges. Document citations resolve to indexed chunks and source locations. A
deleted or no-longer-allowlisted document must disappear from future retrieval.

Agents receive bounded meeting/document search and fetch tools. They do not gain
meeting identity by being mapped to a Paseo workspace or agent record.
