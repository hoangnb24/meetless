# V1 Platform Matrix

The matrix separates product intent, API eligibility, and observed recording
proof.

| Surface | V1 status | Evidence or limit |
| --- | --- | --- |
| macOS 26.4 arm64 desktop recording | First verified V1 recording platform | A controlled two-participant Google Meet produced distinct microphone and system-audio artifacts plus a playable mixed MP3. |
| macOS 15+ desktop recording | Intended compatibility range, unverified outside the proven host | ScreenCaptureKit exposes separate system-audio and microphone outputs from macOS 15; API availability does not replace target-device proof. |
| macOS Intel and macOS 15–25 | Unverified | API availability is not real-device proof. Do not advertise support before target validation. |
| Windows desktop recording | Unsupported in first V1 matrix | No both-side Zoom/Meet artifact. |
| Linux desktop recording | Unsupported in first V1 matrix | No both-side Zoom/Meet artifact. |
| Web/mobile companion clients | In V1 companion scope | Browse, ask, and play while the host is reachable through direct LAN pairing or Paseo's encrypted relay; when offline, show the host-offline state without replacing known meetings with a false empty state; no offline detail-access requirement and no V1 system-audio recording. |

The first supported recording OS is macOS, with the V1 claim currently bounded
to the verified macOS 26.4 arm64 host. Broader macOS versions and hardware may
be added only after equivalent target validation. Windows and Linux are not in
the first V1 recording matrix.

## Current desktop verification status

The macOS development App Store integration has a verified desktop UI handoff:
the owner observed a visible, interactable window and confirmed the requested
basic UI test. The latest local installation is intentionally stopped with its
coordinator-preserved transaction backups retained. This is a desktop UI status,
not a claim of real recording/TCC, second-instance routing, purchase/restore,
managed-production, store publication, or release acceptance. See [the accepted
MAS development integration decision](../decisions/0006-mas-development-desktop-integration.md)
and [the retained execution history](../plans/completed/v1-paseo-foundation-mas-ui-history.md).
