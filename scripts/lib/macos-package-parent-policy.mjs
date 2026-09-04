import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const MACOS_PACKAGE_PARENT_SYSTEM_PATH = "/Applications";
export const MACOS_PACKAGE_PARENT_POLICY = "MACOS_PACKAGE_PARENT_POLICY v1";

const execFile = promisify(execFileCallback);
const POSIX_MODE_MASK = 0o7777;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;

/**
 * Classify one already-inspected package parent. This is deliberately plain
 * data so the policy can be exercised without touching a filesystem. The
 * filesystem/group readers below are adapters at the edge of this seam.
 */
export function evaluateMacOSPackageParentPolicy({
  parentPath,
  resolvedPath,
  metadata,
  currentUid,
  effectiveUid,
  supplementaryGroups = [],
  adminGroupId,
} = {}) {
  if (!isCanonicalAbsolutePath(parentPath)) return rejection("package parent is not one exact canonical absolute path");
  if (resolvedPath !== parentPath) return rejection("package parent is a symlink or path alias");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return rejection("package parent metadata is missing");
  if (metadata.isSymbolicLink === true || metadata.type === "symlink") return rejection("package parent is a symlink");
  if (metadata.isDirectory !== true && metadata.type !== "directory") return rejection("package parent is not one real directory");
  if (!isNonNegativeSafeInteger(metadata.uid) || !isNonNegativeSafeInteger(metadata.gid) ||
      !isNonNegativeSafeInteger(metadata.mode)) {
    return rejection("package parent metadata is incomplete");
  }
  if (!isNonNegativeSafeInteger(currentUid)) return rejection("current user identity is unavailable");

  // /Applications is a contract-owned system destination. It must not be
  // accepted through the private-parent class with drifted system metadata.
  if (parentPath === MACOS_PACKAGE_PARENT_SYSTEM_PATH) {
    if (metadata.uid !== 0 || metadata.gid !== adminGroupId ||
        (metadata.mode & POSIX_MODE_MASK) !== 0o775) {
      return rejection("exact /Applications metadata must be root-owned, admin-group-owned, and mode 0775");
    }
    if (!isNonNegativeSafeInteger(effectiveUid)) return rejection("effective user identity is unavailable for /Applications");
    if (!Array.isArray(supplementaryGroups) || supplementaryGroups.some((group) => !isNonNegativeSafeInteger(group))) {
      return rejection("supplementary group membership is unavailable for /Applications");
    }
    if (effectiveUid !== 0 && !supplementaryGroups.includes(adminGroupId)) {
      return rejection("current effective user is not root or a supplementary member of the admin group");
    }
    if (!isNonNegativeSafeInteger(adminGroupId)) return rejection("the actual system admin group could not be resolved");
    return accepted("system-applications");
  }

  if ((metadata.uid === currentUid || metadata.uid === 0) &&
      (metadata.mode & GROUP_OR_OTHER_WRITE_MASK) === 0) {
    return accepted("private");
  }
  if (metadata.mode & GROUP_OR_OTHER_WRITE_MASK) {
    return rejection("private package parents must not be group- or other-writable");
  }
  return rejection("private package parent must be owned by the current user or root");
}

/**
 * Inspect and enforce the package-parent contract. This function is the only
 * JavaScript filesystem adapter for the shared policy; callers cannot opt into
 * a generic group-writable mode.
 */
export async function assertMacOSPackageParent(parentPath, options = {}) {
  if (!isCanonicalAbsolutePath(parentPath)) {
    throw packageParentFailure(parentPath, "package parent is not one exact canonical absolute path");
  }

  let info;
  try {
    info = await (options.readMetadata ?? lstat)(parentPath);
  } catch (error) {
    throw packageParentFailure(parentPath, `package parent could not be inspected: ${describe(error)}`, error);
  }

  let resolvedPath = null;
  if (!isSymbolicLinkMetadata(info)) {
    try {
      resolvedPath = await (options.resolveRealPath ?? realpath)(parentPath);
    } catch (error) {
      throw packageParentFailure(parentPath, `package parent realpath could not be verified: ${describe(error)}`, error);
    }
  }

  const currentUid = options.currentUid ?? readUid("getuid");
  let effectiveUid = options.effectiveUid;
  let supplementaryGroups = options.supplementaryGroups;
  let adminGroupId = options.adminGroupId;
  if (parentPath === MACOS_PACKAGE_PARENT_SYSTEM_PATH) {
    effectiveUid ??= readUid("geteuid");
    supplementaryGroups ??= effectiveUid === 0 ? [] : readSupplementaryGroups();
    if (adminGroupId === undefined) {
      try {
        adminGroupId = await (options.resolveAdminGroupId ?? resolveMacOSAdminGroupId)();
      } catch (error) {
        throw packageParentFailure(parentPath, `the actual system admin group could not be resolved: ${describe(error)}`, error);
      }
    }
  }

  const result = evaluateMacOSPackageParentPolicy({
    parentPath,
    resolvedPath,
    metadata: packageParentMetadata(info),
    currentUid,
    effectiveUid,
    supplementaryGroups,
    adminGroupId,
  });
  if (!result.accepted) throw packageParentFailure(parentPath, result.reason);
  return result;
}

/**
 * Resolve the macOS Directory Services gid instead of embedding the usual
 * numeric admin gid in policy. A missing or malformed system lookup fails
 * closed rather than broadening the accepted parent class.
 */
export async function resolveMacOSAdminGroupId() {
  if (process.platform !== "darwin") throw new Error("macOS Directory Services are unavailable on this platform");
  const { stdout } = await execFile("/usr/bin/dscl", [".", "-read", "/Groups/admin", "PrimaryGroupID"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  const match = /^PrimaryGroupID:\s*(\d+)\s*$/mu.exec(stdout);
  if (!match) throw new Error("Directory Services returned no exact admin PrimaryGroupID");
  const groupId = Number(match[1]);
  if (!isNonNegativeSafeInteger(groupId)) throw new Error("Directory Services returned an invalid admin PrimaryGroupID");
  return groupId;
}

export function packageParentMetadata(info) {
  const symbolicLink = typeof info?.isSymbolicLink === "function"
    ? info.isSymbolicLink()
    : info?.isSymbolicLink === true;
  const directory = typeof info?.isDirectory === "function"
    ? info.isDirectory()
    : info?.isDirectory === true;
  return {
    type: symbolicLink ? "symlink" : directory ? "directory" : "other",
    isSymbolicLink: Boolean(symbolicLink),
    isDirectory: Boolean(directory),
    mode: Number(info?.mode),
    uid: Number(info?.uid),
    gid: Number(info?.gid),
  };
}

function accepted(classification) {
  return Object.freeze({
    policy: MACOS_PACKAGE_PARENT_POLICY,
    accepted: true,
    classification,
    reason: null,
  });
}

function rejection(reason) {
  return Object.freeze({
    policy: MACOS_PACKAGE_PARENT_POLICY,
    accepted: false,
    classification: null,
    reason,
  });
}

function packageParentFailure(parentPath, reason, cause) {
  const error = new Error(
    `MAS package parent policy rejected ${String(parentPath)}: ${reason}. ` +
    "Authority: the serial MAS package-parent contract and " +
    "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md plus " +
    "docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: use the " +
    "exact contract-owned package parent and leave the private runtime/lock parent unchanged.",
  );
  error.code = "MAS-PACKAGE-PARENT-POLICY";
  if (cause) error.cause = cause;
  return error;
}

function isCanonicalAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) &&
    !value.includes("\0") && path.resolve(value) === value &&
    (value === "/" || !value.endsWith("/"));
}

function isSymbolicLinkMetadata(info) {
  const symbolicLink = typeof info?.isSymbolicLink === "function"
    ? info.isSymbolicLink()
    : info?.isSymbolicLink === true;
  return Boolean(symbolicLink) || info?.type === "symlink";
}

function readUid(name) {
  const getter = process[name];
  if (typeof getter !== "function") throw new Error(`process.${name} is unavailable`);
  const value = getter();
  if (!isNonNegativeSafeInteger(value)) throw new Error(`process.${name} returned an invalid identity`);
  return value;
}

function readSupplementaryGroups() {
  if (typeof process.getgroups !== "function") throw new Error("process.getgroups is unavailable");
  const groups = process.getgroups();
  if (!Array.isArray(groups) || groups.some((group) => !isNonNegativeSafeInteger(group))) {
    throw new Error("process.getgroups returned invalid membership");
  }
  return groups;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
