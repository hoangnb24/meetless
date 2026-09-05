import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMasHostHandoff,
  classifyMasLsofResult,
  inspectListeners,
  inspectMasLiveState,
  inspectOpenHandles,
  installMasDevelopmentGate,
  launchMasDevelopmentGate,
  MAS_LSOF_MAX_BUFFER_BYTES,
  MAS_LSOF_PURPOSES,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  masLiveAbsentObservation,
  readMasDevelopmentGateStatus,
  readMasGateSessionStatus,
  restoreMasDevelopmentGate,
  restoreInRequiredOrder,
  stopMasDevelopmentGate,
  validateMasDevelopmentInstallArtifact,
  validateMasHostHandoff,
} from "../../../scripts/macos-mas-development-gate.mjs";
import {
  MAS_GATE_SESSION_INDEX_BASENAME,
  MAS_GATE_SESSION_INDEX_INTENT_BASENAME,
  MAS_GATE_SESSION_INDEX_SCHEMA,
  MAS_GATE_SESSION_INDEX_VERSION,
  archiveMasGateSessionTransaction,
  attestMasGateRuntimeRoot,
  beginMasGateSessionTransaction,
  restoreMasGateSessionTransaction,
} from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";
import {
  MAS_GATE_LOCK_BASENAME,
  acquireMasGateLock,
  masGateLockPath,
  withMasGateLock,
} from "../../../scripts/lib/macos-mas-gate-lock.mjs";
import { freezeMasGateArtifactBinding } from "../../../scripts/lib/mas-gate-artifact-binding.mjs";
import { inspectPackageMachOEntries } from "../../../scripts/lib/macos-package-inventory.mjs";
import {
  macAppStoreInstallationContractBytes,
  macAppStoreInstallationContractSha256,
  macAppStorePackagedHostConfiguration,
  macAppStorePackagedMarker,
} from "../../../scripts/lib/macos-app-store-package-contract.mjs";
import {
  fingerprintPath,
  packageTransactionPaths,
  replacePackageBundle,
} from "../../../scripts/lib/macos-package-transaction.mjs";
import {
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
} from "../../../scripts/lib/macos-app-store-contract.mjs";
import {
  MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES,
  R5_APP_STORE_DEVELOPMENT_DEVICE_UDID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
  R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
  R5_APP_STORE_BUNDLE_ID,
  R5_APP_STORE_TEAM_ID,
  R5_REVENUECAT_INFO_PLIST_KEY,
} from "../../../scripts/lib/macos-app-store-development.mjs";
import plist from "plist";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedMasSessionIndex(context: ReturnType<typeof masDevelopmentRuntimeContext>) {
  const indexPath = path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME);
  await writeFile(
    indexPath,
    `${JSON.stringify({
      schema: MAS_GATE_SESSION_INDEX_SCHEMA,
      version: MAS_GATE_SESSION_INDEX_VERSION,
      runtimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: context.activePath,
      indexPath,
      indexIntentPath: path.join(context.parentPath, MAS_GATE_SESSION_INDEX_INTENT_BASENAME),
      entries: [],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function makeMasValidationFixture({ bundle, manifestPath }: { bundle: string; manifestPath: string }) {
  const proofRoot = path.dirname(path.dirname(path.dirname(manifestPath)));
  const directCompositionBytes = await readFile(path.join(proofRoot, "release", "macos", "composition-manifest.json"));
  const directComposition = JSON.parse(directCompositionBytes.toString("utf8"));
  const entries = directComposition.entries;
  const inspectedEntries = await inspectPackageMachOEntries(bundle, entries, { ownerMode: true });
  const outerExecutablePath = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  const nestedElectronExecutablePath = path.join(
    bundle,
    "Contents",
    "Resources",
    "meetless",
    "runtime",
    "electron",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  const profilePath = path.join(bundle, "Contents", "embedded.provisionprofile");
  const publicSdkKey = "appl_test_fixture_public_key";
  const contract = macAppStoreInstallationContractBytes();
  const contractSha256 = macAppStoreInstallationContractSha256();
  const marker = Buffer.from(`${JSON.stringify(macAppStorePackagedMarker({ paseoCommit: directComposition.candidateSnapshot.paseoCommit }))}\n`);
  const hostConfiguration = Buffer.from(`${JSON.stringify(macAppStorePackagedHostConfiguration({ contractSha256 }))}\n`);
  const parentEntitlements = Object.fromEntries(MACOS_APP_STORE_PARENT_ENTITLEMENTS.map((key) => [
    key,
    key === "com.apple.security.application-groups" ? [`${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`] : true,
  ]));
  const childEntitlements = Object.fromEntries(MACOS_APP_STORE_CHILD_ENTITLEMENTS.map((key) => [key, true]));
  const outerInfo = Buffer.from(plist.build({
    CFBundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
    [R5_REVENUECAT_INFO_PLIST_KEY]: publicSdkKey,
  }));
  const electronInfo = Buffer.from(plist.build({
    CFBundleExecutable: "Electron",
    CFBundleVersion: "41.2.0",
  }));
  const profile = {
    Name: R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
    UUID: R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
    Entitlements: {
      "com.apple.application-identifier": `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
      "com.apple.developer.team-identifier": R5_APP_STORE_TEAM_ID,
    },
    ExpirationDate: new Date("2099-01-01T00:00:00.000Z"),
    ProvisionedDevices: [R5_APP_STORE_DEVELOPMENT_DEVICE_UDID],
  };
  const profileBytes = Buffer.from(plist.build(profile));
  const signature = {
    bundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    teamId: R5_APP_STORE_TEAM_ID,
    identity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    signature: "CMS",
    cdHash: "a".repeat(40),
  };
  const nestedMachO = inspectedEntries.map((entry) => {
    const isOuter = entry.path === "Contents/MacOS/MeetlessHost";
    const entitlementPolicy = isOuter
      ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
      : entry.machOFileType === "MH_EXECUTE"
        ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
        : MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE;
    return {
      path: entry.path,
      identifier: signature.bundleIdentifier,
      teamId: signature.teamId,
      identity: signature.identity,
      cdHash: signature.cdHash,
      architecture: entry.machOArchitecture,
      fileType: entry.machOFileType,
      entitlementKeys: entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
        ? [...MACOS_APP_STORE_CHILD_ENTITLEMENTS].sort()
        : [],
    };
  }).filter((entry) => entry.path !== "Contents/MacOS/MeetlessHost");
  const packagedContract = {
    schema: JSON.parse(contract.toString("utf8")).schema,
    runtimeRootRelativePath: JSON.parse(contract.toString("utf8")).userSupportRelativePath,
    recordingExportsRelativePath: JSON.parse(contract.toString("utf8")).recordingExportsRelativePath,
    contractSha256,
    markerTarget: JSON.parse(marker.toString("utf8")).target,
    hostRuntimeRootRelativePath: JSON.parse(hostConfiguration.toString("utf8")).runtimeRootRelativeToUserHome,
  };
  const manifest = {
    schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
    authority: "docs/decisions/0005-mac-app-store-and-revenuecat.md",
    target: "macos-app-store-arm64",
    bundlePath: "release/macos/Meetless.app",
    bundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    teamId: R5_APP_STORE_TEAM_ID,
    signingIdentity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    revenueCatPublicSdkKeyEmbedded: true,
    provisioningProfile: {
      name: R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
      uuid: R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
      sha256: createHash("sha256").update(profileBytes).digest("hex"),
      provisionedDevices: [R5_APP_STORE_DEVELOPMENT_DEVICE_UDID],
      expirationDate: profile.ExpirationDate.toISOString(),
    },
    signature: {
      verified: true,
      ...signature,
      nestedMachOCount: nestedMachO.length,
      nestedMachO,
    },
    entitlements: {
      parentKeys: Object.keys(parentEntitlements).sort(),
      childKeys: [...MACOS_APP_STORE_CHILD_ENTITLEMENTS],
      applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
    },
    electron: {
      version: "41.2.0",
      platform: "mas",
      arch: "arm64",
      archiveName: "electron-v41.2.0-mas-arm64.zip",
      executable: path.relative(bundle, nestedElectronExecutablePath).split(path.sep).join("/"),
      architecture: "arm64",
      thin: true,
    },
    artifact: {
      sha256: createHash("sha256").update(Buffer.from(JSON.stringify(entries))).digest("hex"),
      entryCount: entries.length,
      machoEntryCount: inspectedEntries.length,
    },
    packagedContract,
    directComposition: {
      path: "release/macos/composition-manifest.direct.json",
      sha256: createHash("sha256").update(directCompositionBytes).digest("hex"),
      artifactDigest: directComposition.artifactDigest,
    },
    externalGates: {
      launch: "not-run",
      purchase: "not-run",
      distribution: "not-claimed",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const files = new Map([
    [path.resolve(manifestPath), manifestBytes],
    [path.resolve(proofRoot, "release", "macos", "composition-manifest.direct.json"), directCompositionBytes],
    [path.join(bundle, "Contents", "Info.plist"), outerInfo],
    [path.join(bundle, "Contents", "Resources", "meetless", "installation-contract.json"), contract],
    [path.join(bundle, "Contents", "Resources", "meetless", "meetless-package.json"), marker],
    [path.join(bundle, "Contents", "Resources", "host-config.json"), hostConfiguration],
    [profilePath, profileBytes],
    [path.join(bundle, "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app", "Contents", "Info.plist"), electronInfo],
  ]);
  const signatureText = [
    `Identifier=${signature.bundleIdentifier}`,
    `TeamIdentifier=${signature.teamId}`,
    `Authority=${signature.identity}`,
    `Signature=${signature.signature}`,
    `CDHash=${signature.cdHash}`,
  ].join("\n");
  const machoByPath = new Map(inspectedEntries.map((entry) => [entry.path, entry]));
  const adapters = {
    readSecureFile: async (target: string) => files.get(path.resolve(target)) ?? readFile(target),
    assertSecureDirectory: async (target: string) => lstat(target),
    assertSecureFile: async (target: string) => target === profilePath
      ? { uid: process.getuid?.() ?? 0, nlink: 1, mode: 0o400, isFile: () => true, isSymbolicLink: () => false }
      : lstat(target),
    runMacOSCommand: async (command: string, arguments_: string[]) => {
      if (command === "codesign" && arguments_.includes("--verify")) return { stdout: "", stderr: "" };
      if (command === "codesign" && arguments_.includes("--entitlements")) {
        const target = arguments_.at(-1) as string;
        const entry = machoByPath.get(path.relative(bundle, target).split(path.sep).join("/"));
        const isOuter = target === bundle || target === outerExecutablePath;
        const entitlementPolicy = isOuter
          ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
          : entry?.machOFileType === "MH_EXECUTE"
            ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
            : MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE;
        const entitlements = entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
          ? parentEntitlements
          : entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
            ? childEntitlements
            : null;
        return {
          stdout: entitlements === null ? "" : plist.build(entitlements),
          stderr: `Executable=${isOuter && target === bundle ? outerExecutablePath : target}\n`,
        };
      }
      if (command === "codesign" && arguments_.includes("--verbose=4")) return { stdout: signatureText, stderr: "" };
      if (command === "codesign" && arguments_.includes("--verbose=2") && arguments_.at(-1) === profilePath) {
        const error = new Error("code object is not signed at all");
        Object.assign(error, { code: 1, stdout: "", stderr: "code object is not signed at all\n" });
        throw error;
      }
      if (command === "security") return { stdout: plist.build(profile), stderr: "" };
      if (command === "file") return { stdout: "Mach-O 64-bit executable arm64\n", stderr: "" };
      throw new Error(`unexpected fixture owner command ${command}`);
    },
    enumeratePackageEntries: async () => entries,
    inspectPackageMachOEntries: async () => inspectedEntries,
    inspectMachO: async (target: string) => {
      const entry = machoByPath.get(path.relative(bundle, target).split(path.sep).join("/"));
      if (!entry) return null;
      return {
        ...entry,
        dependencies: [],
        rpaths: [],
      };
    },
  };
  return { adapters, publicSdkKey };
}

describe("MAS development gate coordinator", () => {
  it("binds MAS state to the app-container contract and keeps the direct-DMG root separate", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    expect(context.runtimeRoot).toBe("/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless");
    expect(context.directRuntimeRoot).toBe("/Users/example/Library/Application Support/Meetless");
    expect(context.runtimeRoot).not.toBe(context.directRuntimeRoot);
    expect(context.identityPath).toBe(`${context.runtimeRoot}/host-identity.json`);
    expect(context.lockPath).toBe(`${context.parentPath}/${MAS_GATE_LOCK_BASENAME}`);
    expect(masGateRuntimeOptions(context, { requiredFreeBytes: 1 }).runtimeRoot).toBe(context.runtimeRoot);

    const directContract = { ...context.contract, userSupportRelativePath: "Library/Application Support/Meetless" };
    expect(() => masDevelopmentRuntimeContext({ userHome: "/Users/example", contract: directContract })).toThrow(/exact macAppStoreInstallationContract/);
  });

  it("exports the transaction status reader and reports a bounded empty status fixture", async () => {
    expect(readMasGateSessionStatus).toBeTypeOf("function");
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-status-export-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await expect(readMasGateSessionStatus(masGateRuntimeOptions(context))).resolves.toMatchObject({
      status: "uninitialized",
      state: "absent-safe",
      activePath: context.activePath,
    });
    await seedMasSessionIndex(context);
    await expect(readMasGateSessionStatus(masGateRuntimeOptions(context))).resolves.toMatchObject({
      status: "absent",
      activePath: context.activePath,
    });
  });

  it("propagates terminal non-device assurance through the authoritative coordinator", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-terminal-assurance-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n", { mode: 0o600 });
    const isolatedDependencies = {
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };

    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies: isolatedDependencies }),
    });
    await restoreMasGateSessionTransaction(session, masGateRuntimeOptions(context, { dependencies: isolatedDependencies }));
    const archived = await archiveMasGateSessionTransaction(session, masGateRuntimeOptions(context, { dependencies: isolatedDependencies }));
    const currentRoot = await lstat(context.runtimeRoot);
    const historicalDevice = Number(currentRoot.dev) + 1;
    const projected = await attestMasGateRuntimeRoot(context.runtimeRoot, { digestDevice: historicalDevice });
    const journal = JSON.parse(await readFile(archived.journalPath, "utf8"));
    journal.priorAggregateAttestation = { ...projected, root: { ...projected.root, dev: historicalDevice } };
    journal.priorRootIdentity = { ...journal.priorRootIdentity, dev: historicalDevice };
    journal.prior = {
      ...journal.prior,
      rootIdentity: { ...journal.prior.rootIdentity, dev: historicalDevice },
      aggregateAttestation: { ...projected, root: { ...projected.root, dev: historicalDevice } },
    };
    journal.freshRootIdentity = { ...journal.freshRootIdentity, dev: historicalDevice };
    journal.freshRetainedRootIdentity = { ...journal.freshRetainedRootIdentity, dev: historicalDevice };
    await writeFile(archived.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    const status = await readMasDevelopmentGateStatus({
      context,
      dependencies: isolatedDependencies,
    });
    expect(status).toMatchObject({
      status: "archived",
      assurance: {
        classification: "terminal-archive-limited-non-device-equivalence",
        deviceIdentity: "numeric-device-projected",
        recordedNonDeviceProperties: "matched",
        historicalVolumeContinuity: "unproven",
        retainedFreshRootContent: "not-recorded",
      },
      package: { status: "not-applicable" },
      archived: [{ runId: archived.runId, assurance: { classification: "terminal-archive-limited-non-device-equivalence" } }],
    });
  });

  it("returns only an exact absent observation and rejects malformed process/listener evidence", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const empty = {
      processRows: async () => [{ pid: 1, ppid: 0, executablePath: "/sbin/launchd", arguments: ["/sbin/launchd"] }],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    await expect(inspectMasLiveState(context, empty)).resolves.toEqual(masLiveAbsentObservation(context));

    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => undefined,
    })).rejects.toThrow(/complete process list/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/tool", arguments: null }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "", arguments: [] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: Number.MAX_SAFE_INTEGER + 1, ppid: 1, executablePath: "/usr/bin/tool", arguments: ["/usr/bin/tool"] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/tool", arguments: ["/usr/bin/tool", null] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/Paseo Supervisor", arguments: ["/usr/bin/Paseo Supervisor", ""] }],
    })).resolves.toMatchObject({ status: "absent", processes: [] });
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 43, ppid: 1, executablePath: "/usr/bin/MeetlessHostTests", arguments: ["/usr/bin/MeetlessHostTests", ""] }],
    })).resolves.toMatchObject({ status: "absent", processes: [] });
    await expect(inspectMasLiveState(context, {
      ...empty,
      listeners: async () => undefined,
    })).rejects.toThrow(/listener inspection returned malformed/);
  });

  it("does not use command substrings, but detects exact owned descendants, listeners, sockets, and handles", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const base = {
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    const substringOnly = {
      pid: 42,
      ppid: 1,
      executablePath: "/usr/bin/tool",
      arguments: ["/usr/bin/tool", `prefix${context.runtimeRoot}suffix`],
    };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [substringOnly] })).resolves.toMatchObject({ status: "absent" });

    const descendant = { ...substringOnly, arguments: ["/usr/bin/tool", `${context.runtimeRoot}/nested-state`] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [descendant] })).resolves.toMatchObject({
      status: "live",
      processes: [descendant],
    });

    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [host] })).resolves.toMatchObject({ status: "live" });
    for (const row of [
      { ...host, pid: 50, arguments: [context.executablePath, ""] },
      { ...host, pid: 51, arguments: [context.executablePath, "extra"] },
    ]) {
      await expect(inspectMasLiveState(context, { ...base, processRows: async () => [row] })).resolves.toMatchObject({
        status: "live",
        processes: [row],
      });
    }
    for (const row of [
      { pid: 44, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "desktop"] },
      { pid: 45, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "daemon"] },
      { pid: 46, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.daemonWorkerPath, "daemon"] },
      { pid: 47, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.pluginPath] },
      { pid: 48, ppid: 43, executablePath: context.packagePaths.captureHelperPath, arguments: [context.packagePaths.captureHelperPath] },
    ]) {
      await expect(inspectMasLiveState(context, { ...base, processRows: async () => [row] })).resolves.toMatchObject({ status: "live", processes: [row] });
    }
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [{ pid: 49, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, "/private/unknown-role.js"] }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      listeners: async () => [{ port: 16777 }],
    })).resolves.toMatchObject({ status: "live", listeners: [{ port: 16777 }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      sockets: async () => [{ path: context.runtimePaths.recordingSocket, type: "socket" }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      openHandles: async () => [{ path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ path: context.runtimeRoot }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [host],
      openHandles: async () => [{ pid: host.pid, path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ pid: host.pid, path: context.runtimeRoot }] });
  });

  it("classifies exact empty and status-1 live lsof results with bounded records", () => {
    const empty = (overrides: Record<string, unknown> = {}) => ({
      error: undefined,
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
      ...overrides,
    });
    const validOpen = "p31\ncnode\nf3\nn/private/tmp/fixture/held-file\n";
    const validListener = "p31\ncnode\nf3\ntIPv4\n";

    expect(classifyMasLsofResult(empty(), MAS_LSOF_PURPOSES.OPEN_HANDLES)).toEqual({ status: "absent", records: [] });
    expect(classifyMasLsofResult({ ...empty(), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, MAS_LSOF_PURPOSES.LISTENER)).toEqual({ status: "absent", records: [] });
    expect(classifyMasLsofResult({ ...empty(), stdout: validOpen }, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toEqual({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], paths: ["/private/tmp/fixture/held-file"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), stdout: Buffer.from(validListener) }, MAS_LSOF_PURPOSES.LISTENER)).toEqual({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], types: ["IPv4"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), status: 0, stdout: validOpen, stderr: Buffer.alloc(0) }, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toMatchObject({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], paths: ["/private/tmp/fixture/held-file"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), status: 0, stdout: Buffer.from(validListener), stderr: "" }, MAS_LSOF_PURPOSES.LISTENER)).toMatchObject({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], types: ["IPv4"] }],
    });

    const rejected = [
      ["status-1 whitespace stdout", empty({ stdout: " \t\n" })],
      ["status-1 non-empty stderr", empty({ stderr: "diagnostic\n" })],
      ["status-1 missing stderr", empty({ stderr: undefined })],
      ["status-1 valid stdout plus stderr", empty({ stdout: validOpen, stderr: "diagnostic\n" })],
      ["status-1 missing stdout", empty({ stdout: undefined })],
      ["status-1 null stderr", empty({ stderr: null })],
      ["status-1 non-string stream", empty({ stdout: 0 })],
      ["status-1 signal", empty({ signal: "SIGTERM" })],
      ["status-1 missing signal", empty({ signal: undefined })],
      ["status-1 error", empty({ error: Object.assign(new Error("secret lsof error"), { code: "EACCES" }) })],
      ["status-1 valid stdout plus signal", empty({ stdout: validOpen, signal: "SIGTERM" })],
      ["status-1 valid stdout plus error", empty({ stdout: validOpen, error: Object.assign(new Error("secret lsof error"), { code: "EACCES" }) })],
      ["status-1 malformed records", empty({ stdout: "p31\ncnode\nxunexpected\n" })],
      ["status-1 invalid UTF-8", empty({ stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) })],
      ["status-1 maxBuffer overflow", empty({ stdout: Buffer.alloc(MAS_LSOF_MAX_BUFFER_BYTES + 1, 0x78) })],
      ["null result", null],
      ["undefined result", undefined],
      ["null status", empty({ status: null })],
      ["undefined status", empty({ status: undefined })],
      ["negative status", empty({ status: -1 })],
      ["status greater than one", empty({ status: 2 })],
      ["string status", empty({ status: "1" })],
      ["status-0 empty", empty({ status: 0 })],
      ["status-0 whitespace", empty({ status: 0, stdout: " \n" })],
      ["status-0 missing stderr", empty({ status: 0, stderr: undefined })],
      ["status-0 null stdout", empty({ status: 0, stdout: null })],
      ["status-0 diagnostic stderr", empty({ status: 0, stdout: validOpen, stderr: "warning\n" })],
      ["status-0 missing final newline", empty({ status: 0, stdout: validOpen.slice(0, -1) })],
      ["status-0 unknown field", empty({ status: 0, stdout: "p31\ncnode\nxunexpected\n" })],
      ["status-0 missing required field", empty({ status: 0, stdout: "p31\ncnode\n" })],
      ["status-0 invalid UTF-8", empty({ status: 0, stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) })],
      ["status-0 maxBuffer overflow", empty({ status: 0, stdout: Buffer.alloc(MAS_LSOF_MAX_BUFFER_BYTES + 1, 0x78) })],
      ["spawnSync maxBuffer error", { error: Object.assign(new Error("secret maxBuffer output"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), status: null, signal: null, stdout: undefined, stderr: undefined }],
    ] as const;

    for (const [_label, result] of rejected) {
      expect(() => classifyMasLsofResult(result, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toThrow(/MAS runtime-root open-handle lsof result rejected/);
    }

    const diagnosticResult = empty({
      status: 2,
      stdout: `stream-secret-sentinel-${"s".repeat(1024 * 1024)}`,
      stderr: `stream-secret-sentinel-${"e".repeat(1024 * 1024)}`,
      error: Object.assign(new Error("error-message-secret"), { code: "EACCES", syscall: "spawn lsof" }),
    });
    let diagnostic: Error | undefined;
    try {
      classifyMasLsofResult(diagnosticResult, MAS_LSOF_PURPOSES.OPEN_HANDLES);
    } catch (error) {
      diagnostic = error as Error;
    }
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).not.toContain("stream-secret-sentinel");
    expect(diagnostic!.message).not.toContain("error-message-secret");
    expect(diagnostic!.message).toContain('purpose=open-handles');
    expect(diagnostic!.message).toContain('error=name="Error",code="EACCES"');
    expect(diagnostic!.message).toMatch(/stdout=\{state=present,type=string,byteLength=\d+\}/u);
    expect(diagnostic!.message).toMatch(/stderr=\{state=present,type=string,byteLength=\d+\}/u);
    expect(diagnostic!.message.length).toBeLessThan(2_048);
  });

  it("uses bounded low-level lsof adapters and rejects +D root type drift before invocation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-adapter-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    const calls: Array<{ command: string; arguments_: string[]; options: Record<string, unknown> }> = [];
    const empty = { error: undefined, status: 1, signal: null, stdout: "", stderr: "" };
    const invokeLsof = (command: string, arguments_: string[], options: Record<string, unknown>) => {
      calls.push({ command, arguments_, options });
      return empty;
    };

    await expect(inspectListeners([16777], context, { invokeLsof })).resolves.toEqual([]);
    await expect(inspectOpenHandles([], context, { invokeLsof })).resolves.toEqual([]);
    await expect(inspectMasLiveState(context, {
      processRows: async () => [],
      sockets: async () => [],
      invokeLsof,
    })).resolves.toMatchObject({ status: "absent" });
    expect(calls[0]).toMatchObject({
      command: "/usr/sbin/lsof",
      arguments_: ["-nP", "-iTCP:16777", "-sTCP:LISTEN", "-Fpct"],
    });
    expect(calls[0].options).toMatchObject({ encoding: "utf8", maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES });
    expect(Number.isFinite(calls[0].options.maxBuffer)).toBe(true);
    const openCall = calls.find((call) => call.arguments_.includes("+D"));
    expect(openCall).toMatchObject({
      command: "/usr/sbin/lsof",
      arguments_: ["-nP", "+D", context.runtimeRoot, "-Fpcn"],
    });

    const guardedCalls = calls.length;
    await rm(context.runtimeRoot, { recursive: true, force: true });
    await symlink(base, context.runtimeRoot);
    await expect(inspectOpenHandles([], context, { invokeLsof })).rejects.toThrow(/non-symlink directory before invocation/);
    expect(calls).toHaveLength(guardedCalls);

    await rm(context.runtimeRoot, { recursive: true, force: true });
    await writeFile(context.runtimeRoot, "not a directory\n");
    await expect(inspectOpenHandles([], context, { invokeLsof })).rejects.toThrow(/non-symlink directory before invocation/);
    expect(calls).toHaveLength(guardedCalls);
  });

  it("proves exact /usr/sbin/lsof fixture no-match and held-file semantics", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-fixture-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await expect(inspectListeners([1], context)).resolves.toEqual([]);
    await expect(inspectOpenHandles([], context)).resolves.toEqual([]);

    const missingPath = path.join(context.runtimeRoot, "missing-path");
    const missing = spawnSync("/usr/sbin/lsof", ["-nP", "+D", missingPath, "-Fpcn"], {
      encoding: "utf8",
      maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    expect(missing.status).toBe(1);
    expect(Buffer.byteLength(String(missing.stderr), "utf8")).toBeGreaterThan(0);
    expect(() => classifyMasLsofResult(missing, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toThrow(/status 1 is not an exact empty no-match result/);

    const heldPath = path.join(context.runtimeRoot, "held-file");
    await writeFile(heldPath, "held\n");
    const held = await open(heldPath, "r");
    try {
      const heldResult = spawnSync("/usr/sbin/lsof", ["-nP", "+D", context.runtimeRoot, "-Fpcn"], {
        encoding: "utf8",
        maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      });
      expect(heldResult.status).toBe(1);
      expect(Buffer.byteLength(String(heldResult.stdout), "utf8")).toBeGreaterThan(0);
      await expect(inspectOpenHandles([], context)).resolves.toMatchObject([
        { path: context.runtimeRoot, records: expect.any(Array) },
      ]);
      const classified = classifyMasLsofResult(heldResult, MAS_LSOF_PURPOSES.OPEN_HANDLES);
      expect(classified).toMatchObject({ status: "live", records: expect.any(Array) });
      expect(classified.records.length).toBeGreaterThan(0);
    } finally {
      await held.close();
    }
  });

  it("does not begin package rollback when status-1 lsof is live or rejected", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-recovery-boundary-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    const empty = { error: undefined, status: 1, signal: null, stdout: "", stderr: "" };
    const validOpen = "p31\ncnode\nf3\nn/private/tmp/fixture/held-file\n";
    let openHandleResult: Record<string, unknown> = { ...empty, stdout: validOpen };
    const invokeLsof = (_command: string, arguments_: string[]) => arguments_.includes("+D") ? openHandleResult : empty;
    const dependencies = {
      processRows: async () => [],
      sockets: async () => [],
      invokeLsof,
    };
    let mutationCount = 0;
    const attemptRestore = () => restoreInRequiredOrder({
      stop: () => stopMasDevelopmentGate({ context, dependencies }),
      rollbackPackage: async () => {
        mutationCount += 1;
        return { status: "ready-for-runtime-restore" };
      },
      reacquireGateLock: async () => {
        mutationCount += 1;
        return { release: async () => undefined };
      },
      runtimeRestore: async () => {
        mutationCount += 1;
        return { phase: "restored" };
      },
      archiveSession: async () => {
        mutationCount += 1;
        return { phase: "archived" };
      },
    });

    await expect(attemptRestore()).rejects.toThrow(/exact LaunchServices host process/);
    openHandleResult = { ...empty, stdout: validOpen, stderr: "diagnostic\n" };
    await expect(attemptRestore()).rejects.toThrow(/lsof result rejected/);
    expect(mutationCount).toBe(0);
  });

  it("uses one stable kernel lock and rejects contention until the holder releases", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lock-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });
    const first = await acquireMasGateLock({ parentPath: parent });
    expect(first.lockPath).toBe(masGateLockPath(parent));
    await expect(acquireMasGateLock({ parentPath: parent })).rejects.toThrow(/MAS gate lock failed/);
    await first.release();
    const second = await acquireMasGateLock({ parentPath: parent });
    await second.release();
    await expect(lstat(masGateLockPath(parent))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("requires a live kernel-holder assertion for every supplied lease", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lease-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });

    const released = await acquireMasGateLock({ parentPath: parent });
    await released.release();
    await expect(released.assertHeld()).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: released }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);

    const killed = await acquireMasGateLock({ parentPath: parent });
    process.kill(killed.holderPid, "SIGKILL");
    await expect(killed.assertHeld()).rejects.toThrow(/no longer held|kernel lock|holder exited/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: killed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|holder exited|not kernel-backed/);

    const genuine = await acquireMasGateLock({ parentPath: parent });
    expect(Object.isFrozen(genuine)).toBe(true);
    const spoofed = { ...genuine };
    await expect(withMasGateLock({ parentPath: parent, lockLease: spoofed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/not kernel-backed|live holder/);
    await genuine.release();
  });

  it("uses an actual committed package transaction for post-install launch and restore composition", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-launch-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n");
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] } }),
    });
    const packageParent = path.join(base, "Applications");
    const packageTarget = path.join(packageParent, "Meetless.app");
    const packageSource = path.join(base, "candidate.app");
    await mkdir(packageParent, { recursive: true, mode: 0o700 });
    await mkdir(path.join(packageTarget, "Contents"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageTarget, "Contents", "marker"), "prior package\n");
    await mkdir(path.join(packageSource, "Contents"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageSource, "Contents", "marker"), "candidate package\n");
    const manifestPath = path.join(base, "app-store-development-manifest.json");
    const manifestBytes = Buffer.from("retained package manifest\n");
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const packageFingerprint = await fingerprintPath(packageSource);
    if (!packageFingerprint) throw new Error("package fixture source fingerprint is missing");
    const artifactBinding = freezeMasGateArtifactBinding({
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      bundlePath: packageSource,
      bundleFingerprint: packageFingerprint,
      artifactDigest: "a".repeat(64),
      candidateSnapshotDigest: "b".repeat(64),
      packageInputDigest: "c".repeat(64),
      artifactInputDigest: "d".repeat(64),
      licenseDigest: "e".repeat(64),
      signatureDigest: "f".repeat(64),
      publicSdkKeySha256: createHash("sha256").update("fixture-public-key").digest("hex"),
    });
    const packageTransaction = await replacePackageBundle({
      source: packageSource,
      target: packageTarget,
      identityPath: context.identityPath,
      ownerToken: session.ownerToken,
      runId: session.runId,
      artifactBinding,
      inspect: async () => ({
        version: 1,
        bundleIdentifier: context.contract.bundleIdentifier,
        bundlePath: context.bundlePath,
        bundleRealPath: context.bundlePath,
        executablePath: context.executablePath,
        designatedRequirement: "identifier \\\"com.meetless.app\\\"",
        cdHash: "a".repeat(40),
        binarySha256: "b".repeat(64),
        binaryDevice: 1,
        binaryInode: 3,
        binarySize: 10,
        configuration: {
          repositoryRoot: path.join(base, "repository"),
          runtimeRoot: context.runtimeRoot,
          listen: "127.0.0.1:16777",
          rendererOrigin: "http://127.0.0.1:18082",
          transcriptionSocket: path.join(context.runtimeRoot, "transcription.sock"),
          transcriptionStaging: path.join(context.runtimeRoot, "transcription-staging"),
          nodePath: path.join(base, "node"),
          runtimeCliPath: path.join(base, "runtime.js"),
          identityPath: context.identityPath,
        },
      }),
    });
    const installed = {
      version: 1,
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
      configuration: {
        repositoryRoot: path.join(base, "repository"),
        runtimeRoot: context.runtimeRoot,
        listen: "127.0.0.1:16777",
        rendererOrigin: "http://127.0.0.1:18082",
        transcriptionSocket: path.join(context.runtimeRoot, "transcription.sock"),
        transcriptionStaging: path.join(context.runtimeRoot, "transcription-staging"),
        nodePath: path.join(base, "node"),
        runtimeCliPath: path.join(base, "runtime.js"),
        identityPath: context.identityPath,
      },
    };
    const available = createMasHostHandoff(context, session, installed);
    await writeFile(path.join(session.activePath, "host-handoff.json"), `${JSON.stringify(available)}\n`, { mode: 0o600 });
    const packageJournalPath = packageTransactionPaths(context.bundlePath, session.runId).journal;
    const packageFilesystem = {
      resolvePath: (candidate: string) => {
        const logicalParent = path.dirname(context.bundlePath);
        const prefix = `${logicalParent}${path.sep}`;
        if (candidate === logicalParent) return packageParent;
        if (candidate.startsWith(prefix)) return path.join(packageParent, candidate.slice(prefix.length));
        return candidate;
      },
    };
    const launchDependencies = {
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      packageFilesystem,
    };
    const narrativeDigestOutsideRuntimeContract = "0".repeat(64);
    await expect(attestMasGateRuntimeRoot(session.quarantinePath)).resolves.toEqual(session.priorAggregateAttestation);
    expect(session.priorAggregateAttestation.digest).not.toBe(narrativeDigestOutsideRuntimeContract);
    const composedStatus = await readMasDevelopmentGateStatus({
      context,
      dependencies: launchDependencies,
    });
    expect(composedStatus).toMatchObject({
      status: "active",
      phase: "ready",
      package: { status: "committed", state: "committed", journalPath: packageJournalPath },
    });
    let launchCalled = false;
    const result = await launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => {
          launchCalled = true;
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
        },
        waitForHandoff: async () => {
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
          return { ...available, state: "claimed", claimedByPid: process.pid, claimedAt: new Date().toISOString() };
        },
      },
    });
    expect(launchCalled).toBe(true);
    expect(result.status).toBe("launch-claimed");
    expect(result.handoff.state).toBe("claimed");
    expect(result).not.toHaveProperty("readiness");

    const originalIdentity = await lstat(context.identityPath);
    const republishedIdentityPath = `${context.identityPath}.native-republication`;
    await writeFile(republishedIdentityPath, await readFile(context.identityPath), { mode: 0o600 });
    await rename(republishedIdentityPath, context.identityPath);
    const republishedIdentity = await lstat(context.identityPath);
    expect(republishedIdentity.ino).not.toBe(originalIdentity.ino);

    const restored = await restoreMasDevelopmentGate({
      context,
      dependencies: launchDependencies,
    });
    expect(restored.status).toBe("restored");
    await expect(readFile(path.join(packageTarget, "Contents", "marker"), "utf8")).resolves.toBe("prior package\n");
    await expect(lstat(context.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(context.runtimeRoot, "prior-runtime-state"), "utf8")).resolves.toBe("prior runtime\n");
    await expect(lstat(session.freshRetainedPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(lstat(packageTransaction.paths.journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not synthesize post-install active/ready or consult package state before quarantine attestation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-quarantine-status-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n", { mode: 0o600 });
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, {
        requiredFreeBytes: 1,
        dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] },
      }),
    });
    await writeFile(context.identityPath, "published package identity\n", { mode: 0o600 });
    await writeFile(path.join(session.quarantinePath, "prior-runtime-state"), "changed bytes\n", { mode: 0o600 });
    let packagePathResolutions = 0;

    await expect(readMasDevelopmentGateStatus({
      context,
      dependencies: {
        packageFilesystem: {
          resolvePath: (candidate: string) => {
            packagePathResolutions += 1;
            return candidate;
          },
        },
      },
    })).rejects.toThrow(/quarantine prior root attestation changed/);
    expect(packagePathResolutions).toBe(0);
    await expect(readFile(context.identityPath, "utf8")).resolves.toBe("published package identity\n");
    await expect(readFile(path.join(session.quarantinePath, "prior-runtime-state"), "utf8")).resolves.toBe("changed bytes\n");
    await expect(lstat(session.freshRetainedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(context.parentPath, `.meetless-mas-gate-session.${session.runId}.archived`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot authorize launch through a caller-supplied package proof", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-proof-authority-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, {
        requiredFreeBytes: 1,
        dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] },
      }),
    });
    const packageParent = path.join(base, "Applications");
    await mkdir(packageParent, { recursive: true, mode: 0o700 });
    const packageFilesystem = {
      resolvePath: (candidate: string) => {
        const logicalParent = path.dirname(context.bundlePath);
        const prefix = `${logicalParent}${path.sep}`;
        if (candidate === logicalParent) return packageParent;
        if (candidate.startsWith(prefix)) return path.join(packageParent, candidate.slice(prefix.length));
        return candidate;
      },
    };
    let forgedReaderCalled = false;
    let launchCalled = false;
    await expect(launchMasDevelopmentGate({
      context,
      dependencies: {
        processRows: async () => [],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        packageFilesystem,
        readPackageTransactionProof: async () => {
          forgedReaderCalled = true;
          return { status: "committed" };
        },
        launch: async () => { launchCalled = true; },
      },
    })).rejects.toThrow(/committed package transaction/);
    expect(forgedReaderCalled).toBe(false);
    expect(launchCalled).toBe(false);
    await expect(readFile(path.join(session.activePath, "transaction.json"))).resolves.toBeDefined();
  });

  it("stops only the exact owned host through the coordinator and never through an ambient authority string", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-stop-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    let live = true;
    const dependencies = {
      processRows: async () => live ? [host] : [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      stopProcess: async (pid: number) => {
        expect(pid).toBe(host.pid);
        live = false;
      },
      waitForProcessExit: async () => undefined,
    };
    await expect(stopMasDevelopmentGate({ context, dependencies })).resolves.toMatchObject({ status: "stopped" });

    let signalled = false;
    const nonExactHost = { ...host, arguments: [context.executablePath, ""] };
    await expect(stopMasDevelopmentGate({
      context,
      dependencies: {
        processRows: async () => [nonExactHost],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        stopProcess: async () => { signalled = true; },
      },
    })).rejects.toThrow(/exact LaunchServices host process/);
    expect(signalled).toBe(false);

    const masRoot = context.runtimeRoot;
    const forged = await execFile(process.execPath, ["scripts/stop-macos-host.mjs"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: base,
        MEETLESS_RUNTIME_ROOT: masRoot,
        MEETLESS_LISTEN: context.contract.listen,
        MEETLESS_MAS_COORDINATOR_AUTHORITY: "MAS_GATE_COORDINATOR v1",
      },
    }).catch((error) => error);
    expect(forged.code).not.toBe(0);
    expect(`${forged.stderr ?? ""}${forged.stdout ?? ""}`).toMatch(/refuses the MAS app-container runtime root/);
  });

  it("always runs production validation and ignores forged validator results before any mutation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-install-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const proofRoot = path.join(base, "proof");
    const releaseRoot = path.join(proofRoot, "release", "macos");
    const bundle = path.join(releaseRoot, "Meetless.app");
    const manifestPath = path.join(releaseRoot, "app-store-development-manifest.json");
    await mkdir(bundle, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      bundlePath: "release/macos/Meetless.app",
      directComposition: { path: "release/macos/composition-manifest.direct.json" },
    })}\n`, { mode: 0o600 });
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await mkdir(context.runtimeRoot, { recursive: true });
    await writeFile(prior, "prior\n");
    const forgedBinding = {
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      bundlePath: bundle,
      manifestSha256: "f".repeat(64),
      bundleFingerprint: "f".repeat(64),
      artifactDigest: "f".repeat(64),
      candidateSnapshotDigest: "f".repeat(64),
      packageInputDigest: "f".repeat(64),
      artifactInputDigest: "f".repeat(64),
      licenseDigest: "f".repeat(64),
      signatureDigest: "f".repeat(64),
      publicSdkKeySha256: "f".repeat(64),
    };
    let forgedValidatorCalled = false;
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        validateArtifact: async () => {
          forgedValidatorCalled = true;
          return { status: "passed", artifactBinding: forgedBinding };
        },
      },
    })).rejects.toThrow(/full MAS artifact validation|schema, authority, bundle/);
    expect(forgedValidatorCalled).toBe(false);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(context.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        artifactValidationAdapters: { fingerprintPath: async () => "f".repeat(64) },
      },
    })).rejects.toThrow(/not an allowed low-level function/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installMasDevelopmentGate({
      manifestPath: path.join(releaseRoot, "missing.json"),
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        artifactBinding: forgedBinding,
        validateArtifact: async () => ({ status: "passed", artifactBinding: forgedBinding }),
      },
    })).rejects.toThrow(/MAS development manifest/);
  });

  it("rejects a wrong public key or missing license evidence before runtime quarantine", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-validation-negative-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await writeFile(prior, "prior\n");
    const bundle = path.resolve("release/macos/Meetless.app");
    const manifestPath = path.resolve("release/macos/app-store-development-manifest.json");
    const fixture = await makeMasValidationFixture({ bundle, manifestPath });
    const baseDependencies = {
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      artifactValidationAdapters: fixture.adapters,
    };
    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies: { ...baseDependencies, expectedRevenueCatPublicSdkKey: "appl_wrong_fixture_public_key" },
    })).rejects.toThrow(/different RevenueCat public SDK key/);

    const originalReadSecureFile = fixture.adapters.readSecureFile;
    const missingLicenseAdapters = {
      ...fixture.adapters,
      readSecureFile: async (target: string, label: string) => target.endsWith("/license-inventory.json")
        ? Buffer.from("{}")
        : originalReadSecureFile(target, label),
    };
    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies: {
        ...baseDependencies,
        expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
        artifactValidationAdapters: missingLicenseAdapters,
      },
    })).rejects.toThrow(/license inventory|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });

    const originalEntries = await fixture.adapters.enumeratePackageEntries();
    const symlinkEvidenceAdapters = {
      ...fixture.adapters,
      enumeratePackageEntries: async () => originalEntries.map((entry, index) => index === 0
        ? { ...entry, type: "symlink", target: "../outside" }
        : entry),
    };
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        ...baseDependencies,
        artifactValidationAdapters: symlinkEvidenceAdapters,
      },
    })).rejects.toThrow(/packaged symlink|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });

    const originalInspectMachO = fixture.adapters.inspectMachO;
    const loadPathEvidenceAdapters = {
      ...fixture.adapters,
      inspectMachO: async (target: string) => {
        const inspected = await originalInspectMachO(target);
        return inspected ? { ...inspected, dependencies: ["/tmp/forbidden-mas-fixture.dylib"] } : inspected;
      },
    };
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        ...baseDependencies,
        artifactValidationAdapters: loadPathEvidenceAdapters,
      },
    })).rejects.toThrow(/external dependency|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs complete policy with low-level fixture adapters and passes the unchanged binding to composition", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-binding-composition-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await writeFile(path.join(context.runtimeRoot, "opaque-state"), "preserve me\n");

    const bundle = path.resolve("release/macos/Meetless.app");
    const manifestPath = path.resolve("release/macos/app-store-development-manifest.json");
    const fixture = await makeMasValidationFixture({ bundle, manifestPath });
    const dependencies = {
      expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      artifactValidationAdapters: fixture.adapters,
    };
    const validation = await validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies,
    });
    const runtimeLease = await acquireMasGateLock({ parentPath: context.parentPath });
    let session;
    try {
      session = await beginMasGateSessionTransaction({
        ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies }),
        lockLease: runtimeLease,
      });
    } finally {
      await runtimeLease.release();
    }
    let packageInput: Record<string, unknown> | null = null;
    const packageTransaction = await (async (input: Record<string, unknown>) => {
      packageInput = input;
      return { schema: "MAS_PACKAGE_TRANSACTION v4", version: 4, artifactBinding: input.artifactBinding };
    })({
      source: bundle,
      target: context.bundlePath,
      artifactBinding: validation.artifactBinding,
    });
    const result = { status: "installed", session, packageTransaction };

    expect(result.status).toBe("installed");
    expect(result.session.schema).toBe("MAS_GATE_SESSION_TRANSACTION v2");
    expect(packageInput?.artifactBinding).toBe(result.packageTransaction.artifactBinding);
    expect(Object.isFrozen(packageInput?.artifactBinding)).toBe(true);
    expect(JSON.stringify(packageInput)).not.toContain(fixture.publicSdkKey);
    await expect(readFile(path.join(context.runtimeRoot, "opaque-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(result.session.quarantinePath, "opaque-state"), "utf8")).resolves.toBe("preserve me\n");
  });

  it("binds a one-time host handoff to the owner, run, fresh-root identity, exact bundle, and exact executable", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const session = {
      phase: "ready",
      stateScope: "runtime-root-only",
      ownerToken: "owner-token-abcdefghijklmnopqrstuvwxyz-0123456789",
      runId: "run-1",
      canonicalRuntimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: context.activePath,
      identityRelativePath: context.identityRelativePath,
      identityPath: context.identityPath,
      freshRootIdentity: {
        type: "directory",
        mode: 448,
        uid: 501,
        gid: 20,
        dev: 1,
        ino: 2,
        nlink: 2,
        size: 0,
      },
    };
    const installed = {
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
    };
    const handoff = createMasHostHandoff(context, session, installed);
    const packageProof = {
      status: "committed",
      ownerToken: session.ownerToken,
      runId: session.runId,
      target: context.bundlePath,
      identityPath: context.identityPath,
      candidateFingerprint: "c".repeat(64),
      artifactBinding: { bundleFingerprint: "c".repeat(64) },
      transaction: { state: "committed" },
      publishedHostIdentity: { version: 1, ...installed },
    };
    expect(validateMasHostHandoff(handoff, { context, session, packageProof })).toBe(handoff);
    const swiftSorted = Object.fromEntries(Object.entries({
      ...handoff,
      freshRootIdentity: Object.fromEntries(Object.entries(handoff.freshRootIdentity).reverse()),
    }).reverse());
    expect(validateMasHostHandoff(swiftSorted, { context, session, packageProof })).toBe(swiftSorted);
    for (const change of [
      { ownerToken: "other-owner" },
      { runId: "other-run" },
      { canonicalRuntimeRoot: `${context.runtimeRoot}-other` },
      { identityPath: `${context.identityPath}-other` },
      { bundlePath: `${context.bundlePath}-other` },
      { bundleIdentifier: "other.bundle" },
    ]) {
      expect(() => validateMasHostHandoff({ ...handoff, ...change }, { context, session, packageProof })).toThrow(/not bound/);
    }
    expect(() => validateMasHostHandoff({ ...handoff, extra: true }, { context, session, packageProof })).toThrow(/not bound/);
    const { binarySize: _missing, ...missingKey } = handoff;
    expect(() => validateMasHostHandoff(missingKey, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff({ ...handoff, binarySize: "10" }, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff({
      ...handoff,
      freshRootIdentity: { ...handoff.freshRootIdentity, extra: 1 },
    }, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff(handoff, {
      context,
      session,
      packageProof: { ...packageProof, candidateFingerprint: "d".repeat(64) },
    })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff(handoff, {
      context,
      session,
      packageProof: { ...packageProof, publishedHostIdentity: { ...packageProof.publishedHostIdentity, cdHash: "d".repeat(40) } },
    })).toThrow(/not bound/);
    const replay = { ...handoff, state: "claimed", claimedByPid: 99, claimedAt: new Date().toISOString() };
    expect(() => validateMasHostHandoff(replay, { context, session, packageProof })).toThrow(/not bound/);
    expect(validateMasHostHandoff(replay, { context, session, state: "claimed", packageProof })).toBe(replay);
  });

  it("keeps restore ordering package-first and releases the reacquired lock last", async () => {
    const events: string[] = [];
    const lease = { release: async () => { events.push("release"); } };
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "ready-for-runtime-restore" }; },
      reacquireGateLock: async () => { events.push("lock"); return lease; },
      runtimeRestore: async () => { events.push("runtime-restore"); return { phase: "restored" }; },
      archiveSession: async () => { events.push("archive"); return { phase: "archived" }; },
    });
    expect(result.status).toBe("restored");
    expect(events).toEqual(["stop", "package-rollback", "lock", "runtime-restore", "archive", "release"]);
  });

  it("does not reacquire or mutate anything when stop proves no active session", async () => {
    const events: string[] = [];
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "nothing-to-restore", observation: masLiveAbsentObservation(masDevelopmentRuntimeContext({ userHome: "/Users/example" })) }; },
      reacquireGateLock: async () => { events.push("lock"); throw new Error("must not acquire"); },
      runtimeRestore: async () => { events.push("runtime"); return {}; },
      archiveSession: async () => { events.push("archive"); return {}; },
    });
    expect(result.status).toBe("nothing-to-restore");
    expect(events).toEqual(["stop", "package-rollback"]);
  });

});
