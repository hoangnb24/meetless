import Foundation

struct HomeViewModel {
    let eyebrow = "Native macOS Meeting Recorder"
    let title = "Capture the meeting, keep your voice separate, and leave room for the real pipeline to plug in."
    let subtitle = "This shell keeps the first screen intentionally sparse: one primary Start/Stop action, a live status region, and clear attachment points for recording coordination, permissions, and later navigation."

    let shellHighlights = [
        "Whole-system meeting audio and microphone stay modeled as separate inputs from the first screen forward.",
        "The status area is ready for ScreenCaptureKit, permission repair, and degraded-source messaging in later beads.",
        "A pinned bundled whisper model now loads through an isolated bridge seam so later recording beads can depend on a proven local transcription path.",
        "History and session detail already exist as thin shells so persistence work can attach without reworking the window structure."
    ]
}
