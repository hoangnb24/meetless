@preconcurrency import AVFoundation
import CoreMedia
import CryptoKit
import Darwin
import Foundation
import ScreenCaptureKit

private let sampleRate = 16_000
private let channels = 1
private let defaultChunkFrames = 16_000
// ScreenCaptureKit callback PTS can drift slightly from the converted PCM frame count.
// Differences up to 100 ms are callback jitter, not a timeline gap. At one-second
// target chunks this keeps ordinary capture at no more than 61 chunks/source/minute
// (the final partial chunk accounts for the extra one).
private let callbackJitterToleranceFrames = sampleRate / 10

private struct Command: Decodable {
  let version: Int
  let command: String
  let sessionDirectory: String?
  let elapsedMs: Int?
}

private struct ProtocolEvent: Encodable {
  let version = 1
  let event: String
  var source: String? = nil
  var id: String? = nil
  var path: String? = nil
  var byteLength: Int? = nil
  var sha256: String? = nil
  var logicalStartMs: Int? = nil
  var durationMs: Int? = nil
  var sampleRate: Int? = nil
  var channels: Int? = nil
  var format: String? = nil
  var error: String? = nil
}

private let encoder = JSONEncoder()
private let outputLock = NSLock()

private func emit(_ event: ProtocolEvent) {
  do {
    let data = try encoder.encode(event) + Data([0x0a])
    outputLock.lock()
    defer { outputLock.unlock() }
    try FileHandle.standardOutput.write(contentsOf: data)
  } catch {
    FileHandle.standardError.write(Data("protocol write failed: \(error)\n".utf8))
  }
}

private func diagnostic(_ message: String) {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
}

private enum Source: String, CaseIterable { case microphone, system }

private final class ChunkWriter: @unchecked Sendable {
  private struct Packet {
    let samples: [Int16]
    let source: Source
    let presentationFrame: Int64
  }

  private let directory: URL
  private let invalidClaimFixture: Bool
  private let lock = NSLock()
  private var buffers: [Source: [Int16]] = [.microphone: [], .system: []]
  private var chunkStartFrames: [Source: Int64] = [:]
  private var nextExpectedFrames: [Source: Int64] = [:]
  private var indexes: [Source: Int] = [.microphone: 0, .system: 0]
  private var originPresentationFrame: Int64?
  private var sharedAdjustmentFrame: Int64 = 0
  private var pendingAnchorPackets: [Packet] = []
  private var pendingAnchorSources: Set<Source> = []
  private var resumeElapsedFrame: Int64?
  private var awaitingSharedAnchor = true
  private var paused = false
  private var closed = false

  init(directory: URL, invalidClaimFixture: Bool) throws {
    self.directory = directory.standardizedFileURL
    self.invalidClaimFixture = invalidClaimFixture
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
  }

  func append(_ samples: [Int16], source: Source, presentationFrame: Int64) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !paused && !closed else { return }
    guard !samples.isEmpty, presentationFrame >= 0 else { return }
    let packet = Packet(samples: samples, source: source, presentationFrame: presentationFrame)
    if awaitingSharedAnchor {
      pendingAnchorPackets.append(packet)
      pendingAnchorSources.insert(source)
      if pendingAnchorSources.count == Source.allCases.count { try activateSharedAnchor() }
      return
    }
    try appendMapped(packet)
  }

  func pause() throws {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    if awaitingSharedAnchor && !pendingAnchorPackets.isEmpty { try activateSharedAnchor() }
    try flushAll()
    paused = true
  }

  func resume(elapsedMs: Int) {
    lock.lock()
    defer { lock.unlock() }
    pendingAnchorPackets = []
    pendingAnchorSources = []
    resumeElapsedFrame = Int64(elapsedMs) * Int64(sampleRate) / 1_000
    awaitingSharedAnchor = true
    paused = false
  }

  func close() throws {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    if awaitingSharedAnchor && !pendingAnchorPackets.isEmpty { try activateSharedAnchor() }
    try flushAll()
    closed = true
  }

  private func activateSharedAnchor() throws {
    guard let firstPresentationFrame = pendingAnchorPackets.map(\.presentationFrame).min() else { return }
    if originPresentationFrame == nil {
      originPresentationFrame = firstPresentationFrame
      sharedAdjustmentFrame = 0
    } else if let resumeElapsedFrame, let originPresentationFrame {
      sharedAdjustmentFrame = resumeElapsedFrame - (firstPresentationFrame - originPresentationFrame)
    }
    let packets = pendingAnchorPackets.sorted {
      if $0.presentationFrame != $1.presentationFrame { return $0.presentationFrame < $1.presentationFrame }
      return $0.source.rawValue < $1.source.rawValue
    }
    pendingAnchorPackets = []
    pendingAnchorSources = []
    self.resumeElapsedFrame = nil
    awaitingSharedAnchor = false
    for packet in packets { try appendMapped(packet) }
  }

  private func appendMapped(_ packet: Packet) throws {
    guard let originPresentationFrame else { return }
    var logicalStart = packet.presentationFrame - originPresentationFrame + sharedAdjustmentFrame
    guard logicalStart >= 0 else { throw NSError(domain: "MeetlessCapture", code: 20, userInfo: [NSLocalizedDescriptionKey: "Audio PTS predates the shared timeline origin"]) }
    if let expected = nextExpectedFrames[packet.source] {
      if logicalStart < expected - Int64(callbackJitterToleranceFrames) {
        throw NSError(
          domain: "MeetlessCapture",
          code: 21,
          userInfo: [NSLocalizedDescriptionKey: "Audio PTS moved backwards beyond callback jitter tolerance"]
        )
      } else if logicalStart > expected + Int64(callbackJitterToleranceFrames) {
        try flush(packet.source)
        nextExpectedFrames[packet.source] = nil
      } else {
        logicalStart = expected
      }
    }
    if buffers[packet.source, default: []].isEmpty { chunkStartFrames[packet.source] = logicalStart }
    buffers[packet.source, default: []].append(contentsOf: packet.samples)
    nextExpectedFrames[packet.source] = logicalStart + Int64(packet.samples.count)
    while buffers[packet.source, default: []].count >= defaultChunkFrames {
      let frames = Array(buffers[packet.source, default: []].prefix(defaultChunkFrames))
      buffers[packet.source]?.removeFirst(defaultChunkFrames)
      let startFrame = chunkStartFrames[packet.source]!
      try commit(frames, source: packet.source, startFrame: startFrame)
      chunkStartFrames[packet.source] = startFrame + Int64(frames.count)
      if buffers[packet.source, default: []].isEmpty { chunkStartFrames[packet.source] = nil }
    }
  }

  private func flushAll() throws {
    for source in Source.allCases { try flush(source) }
  }

  private func flush(_ source: Source) throws {
    let frames = buffers[source, default: []]
    buffers[source] = []
    guard !frames.isEmpty, let startFrame = chunkStartFrames[source] else { return }
    try commit(frames, source: source, startFrame: startFrame)
    chunkStartFrames[source] = nil
  }

  private func commit(_ frames: [Int16], source: Source, startFrame: Int64) throws {
    guard !frames.isEmpty else { return }
    let index = indexes[source, default: 0]
    let id = String(format: "chunk--%@--%06d--%012lld--%012d--%d--%d", source.rawValue, index, startFrame, frames.count, sampleRate, channels)
    let finalURL = directory.appendingPathComponent("\(id).wav")
    let partialURL = directory.appendingPathComponent(".\(id).\(UUID().uuidString).partial")
    let wav = wavData(frames)
    let descriptor = Darwin.open(partialURL.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    do {
      try wav.withUnsafeBytes { raw in
        var written = 0
        while written < raw.count {
          let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: written), raw.count - written)
          if count < 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
          written += count
        }
      }
      if fsync(descriptor) != 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    } catch {
      Darwin.close(descriptor)
      try? FileManager.default.removeItem(at: partialURL)
      throw error
    }
    Darwin.close(descriptor)
    if rename(partialURL.path, finalURL.path) != 0 {
      try? FileManager.default.removeItem(at: partialURL)
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let directoryFd = Darwin.open(directory.path, O_RDONLY)
    if directoryFd >= 0 { _ = fsync(directoryFd); Darwin.close(directoryFd) }
    let committed = try Data(contentsOf: finalURL)
    let digest = SHA256.hash(data: committed).map { String(format: "%02x", $0) }.joined()
    let startMs = Int(startFrame * 1_000 / Int64(sampleRate))
    let durationMs = max(1, frames.count * 1_000 / sampleRate)
    let eventDigest = invalidClaimFixture && source == .microphone && index == 1 ? String(repeating: "0", count: 64) : digest
    emit(ProtocolEvent(
      event: "chunkCommitted", source: source.rawValue, id: id, path: finalURL.path,
      byteLength: committed.count, sha256: eventDigest, logicalStartMs: startMs,
      durationMs: durationMs, sampleRate: sampleRate, channels: channels, format: "wav"
    ))
    indexes[source] = index + 1
  }

  private func wavData(_ frames: [Int16]) -> Data {
    var data = Data()
    func append<T>(_ value: T) {
      var little = value
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    data.append(Data("RIFF".utf8)); append(UInt32(36 + frames.count * 2).littleEndian)
    data.append(Data("WAVEfmt ".utf8)); append(UInt32(16).littleEndian)
    append(UInt16(1).littleEndian); append(UInt16(channels).littleEndian)
    append(UInt32(sampleRate).littleEndian); append(UInt32(sampleRate * channels * 2).littleEndian)
    append(UInt16(channels * 2).littleEndian); append(UInt16(16).littleEndian)
    data.append(Data("data".utf8)); append(UInt32(frames.count * 2).littleEndian)
    for frame in frames { append(UInt16(bitPattern: frame).littleEndian) }
    return data
  }
}

private protocol CaptureSource: AnyObject, Sendable {
  func start() async throws
  func stop() async
}

private final class FixtureSource: CaptureSource, @unchecked Sendable {
  private let writer: ChunkWriter
  private let timelineFixture: Bool
  private let jitterFixture: Bool
  private let backwardPTSFixture: Bool
  private var timer: DispatchSourceTimer?
  private var micFrame: Int64 = 0
  private var systemFrame: Int64 = 0
  private var tickIndex: Int64 = 0
  init(writer: ChunkWriter, timelineFixture: Bool, jitterFixture: Bool, backwardPTSFixture: Bool) {
    self.writer = writer
    self.timelineFixture = timelineFixture
    self.jitterFixture = jitterFixture
    self.backwardPTSFixture = backwardPTSFixture
  }
  func start() async throws {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "meetless.fixture"))
    timer.schedule(deadline: .now(), repeating: .milliseconds(jitterFixture ? 5 : (timelineFixture ? 50 : 100)))
    timer.setEventHandler { [weak self] in self?.tick() }
    self.timer = timer
    timer.resume()
  }
  private func tick() {
    let count = timelineFixture ? sampleRate / 4 : sampleRate / 10
    let mic = (0..<count).map { offset -> Int16 in
      let value = sin(2 * Double.pi * 440 * Double(micFrame + Int64(offset)) / Double(sampleRate))
      return Int16(value * 8_000)
    }
    let system = (0..<count).map { offset -> Int16 in
      let value = sin(2 * Double.pi * 880 * Double(systemFrame + Int64(offset)) / Double(sampleRate))
      return Int16(value * 8_000)
    }
    micFrame += Int64(count); systemFrame += Int64(count)
    let base = timelineFixture ? Int64(sampleRate * 10) : 0
    let jitter = jitterFixture ? [Int64(0), Int64(80), Int64(-64)][Int(tickIndex % 3)] : 0
    let micPresentation = timelineFixture
      ? base + (tickIndex == 0 ? 0 : (tickIndex + 1) * Int64(count))
      : (backwardPTSFixture && tickIndex == 3 ? 0 : tickIndex * Int64(count) + jitter)
    let systemPresentation = timelineFixture
      ? base + Int64(sampleRate / 8) + tickIndex * Int64(count)
      : tickIndex * Int64(count) - jitter
    tickIndex += 1
    do {
      try writer.append(mic, source: .microphone, presentationFrame: micPresentation)
      try writer.append(system, source: .system, presentationFrame: systemPresentation)
      if jitterFixture && tickIndex >= 600 { timer?.cancel(); timer = nil }
    }
    catch {
      diagnostic("fixture write failed: \(error)")
      if backwardPTSFixture {
        emit(ProtocolEvent(event: "captureFailed", error: error.localizedDescription))
        timer?.cancel(); timer = nil
      }
    }
  }
  func stop() async { timer?.cancel(); timer = nil }
}

@available(macOS 15.0, *)
private final class ScreenCaptureSource: NSObject, CaptureSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let writer: ChunkWriter
  private var stream: SCStream?
  private let systemQueue = DispatchQueue(label: "meetless.capture.system")
  private let microphoneQueue = DispatchQueue(label: "meetless.capture.microphone")
  init(writer: ChunkWriter) { self.writer = writer }

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw NSError(domain: "MeetlessCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available for ScreenCaptureKit"] ) }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.width = 2; configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.capturesAudio = true
    configuration.captureMicrophone = true
    configuration.excludesCurrentProcessAudio = true
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: systemQueue)
    try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: microphoneQueue)
    self.stream = stream
    try await stream.startCapture()
  }

  func stop() async { try? await stream?.stopCapture(); stream = nil }

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard buffer.isValid else { return }
    let source: Source = type == .microphone ? .microphone : .system
    guard type == .microphone || type == .audio else { return }
    let presentationSeconds = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
    guard presentationSeconds.isFinite && presentationSeconds >= 0 else {
      diagnostic("\(source.rawValue) buffer rejected: invalid presentation timestamp")
      return
    }
    let presentationFrame = Int64((presentationSeconds * Double(sampleRate)).rounded())
    do { try writer.append(try normalizedSamples(buffer), source: source, presentationFrame: presentationFrame) }
    catch {
      let reason = "\(source.rawValue) capture failed: \(error.localizedDescription)"
      diagnostic(reason)
      emit(ProtocolEvent(event: "captureFailed", error: reason))
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: any Error) {
    emit(ProtocolEvent(event: "captureFailed", error: error.localizedDescription))
  }

  private func normalizedSamples(_ sampleBuffer: CMSampleBuffer) throws -> [Int16] {
    guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
          let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description),
          let sourceFormat = AVAudioFormat(streamDescription: basic) else {
      throw NSError(domain: "MeetlessCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing audio format"])
    }
    let sourceFrames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: sourceFrames) else {
      throw NSError(domain: "MeetlessCapture", code: 3)
    }
    input.frameLength = sourceFrames
    let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(sourceFrames), into: input.mutableAudioBufferList)
    guard copyStatus == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(copyStatus)) }
    guard let targetFormat = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1),
          let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
      throw NSError(domain: "MeetlessCapture", code: 4)
    }
    let ratio = Double(sampleRate) / sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(sourceFrames) * ratio) + 32)
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      throw NSError(domain: "MeetlessCapture", code: 5)
    }
    final class Supply: @unchecked Sendable { var supplied = false }
    let supply = Supply()
    var conversionError: NSError?
    converter.convert(to: output, error: &conversionError) { _, status in
      if supply.supplied { status.pointee = .noDataNow; return nil }
      supply.supplied = true; status.pointee = .haveData; return input
    }
    if let conversionError { throw conversionError }
    guard let channel = output.floatChannelData?[0] else { return [] }
    return (0..<Int(output.frameLength)).map { index in
      let clipped = max(-1.0, min(1.0, channel[index]))
      return Int16(clipped * Float(Int16.max))
    }
  }
}

private final class Runtime: @unchecked Sendable {
  private let fixture: Bool
  private let timelineFixture: Bool
  private let invalidClaimFixture: Bool
  private let jitterFixture: Bool
  private let backwardPTSFixture: Bool
  private var writer: ChunkWriter?
  private var source: CaptureSource?
  private var stopped = false
  init(fixture: Bool, timelineFixture: Bool, invalidClaimFixture: Bool, jitterFixture: Bool, backwardPTSFixture: Bool) {
    self.fixture = fixture
    self.timelineFixture = timelineFixture
    self.invalidClaimFixture = invalidClaimFixture
    self.jitterFixture = jitterFixture
    self.backwardPTSFixture = backwardPTSFixture
  }

  func handle(_ command: Command) throws {
    guard command.version == 1 else { throw NSError(domain: "MeetlessCapture", code: 10, userInfo: [NSLocalizedDescriptionKey: "Unsupported protocol version"] ) }
    switch command.command {
    case "start":
      guard writer == nil, let rawDirectory = command.sessionDirectory else { throw NSError(domain: "MeetlessCapture", code: 11) }
      let directory = URL(fileURLWithPath: rawDirectory).standardizedFileURL
      let writer = try ChunkWriter(directory: directory, invalidClaimFixture: invalidClaimFixture)
      self.writer = writer
      let source: CaptureSource = fixture
        ? FixtureSource(
            writer: writer,
            timelineFixture: timelineFixture,
            jitterFixture: jitterFixture,
            backwardPTSFixture: backwardPTSFixture
          )
        : ScreenCaptureSource(writer: writer)
      self.source = source
      let semaphore = DispatchSemaphore(value: 0)
      final class ErrorBox: @unchecked Sendable { var error: Error? }
      let box = ErrorBox()
      Task.detached { do { try await source.start() } catch { box.error = error }; semaphore.signal() }
      semaphore.wait()
      if let startError = box.error { throw startError }
      emit(ProtocolEvent(event: "started"))
    case "pause":
      try requireWriter().pause(); emit(ProtocolEvent(event: "paused"))
    case "resume":
      try requireWriter().resume(elapsedMs: command.elapsedMs ?? 0); emit(ProtocolEvent(event: "resumed"))
    case "stop":
      shutdown(interrupted: false)
    default: throw NSError(domain: "MeetlessCapture", code: 12, userInfo: [NSLocalizedDescriptionKey: "Unknown command \(command.command)"])
    }
  }

  func shutdown(interrupted: Bool) {
    guard !stopped else { return }
    stopped = true
    let semaphore = DispatchSemaphore(value: 0)
    let source = self.source
    Task.detached { await source?.stop(); semaphore.signal() }
    semaphore.wait()
    do { try writer?.close() } catch { diagnostic("final chunk close failed: \(error)") }
    emit(ProtocolEvent(event: interrupted ? "interrupted" : "stopped"))
  }

  private func requireWriter() throws -> ChunkWriter {
    guard let writer else { throw NSError(domain: "MeetlessCapture", code: 13, userInfo: [NSLocalizedDescriptionKey: "Capture has not started"] ) }
    return writer
  }
}

private let timelineFixture = CommandLine.arguments.contains("--timeline-fixture")
private let invalidClaimFixture = CommandLine.arguments.contains("--invalid-claim-fixture")
private let jitterFixture = CommandLine.arguments.contains("--jitter-fixture")
private let backwardPTSFixture = CommandLine.arguments.contains("--backward-pts-fixture")
private let runtime = Runtime(
  fixture: CommandLine.arguments.contains("--fixture") || timelineFixture || invalidClaimFixture || jitterFixture || backwardPTSFixture,
  timelineFixture: timelineFixture,
  invalidClaimFixture: invalidClaimFixture,
  jitterFixture: jitterFixture,
  backwardPTSFixture: backwardPTSFixture
)
while let line = readLine() {
  guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
  do {
    let command = try JSONDecoder().decode(Command.self, from: Data(line.utf8))
    try runtime.handle(command)
    if command.command == "stop" { break }
  } catch {
    emit(ProtocolEvent(event: "error", error: error.localizedDescription))
  }
}
runtime.shutdown(interrupted: true)
