import { homedir } from "node:os";
import path from "node:path";

export const MACOS_PACKAGE_SCHEMA = "MEETLESS_MACOS_PACKAGE v1";
export const MACOS_PACKAGE_RUNTIME_ROOT = "/private/tmp/meetless-package-runtime";
export const MACOS_PACKAGE_IDENTITY_PATH = "/private/tmp/meetless-package-host-identity.json";
export const MACOS_PACKAGE_RENDERER_ORIGIN = "http://127.0.0.1:18082";

export function acceptedMacOSPackagePaths(userHome = homedir()) {
  const canonicalBundlePath = path.resolve(userHome, "Applications", "Meetless.app");
  return {
    canonicalBundlePath,
    runtimeRoot: MACOS_PACKAGE_RUNTIME_ROOT,
    recordingExports: path.join(MACOS_PACKAGE_RUNTIME_ROOT, "exports"),
    identityPath: MACOS_PACKAGE_IDENTITY_PATH,
    rendererOrigin: MACOS_PACKAGE_RENDERER_ORIGIN,
  };
}
