# V1 Platform Matrix

> **Current direction — 2026-09-18:** [Desktop Managed AI](desktop-managed-ai.md)
> limits the pivot to Mac; mobile is later and web/companion delivery is outside
> this phase. The matrix below is historical V1 scope/evidence, not a new support
> claim. No additional platform or pivot runtime has been verified.

> **Current status — 2026-09-16:** Current V1 and Mac App Store work is paused
> pending a shutdown-or-pivot decision. The matrix and verification notes below
> preserve accepted scope and observed evidence; they do not authorize another
> build, upload, deployment, or store submission. See
> [ADR0007](../decisions/0007-stop-v1-pending-product-direction.md).

The matrix separates product intent, API eligibility, and observed recording
proof.

| Surface | V1 status | Evidence or limit |
| --- | --- | --- |
| macOS 26.4 arm64 desktop recording | First verified V1 recording platform | A controlled two-participant Google Meet produced distinct microphone and system-audio artifacts plus a playable mixed MP3. |
| macOS 15+ desktop recording | Intended compatibility range, unverified outside the proven host | ScreenCaptureKit exposes separate system-audio and microphone outputs from macOS 15; API availability does not replace target-device proof. |
| macOS Intel and macOS 15–25 | Unverified | API availability is not real-device proof. Do not advertise support before target validation. |
| Windows desktop recording | Unsupported in first V1 matrix | No both-side Zoom/Meet artifact. |
| Linux desktop recording | Unsupported in first V1 matrix | No both-side Zoom/Meet artifact. |
| Web/mobile companion clients | Accepted V1 companion scope, paused | Browse, ask, and play while the host is reachable through direct LAN pairing or Paseo's encrypted relay; when offline, show the host-offline state without replacing known meetings with a false empty state; no offline detail-access requirement and no V1 system-audio recording. |

The first supported recording OS is macOS, with the V1 claim currently bounded
to the verified macOS 26.4 arm64 host. Broader macOS versions and hardware may
be added only after equivalent target validation. Windows and Linux are not in
the first V1 recording matrix.

## Historical desktop verification status

The macOS development App Store integration had a verified desktop UI handoff:
the owner observed a visible, interactable window and confirmed the requested
basic UI test on 2026-09-06. In TestFlight build 1.0 (4), the owner also
confirmed recording permissions, a meeting recording, a monthly Sandbox
purchase, and managed transcription. These are bounded historical observations.

TestFlight build 1.0 (6) reached the existing meeting, but the attempted
chooser/bookmark path did not establish executable access to the user's
existing Codex installation. No model launch or actual Ask response was
accepted. Dynamic file access and a symlink do not by themselves grant execute
permission; some static paths or temporary exceptions may be technically
available, but they were not proven for Meetless and their Mac App Store review
outcome is uncertain. See Apple's [sandbox file-access documentation](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox),
[symbolic-link guidance](https://developer.apple.com/documentation/security/migrating-your-app-s-files-to-its-app-sandbox-container),
and [DTS guidance on sandboxed developer tools](https://developer.apple.com/forums/thread/746478).

This is a desktop UI and bounded feature status, not a claim of live Ask
acceptance, second-instance routing, purchase/restore completeness, managed
production, store publication, or release acceptance. Further provider
experiments are paused by [ADR0007](../decisions/0007-stop-v1-pending-product-direction.md).
See [the retained historical execution evidence](../plans/completed/v1-paseo-foundation-mas-ui-history.md).
