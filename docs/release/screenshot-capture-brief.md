# Meetless 1.0 — App Store screenshot capture brief

Status: capture input prepared; no screenshot in this brief is a captured or
accepted store asset. Use the actual signed candidate and a separate test data
area that does not expose or replace the owner's meetings. Do not simulate
purchase/transcription success or use the design prototype as the product.

## Candidate and output

- Capture candidate: actual TestFlight macOS 1.0 (3), source
  `7e958c3d7586029fa77347e987e0e380b980f563`, Apple build
  `401bf672-c396-4ae0-8bb7-1ca1632e037d`. Open/relaunch, native idle CPU and
  recording preservation have scoped independent/Lead acceptance. This opens
  capture preparation; no screenshots or broader feature flows are accepted yet.
- Five images, following the shot list in `app-store-submission.md`.
- Capture the real UI with fictional meeting content. Record the candidate,
  capture method, output dimensions, and hashes with each accepted asset.
- Use an Apple-supported 16:10 output size. Prefer native capture at 2880×1800
  where supported; do not stretch UI or replace rendered app controls.
- Capture only app content; exclude account menus, provider configuration,
  credentials, real meetings, purchase identifiers, and unrelated desktop apps.
- Review actual images for legibility and privacy before ASC upload. Store raw
  captures in ignored `.artifacts/app-store-screenshots/` until reviewed.

## Fictional recording input

Meeting title: **Website launch planning**

Read this script in a clean test recording. The script is original fictional
content for the demonstration; it does not represent a customer conversation.

> Let's agree on the website launch plan. We need three pages: an overview,
> a support page, and a privacy page. The overview should explain recording,
> transcription, and asking questions about a meeting.
>
> Our first priority is clarity. A visitor should understand that recordings
> stay on their Mac and that transcription starts only when they choose it.
> The support page should answer the questions people will have on their first
> day, including permissions, subscriptions, and restoring a purchase.
>
> Before launch, we will check the website on both a computer and a phone.
> We will also test every navigation link and make sure the support email is
> easy to find. The privacy page needs to describe the actual data flow.
>
> The decision is to finish the three pages first, then review the screenshots.
> We will not announce a download until the app is available. Our next check-in
> is Friday, when we will review the page copy and the first set of images.

## Capture sequence

| Image | Real UI state | Content to make readable |
| --- | --- | --- |
| 01 — Ready to record | Record meeting setup before capture | Fictional title, audio sources, Start recording |
| 02 — In the conversation | Recording in progress | Elapsed time, active indicator, Pause/Stop |
| 03 — Saved on your Mac | Finished recording in the meeting library | Saved state and explicit Transcribe action |
| 04 — Read the transcript | Transcript returned through the real supported transcription route | Timed text from the script and readable segments |
| 05 — Ask with evidence | Actual answer from the selected provider | Question below, actual answer, and a playable citation |

Suggested Ask question: **What did we decide to finish before reviewing the screenshots?**

Use the actual returned transcript, answer, and citation. Do not prewrite or
inject a successful answer to impersonate a completed provider request. If
transcription/Ask cannot be exercised on the accepted candidate, mark images
04/05 pending rather than fabricating them. Test data demonstrates UI only;
it cannot prove live production billing, quota enforcement, or retention.

## Capture-environment gate

The repository's accepted runtime isolation and launch rules still apply.
The supported MAS host requires LaunchServices and the exact path
`/Applications/Meetless.app` (`packages/runtime/src/host.ts`). A copied bundle in
an artifact directory is rejected. Its runtime uses the bundle-specific macOS
container; no supported packaged override creates an isolated second instance.
`dev:mas` resets canonical data and must not be used for this capture.

A separate Mac is the simplest way to keep the current installation untouched.
A separate macOS user isolates the container, but `/Applications/Meetless.app`
is shared across users on the same Mac, so that alone does not preserve the
installed app. Using this Mac requires explicit owner approval to replace the
installed app after a verified backup/recovery plan. The owner approved this
Mac route on 2026-09-15; backup verification and installation are separate
execution steps recorded in the active plan.
Do not change bundle identity/signature to bypass the accepted launch contract.

Existing repository screenshots are historical or fixture outputs at different
candidate identities and unsupported store dimensions. They are not accepted
as screenshots of build 3. Images 01–05 remain pending until the controlled
fictional-content capture and image review are completed.
