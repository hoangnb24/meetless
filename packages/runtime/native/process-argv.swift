import Darwin
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]),
      pid > 0 else {
  fail("usage: meetless-process-argv <pid>")
}

var mib = [CTL_KERN, KERN_PROCARGS2, pid]
var size = 0
guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
  fail("cannot size native argv for PID \(pid): \(String(cString: strerror(errno)))")
}

var bytes = [UInt8](repeating: 0, count: size)
guard sysctl(&mib, UInt32(mib.count), &bytes, &size, nil, 0) == 0 else {
  fail("cannot read native argv for PID \(pid): \(String(cString: strerror(errno)))")
}
bytes.removeSubrange(size..<bytes.count)

let argc = bytes.withUnsafeBytes { raw in
  raw.loadUnaligned(as: Int32.self)
}
guard argc > 0 else { fail("native argv for PID \(pid) has invalid argc \(argc)") }

var cursor = MemoryLayout<Int32>.size
while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
while cursor < bytes.count && bytes[cursor] == 0 { cursor += 1 }

var arguments: [String] = []
while arguments.count < Int(argc), cursor < bytes.count {
  let start = cursor
  while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
  let value = String(decoding: bytes[start..<cursor], as: UTF8.self)
  arguments.append(value)
  cursor += 1
}

guard arguments.count == Int(argc) else {
  fail("native argv for PID \(pid) ended after \(arguments.count) of \(argc) arguments")
}

let output = try JSONEncoder().encode(arguments)
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data("\n".utf8))
