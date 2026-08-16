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
| Web/mobile companion clients | In V1 companion scope | Browse, ask, and play while the host is reachable; no V1 system-audio recording. |

The first supported recording OS is macOS, with the V1 claim currently bounded
to the verified macOS 26.4 arm64 host. Broader macOS versions and hardware may
be added only after equivalent target validation. Windows and Linux are not in
the first V1 recording matrix.
