import Darwin
import Foundation

private let protocolSchema = "MAS_GATE_MUTATION v1"
private let lockSchema = "MAS_GATE_LOCK v1"
private let lockFilename = ".meetless-mas-gate.lock"
private let renameExclusive: UInt32 = 0x00000004 // RENAME_EXCL
private let renameNoFollowAny: UInt32 = 0x00000010 // RENAME_NOFOLLOW_ANY
private let originalParentPID = getppid()

private struct Arguments {
  let parentPath: String
  let lockPath: String
}

private struct MutationError: Error {
  let code: Int32
  let message: String
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("MeetlessMasGateMutation: \(message)\n".utf8))
  exit(1)
}

private func parseArguments() -> Arguments {
  var parentPath: String?
  var lockPath: String?
  for argument in CommandLine.arguments.dropFirst() {
    if argument.hasPrefix("--parent=") {
      guard parentPath == nil else { fail("--parent was supplied more than once") }
      parentPath = String(argument.dropFirst("--parent=".count))
    } else if argument.hasPrefix("--lock=") {
      guard lockPath == nil else { fail("--lock was supplied more than once") }
      lockPath = String(argument.dropFirst("--lock=".count))
    } else {
      fail("unsupported argument \(argument)")
    }
  }
  guard let parentPath, let lockPath, !parentPath.isEmpty, !lockPath.isEmpty else {
    fail("--parent and --lock are required")
  }
  guard parentPath == URL(fileURLWithPath: parentPath).path else {
    fail("parent path is not one canonical absolute path")
  }
  guard lockPath == URL(fileURLWithPath: lockPath).path else {
    fail("lock path is not one canonical absolute path")
  }
  guard lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(lockFilename).path else {
    fail("lock path is not the fixed sibling lock")
  }
  return Arguments(parentPath: parentPath, lockPath: lockPath)
}

private func emit(_ value: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(value),
        let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
    fail("could not encode protocol response")
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
  try? FileHandle.standardOutput.synchronize()
}

private func errorCodeName(_ code: Int32) -> String {
  switch code {
  case EEXIST: return "EEXIST"
  case ENOENT: return "ENOENT"
  case EXDEV: return "EXDEV"
  case EBUSY: return "EBUSY"
  case EPERM: return "EPERM"
  case EACCES: return "EACCES"
  case ENOTDIR: return "ENOTDIR"
  default: return "ERRNO_\(code)"
  }
}

private func currentStat(_ path: String) throws -> stat {
  var information = stat()
  let result = lstat(path, &information)
  guard result == 0 else {
    throw MutationError(code: errno, message: "cannot inspect \(path)")
  }
  return information
}

private func assertSecureParent(_ path: String, label: String) throws -> stat {
  let information = try currentStat(path)
  guard (information.st_mode & S_IFMT) == S_IFDIR,
        information.st_uid == getuid(),
        (information.st_mode & 0o022) == 0 else {
    throw MutationError(code: EPERM, message: "\(label) is not one secure current-owner directory")
  }
  return information
}

private func openDirectory(_ path: String, label: String) throws -> (Int32, stat) {
  let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  guard descriptor >= 0 else {
    throw MutationError(code: errno, message: "cannot open \(label)")
  }
  do {
    var information = stat()
    guard fstat(descriptor, &information) == 0 else {
      throw MutationError(code: errno, message: "cannot inspect \(label)")
    }
    guard (information.st_mode & S_IFMT) == S_IFDIR,
          (information.st_uid == getuid() || information.st_uid == 0),
          (information.st_mode & 0o022) == 0 else {
      throw MutationError(code: EPERM, message: "\(label) is not one secure non-writable directory")
    }
    return (descriptor, information)
  } catch {
    close(descriptor)
    throw error
  }
}

private func finalComponent(_ path: String, label: String) throws -> String {
  let component = URL(fileURLWithPath: path).lastPathComponent
  guard !component.isEmpty, component != ".", component != "..", !component.contains("\0") else {
    throw MutationError(code: EINVAL, message: "\(label) has an invalid final component")
  }
  return component
}

private func assertNoSymlinkAncestors(_ path: String) throws {
  var current = URL(fileURLWithPath: path).deletingLastPathComponent().path
  while current != "/" {
    let information = try currentStat(current)
    guard (information.st_mode & S_IFMT) == S_IFDIR else {
      throw MutationError(code: ENOTDIR, message: "path ancestor is not a directory at \(current)")
    }
    current = URL(fileURLWithPath: current).deletingLastPathComponent().path
  }
}

private func acquireLock(_ arguments: Arguments) -> Int32 {
  do {
    let parent = try assertSecureParent(arguments.parentPath, label: "lock parent")
    let descriptor = open(arguments.lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw MutationError(code: errno, message: "cannot open the stable sibling lock") }
    do {
      guard fchmod(descriptor, 0o600) == 0 else {
        throw MutationError(code: errno, message: "cannot set stable sibling lock mode")
      }
      var lock = stat()
      guard fstat(descriptor, &lock) == 0 else {
        throw MutationError(code: errno, message: "cannot inspect the stable sibling lock")
      }
      guard (lock.st_mode & S_IFMT) == S_IFREG,
            lock.st_uid == getuid(),
            lock.st_nlink == 1,
            lock.st_dev == parent.st_dev else {
        throw MutationError(code: EPERM, message: "stable sibling lock is not one secure same-device file")
      }
      guard lockf(descriptor, F_TLOCK, 0) == 0 else {
        throw MutationError(code: errno, message: "stable sibling fcntl lock is held")
      }
      let metadata: [String: Any] = [
        "schema": lockSchema,
        "role": "mutation-helper",
        "pid": Int(getpid()),
        "parentPath": arguments.parentPath,
      ]
      guard JSONSerialization.isValidJSONObject(metadata),
            let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]),
            ftruncate(descriptor, 0) == 0 else {
        throw MutationError(code: errno, message: "cannot publish stable sibling lock metadata")
      }
      let bytesWritten = data.withUnsafeBytes { bytes in
        write(descriptor, bytes.baseAddress, data.count)
      }
      guard bytesWritten == data.count, write(descriptor, "\n", 1) == 1, fsync(descriptor) == 0 else {
        throw MutationError(code: errno, message: "cannot durably publish stable sibling lock metadata")
      }
      emit([
        "schema": protocolSchema,
        "version": 1,
        "kind": "ready",
        "pid": Int(getpid()),
        "lockPath": arguments.lockPath,
      ])
      return descriptor
    } catch {
      close(descriptor)
      throw error
    }
  } catch let error as MutationError {
    emit([
      "schema": protocolSchema,
      "version": 1,
      "kind": "fatal",
      "code": errorCodeName(error.code),
      "message": error.message,
    ])
    exit(1)
  } catch {
    emit([
      "schema": protocolSchema,
      "version": 1,
      "kind": "fatal",
      "code": "UNKNOWN",
      "message": "stable sibling lock acquisition failed",
    ])
    exit(1)
  }
}

private func assertLock(_ descriptor: Int32, arguments: Arguments) throws {
  guard getppid() == originalParentPID else {
    throw MutationError(code: ESRCH, message: "lock-holder parent exited")
  }
  var lock = stat()
  guard fstat(descriptor, &lock) == 0 else {
    throw MutationError(code: errno, message: "cannot inspect the held lock descriptor")
  }
  let parent = try currentStat(arguments.parentPath)
  var lockPathIdentity = stat()
  guard fstatat(AT_FDCWD, arguments.lockPath, &lockPathIdentity, AT_SYMLINK_NOFOLLOW) == 0 else {
    throw MutationError(code: errno, message: "stable sibling lock path is unavailable")
  }
  guard (lock.st_mode & S_IFMT) == S_IFREG,
        lock.st_uid == getuid(),
        lock.st_nlink == 1,
        lock.st_dev == parent.st_dev,
        (lockPathIdentity.st_mode & S_IFMT) == S_IFREG,
        lockPathIdentity.st_dev == lock.st_dev,
        lockPathIdentity.st_ino == lock.st_ino,
        lockPathIdentity.st_uid == lock.st_uid,
        lockPathIdentity.st_nlink == lock.st_nlink else {
    throw MutationError(code: EPERM, message: "held lock identity changed")
  }
}

private func renameNoReplace(_ source: String, _ destination: String) throws {
  guard source.hasPrefix("/"), destination.hasPrefix("/"), source == URL(fileURLWithPath: source).path,
        destination == URL(fileURLWithPath: destination).path else {
    throw MutationError(code: EINVAL, message: "protected move paths must be canonical absolute paths")
  }
  guard source != destination else {
    throw MutationError(code: EINVAL, message: "protected move source and destination must differ")
  }
  try assertNoSymlinkAncestors(source)
  try assertNoSymlinkAncestors(destination)
  let sourceParentPath = URL(fileURLWithPath: source).deletingLastPathComponent().path
  let destinationParentPath = URL(fileURLWithPath: destination).deletingLastPathComponent().path
  let sourceName = try finalComponent(source, label: "protected move source")
  let destinationName = try finalComponent(destination, label: "protected move destination")
  let (sourceParent, sourceParentStat) = try openDirectory(sourceParentPath, label: "protected move source parent")
  defer { close(sourceParent) }
  let (destinationParent, destinationParentStat) = try openDirectory(destinationParentPath, label: "protected move destination parent")
  defer { close(destinationParent) }
  guard sourceParentStat.st_dev == destinationParentStat.st_dev else {
    throw MutationError(code: EXDEV, message: "protected move source and destination are on different devices")
  }
  var sourceInformation = stat()
  guard fstatat(sourceParent, sourceName, &sourceInformation, AT_SYMLINK_NOFOLLOW) == 0 else {
    throw MutationError(code: errno, message: "protected move source is unavailable")
  }
  guard (sourceInformation.st_mode & S_IFMT) != S_IFLNK else {
    throw MutationError(code: ELOOP, message: "protected move source is a symlink")
  }
  guard renameatx_np(sourceParent, sourceName, destinationParent, destinationName, renameExclusive | renameNoFollowAny) == 0 else {
    throw MutationError(code: errno, message: "protected move failed")
  }
}

private func handle(_ request: [String: Any], descriptor: Int32, arguments: Arguments) -> Bool {
  let requestID = request["requestId"] as? String ?? ""
  guard request["schema"] as? String == protocolSchema,
        request["version"] as? Int == 1,
        !requestID.isEmpty else {
    emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": false, "code": "EINVAL", "message": "invalid mutation request"])
    return true
  }
  do {
    try assertLock(descriptor, arguments: arguments)
    switch request["command"] as? String {
    case "assert-held":
      emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": true])
    case "rename-excl":
      guard let source = request["source"] as? String, let destination = request["destination"] as? String else {
        throw MutationError(code: EINVAL, message: "rename-excl requires source and destination")
      }
      try renameNoReplace(source, destination)
      emit(["schema": protocolSchema, "version": 1, "kind": "mutation-applied", "requestId": requestID, "source": source, "destination": destination])
      emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": true])
    case "release":
      emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": true])
      return false
    default:
      throw MutationError(code: EINVAL, message: "unknown mutation command")
    }
  } catch let error as MutationError {
    emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": false, "code": errorCodeName(error.code), "message": error.message])
  } catch {
    emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": requestID, "ok": false, "code": "UNKNOWN", "message": "mutation command failed"])
  }
  return true
}

private let arguments_ = parseArguments()
let lockDescriptor = acquireLock(arguments_)
defer {
  _ = lockf(lockDescriptor, F_ULOCK, 0)
  close(lockDescriptor)
}

while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data),
        let request = object as? [String: Any] else {
    emit(["schema": protocolSchema, "version": 1, "kind": "response", "requestId": "", "ok": false, "code": "EINVAL", "message": "invalid JSON request"])
    continue
  }
  if !handle(request, descriptor: lockDescriptor, arguments: arguments_) { break }
}
