# 0008 Desktop Managed AI Pivot

Date: 2026-09-18

## Status

Accepted for product policy; amended 2026-09-18 with Human's bounded E2
execution authorization below. E1 documentation acceptance is not runtime acceptance.

## Context

The owner asked to start E1 of the desktop managed-AI Epic and then approved the
proposed scope, free access, subscription boundary, data flow, consent, and
temporary backend retention. The previous existing-provider Ask path did not
produce an accepted response on TestFlight build 1.0 (6). Build 1.0 (4) retains
only its bounded recording, monthly Sandbox purchase, and transcription evidence.

## Decision

Adopt [Desktop Managed AI](../product/desktop-managed-ai.md) as the current
consumer contract: Mac-only this phase, subscription-managed Transcribe and Ask,
no coding agent or API key required, durable evidence on the Mac, free recording
and access to existing evidence even after expiry or quota exhaustion.

That contract supersedes the provider-reuse direction retained by ADR0007 and
the conflicting free Ask, future BYOK precedence, and offer requirements in
ADR0005 and V1 product documents for this phase. Mobile remains later; old web
and companion requirements are not pivot delivery obligations. This is not a
decision to remove Paseo or rewrite the app.

Consent and sending are distinct: after the 2026-09-18 interview, Ask consent
is once per meeting, survives reopen and transcript changes; each Ask/Retry
still needs deliberate user action. This supersedes the initial per-operation
Ask confirmation, without changing Transcribe consent. Transcribe sends selected audio; Ask
sends only the open meeting's transcript, question, and necessary chat history.
Backend content expires within 24 hours, sooner after acknowledged local
publication; stricter existing transcription cleanup remains. AI-provider
retention must be verified for the actual provider/configuration; bounded E2
disclosure acceptance is recorded below, not a claim of runtime enforcement.
Retain existing credential, logging, local-data, host-ownership, and billing
safety constraints. No automatic AI calls after purchase or app update.

E3 owns price, trial, quotas, usage units, model, and new Ask settlement choices.
Old V1 offer values are not pivot defaults. E2 can use separately authorized
experimental limits without establishing customer policy.

## Authority And Consequences

The initial approval lifted the ADR0007 pause only for E1 documentation.
The subsequent Human directive authorizes E2 code changes, builds, installation,
sending meeting transcripts to AI, OpenAI as the Ask provider, and TestFlight
uploads. Human imposes no experience cost ceiling at this stage; record observed
usage/cost, do not invent a cap. This does not grant unlimited customer access.

Human subsequently selected `gpt-5.6-luna` for E2, accepted OpenAI retention as
disclosed (abuse logs up to 30 days with stated longer-retention exceptions;
`store:false` is not ZDR), and authorized Sandbox backend deployment/configuration.
Use foreground Responses with `store:false`, no Files/Conversations/hosted tools;
do not claim project ZDR. Confirm exact Sandbox target before mutations.
The later interview accepts the Ask behavior in the product contract (recovery,
streaming, stop, meeting concurrency and local persistence) and permits changing
chat UI to benefit from SDK reuse; it does not select an SDK or prove feasibility.
The release-first directive makes a usable Mac App Store release the delivery
goal and brings release-risk assessment before polish. The Epic sequences this
work; it is not authority for migration, App Review, public release or Production
service changes. E3 offer decisions and later product/privacy changes remain
Human-owned. Do not silently defer an accepted behavior as cosmetic polish.
The old V1 provider-reuse route is not resumed.

Human subsequently approved closing E2 as integration feasibility after the
foundation audit, then proceeding directly to E4 usable-Ask remediation. This
authorizes the bounded next implementation, not E3 offer choices, Production,
App Review or public release. Failures remain release obligations, not passes.

Keep the [Epic](../plans/active/desktop-managed-ai-pivot.md) as the single work
status source. Preserve historical failures and unknown results. Product-policy
acceptance does not establish runtime, privacy enforcement, or release acceptance.

Reopen with the owner if provider terms require a different privacy boundary,
free access or scope changes, or new cost/external/irreversible authority is
needed. Technical reuse and architecture remain Lead decisions within that scope.
