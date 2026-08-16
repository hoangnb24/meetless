import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: swift scripts/recognize-text.swift <image>\n".utf8))
  exit(2)
}

let imagePath = CommandLine.arguments[1]
guard
  let image = NSImage(contentsOfFile: imagePath),
  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
  FileHandle.standardError.write(Data("cannot read image at \(imagePath)\n".utf8))
  exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: cgImage).perform([request])

let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
