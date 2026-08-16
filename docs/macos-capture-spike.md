# macOS Zoom/Meet Capture Spike

## Purpose

Accept the first recording platform only after a real or controlled Zoom/Google
Meet call produces distinct non-silent system-audio and microphone artifacts.
A fixture, mock, generated tone, or design review cannot pass this gate.

## Spike Tool And Environment

The current spike uses an existing native app read-only; it is evidence tooling,
not adopted Meetless V1 implementation:

- source checkout: `/Users/tubakhuym/projects/meetless`
- inspected commit: `3eb2cfb861d6b69ff89de83de1875d9980d8a078`
- spike executable: `/Users/tubakhuym/Library/Developer/Xcode/DerivedData/Meetless-bhbrsuxvvvttarbgpeqhriewhphp/Build/Products/Debug/Meetless.app/Contents/MacOS/Meetless`
- executable SHA-256: `0423e50f8944e360e83bc111b8df071dc6d818d18ea01ec970db8a22b954f87c`
- capture: `MeetlessApp/Services/Capture/ScreenCaptureSession.swift`
- normalization: `MeetlessApp/Services/AudioPipeline/SourceAudioPipeline.swift`
- host: macOS 26.4 arm64

It uses one ScreenCaptureKit stream with `capturesAudio = true` and
`captureMicrophone = true`, routing `.audio` to `Meeting` and `.microphone` to
`Me`. macOS 15 is the API minimum for the microphone output.

System Settings currently shows Meetless enabled for both **Screen & System
Audio Recording** and **Microphone**. Google Meet detects `External Microphone`
and is prepared with `External Headphones` output.

The existing debug executable has no build attestation that cryptographically
ties it to the inspected source commit. Its hash makes this run reproducible as
an evidence-tool run, but the result cannot accept that source implementation
for V1. Milestone 0 uses it only to decide whether the macOS capture capability
is viable; Milestone 2 still owns the production adapter and its build proof.

## Controlled Call

1. Join the same Google Meet from the Mac host and a second account/device.
2. Use headphones on the Mac to limit acoustic bleed.
3. Start the native recorder.
4. On the Mac, say: `LOCAL ALPHA SEVEN. This sentence came from the microphone.`
5. On the second participant, say: `REMOTE BRAVO NINE. This sentence came through Google Meet.`
6. Stop after at least 15 seconds and preserve the generated session directory.
7. Create a mixed MP3 only after both raw source artifacts pass.

## Pass Criteria And Commands

For each raw source and the mixed artifact:

```bash
ffprobe -v error \
  -show_entries format=filename,duration,size:stream=index,codec_name,sample_rate,channels \
  -of json '<artifact>'

ffmpeg -hide_banner -nostats -i '<artifact>' \
  -af astats=metadata=1:reset=0 -f null - 2>&1 \
  | rg 'RMS level dB|Peak level dB|Duration'

shasum -a 256 '<artifact>'
```

Pass only when:

- the Meet call had two joined participants;
- both source artifacts have playable audio streams and call-length duration;
- the microphone artifact contains the local phrase interval;
- the system artifact contains the remote phrase interval;
- both tracks are observably non-silent; and
- a mixed artifact contains both intervals.

Record artifact paths, timestamps, durations, sizes, hashes, measured levels,
participant observation, and phrase observation in this document. Listening or
transcript evidence identifies phrase presence; levels alone prove only sound.

## Accepted Evidence: 2026-08-16 Google Meet

The controlled call used Google Meet `iau-pdpo-qtq`. The Meet participant panel
showed two joined participants, `Hoang` (host) and `Nguyen Bang Hoang` (visitor),
before recording. The accepted session is:

```text
/Users/tubakhuym/Library/Containers/com.themrb.meetless/Data/Library/Application Support/Meetless/Sessions/42943d6a-1e4a-475b-a0e2-b5692a28d6d5
```

`session.json` records a completed session from `2026-08-16T10:43:20Z` through
`2026-08-16T10:44:29Z`, with both `Meeting` and `Me` source statuses `ready`.

| Artifact | Source | Duration | Size | RMS | Peak | SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `meeting.m4a` | Google Meet system audio | 69.312s | 95,933 bytes | -31.027490 dB | -1.293673 dB | `628c707fb5d9a17cdcabfdc0f6d5fb6aa42a082dda16b2d4cf4c45c47bb63458` |
| `me.m4a` | External microphone | 69.376s | 435,865 bytes | -35.631843 dB | -7.370629 dB | `617df2fdc8866bcd8e089e190cdbb7a176a69e38c650759926fbfb86b6363967` |
| `mixed.mp3` | `Meeting` + `Me` through `ffmpeg amix` | 69.244s | 365,499 bytes | -29.733508 dB | -1.435606 dB | `dc6a3add067c5ed8fc1634e5c603c5dab09e9fb345abc2ce1766397e53f6e89c` |

All three artifacts have one playable 16 kHz mono audio stream. The mixed MP3
was produced only after both raw sources passed:

```bash
ffmpeg -hide_banner -y -i meeting.m4a -i me.m4a \
  -filter_complex '[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]' \
  -map '[a]' -codec:a libmp3lame -q:a 2 mixed.mp3
```

Phrase and separation evidence comes from the source-labelled transcript and
the corresponding four-second raw-source windows:

- `Me`, frames 384516–448603 (24.032–28.038s):
  `and FAS-7 this sentence came from the microphone.` The recognizer distorted
  `LOCAL ALPHA SEVEN`, but retained the identifying sentence and assigned the
  interval to the microphone source. This window measured -27.6 dB mean in
  `me.m4a` and -91.0 dB in `meeting.m4a`.
- `Meeting`, frames 704314–768314 (44.020–48.020s):
  `This sentence came from Google Man.` The recognizer distorted the end of the
  requested remote phrase, but assigned its identifying sentence to system
  audio. This window measured -21.6 dB mean in `meeting.m4a` and -46.1 dB in
  `me.m4a`.

The source labels, transcript intervals, and large opposite-track level gaps
are observable evidence that the microphone and Google Meet participant were
captured as separate sides. Because `mixed.mp3` deterministically combines
those aligned source artifacts, it contains both accepted intervals. This run
passes the Milestone 0 capture boundary for macOS 26.4 arm64.

## Rejected Evidence

The 2026-05-20 session
`e31c64b0-fb6d-4969-81dd-832200618e68` does not pass:

- `meeting.m4a`: 27.008 seconds, RMS -26.880938 dB, SHA-256
  `9bf9f51399ede9bf3b66526d88b6836f6c4fb08b573bd05fcc831acf50de973a`.
- `me.wav`: 44-byte header, zero frames, SHA-256
  `ba584a378b11d9e9c98736fd8c256fe1453a84ee4139416d24b07acff424f0fb`.

It proves system-audio capture only and remains rejected. The accepted fresh
call above supersedes it for the Milestone 0 capability decision.
