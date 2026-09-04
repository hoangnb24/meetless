import Darwin
import Foundation

private let protocolSchema = "MAS_GATE_MUTATION v2"
private let protocolVersion = 2
private let lockSchema = "MAS_GATE_LOCK v1"
private let lockFilename = ".meetless-mas-gate.lock"
private let systemPackageParentPath = "/Applications"
private let renameExclusive: UInt32 = 0x00000004 // RENAME_EXCL
private let renameNoFollowAny: UInt32 = 0x00000010 // RENAME_NOFOLLOW_ANY
private let originalParentPID = getppid()

private struct Arguments {
  let parentPath: String
  let lockPath: String
  let packageParentPath: String
}

private struct DirectoryHandle {
  let descriptor: Int32
  let information: stat
  let path: String
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
  var packageParentPath: String?
  for argument in CommandLine.arguments.dropFirst() {
    if argument.hasPrefix("--parent=") {
      guard parentPath == nil else { fail("--parent was supplied more than once") }
      parentPath = String(argument.dropFirst("--parent=".count))
    } else if argument.hasPrefix("--lock=") {
      guard lockPath == nil else { fail("--lock was supplied more than once") }
      lockPath = String(argument.dropFirst("--lock=".count))
    } else if argument.hasPrefix("--package-parent=") {
      guard packageParentPath == nil else { fail("--package-parent was supplied more than once") }
      packageParentPath = String(argument.dropFirst("--package-parent=".count))
    } else {
      fail("unsupported argument \(argument)")
    }
  }
  guard let parentPath, let lockPath, let packageParentPath,
        !parentPath.isEmpty, !lockPath.isEmpty, !packageParentPath.isEmpty else {
    fail("--parent, --lock, and --package-parent are required")
  }
  do {
    try validateCanonicalAbsolutePath(parentPath, label: "parent path")
    try validateCanonicalAbsolutePath(lockPath, label: "lock path")
    try validateCanonicalAbsolutePath(packageParentPath, label: "package parent path")
  } catch let error as MutationError {
    fail(error.message)
  } catch {
    fail("invalid mutation-session arguments")
  }
  guard lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(lockFilename).path else {
    fail("lock path is not the fixed sibling lock")
  }
  return Arguments(parentPath: parentPath, lockPath: lockPath, packageParentPath: packageParentPath)
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
  case ELOOP: return "ELOOP"
  case ENOTDIR: return "ENOTDIR"
  case EINVAL: return "EINVAL"
  default: return "ERRNO_\(code)"
  }
}

private func validateCanonicalAbsolutePath(_ path: String, label: String) throws {
  guard path.hasPrefix("/"), !path.contains("\0"),
        path == URL(fileURLWithPath: path).path else {
    throw MutationError(code: EINVAL, message: "\(label) is not one canonical absolute path")
  }
  if path == "/" { return }
  guard !path.hasSuffix("/") else {
    throw MutationError(code: EINVAL, message: "\(label) is not one canonical absolute path")
  }
  let components = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
        "/" + components.joined(separator: "/") == path else {
    throw MutationError(code: EINVAL, message: "\(label) contains a non-canonical path component")
  }
}

private func absoluteComponents(_ path: String, label: String) throws -> [String] {
  try validateCanonicalAbsolutePath(path, label: label)
  if path == "/" { return [] }
  return path.dropFirst().split(separator: "/").map(String.init)
}

private func descriptorStat(_ descriptor: Int32, label: String) throws -> stat {
  var information = stat()
  guard fstat(descriptor, &information) == 0 else {
    throw MutationError(code: errno, message: "cannot inspect \(label)")
  }
  return information
}

private func assertSecureDirectory(_ handle: DirectoryHandle, label: String) throws {
  let information = handle.information
  guard (information.st_mode & S_IFMT) == S_IFDIR,
        (information.st_uid == getuid() || information.st_uid == 0),
        (information.st_mode & 0o022) == 0 else {
    throw MutationError(code: EPERM, message: "\(label) is not one secure non-writable directory")
  }
}

private func assertPackageParent(_ handle: DirectoryHandle) throws {
  let information = try descriptorStat(handle.descriptor, label: "package parent")
  guard sameDirectory(information, handle.information) else {
    throw MutationError(code: EPERM, message: "package parent descriptor identity changed")
  }
  let resolvedPath = try canonicalRealPath(handle.path)
  guard resolvedPath == handle.path else {
    throw MutationError(code: EPERM, message: "package parent is a symlink or path alias")
  }
  let adminGroup = handle.path == systemPackageParentPath ? try resolvedAdminGroup() : nil
  let effectiveUid = geteuid()
  let supplementaryGroups = handle.path == systemPackageParentPath && effectiveUid != 0
    ? try supplementaryGroupSet()
    : Set<gid_t>()
  try assertPackageParentMetadata(
    information,
    path: handle.path,
    resolvedAdminGroup: adminGroup,
    effectiveUid: effectiveUid,
    supplementaryGroups: supplementaryGroups,
  )
}

private func assertPackageParentMetadata(
  _ information: stat,
  path: String,
  resolvedAdminGroup: gid_t?,
  effectiveUid: uid_t,
  supplementaryGroups: Set<gid_t>,
) throws {
  guard (information.st_mode & S_IFMT) == S_IFDIR else {
    throw MutationError(code: EPERM, message: "package parent is not one directory")
  }

  // /Applications is a contract-owned system destination. Its metadata is
  // intentionally not accepted through the private-parent class.
  if path == systemPackageParentPath {
    guard information.st_uid == 0,
          (information.st_mode & 0o7777) == 0o775 else {
      throw MutationError(code: EPERM, message: "exact /Applications package parent must be root-owned with mode 0775")
    }
    guard let adminGroup = resolvedAdminGroup else {
      throw MutationError(code: EPERM, message: "the actual system admin group could not be resolved")
    }
    guard information.st_gid == adminGroup else {
      throw MutationError(code: EPERM, message: "exact /Applications package parent is not owned by the resolved admin group")
    }
    let authorized = effectiveUid == 0 || supplementaryGroups.contains(adminGroup)
    guard authorized else {
      throw MutationError(code: EPERM, message: "effective user is neither root nor a supplementary member of the admin group")
    }
    return
  }

  guard (information.st_uid == getuid() || information.st_uid == 0),
        (information.st_mode & 0o022) == 0 else {
    throw MutationError(code: EPERM, message: "private package parent must be current-user/root-owned and non-group/other-writable")
  }
}

private func resolvedAdminGroup() throws -> gid_t {
  guard let entry = "admin".withCString({ getgrnam($0) }) else {
    throw MutationError(code: EPERM, message: "the actual system admin group could not be resolved")
  }
  return entry.pointee.gr_gid
}

private func supplementaryGroupSet() throws -> Set<gid_t> {
  let count = getgroups(0, nil)
  guard count >= 0 else {
    throw MutationError(code: errno, message: "cannot inspect supplementary group membership")
  }
  if count == 0 { return [] }
  var groups = [gid_t](repeating: 0, count: Int(count))
  let copied = groups.withUnsafeMutableBufferPointer { buffer in
    getgroups(count, buffer.baseAddress)
  }
  guard copied == count else {
    throw MutationError(code: errno, message: "cannot read complete supplementary group membership")
  }
  return Set(groups)
}

private func openDirectoryFromDescriptor(_ base: Int32, _ components: [String], label: String) throws -> Int32 {
  var descriptor = ".".withCString { openat(base, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
  guard descriptor >= 0 else {
    throw MutationError(code: errno, message: "cannot open \(label)")
  }
  do {
    for component in components {
      let next = component.withCString { openat(descriptor, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
      guard next >= 0 else {
        throw MutationError(code: errno, message: "cannot open \(label) component \(component)")
      }
      close(descriptor)
      descriptor = next
    }
    return descriptor
  } catch {
    close(descriptor)
    throw error
  }
}

private func openTrustedDirectory(_ path: String, label: String) throws -> DirectoryHandle {
  let components = try absoluteComponents(path, label: label)
  let rootDescriptor = "/".withCString { open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
  guard rootDescriptor >= 0 else {
    throw MutationError(code: errno, message: "cannot open trusted filesystem root")
  }
  defer { close(rootDescriptor) }
  let descriptor = try openDirectoryFromDescriptor(rootDescriptor, components, label: label)
  do {
    let information = try descriptorStat(descriptor, label: label)
    guard (information.st_mode & S_IFMT) == S_IFDIR else {
      throw MutationError(code: ENOTDIR, message: "\(label) is not a directory")
    }
    return DirectoryHandle(descriptor: descriptor, information: information, path: path)
  } catch {
    close(descriptor)
    throw error
  }
}

private func openTrustedDirectoryRelativeTo(_ root: DirectoryHandle, _ path: String, label: String) throws -> DirectoryHandle {
  guard path == root.path || path.hasPrefix("\(root.path)/") else {
    throw MutationError(code: EPERM, message: "\(label) is outside its authorized runtime root")
  }
  let suffix = path == root.path ? "" : String(path.dropFirst(root.path.count + 1))
  let components = suffix.isEmpty ? [] : suffix.split(separator: "/").map(String.init)
  let descriptor = try openDirectoryFromDescriptor(root.descriptor, components, label: label)
  do {
    let information = try descriptorStat(descriptor, label: label)
    guard (information.st_mode & S_IFMT) == S_IFDIR else {
      throw MutationError(code: ENOTDIR, message: "\(label) is not a directory")
    }
    return DirectoryHandle(descriptor: descriptor, information: information, path: path)
  } catch {
    close(descriptor)
    throw error
  }
}

private func sameDirectory(_ left: stat, _ right: stat) -> Bool {
  left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

private func canonicalRealPath(_ path: String) throws -> String {
  guard let resolved = path.withCString({ realpath($0, nil) }) else {
    throw MutationError(code: errno, message: "cannot verify the canonical package parent path")
  }
  defer { free(resolved) }
  return String(cString: resolved)
}

private func closeDirectory(_ handle: DirectoryHandle) {
  close(handle.descriptor)
}

private func finalComponent(_ path: String, label: String) throws -> String {
  try validateCanonicalAbsolutePath(path, label: label)
  guard let component = path.split(separator: "/").last.map(String.init),
        !component.isEmpty, component != ".", component != "..", !component.contains("\0") else {
    throw MutationError(code: EINVAL, message: "\(label) has an invalid final component")
  }
  return component
}

private func parentPath(_ path: String) -> String {
  URL(fileURLWithPath: path).deletingLastPathComponent().path
}

private func acquireLock(_ arguments: Arguments) -> (Int32, DirectoryHandle, DirectoryHandle) {
  do {
    let parent = try openTrustedDirectory(arguments.parentPath, label: "lock parent")
    do {
      try assertSecureDirectory(parent, label: "lock parent")
      let packageParent = try openTrustedDirectory(arguments.packageParentPath, label: "package parent")
      do {
        try assertPackageParent(packageParent)
        let descriptor = lockFilename.withCString { openat(parent.descriptor, $0, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600) }
        guard descriptor >= 0 else { throw MutationError(code: errno, message: "cannot open the stable sibling lock") }
        do {
          guard fchmod(descriptor, 0o600) == 0 else {
            throw MutationError(code: errno, message: "cannot set stable sibling lock mode")
          }
          let lock = try descriptorStat(descriptor, label: "stable sibling lock")
          guard (lock.st_mode & S_IFMT) == S_IFREG,
                lock.st_uid == getuid(),
                lock.st_nlink == 1,
                lock.st_dev == parent.information.st_dev else {
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
            "version": protocolVersion,
            "kind": "ready",
            "pid": Int(getpid()),
            "lockPath": arguments.lockPath,
            "packageParentPath": arguments.packageParentPath,
          ])
          return (descriptor, parent, packageParent)
        } catch {
          close(descriptor)
          throw error
        }
      } catch {
        closeDirectory(packageParent)
        throw error
      }
    } catch {
      closeDirectory(parent)
      throw error
    }
  } catch let error as MutationError {
    emit([
      "schema": protocolSchema,
      "version": protocolVersion,
      "kind": "fatal",
      "code": errorCodeName(error.code),
      "message": error.message,
    ])
    exit(1)
  } catch {
    emit([
      "schema": protocolSchema,
      "version": protocolVersion,
      "kind": "fatal",
      "code": "UNKNOWN",
      "message": "stable sibling lock acquisition failed",
    ])
    exit(1)
  }
}

private func assertLock(_ descriptor: Int32, parent: DirectoryHandle, arguments: Arguments) throws {
  guard getppid() == originalParentPID else {
    throw MutationError(code: ESRCH, message: "lock-holder parent exited")
  }
  let lock = try descriptorStat(descriptor, label: "the held lock descriptor")
  let currentParent = try openTrustedDirectory(arguments.parentPath, label: "lock parent")
  defer { closeDirectory(currentParent) }
  guard sameDirectory(currentParent.information, parent.information) else {
    throw MutationError(code: EPERM, message: "held lock parent identity changed")
  }
  var lockPathIdentity = stat()
  guard fstatat(parent.descriptor, lockFilename, &lockPathIdentity, AT_SYMLINK_NOFOLLOW) == 0 else {
    throw MutationError(code: errno, message: "stable sibling lock path is unavailable")
  }
  guard (lock.st_mode & S_IFMT) == S_IFREG,
        lock.st_uid == getuid(),
        lock.st_nlink == 1,
        lock.st_dev == parent.information.st_dev,
        (lockPathIdentity.st_mode & S_IFMT) == S_IFREG,
        lockPathIdentity.st_dev == lock.st_dev,
        lockPathIdentity.st_ino == lock.st_ino,
        lockPathIdentity.st_uid == lock.st_uid,
        lockPathIdentity.st_nlink == lock.st_nlink else {
    throw MutationError(code: EPERM, message: "held lock identity changed")
  }
}

private func resolveMoveParents(
  sourceParentPath: String,
  destinationParentPath: String,
  pathClass: String,
  authorizedParentPath: String?,
  authorizedRootPath: String?,
  lockParent: DirectoryHandle,
  packageParent: DirectoryHandle,
  runtimeRoot: DirectoryHandle?,
) throws -> (DirectoryHandle, DirectoryHandle) {
  switch pathClass {
  case "runtime-sibling":
    guard authorizedParentPath == nil, authorizedRootPath == nil else {
      throw MutationError(code: EINVAL, message: "runtime-sibling move has unexpected authorized path data")
    }
    let sourceParent = try openTrustedDirectory(sourceParentPath, label: "runtime-sibling source parent")
    let destinationParent: DirectoryHandle
    do {
      destinationParent = try openTrustedDirectory(destinationParentPath, label: "runtime-sibling destination parent")
    } catch {
      closeDirectory(sourceParent)
      throw error
    }
    guard sameDirectory(sourceParent.information, lockParent.information),
          sameDirectory(destinationParent.information, lockParent.information) else {
      closeDirectory(sourceParent)
      closeDirectory(destinationParent)
      throw MutationError(code: EPERM, message: "runtime-sibling parents are not the held lock parent descriptor")
    }
    return (sourceParent, destinationParent)
  case "package-sibling":
    guard let authorizedParentPath,
          authorizedParentPath == packageParent.path,
          authorizedRootPath == nil else {
      throw MutationError(code: EINVAL, message: "package-sibling move is not bound to the pinned package parent")
    }
    try assertPackageParent(packageParent)
    let sourceParent = try openTrustedDirectory(sourceParentPath, label: "package-sibling source parent")
    let destinationParent: DirectoryHandle
    do {
      destinationParent = try openTrustedDirectory(destinationParentPath, label: "package-sibling destination parent")
    } catch {
      closeDirectory(sourceParent)
      throw error
    }
    guard sameDirectory(sourceParent.information, packageParent.information),
          sameDirectory(destinationParent.information, packageParent.information) else {
      closeDirectory(sourceParent)
      closeDirectory(destinationParent)
      throw MutationError(code: EPERM, message: "package-sibling parents do not match the pinned package parent descriptor")
    }
    return (sourceParent, destinationParent)
  case "runtime-child":
    guard let runtimeRoot,
          let authorizedRootPath,
          authorizedRootPath == runtimeRoot.path,
          authorizedParentPath == nil else {
      throw MutationError(code: EINVAL, message: "runtime-child move is not bound to the live runtime-root descriptor")
    }
    let sourceParent = try openTrustedDirectoryRelativeTo(runtimeRoot, sourceParentPath, label: "runtime-child source parent")
    let destinationParent: DirectoryHandle
    do {
      destinationParent = try openTrustedDirectoryRelativeTo(runtimeRoot, destinationParentPath, label: "runtime-child destination parent")
    } catch {
      closeDirectory(sourceParent)
      throw error
    }
    return (sourceParent, destinationParent)
  default:
    throw MutationError(code: EINVAL, message: "protected move has an unknown path class")
  }
}

private func renameNoReplace(
  _ source: String,
  _ destination: String,
  pathClass: String,
  authorizedParentPath: String?,
  authorizedRootPath: String?,
  lockParent: DirectoryHandle,
  packageParent: DirectoryHandle,
  runtimeRoot: DirectoryHandle?,
) throws {
  try validateCanonicalAbsolutePath(source, label: "protected move source")
  try validateCanonicalAbsolutePath(destination, label: "protected move destination")
  guard source != destination else {
    throw MutationError(code: EINVAL, message: "protected move source and destination must differ")
  }
  let sourceName = try finalComponent(source, label: "protected move source")
  let destinationName = try finalComponent(destination, label: "protected move destination")
  let sourceParentPath = parentPath(source)
  let destinationParentPath = parentPath(destination)
  let (sourceParent, destinationParent) = try resolveMoveParents(
    sourceParentPath: sourceParentPath,
    destinationParentPath: destinationParentPath,
    pathClass: pathClass,
    authorizedParentPath: authorizedParentPath,
    authorizedRootPath: authorizedRootPath,
    lockParent: lockParent,
    packageParent: packageParent,
    runtimeRoot: runtimeRoot,
  )
  defer {
    closeDirectory(sourceParent)
    closeDirectory(destinationParent)
  }
  if pathClass == "package-sibling" {
    try assertPackageParent(packageParent)
  }
  guard sourceParent.information.st_dev == destinationParent.information.st_dev else {
    throw MutationError(code: EXDEV, message: "protected move source and destination are on different devices")
  }
  var sourceInformation = stat()
  guard fstatat(sourceParent.descriptor, sourceName, &sourceInformation, AT_SYMLINK_NOFOLLOW) == 0 else {
    throw MutationError(code: errno, message: "protected move source is unavailable")
  }
  guard (sourceInformation.st_mode & S_IFMT) != S_IFLNK else {
    throw MutationError(code: ELOOP, message: "protected move source is a symlink")
  }
  guard renameatx_np(sourceParent.descriptor, sourceName, destinationParent.descriptor, destinationName, renameExclusive | renameNoFollowAny) == 0 else {
    throw MutationError(code: errno, message: "protected move failed")
  }
}

private func bindRuntimeRoot(_ path: String, current: inout DirectoryHandle?) throws {
  let candidate = try openTrustedDirectory(path, label: "runtime root")
  do {
    try assertSecureDirectory(candidate, label: "runtime root")
    if let current {
      guard current.path == candidate.path, sameDirectory(current.information, candidate.information) else {
        throw MutationError(code: EPERM, message: "runtime-root descriptor identity changed")
      }
      closeDirectory(candidate)
    } else {
      current = candidate
    }
  } catch {
    if current?.descriptor != candidate.descriptor { closeDirectory(candidate) }
    throw error
  }
}

private func handle(
  _ request: [String: Any],
  descriptor: Int32,
  lockParent: DirectoryHandle,
  packageParent: DirectoryHandle,
  arguments: Arguments,
  runtimeRoot: inout DirectoryHandle?,
) -> Bool {
  let requestID = request["requestId"] as? String ?? ""
  guard request["schema"] as? String == protocolSchema,
        request["version"] as? Int == protocolVersion,
        !requestID.isEmpty else {
    emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": false, "code": "EINVAL", "message": "invalid mutation request"])
    return true
  }
  do {
    try assertLock(descriptor, parent: lockParent, arguments: arguments)
    switch request["command"] as? String {
    case "assert-held":
      emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": true])
    case "bind-runtime-root":
      guard let path = request["runtimeRootPath"] as? String else {
        throw MutationError(code: EINVAL, message: "bind-runtime-root requires runtimeRootPath")
      }
      try bindRuntimeRoot(path, current: &runtimeRoot)
      emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": true, "runtimeRootPath": path])
    case "rename-excl":
      guard let source = request["source"] as? String,
            let destination = request["destination"] as? String,
            let pathClass = request["pathClass"] as? String else {
        throw MutationError(code: EINVAL, message: "rename-excl requires source, destination, and pathClass")
      }
      try renameNoReplace(
        source,
        destination,
        pathClass: pathClass,
        authorizedParentPath: request["authorizedParentPath"] as? String,
        authorizedRootPath: request["authorizedRootPath"] as? String,
        lockParent: lockParent,
        packageParent: packageParent,
        runtimeRoot: runtimeRoot,
      )
      emit(["schema": protocolSchema, "version": protocolVersion, "kind": "mutation-applied", "requestId": requestID, "source": source, "destination": destination, "pathClass": pathClass])
      emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": true])
    case "release":
      emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": true])
      return false
    default:
      throw MutationError(code: EINVAL, message: "unknown mutation command")
    }
  } catch let error as MutationError {
    emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": false, "code": errorCodeName(error.code), "message": error.message])
  } catch {
    emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": requestID, "ok": false, "code": "UNKNOWN", "message": "mutation command failed"])
  }
  return true
}

#if MEETLESS_MAS_GATE_POLICY_TESTING
private func modeledPackageParentStat(uid: uid_t, gid: gid_t, mode: UInt16, symlink: Bool = false) -> stat {
  var information = stat()
  information.st_uid = uid
  information.st_gid = gid
  information.st_mode = (symlink ? S_IFLNK : S_IFDIR) | mode
  return information
}

private func assertModeledPackageParentAccepted(
  _ information: stat,
  path: String,
  adminGroup: gid_t?,
  effectiveUid: uid_t,
  supplementaryGroups: Set<gid_t>,
) {
  do {
    try assertPackageParentMetadata(
      information,
      path: path,
      resolvedAdminGroup: adminGroup,
      effectiveUid: effectiveUid,
      supplementaryGroups: supplementaryGroups,
    )
  } catch {
    fail("modeled package-parent policy rejected an allowed case: \(path)")
  }
}

private func assertModeledPackageParentRejected(
  _ information: stat,
  path: String,
  adminGroup: gid_t?,
  effectiveUid: uid_t,
  supplementaryGroups: Set<gid_t>,
) {
  do {
    try assertPackageParentMetadata(
      information,
      path: path,
      resolvedAdminGroup: adminGroup,
      effectiveUid: effectiveUid,
      supplementaryGroups: supplementaryGroups,
    )
    fail("modeled package-parent policy accepted a forbidden case: \(path)")
  } catch let error as MutationError {
    _ = error
  } catch {
    fail("modeled package-parent policy returned an unexpected error: \(path)")
  }
}

private func runModeledPackageParentPolicyTests() -> Never {
  let currentUid = uid_t(501)
  let adminGroup = gid_t(80)
  let system = modeledPackageParentStat(uid: 0, gid: adminGroup, mode: 0o775)
  assertModeledPackageParentAccepted(
    system,
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )
  assertModeledPackageParentRejected(
    system,
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [],
  )
  assertModeledPackageParentRejected(
    system,
    path: "/private/tmp/not-Applications",
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )
  assertModeledPackageParentRejected(
    modeledPackageParentStat(uid: currentUid, gid: adminGroup, mode: 0o775),
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )
  assertModeledPackageParentRejected(
    modeledPackageParentStat(uid: 0, gid: gid_t(20), mode: 0o775),
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )
  assertModeledPackageParentRejected(
    modeledPackageParentStat(uid: 0, gid: adminGroup, mode: 0o755),
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )
  assertModeledPackageParentRejected(
    modeledPackageParentStat(uid: 0, gid: adminGroup, mode: 0o775, symlink: true),
    path: systemPackageParentPath,
    adminGroup: adminGroup,
    effectiveUid: currentUid,
    supplementaryGroups: [adminGroup],
  )

  let privateParent = modeledPackageParentStat(uid: currentUid, gid: gid_t(20), mode: 0o700)
  assertModeledPackageParentAccepted(
    privateParent,
    path: "/private/tmp/private-package-parent",
    adminGroup: nil,
    effectiveUid: currentUid,
    supplementaryGroups: [],
  )
  assertModeledPackageParentRejected(
    modeledPackageParentStat(uid: currentUid, gid: gid_t(20), mode: 0o775),
    path: "/private/tmp/runtime-parent",
    adminGroup: nil,
    effectiveUid: currentUid,
    supplementaryGroups: [],
  )
  exit(0)
}

runModeledPackageParentPolicyTests()
#else
private let arguments_ = parseArguments()
private let acquiredLock = acquireLock(arguments_)
private let lockDescriptor = acquiredLock.0
private let lockParent = acquiredLock.1
private let packageParent = acquiredLock.2
private var runtimeRoot: DirectoryHandle?
defer {
  if let runtimeRoot { closeDirectory(runtimeRoot) }
  _ = lockf(lockDescriptor, F_ULOCK, 0)
  close(lockDescriptor)
  closeDirectory(packageParent)
  closeDirectory(lockParent)
}

while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data),
        let request = object as? [String: Any] else {
    emit(["schema": protocolSchema, "version": protocolVersion, "kind": "response", "requestId": "", "ok": false, "code": "EINVAL", "message": "invalid JSON request"])
    continue
  }
  if !handle(request, descriptor: lockDescriptor, lockParent: lockParent, packageParent: packageParent, arguments: arguments_, runtimeRoot: &runtimeRoot) { break }
}
#endif
