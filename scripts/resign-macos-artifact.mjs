import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enumeratePackageEntries,
  inspectPackageMachOEntries,
} from "./lib/macos-package-inventory.mjs";
import {
  MACOS_LICENSE_INVENTORY_PATH,
} from "./lib/macos-license-inventory.mjs";
import {
  collectMacOSSignatureEvidence,
  createSigningMetadata,
  loadEntitlementPolicy,
  resolveSigningInputs,
  validateApprovedEntitlementMachOEntries,
  RELEASE_SIGNING_MODE,
} from "./lib/macos-package-signing.mjs";
import {
  MACOS_SIGNING_OUTER_PATH,
  MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1,
  MACOS_REQUIRED_DEVELOPER_ID_TEAM,
} from "./lib/macos-package-signing.mjs";
import {
  acquireArtifactStageCapability,
  assertExternalArtifactStageRoot,
  assertFinalOuterClosure,
  assertArtifactResignLifecycleOrder,
  assertBaselineArtifactClosure,
  assertBaselineIdentity,
  assertMachOPayloadClosure,
  assertRegularFileIdentity,
  assertReboundDigestEquality,
  assertSigningBoundClosure,
  assertSigningOrder,
  assertStagePolicyBinding,
  assertStageWritableSurface,
  bindMachOPayloads,
  buildArtifactBaseline,
  buildArtifactResignManifest,
  buildPreOuterSigningBoundDescriptor,
  buildOwnerTerminalEvidence,
  captureOwnerParentBinding,
  captureRegularFileIdentity,
  createOwnerStage,
  createOwnerStatusDocument,
  createStagePolicyEvidence,
  createSigningBoundDescriptor,
  isCodeResourcesPath,
  parseArtifactResignArguments,
  rebindLicenseInventory,
  rebindPackageInputManifest,
  signNestedMachOClosure,
  signOuterApp,
  transitionOwnerStatus,
  assertOwnerNativeTerminal,
  validateOwnerSourceClosure,
  validateOwnerStatusDocument,
  validateOwnerTerminalEvidence,
  validateArtifactResignMetadata,
  validateArtifactStageRoot,
  validateExactEntitlementPolicy,
  createOwnerSignalController,
  writeArtifactMetadataAtomically,
  writeOwnerFailureStatusAtomically,
} from "./lib/macos-artifact-resign.mjs";
import {
  validateLicenseInventoryCoverage,
  validateLicenseInventoryDocument,
  validateMacOSPackage,
  commitRetainedMacOSPackageSuccess,
  validateManifestDocument,
} from "./validate-macos-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    (error) => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      process.exitCode = 1;
    },
  );
}

export async function run(arguments_, hooks = {}) {
  assertDarwinArm64();
  const options = parseArtifactResignArguments(arguments_);
  const observer = resolveLifecycleObserver(hooks);
  if (options.prepare) return runPrepareMode(options, observer);
  return runPreparedStage(options, observer, { ownerMode: true });
}

async function runPreparedStage(options, observer = null, { ownerMode = false, preparedStage = null } = {}) {
  if (!ownerMode) {
    throw new Error("artifact re-sign consumption requires the explicit owner stage mode. Authority: docs/specs/macos-artifact-validation.md. Next action: run the generated native-Terminal command with --stage-root.");
  }
  const validatePackage = validateMacOSPackage;
  const lifecycleEvents = [];
  const stage = preparedStage ?? await validateArtifactStageRoot({
    stageRoot: options.stageRoot,
    repositoryRoot,
    ownerMode,
  });
  const expectedStageBinding = {
    stageRoot: stage.stageRoot,
    stageRealPath: stage.stageRealPath,
    markerIdentity: stage.markerIdentity,
    parentBinding: stage.parentBinding,
  };
  const manifestIdentity = await captureRegularFileIdentity(stage.manifestPath, "baseline staged composition manifest");
  const manifestBytes = manifestIdentity.bytes;
  const baselineManifest = validateManifestDocument(parseJson(manifestBytes, "staged composition manifest"));
  assertBaselineIdentity({
    manifest: baselineManifest,
    marker: stage.marker,
    manifestBytes,
    expected: stage.marker.baseline,
  });

  const baselineSnapshot = await inspectCommandPackage(stage.bundlePath, { ownerMode });
  const baselineEntries = baselineSnapshot.entries;
  const baselineMachOEntries = baselineSnapshot.machoEntries;
  const baselineMachOPayloads = baselineSnapshot.machoPayloads;
  assertMachOPayloadClosure({ baselinePayloads: stage.marker.baseline.machoPayloads, finalPayloads: baselineMachOPayloads });

  const inventoryPath = path.resolve(stage.bundlePath, baselineManifest.licenseInventory.path);
  const baselineInventoryIdentity = await captureRegularFileIdentity(inventoryPath, "baseline packaged license inventory");
  const baselineInventoryBytes = baselineInventoryIdentity.bytes;
  const baselineInventory = validateLicenseInventoryDocument(parseJson(baselineInventoryBytes, "baseline packaged license inventory"), {
    repositoryRoot,
    bundlePath: stage.bundlePath,
  });
  validateLicenseInventoryCoverage(
    baselineInventory,
    baselineEntries,
    baselineManifest.licenseInventory,
    baselineManifest.macho,
    { repositoryRoot, bundlePath: stage.bundlePath },
  );
  const baselineClosure = assertBaselineArtifactClosure({
    manifest: baselineManifest,
    actualEntries: baselineEntries,
    actualMachOEntries: baselineMachOEntries,
    actualMachOPayloads: baselineMachOPayloads,
    expectedMachOPayloads: stage.marker.baseline.machoPayloads,
    baselineInventory,
    expectedBaseline: stage.marker.baseline,
  });
  const baselineSigningBound = createSigningBoundDescriptor({
    phase: "final",
    machoPaths: baselineClosure.machoPaths,
    machoPayloads: baselineClosure.machoPayloads,
    codeResourcePaths: baselineClosure.codeResourcePaths,
  });
  await validatePackage(stage.manifestPath, {
    artifactOnly: true,
    repositoryRoot,
    signingMode: "local-ad-hoc",
    signingIdentity: "-",
    ownerMode,
  });

  const policy = await loadEntitlementPolicy({ repositoryRoot, ownerMode });
  validateExactEntitlementPolicy(policy, { machoPaths: baselineSigningBound.macho });
  assertStagePolicyBinding(stage.marker.policy, policy);
  validateApprovedEntitlementMachOEntries({
    entries: baselineEntries,
    machoEntries: baselineMachOEntries,
    policy,
  });

  let signingInputs;
  let capability = null;
  let ownerSignals = null;
  let consumedStatusIdentity = null;
  try {
    capability = await acquireArtifactStageCapability({ stageRoot: stage.stageRoot, markerBytes: stage.markerBytes });
    await transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath: stage.statusPath,
      markerBytes: stage.markerBytes,
      from: "prepared",
      state: "preflight",
      attempt: 0,
      parentBinding: stage.parentBinding,
    });
    assertOwnerNativeTerminal();
    await recheckStageBeforeFirstCodesign({
      stage,
      baselineManifest,
      baselineManifestBytes: manifestBytes,
      baselineEntries,
      baselineMachOPayloads,
      baselineInventory,
      baselineInventoryBytes,
      policy,
      ownerMode,
    });
    ownerSignals = createOwnerSignalController();
    await transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath: stage.statusPath,
      markerBytes: stage.markerBytes,
      from: "preflight",
      state: "consumed",
      attempt: 1,
      parentBinding: stage.parentBinding,
    });
    consumedStatusIdentity = await captureRegularFileIdentity(stage.statusPath, "consumed owner attempt status");
    validateOwnerStatusDocument(parseJson(consumedStatusIdentity.bytes, "consumed owner attempt status"), { stageRoot: stage.stageRoot, markerBytes: stage.markerBytes });
    ownerSignals.assertNotInterrupted();
    signingInputs = await resolveSigningInputs({
      mode: RELEASE_SIGNING_MODE,
      signingIdentity: options.signingIdentity,
      expectedTeamId: options.expectedTeamId,
      repositoryRoot,
      ownerMode: true,
    });
    validateExactEntitlementPolicy(signingInputs.entitlementPolicy, { machoPaths: baselineSigningBound.macho });
    assertStagePolicyBinding(stage.marker.policy, signingInputs.entitlementPolicy);

    const nestedSigning = await signNestedMachOClosure({
      bundlePath: stage.bundlePath,
      machoPaths: baselineSigningBound.macho,
      signingInputs,
      entitlementPolicy: signingInputs.entitlementPolicy,
      signalController: ownerSignals,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "nested-signing-complete", { count: nestedSigning.observed.length });
    ownerSignals?.assertNotInterrupted();
    const nestedSnapshot = await inspectCommandPackage(stage.bundlePath, { ownerMode });
    const nestedEntries = nestedSnapshot.entries;
    const nestedMachOPayloads = nestedSnapshot.machoPayloads;
    const nestedCodeResourcePaths = nestedEntries
      .filter((entry) => isCodeResourcesPath(entry.path) && entry.path !== "Contents/_CodeSignature/CodeResources")
      .map((entry) => entry.path);
    const preOuterSigningBound = buildPreOuterSigningBoundDescriptor({
      machoPaths: baselineSigningBound.macho,
      machoPayloads: nestedMachOPayloads,
      codeResourcePaths: nestedCodeResourcePaths,
      baselinePackageInputs: baselineManifest.packageInputs,
      preOuterEntries: nestedEntries,
      baselineInventory,
    });
    assertSigningBoundClosure({
      baselineEntries,
      finalEntries: nestedEntries,
      machoPaths: baselineSigningBound.macho,
      baselineMachOPayloads,
      finalMachOPayloads: nestedMachOPayloads,
    });
    const reboundPackageInputs = rebindPackageInputManifest({
      baseline: baselineManifest.packageInputs,
      preOuterEntries: nestedEntries,
      signingBound: preOuterSigningBound,
    });
    const reboundInventory = rebindLicenseInventory({
      baseline: baselineInventory,
      packageInputs: reboundPackageInputs,
      preOuterEntries: nestedEntries,
      signingBound: preOuterSigningBound,
    });
    assertReboundDigestEquality({ scopedEntries: nestedEntries, packageInputs: reboundPackageInputs, inventory: reboundInventory });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "inventory-rebound", {
      packageInputDigest: reboundPackageInputs.digest,
      artifactInputDigest: reboundPackageInputs.artifactInput.digest,
      inventoryArtifactDigest: reboundInventory.artifact.entryBinding.digest,
    });

    await writeArtifactMetadataAtomically({
      filePath: inventoryPath,
      value: reboundInventory,
      label: "rebound packaged license inventory",
      expectedTarget: baselineInventoryIdentity,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "inventory-written", { path: inventoryPath });
    const preOuterSnapshot = await inspectCommandPackage(stage.bundlePath, { ownerMode });
    const preOuterEntries = preOuterSnapshot.entries;
    const preOuterMachOPayloads = preOuterSnapshot.machoPayloads;
    assertSigningBoundClosure({
      baselineEntries,
      finalEntries: preOuterEntries,
      machoPaths: baselineSigningBound.macho,
      baselineMachOPayloads,
      finalMachOPayloads: preOuterMachOPayloads,
    });

    const outerSigning = await signOuterApp({
      bundlePath: stage.bundlePath,
      signingInputs,
      signalController: ownerSignals,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "outer-sign-complete", { count: outerSigning.observed.length });
    ownerSignals?.assertNotInterrupted();
    const finalSnapshot = await inspectCommandPackage(stage.bundlePath, { ownerMode });
    const finalEntries = finalSnapshot.entries;
    const finalMachOEntries = finalSnapshot.machoEntries;
    const finalMachOPayloads = finalSnapshot.machoPayloads;
    const finalSigningBound = createSigningBoundDescriptor({
      phase: "final",
      machoPaths: baselineSigningBound.macho,
      machoPayloads: finalMachOPayloads,
      codeResourcePaths: finalEntries.filter((entry) => isCodeResourcesPath(entry.path)).map((entry) => entry.path),
    });
    assertSigningOrder(
      [...nestedSigning.observed, ...outerSigning.observed],
      [...nestedSigning.order.nestedMachO, MACOS_SIGNING_OUTER_PATH],
    );
    assertSigningBoundClosure({
      baselineEntries,
      finalEntries,
      machoPaths: finalSigningBound.macho,
      baselineMachOPayloads,
      finalMachOPayloads,
    });
    assertFinalOuterClosure({
      preOuterEntries,
      finalEntries,
      preOuterSigningBound,
      finalSigningBound,
    });
    validateApprovedEntitlementMachOEntries({
      entries: finalEntries,
      machoEntries: finalMachOEntries,
      policy: signingInputs.entitlementPolicy,
    });

    const signatureEvidence = await collectMacOSSignatureEvidence({
      bundlePath: stage.bundlePath,
      machoPaths: finalSigningBound.macho,
      machoEntries: finalMachOEntries,
      verify: true,
      requireCertificateEvidence: true,
      ownerMode,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "signature-evidence-complete", {
      nested: signatureEvidence.nestedMachO.length,
      total: signatureEvidence.nestedMachO.length + 1,
    });
    const signing = createSigningMetadata({
      mode: RELEASE_SIGNING_MODE,
      identity: signingInputs.identity,
      requestedIdentity: signingInputs.requestedIdentity,
      resolvedIdentity: signingInputs.resolvedIdentity,
      expectedTeamId: options.expectedTeamId,
      resolvedTeamId: signingInputs.resolvedTeamId,
      certificateFingerprint: signingInputs.certificateFingerprint,
      certificateSha1: signingInputs.certificateSha1,
      entitlementPolicy: signingInputs.entitlementPolicy,
      order: signatureEvidence.order,
      outer: signatureEvidence.outer,
      nestedMachO: signatureEvidence.nestedMachO,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "metadata-observed", { signatureStateDigest: signing.signatureStateDigest });
    const finalInventoryBytes = await readRegularFile(inventoryPath, "final packaged license inventory");
    const finalInventory = validateLicenseInventoryDocument(parseJson(finalInventoryBytes, "final packaged license inventory"), {
      repositoryRoot,
      bundlePath: stage.bundlePath,
    });
    validateLicenseInventoryCoverage(
      finalInventory,
      finalEntries,
      null,
      finalSigningBound.macho,
      { repositoryRoot, bundlePath: stage.bundlePath },
    );
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "inventory-reread", { sha256: sha256(finalInventoryBytes) });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "final-observation", {
      entries: finalEntries.length,
      codeResources: finalSigningBound.codeResources.length,
      signatures: signatureEvidence.nestedMachO.length + 1,
    });
    const finalManifest = buildArtifactResignManifest({
      baselineManifest,
      packageInputs: reboundPackageInputs,
      inventory: finalInventory,
      signing,
      preOuterEntries,
      finalEntries,
      preOuterSigningBound,
      finalSigningBound,
      baseline: stage.marker.baseline,
      markerBytes: stage.markerBytes,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "manifest-built", { artifactDigest: finalManifest.artifactDigest });
    validateArtifactResignMetadata({
      baselineManifest,
      baselineEntries,
      baselineMachOPayloads,
      baselineInventory,
      manifest: finalManifest,
      preOuterEntries,
      preOuterMachOPayloads,
      finalEntries,
      finalMachOPayloads,
      finalInventory,
      baseline: stage.marker.baseline,
      markerBytes: stage.markerBytes,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "manifest-validated", { artifactDigest: finalManifest.artifactDigest });
    await writeArtifactMetadataAtomically({
      filePath: stage.manifestPath,
      value: finalManifest,
      label: "retained staged composition manifest",
      expectedTarget: manifestIdentity,
    });
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "manifest-written", { path: stage.manifestPath });

    await assertStageWritableSurface(stage);
    ownerSignals?.assertNotInterrupted();
    await emitCommandLifecycleEvent(observer, lifecycleEvents, "retained-validation-start", { path: stage.manifestPath });
    const result = {
      status: "candidate",
      stageRoot: stage.stageRoot,
      bundlePath: stage.bundlePath,
      manifestPath: stage.manifestPath,
      artifactDigest: finalManifest.artifactDigest,
      packageInputDigest: finalManifest.packageInputs.digest,
      artifactInputDigest: finalManifest.packageInputs.artifactInput.digest,
      signatureStateDigest: finalManifest.signing.signatureStateDigest,
      entries: finalEntries.length,
      macho: finalMachOEntries.length,
      codeResources: finalSigningBound.codeResources.length,
      signingOrder: finalManifest.signing.order.all,
    };
    ownerSignals?.assertNotInterrupted();
    if (ownerMode) {
      assertArtifactResignLifecycleOrder([...lifecycleEvents, "retained-validation-complete", "terminal-retained-success"]);
      const committed = await commitRetainedMacOSPackageSuccess({
        manifestPath: stage.manifestPath,
        repositoryRoot,
        expectedStatusIdentity: consumedStatusIdentity,
        expectedStageBinding,
        result,
        signalController: ownerSignals,
      });
      await emitCommandLifecycleEvent(observer, lifecycleEvents, "retained-validation-complete", { status: committed.validator.status });
      await emitCommandLifecycleEvent(observer, lifecycleEvents, "terminal-retained-success", { state: committed.terminal.state, attempt: committed.terminal.attempt });
      return { ...result, validator: committed.validator, postCommitDiagnostic: committed.postCommitDiagnostic };
    }
    return result;
  } catch (error) {
    if (ownerMode) {
      if (error?.ownerCommitted === true) throw error;
      await ownerSignals?.waitForChildAbsence();
      const outcome = error?.ownerOutcome === "interrupted" || ownerSignals?.isInterrupted() ? "interrupted" : "failure";
      const terminal = await retainOwnerFailureOutcome({ stage, outcome, error, expectedStatusIdentity: consumedStatusIdentity });
      await emitCommandLifecycleEvent(observer, lifecycleEvents, `terminal-${terminal.state}`, { state: terminal.state, attempt: terminal.attempt });
    }
    throw error;
  } finally {
    try {
      await capability?.release();
    } finally {
      ownerSignals?.close();
    }
  }
}

async function runPrepareMode(options, observer = null) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const sourcePaths = assertExternalArtifactStageRoot({ stageRoot: sourceRoot, repositoryRoot });
  const sourceBundlePath = sourcePaths.bundlePath;
  const sourceManifestPath = sourcePaths.manifestPath;
  await validateOwnerSourceClosure({ sourceRoot, sourceBundlePath, sourceManifestPath });

  const manifestBytes = await readFile(sourceManifestPath);
  const baselineManifest = validateManifestDocument(parseJson(manifestBytes, "external local package manifest"));
  await validateMacOSPackage(sourceManifestPath, {
    repositoryRoot,
    disposableProof: true,
    signingMode: "local-ad-hoc",
    signingIdentity: "-",
  });
  await emitCommandLifecycleEvent(observer, [], "local-ad-hoc-preflight", { sourceRoot });

  const baselineSnapshot = await inspectCommandPackage(sourceBundlePath);
  const baselineEntries = baselineSnapshot.entries;
  const baselineMachOEntries = baselineSnapshot.machoEntries;
  const baselineMachOPayloads = baselineSnapshot.machoPayloads;
  const baseline = buildArtifactBaseline({ manifest: baselineManifest, manifestBytes, machoPayloads: baselineMachOPayloads });
  assertBaselineIdentity({ manifest: baselineManifest, marker: { baseline }, manifestBytes, expected: baseline });
  const inventoryPath = path.resolve(sourceBundlePath, baselineManifest.licenseInventory.path);
  const inventoryBytes = await readFile(inventoryPath);
  const baselineInventory = validateLicenseInventoryDocument(parseJson(inventoryBytes, "external packaged license inventory"), {
    repositoryRoot,
    bundlePath: sourceBundlePath,
  });
  validateLicenseInventoryCoverage(baselineInventory, baselineEntries, baselineManifest.licenseInventory, baselineManifest.macho, { repositoryRoot, bundlePath: sourceBundlePath });
  const baselineClosure = assertBaselineArtifactClosure({
    manifest: baselineManifest,
    actualEntries: baselineEntries,
    actualMachOEntries: baselineMachOEntries,
    actualMachOPayloads: baselineMachOPayloads,
    expectedMachOPayloads: baseline.machoPayloads,
    baselineInventory,
    bundlePath: sourceBundlePath,
    expectedBaseline: baseline,
  });
  const signingBound = createSigningBoundDescriptor({
    phase: "final",
    machoPaths: baselineClosure.machoPaths,
    machoPayloads: baselineClosure.machoPayloads,
    codeResourcePaths: baselineClosure.codeResourcePaths,
  });
  const policy = await loadEntitlementPolicy({ repositoryRoot });
  validateExactEntitlementPolicy(policy, { machoPaths: signingBound.macho });
  validateApprovedEntitlementMachOEntries({ entries: baselineEntries, machoEntries: baselineMachOEntries, policy });

  const marker = (stage) => ({
    schema: "MEETLESS_MACOS_ARTIFACT_STAGE v1",
    stageRoot: stage.stageRoot,
    bundlePath: "Meetless.app",
    manifestPath: "composition-manifest.json",
    baseline: structuredClone(baseline),
    policy: createStagePolicyEvidence(policy),
  });
  const stage = await createOwnerStage({
    sourceRoot,
    sourceBundlePath,
    sourceManifestPath,
    repositoryRoot,
    marker,
  });
  const ownerCommand = `npm run resign:macos:artifact -- --stage-root=${stage.stageRoot} --signing-identity=${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1.toUpperCase()} --team-id=${MACOS_REQUIRED_DEVELOPER_ID_TEAM}`;
  await emitCommandLifecycleEvent(observer, [], "stage-prepared", { stageRoot: stage.stageRoot });
  await announceOwnerStage(stage.stageRoot);
  return {
    status: "prepared",
    sourceRoot,
    sourceBundlePath,
    sourceManifestPath,
    stageRoot: stage.stageRoot,
    bundlePath: stage.bundlePath,
    manifestPath: stage.manifestPath,
    markerPath: stage.markerPath,
    statusPath: stage.statusPath,
    baseline,
    ownerCommand,
  };
}

async function retainOwnerFailureOutcome({ stage, outcome, error = null, expectedStatusIdentity = null }) {
  if (!["failure", "interrupted"].includes(outcome)) {
    throw artifactResignError(`owner failure terminalization does not accept outcome ${String(outcome)}`, "use the end-to-end retained-success operation for success and this path only for failure or interruption");
  }
  const stageRoot = stage.stageRoot;
  const statusPath = stage.statusPath ?? path.join(stageRoot, ".meetless-artifact-resign-status.json");
  const markerPath = stage.markerPath ?? path.join(stageRoot, ".meetless-artifact-stage.json");
  const markerBytes = stage.markerBytes ?? await readFile(markerPath).catch(() => null);
  const parentBinding = stage.parentBinding ?? await captureOwnerParentBinding(stageRoot, "owner status parent");
  const statusIdentity = await captureRegularFileIdentity(statusPath, "owner attempt status").catch((captureError) => {
    if (expectedStatusIdentity) {
      throw artifactResignError(`expected consumed owner attempt status is missing or unreadable: ${captureError instanceof Error ? captureError.message : String(captureError)}`, "restore the exact consumed status file before recording its terminal failure or interruption");
    }
    return null;
  });
  if (expectedStatusIdentity) assertRegularFileIdentity(statusIdentity, expectedStatusIdentity, "owner attempt status before terminal commit");
  const current = statusIdentity ? parseJson(statusIdentity.bytes, "owner attempt status") : null;
  if (current) validateOwnerStatusDocument(current, { stageRoot, markerBytes });
  if (current && current.state.startsWith("retained-")) {
    const expectedState = {
      "preparation-failure": "retained-preparation-failure",
      failure: "retained-failure",
      interrupted: "retained-interrupted",
    }[outcome];
    if (current.state !== expectedState) {
      throw artifactResignError(`existing owner terminal state ${current.state} does not match requested ${expectedState}`, "do not return a stale or mismatched terminal outcome as the current command result");
    }
    return current;
  }
  const consumed = current?.attempt === 1 || current?.state === "consumed";
  const terminalOutcome = consumed ? outcome : "preparation-failure";
  const attempt = consumed ? 1 : 0;
  const terminalEvidence = buildOwnerTerminalEvidence({
    stageRoot,
    markerBytes,
    status: { attempt },
    outcome: terminalOutcome,
    error,
  });
  const terminalStatus = createOwnerStatusDocument({
    stageRoot,
    markerBytes,
    state: {
      "preparation-failure": "retained-preparation-failure",
      failure: "retained-failure",
      interrupted: "retained-interrupted",
    }[terminalOutcome],
    attempt,
    outcome: terminalOutcome,
    terminal: terminalEvidence,
  });
  if (current) {
    await transitionOwnerStatus({
      stageRoot,
      statusPath,
      markerBytes,
      from: current.state,
      state: terminalStatus.state,
      attempt,
      outcome: terminalOutcome,
      terminal: terminalEvidence,
      expectedCurrentIdentity: expectedStatusIdentity,
      parentBinding,
    });
  } else {
    await writeOwnerFailureStatusAtomically({ filePath: statusPath, value: terminalStatus, stageRoot, markerBytes, label: "owner attempt status", allowMissingTarget: true, parentBinding });
  }
  await announceOwnerTerminal({ stageRoot, status: terminalStatus.state });
  return terminalStatus;
}

async function announceOwnerStage(stageRoot) {
  const line = `owner stage root: ${stageRoot}\n`;
  process.stdout.write(line);
}

async function announceOwnerTerminal({ stageRoot, status }) {
  const line = `owner terminal status: ${status}; stage root: ${stageRoot}; lifecycle: ${path.join(stageRoot, ".meetless-artifact-resign-status.json")}\n`;
  process.stdout.write(line);
}

async function recheckStageBeforeFirstCodesign({ stage, baselineManifest, baselineManifestBytes, baselineEntries, baselineMachOPayloads, baselineInventory, baselineInventoryBytes, policy, ownerMode = false }) {
  const freshStage = await validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot, ownerMode });
  if (sha256(freshStage.markerBytes) !== sha256(stage.markerBytes)) {
    throw artifactResignError("stage marker changed after the initial preflight", "stop before codesign and retain the owner marker for inspection");
  }
  const freshManifestBytes = await readFile(freshStage.manifestPath);
  if (!freshManifestBytes.equals(baselineManifestBytes)) {
    throw artifactResignError("staged composition manifest changed after the initial preflight", "stop before codesign and restore the accepted baseline manifest bytes");
  }
  const freshManifest = validateManifestDocument(parseJson(freshManifestBytes, "rechecked staged composition manifest"));
  assertBaselineIdentity({ manifest: freshManifest, marker: freshStage.marker, manifestBytes: freshManifestBytes, expected: freshStage.marker.baseline });
  const freshSnapshot = await inspectCommandPackage(freshStage.bundlePath, { ownerMode });
  const freshEntries = freshSnapshot.entries;
  const freshMachOEntries = freshSnapshot.machoEntries;
  const freshMachOPayloads = freshSnapshot.machoPayloads;
  const freshInventoryPath = path.resolve(freshStage.bundlePath, freshManifest.licenseInventory.path);
  const freshInventoryBytes = await readRegularFile(freshInventoryPath, "rechecked packaged license inventory");
  if (!freshInventoryBytes.equals(baselineInventoryBytes)) {
    throw artifactResignError("packaged license inventory changed after the initial preflight", "stop before codesign and restore the accepted inventory bytes");
  }
  const freshInventory = validateLicenseInventoryDocument(parseJson(freshInventoryBytes, "rechecked packaged license inventory"), { repositoryRoot, bundlePath: freshStage.bundlePath });
  validateLicenseInventoryCoverage(freshInventory, freshEntries, freshManifest.licenseInventory, freshManifest.macho, { repositoryRoot, bundlePath: freshStage.bundlePath });
  assertBaselineArtifactClosure({
    manifest: freshManifest,
    actualEntries: freshEntries,
    actualMachOEntries: freshMachOEntries,
    actualMachOPayloads: freshMachOPayloads,
    expectedMachOPayloads: freshStage.marker.baseline.machoPayloads,
    baselineInventory: freshInventory,
    expectedBaseline: freshStage.marker.baseline,
  });
  assertMachOPayloadClosure({ baselinePayloads: baselineMachOPayloads, finalPayloads: freshMachOPayloads });
  assertStagePolicyBinding(freshStage.marker.policy, policy);
  validateApprovedEntitlementMachOEntries({ entries: freshEntries, machoEntries: freshMachOEntries, policy });
  await validateMacOSPackage(freshStage.manifestPath, { artifactOnly: true, repositoryRoot, signingMode: "local-ad-hoc", signingIdentity: "-", ownerMode });
  await assertStageWritableSurface(freshStage);
  return freshStage;
}

async function inspectCommandPackage(bundlePath, { ownerMode = false } = {}) {
  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries, { ownerMode });
  const machoPayloads = await bindMachOPayloads({ bundlePath, machoPaths: machoEntries.map((entry) => entry.path) });
  return { entries, machoEntries, machoPayloads };
}

function resolveLifecycleObserver(hooks) {
  if (hooks === undefined || hooks === null) return null;
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    throw artifactResignError("artifact re-sign observer options are malformed", "omit options or provide only the observation-only onLifecycleEvent callback");
  }
  const supplied = Object.keys(hooks);
  const unsupported = supplied.filter((name) => name !== "onLifecycleEvent");
  if (unsupported.length > 0) {
    throw artifactResignError(`production artifact re-sign rejects caller lifecycle collaborators: ${unsupported.join(", ")}`, "run the existing command with its fixed stage, signing, evidence, validator, and status authorities");
  }
  if (hooks.onLifecycleEvent !== undefined && typeof hooks.onLifecycleEvent !== "function") {
    throw artifactResignError("onLifecycleEvent observation hook is not a function", "provide one callback that only observes lifecycle events");
  }
  return hooks.onLifecycleEvent ?? null;
}

async function emitCommandLifecycleEvent(observer, events, event, details = {}) {
  events.push(event);
  if (typeof observer !== "function") return;
  try {
    await observer(event, details);
  } catch {
    // An observation hook cannot change the production command outcome.
  }
}

function assertDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("artifact re-sign requires macOS arm64. Authority: docs/specs/macos-artifact-validation.md. Next action: run the owner-authorized transform only on the accepted macOS arm64 host.");
  }
}

async function readRegularFile(filePath, label) {
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw artifactResignError(label + " is not a regular non-symlink file: " + filePath, "restore the accepted staged metadata before signing");
  }
  return readFile(filePath);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw artifactResignError(label + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)), "restore the accepted machine-readable staged metadata");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactResignError(reason, nextAction) {
  return new Error(`${reason}. Authority: docs/specs/macos-artifact-validation.md. Next action: ${nextAction}.`);
}
