import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { connectMeetlessClient } from "@meetless/client";

const repositoryRoot = process.cwd();
const productionHome = path.join(homedir(), ".paseo");
const observedProductionFiles = ["paseo.pid", "server-id", "config.json"].map((name) =>
  path.join(productionHome, name),
);
const forbiddenProductLabels = /\b(workspaces?|agents?|projects?|schedules?)\b/iu;
const appBundleId = "com.meetless.app";

await main();

async function main() {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:.]/gu, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const workingRoot = mkdtempSync(path.join(tmpdir(), `meetless-m1-${runId}-`));
  const runtimeRoot = path.join(repositoryRoot, ".meetless-runtime");
  const preservedRuntimeRoot = `${runtimeRoot}.m1-preserved-${runId}`;
  const originalRuntimeRootExisted = existsSync(runtimeRoot);
  const workingEvidence = path.join(workingRoot, "evidence");
  const hostStopLog = path.join(workingEvidence, "host-stop.log");
  const preEvidenceSourceDigest = candidateSnapshot().digest;
  const before = productionSnapshot();
  const owned = [];
  let electronBrowser;
  let webBrowser;
  let electronPage;
  let webTabletPage;
  let webDesktopPage;
  let fixtureClient;
  let simulator = null;
  let simulatorInstalled = false;
  let simulatorLaunched = false;
  let authorizedStopChecked = false;
  let hostLaunched = false;
  let hostLaunchAttempted = false;
  let hostStopped = false;
  let runtimeRootStaged = false;
  let runtimeRootRestored = false;
  let hostEnvironment = null;
  let operationError = null;
  let hostStopFailure = null;
  let proofFacts = null;
  let ports = null;

  try {
    run("npm", ["run", "build:meetless"], { logPath: path.join(workingRoot, "build-meetless.log") });
    run("npm", ["run", "build:app"], { logPath: path.join(workingRoot, "build-app.log") });
    const publication = await import("../packages/runtime/dist/proof-publication.js");
    const { newUiTestEnvelope, writeUiTestEnvelope, readConsumedUiTestMarker } = await import(
      "../packages/runtime/dist/ui-test-envelope.js"
    );
    void publication;

    const [rendererPort, cdpPort] = await Promise.all([availablePort(), availablePort()]);
    const daemonPort = 6777;
    if (!listenerIsAbsent(daemonPort)) {
      throw new Error("Cannot stage M1 proof while the installed Meetless listener 127.0.0.1:6777 is in use");
    }
    ports = { daemonPort, rendererPort, cdpPort };
    const listen = `127.0.0.1:${daemonPort}`;
    const daemonUrl = `ws://${listen}/ws`;
    const rendererOrigin = `http://127.0.0.1:${rendererPort}`;
    const environment = {
      ...process.env,
      EXPO_PUBLIC_MEETLESS_DAEMON_URL: daemonUrl,
      MEETLESS_LISTEN: listen,
      MEETLESS_RENDERER_ORIGIN: rendererOrigin,
      MEETLESS_RUNTIME_ROOT: runtimeRoot,
      MEETLESS_DIRECT_PASSWORD: "m1-proof-direct-password",
      MEETLESS_RENDERER_URL: rendererOrigin,
    };
    hostEnvironment = environment;

    assertExactHostAbsent();
    preserveRuntimeRoot(runtimeRoot, preservedRuntimeRoot, originalRuntimeRootExisted);
    runtimeRootStaged = true;
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const uiTestEnvelope = newUiTestEnvelope({
      runId: `m1-proof-${runId}`,
      cdpPort,
      transcriptionMode: "fake",
      forceAccessibility: true,
    });
    await writeUiTestEnvelope(runtimeRoot, uiTestEnvelope);

    const renderer = start(
      "npm",
      ["run", "start:web", "--workspace=@meetless/app", "--", "--port", String(rendererPort)],
      { env: environment, logPath: path.join(workingRoot, "renderer.log") },
    );
    owned.push(renderer);
    await waitFor(async () => (await fetch(rendererOrigin)).ok, 90_000, "Expo web renderer");

    hostLaunchAttempted = true;
    run(process.execPath, [path.join(repositoryRoot, "scripts/launch-macos-host.mjs")], {
      env: environment,
      logPath: path.join(workingRoot, "host-launch.log"),
    });
    hostLaunched = true;
    await waitFor(
      async () => (await readConsumedUiTestMarker(runtimeRoot))?.runId === uiTestEnvelope.runId,
      90_000,
      "consumed M1 UI-test marker",
    );
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok,
      90_000,
      "Meetless Electron CDP endpoint",
    );

    electronBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    electronPage = await waitForElectronPage(electronBrowser, rendererOrigin);
    await electronPage.getByText("Host online", { exact: true }).waitFor({
      timeout: 60_000,
    });
    const electronBridgePresent = await electronPage.evaluate(
      () =>
        typeof window.paseoDesktop === "object" &&
        typeof window.paseoDesktop?.invoke === "function",
    );
    assertEqual(electronBridgePresent, true, "Electron trusted desktop bridge");
    assertEqual(await electronPage.title(), "Meetless", "Electron document title");
    await assertNoCodingProduct(electronPage, "Electron");
    await electronPage.getByTestId("meeting-layout-desktop").waitFor({ state: "visible" });
    await assertNoHorizontalOverflow(electronPage, "Electron desktop");
    await electronPage.getByTestId("record-meeting-entry").waitFor({ state: "visible", timeout: 30_000 });
    await electronPage.getByTestId("record-meeting-entry").click();
    await electronPage.getByTestId("recording-setup").waitFor({ state: "visible" });
    assertEqual(await electronPage.getByText("Proposed", { exact: true }).count(), 2, "recording source readiness");
    await electronPage.getByTestId("recording-setup-title").fill("M1 Surface Proof");
    if (!(await electronPage.getByTestId("recording-start").isEnabled())) {
      throw new Error("Electron Record meeting setup did not enable Start after a title was supplied");
    }
    await electronPage.getByTestId("recording-setup-cancel").click();
    assertEqual(await electronPage.getByTestId("desktop-create-controls").count(), 0, "Electron create controls");
    assertEqual(await electronPage.getByTestId("meeting-create-button").count(), 0, "Electron create action");

    fixtureClient = await connectMeetlessClient({
      url: daemonUrl,
      clientId: `m1-proof-fixture-${Date.now()}`,
      clientType: "cli",
    });
    const fixtureMeeting = await fixtureClient.client.createMeeting({ title: "M1 Surface Proof" });
    await electronPage.getByTestId("meeting-refresh-button").click();
    const electronMeetingTitle = electronPage.getByText("M1 Surface Proof", { exact: true });
    await electronMeetingTitle.waitFor({ timeout: 30_000 });
    const meetingTestId = await resolveMeetingRowTestId(electronMeetingTitle, "Electron");
    const meetingId = fixtureMeeting.id;
    assertEqual(meetingId, meetingTestId.slice("meeting-".length), "fixture meeting ID");
    const electronScreenshot = path.join(workingEvidence, "electron.png");
    ensureParent(electronScreenshot);
    await electronPage.screenshot({ path: electronScreenshot, fullPage: true });

    const chromePath = resolveChromePath();
    webBrowser = await chromium.launch({ executablePath: chromePath, headless: true });
    const companionProfile = {
      version: 1,
      id: `direct:127.0.0.1:${daemonPort}`,
      label: "M1 Direct LAN proof host",
      type: "direct",
      endpoint: `127.0.0.1:${daemonPort}`,
      useTls: false,
      password: "m1-proof-direct-password",
    };
    const webPage = await webBrowser.newPage({ viewport: { width: 390, height: 844 } });
    await webPage.addInitScript((profile) => {
      window.localStorage.setItem("meetless.companion.profile.v1", JSON.stringify(profile));
    }, companionProfile);
    await webPage.goto(
      `${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}&mode=desktop`,
    );
    assertEqual(new URL(webPage.url()).searchParams.get("mode"), "desktop", "web attack query");
    const webBridgePresent = await webPage.evaluate(
      () => typeof window.paseoDesktop !== "undefined",
    );
    assertEqual(webBridgePresent, false, "ordinary Chrome desktop bridge");
    await webPage.getByText("Host online", { exact: true }).waitFor({ timeout: 30_000 });
    await webPage.getByTestId("meeting-layout-phone").waitFor({ state: "visible" });
    const webMeetingTitle = webPage.getByText("M1 Surface Proof", { exact: true });
    await webMeetingTitle.waitFor({ timeout: 30_000 });
    const webMeetingTestId = await resolveMeetingRowTestId(webMeetingTitle, "Web");
    assertEqual(webMeetingTestId, meetingTestId, "web companion meeting ID");
    if (!(await webPage.getByText("Companion library · recording happens on desktop", { exact: true }).isVisible())) {
      throw new Error("Web companion did not render its companion library surface");
    }
    assertEqual(await webPage.getByTestId("record-meeting-entry").count(), 0, "web Record meeting entry");
    assertEqual(await webPage.getByTestId("desktop-create-controls").count(), 0, "web create controls");
    assertEqual(await webPage.getByTestId("meeting-create-button").count(), 0, "web create action");
    await assertNoCodingProduct(webPage, "web companion");
    await assertNoHorizontalOverflow(webPage, "web phone companion");
    const webScreenshot = path.join(workingEvidence, "web-phone.png");
    await webPage.screenshot({ path: webScreenshot, fullPage: true });
    webTabletPage = await webBrowser.newPage({ viewport: { width: 834, height: 1112 } });
    await webTabletPage.addInitScript((profile) => {
      window.localStorage.setItem("meetless.companion.profile.v1", JSON.stringify(profile));
    }, companionProfile);
    await webTabletPage.goto(`${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}`);
    await webTabletPage.getByText("Host online", { exact: true }).waitFor({ timeout: 30_000 });
    await webTabletPage.getByText("M1 Surface Proof", { exact: true }).waitFor({ timeout: 30_000 });
    await webTabletPage.getByTestId("meeting-layout-tablet").waitFor({ state: "visible" });
    assertEqual(await webTabletPage.getByTestId("record-meeting-entry").count(), 0, "tablet Record meeting entry");
    assertEqual(await webTabletPage.getByTestId("meeting-create-button").count(), 0, "tablet create action");
    await assertNoHorizontalOverflow(webTabletPage, "web tablet companion");
    await assertNoCodingProduct(webTabletPage, "web tablet companion");
    const webTabletScreenshot = path.join(workingEvidence, "web-tablet.png");
    await webTabletPage.screenshot({ path: webTabletScreenshot, fullPage: true });
    webDesktopPage = await webBrowser.newPage({ viewport: { width: 1440, height: 900 } });
    await webDesktopPage.addInitScript((profile) => {
      window.localStorage.setItem("meetless.companion.profile.v1", JSON.stringify(profile));
    }, companionProfile);
    await webDesktopPage.goto(`${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}`);
    await webDesktopPage.getByText("Host online", { exact: true }).waitFor({ timeout: 30_000 });
    await webDesktopPage.getByText("M1 Surface Proof", { exact: true }).waitFor({ timeout: 30_000 });
    await webDesktopPage.getByTestId("meeting-layout-desktop").waitFor({ state: "visible" });
    assertEqual(await webDesktopPage.getByTestId("record-meeting-entry").count(), 0, "desktop companion Record meeting entry");
    assertEqual(await webDesktopPage.getByTestId("meeting-create-button").count(), 0, "desktop companion create action");
    await assertNoHorizontalOverflow(webDesktopPage, "web desktop companion");
    await assertNoCodingProduct(webDesktopPage, "web desktop companion");
    const webDesktopScreenshot = path.join(workingEvidence, "web-desktop.png");
    await webDesktopPage.screenshot({ path: webDesktopScreenshot, fullPage: true });

    simulator = createDisposableSimulator(runId);
    const iosBuildLog = path.join(workingRoot, "ios-build.log");
    const iosDerivedDataPath = path.join(workingRoot, "ios-derived-data");
    const iosResultBundlePath = path.join(workingRoot, "ios-build.xcresult");
    await runOwnedBuild(
      "xcodebuild",
      [
        "-workspace",
        "Meetless.xcworkspace",
        "-configuration",
        "Release",
        "-scheme",
        "Meetless",
        "-destination",
        `id=${simulator.udid}`,
        "-derivedDataPath",
        iosDerivedDataPath,
        "-resultBundlePath",
        iosResultBundlePath,
        "build",
      ],
      {
        cwd: path.join(repositoryRoot, "packages/meetless-app/ios"),
        env: {
          ...environment,
          NODE_ENV: "production",
          RCT_NO_LAUNCH_PACKAGER: "true",
        },
        logPath: iosBuildLog,
        timeout: 25 * 60_000,
      },
      owned,
    );
    const iosAppPath = path.join(
      iosDerivedDataPath,
      "Build",
      "Products",
      "Release-iphonesimulator",
      "Meetless.app",
    );
    if (!existsSync(iosAppPath) || !statSync(iosAppPath).isDirectory()) {
      throw new Error(`Direct iOS build did not produce the proof-owned app at ${iosAppPath}`);
    }
    const iosBundleIdentifier = run(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", path.join(iosAppPath, "Info.plist")],
      { capture: true },
    ).trim();
    assertEqual(iosBundleIdentifier, appBundleId, "iOS Release simulator app bundle identifier");
    run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"], {
      logPath: path.join(workingRoot, "simulator-boot.log"),
    });
    run("xcrun", ["simctl", "install", simulator.udid, iosAppPath], {
      logPath: path.join(workingRoot, "simulator-install.log"),
    });
    simulatorInstalled = true;
    checkedCommand("xcrun", ["simctl", "terminate", simulator.udid, appBundleId]);
    seedIosCompanionProfile(simulator.udid, companionProfile);
    run("xcrun", ["simctl", "launch", "--terminate-running-process", simulator.udid, appBundleId], {
      logPath: path.join(workingRoot, "simulator-launch.log"),
    });
    simulatorLaunched = true;

    const iosSurfaceLogBody = await waitForIosMeetingLog(simulator.udid, meetingId);
    const iosSurfaceLog = path.join(workingEvidence, "ios-surface.log");
    writeFileSync(iosSurfaceLog, iosSurfaceLogBody);
    await delay(1_500);
    const iosScreenshot = path.join(workingEvidence, "ios.png");
    run("xcrun", ["simctl", "io", simulator.udid, "screenshot", iosScreenshot], {
      logPath: path.join(workingRoot, "simulator-screenshot.log"),
    });
    const ocr = run("swift", ["scripts/recognize-text.swift", iosScreenshot], {
      capture: true,
      logPath: path.join(workingRoot, "ios-ocr-errors.log"),
    });
    const iosOcrLog = path.join(workingEvidence, "ios-ocr.log");
    writeFileSync(iosOcrLog, ocr);
    const normalizedOcr = normalizeOcrText(ocr);
    for (const requiredText of ["Meetless", "Meetings", "Companion library", "M1 Surface Proof"]) {
      if (!normalizedOcr.includes(normalizeOcrText(requiredText))) {
        throw new Error(
          `iOS screenshot OCR did not contain ${JSON.stringify(requiredText)}. Complete OCR output:\n${ocr}`,
        );
      }
    }
    if (normalizedOcr.includes(normalizeOcrText("Create meeting"))) {
      throw new Error(
        `iOS companion screenshot unexpectedly exposed meeting creation. Complete OCR output:\n${ocr}`,
      );
    }
    if (forbiddenProductLabels.test(ocr)) {
      throw new Error(`iOS screenshot exposed a forbidden coding-product label:\n${ocr}`);
    }

    proofFacts = {
      meetingId,
      endpoint: listen,
      rendererOrigin,
      surfaces: {
        electron: {
          identity: "Meetless Electron desktop",
          title: await electronPage.title(),
          mode: "desktop",
          trustedDesktopBridge: electronBridgePresent,
          recordSetupVisible: true,
          createEnabled: false,
          meetingId,
          viewport: await electronPage.viewportSize(),
        },
        web: {
          identity: "Meetless Expo web companion",
          title: await webPage.title(),
          mode: "companion",
          attemptedUrlMode: "desktop",
          trustedDesktopBridge: webBridgePresent,
          createEnabled: false,
          meetingId,
          viewport: webPage.viewportSize(),
        },
        tablet: {
          identity: "Meetless Expo web tablet layout",
          mode: "companion",
          meetingId,
          viewport: await webTabletPage.viewportSize(),
        },
        phone: {
          identity: "Meetless Expo web phone layout",
          mode: "companion",
          meetingId,
          viewport: await webPage.viewportSize(),
        },
        desktopLayout: {
          identity: "Meetless Expo web desktop layout",
          mode: "companion",
          meetingId,
          viewport: await webDesktopPage.viewportSize(),
        },
        ios: {
          identity: "Meetless Expo iOS companion",
          bundleId: appBundleId,
          deviceName: simulator.name,
          deviceUdid: simulator.udid,
          deviceType: simulator.deviceType,
          runtime: simulator.runtime,
          mode: "companion",
          createEnabled: false,
          meetingId,
        },
      },
      evidenceFiles: [
        { sourcePath: electronScreenshot, name: "electron.png", kind: "screenshot" },
        { sourcePath: webScreenshot, name: "web-phone.png", kind: "screenshot" },
        { sourcePath: webTabletScreenshot, name: "web-tablet.png", kind: "screenshot" },
        { sourcePath: webDesktopScreenshot, name: "web-desktop.png", kind: "screenshot" },
        { sourcePath: iosScreenshot, name: "ios.png", kind: "screenshot" },
        { sourcePath: iosSurfaceLog, name: "ios-surface.log", kind: "log" },
        { sourcePath: iosOcrLog, name: "ios-ocr.log", kind: "log" },
        { sourcePath: hostStopLog, name: "host-stop.log", kind: "log" },
      ],
    };
  } catch (error) {
    operationError = error;
  }

  if (fixtureClient) await fixtureClient.close().catch((error) => { operationError ??= error; });

  let browserClientsClosed = true;
  for (const browser of [webBrowser, electronBrowser]) {
    if (!browser) continue;
    try {
      await browser.close();
      browserClientsClosed &&= !browser.isConnected();
    } catch (error) {
      browserClientsClosed = false;
      operationError ??= error;
    }
  }

  const processGroupChecks = [];
  for (const child of [...owned].reverse()) {
    try {
      processGroupChecks.push(await stopProcessGroup(child));
    } catch (error) {
      processGroupChecks.push(false);
      operationError ??= error;
    }
  }

  if (hostLaunchAttempted) {
    try {
      run(process.execPath, [path.join(repositoryRoot, "scripts/stop-macos-host.mjs")], {
        env: hostEnvironment ?? process.env,
        logPath: hostStopLog,
      });
      hostStopped = true;
      authorizedStopChecked = true;
    } catch (error) {
      hostStopFailure = errorWithLogTail(error, "host-stop", hostStopLog);
      operationError ??= hostStopFailure;
    }
  }

  let simulatorCleanup = { terminate: false, uninstall: false, shutdown: false, delete: false };
  try {
    simulatorCleanup = cleanupDisposableSimulator(simulator, {
      installed: simulatorInstalled,
      launched: simulatorLaunched,
    });
  } catch (error) {
    operationError ??= error;
  }
  if (runtimeRootStaged) {
    try {
      if (exactHostPids().length > 0) {
        throw new Error("Refusing staged runtime cleanup while an exact MeetlessHost process remains live");
      }
      rmSync(runtimeRoot, { recursive: true, force: true });
      if (originalRuntimeRootExisted) {
        renameSync(preservedRuntimeRoot, runtimeRoot);
        runtimeRootRestored = true;
      } else {
        runtimeRootRestored = !existsSync(runtimeRoot) && !existsSync(preservedRuntimeRoot);
      }
    } catch (error) {
      operationError ??= error;
    }
  }

  let after;
  try {
    after = productionSnapshot();
  } catch (error) {
    operationError ??= error;
    after = { inspectionFailed: true };
  }
  const finalChecks = {
    authorizedIsolatedStopChecked: authorizedStopChecked,
    browserClientsClosed,
    ownedProcessGroupsGone: processGroupChecks.length > 0 && processGroupChecks.every(Boolean),
    isolatedListenersGone:
      ports !== null &&
      [ports.daemonPort, ports.rendererPort, ports.cdpPort].every((port) => listenerIsAbsent(port)),
    runtimeRootAbsent: !existsSync(runtimeRoot),
    runtimeRootRestored,
    disposableSimulatorAbsent: simulator !== null && simulatorIsAbsent(simulator.udid),
    simulatorTerminateChecked: simulatorCleanup.terminate,
    simulatorUninstallChecked: simulatorCleanup.uninstall,
    simulatorShutdownChecked: simulatorCleanup.shutdown,
    simulatorDeleteChecked: simulatorCleanup.delete,
    productionPreserved: productionUnchanged(before, after),
  };

  if (operationError || !proofFacts) {
    rmSync(workingRoot, { recursive: true, force: true });
    const reasons = [];
    if (operationError) reasons.push(errorStack(operationError));
    if (hostStopFailure && hostStopFailure !== operationError) reasons.push(errorStack(hostStopFailure));
    const reason = reasons.join("\n") || "Proof facts were not produced";
    throw new Error(
      `M1 surface proof failed before publication. finalChecks=${JSON.stringify(finalChecks)}\n${reason}`,
    );
  }

  const { assertProofFinalChecks, publishProofEvidenceAtomically } = await import(
    "../packages/runtime/dist/proof-publication.js"
  );
  let publication;
  try {
    assertProofFinalChecks(finalChecks);
    const endedAt = new Date().toISOString();
    const destinationDirectory = path.join(repositoryRoot, "test/evidence/m1", runId);
    publication = publishProofEvidenceAtomically({
      destinationDirectory,
      runId,
      preEvidenceSourceDigest,
      startedAt,
      endedAt,
      result: {
        meetingId: proofFacts.meetingId,
        endpoint: proofFacts.endpoint,
        rendererOrigin: proofFacts.rendererOrigin,
        surfaces: proofFacts.surfaces,
        production: { before, after },
        host: {
          platform: process.platform,
          architecture: process.arch,
        },
      },
      finalChecks,
      evidenceFiles: proofFacts.evidenceFiles,
    });
  } finally {
    rmSync(workingRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        runId,
        meetingId: proofFacts.meetingId,
        preEvidenceSourceDigest,
        evidenceDirectory: path.relative(repositoryRoot, publication.directory),
        finalChecks,
      },
      null,
      2,
    )}\n`,
  );
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function run(command, args, options = {}) {
  const descriptor = options.logPath ? openSync(options.logPath, "w") : undefined;
  try {
    const completed = spawnSync(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      encoding: options.capture ? "utf8" : undefined,
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.capture
        ? ["ignore", "pipe", descriptor ?? "inherit"]
        : ["ignore", descriptor ?? "inherit", descriptor ?? "inherit"],
      timeout: options.timeout,
    });
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed with status ${completed.status}; ` +
          `see ${options.logPath ?? "console"}`,
      );
    }
    return options.capture ? completed.stdout : "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function runOwnedBuild(command, args, options, owned) {
  const descriptor = options.logPath ? openSync(options.logPath, "w") : undefined;
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", descriptor ?? "inherit", descriptor ?? "inherit"],
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!child.pid) throw new Error(`Could not start owned ${command} build process`);
  owned.push(child);

  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    child.once("close", (status, signal) => resolve({ type: "close", status, signal }));
  });
  let outcome = await waitForChildOutcome(exit, options.timeout);
  if (outcome.type === "timeout") {
    signalProcessGroup(child.pid, "SIGTERM");
    outcome = await waitForChildOutcome(exit, 10_000);
    if (outcome.type === "timeout") {
      signalProcessGroup(child.pid, "SIGKILL");
      outcome = await waitForChildOutcome(exit, 5_000);
    }
    throw new Error(buildFailureMessage(command, args, options, `timed out after ${options.timeout} ms`));
  }
  if (outcome.type === "error") {
    throw new Error(buildFailureMessage(command, args, options, String(outcome.error)));
  }
  if (outcome.status !== 0) {
    throw new Error(
      buildFailureMessage(
        command,
        args,
        options,
        `failed with status ${outcome.status ?? "null"}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`,
      ),
    );
  }
}

function waitForChildOutcome(exit, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });
  return Promise.race([exit, timeout]).finally(() => clearTimeout(timer));
}

function buildFailureMessage(command, args, options, reason) {
  const tail = options.logPath ? readLogTail(options.logPath, "build") : "(no build log was configured)";
  return (
    `${command} ${args.join(" ")} ${reason}; see ${options.logPath ?? "console"}\n` +
    `--- final build log tail (up to 200 lines) ---\n${tail}`
  );
}

function errorWithLogTail(error, label, logPath) {
  return new Error(
    `${errorStack(error)}\n--- final ${label} log tail (up to 200 lines) ---\n${readLogTail(logPath, label)}`,
  );
}

function errorStack(error) {
  return error instanceof Error ? error.stack : String(error);
}

function readLogTail(logPath, label) {
  if (!existsSync(logPath)) return `(${label} log is absent: ${logPath})`;
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/u);
  return lines.slice(Math.max(0, lines.length - 200)).join("\n").trim() || `(${label} log is empty)`;
}

function start(command, args, options) {
  const stream = createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.once("exit", () => stream.end());
  return child;
}

async function stopProcessGroup(child) {
  if (!child.pid) return false;
  signalProcessGroup(child.pid, "SIGTERM");
  const terminated = await waitForProcessGroupGone(child.pid, 10_000);
  if (terminated) return true;
  signalProcessGroup(child.pid, "SIGKILL");
  return waitForProcessGroupGone(child.pid, 5_000);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function waitForProcessGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    }
    await delay(100);
  }
  return false;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a loopback port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

async function waitForElectronPage(browser, rendererOrigin) {
  let page;
  await waitFor(() => {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(rendererOrigin));
    return Boolean(page);
  }, 30_000, "Electron Meetless renderer page");
  return page;
}

async function assertNoCodingProduct(page, surface) {
  const text = await page.getByTestId("meetless-product-root").innerText();
  if (forbiddenProductLabels.test(text)) {
    throw new Error(`${surface} exposed a coding-product label:\n${text}`);
  }
}

async function assertNoHorizontalOverflow(page, surface) {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  if (overflow.documentWidth > overflow.viewportWidth) {
    throw new Error(`${surface} has horizontal overflow: ${JSON.stringify(overflow)}`);
  }
}

function resolveChromePath() {
  const candidates = [
    process.env.MEETLESS_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error("Surface proof requires installed Google Chrome/Chromium or MEETLESS_CHROME_PATH");
  }
  return selected;
}

function createDisposableSimulator(runId) {
  const deviceTypes = JSON.parse(run("xcrun", ["simctl", "list", "devicetypes", "--json"], { capture: true }));
  const runtimes = JSON.parse(run("xcrun", ["simctl", "list", "runtimes", "--json"], { capture: true }));
  const deviceType = deviceTypes.devicetypes.find((candidate) => candidate.name === "iPhone 17 Pro");
  const runtime = runtimes.runtimes.find(
    (candidate) => candidate.identifier === "com.apple.CoreSimulator.SimRuntime.iOS-26-5" && candidate.isAvailable,
  );
  if (!deviceType || !runtime) {
    throw new Error("Proof requires the available iPhone 17 Pro device type and iOS 26.5 runtime");
  }
  const name = `Meetless Proof ${runId}`;
  const udid = run("xcrun", ["simctl", "create", name, deviceType.identifier, runtime.identifier], {
    capture: true,
  }).trim();
  if (!/^[0-9A-F-]{36}$/u.test(udid)) throw new Error(`simctl returned invalid disposable UDID ${udid}`);
  return { udid, name, deviceType: deviceType.identifier, runtime: runtime.identifier };
}

function seedIosCompanionProfile(udid, profile) {
  const container = run("xcrun", ["simctl", "get_app_container", udid, appBundleId, "data"], { capture: true }).trim();
  if (!container) throw new Error("Could not resolve the installed iOS app data container");
  const storageDirectory = path.join(
    container,
    "Library",
    "Application Support",
    appBundleId,
    "RCTAsyncLocalStorage_V1",
  );
  const manifestPath = path.join(storageDirectory, "manifest.json");
  let manifest = {};
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  ensureParent(manifestPath);
  manifest["meetless.companion.profile.v1"] = JSON.stringify(profile);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function cleanupDisposableSimulator(simulator, state) {
  if (!simulator) return { terminate: false, uninstall: false, shutdown: false, delete: false };
  const terminate = state.launched && checkedCommand("xcrun", ["simctl", "terminate", simulator.udid, appBundleId]);
  const uninstall = state.installed && checkedCommand("xcrun", ["simctl", "uninstall", simulator.udid, appBundleId]);
  const shutdown = checkedCommand("xcrun", ["simctl", "shutdown", simulator.udid]);
  const deleted = checkedCommand("xcrun", ["simctl", "delete", simulator.udid]);
  return { terminate, uninstall, shutdown, delete: deleted };
}

function checkedCommand(command, args) {
  const completed = spawnSync(command, args, { encoding: "utf8" });
  return !completed.error && completed.status === 0;
}

function simulatorIsAbsent(udid) {
  const listed = spawnSync("xcrun", ["simctl", "list", "devices", "--json"], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) return false;
  const devices = Object.values(JSON.parse(listed.stdout).devices).flat();
  return !devices.some((device) => device.udid === udid);
}

function preserveRuntimeRoot(runtimeRoot, preservedRuntimeRoot, originalExisted) {
  if (existsSync(preservedRuntimeRoot)) {
    throw new Error(`Refusing M1 runtime preservation because ${preservedRuntimeRoot} already exists`);
  }
  if (originalExisted) {
    const info = statSync(runtimeRoot);
    if (!info.isDirectory()) throw new Error(`Refusing to preserve non-directory runtime root ${runtimeRoot}`);
    renameSync(runtimeRoot, preservedRuntimeRoot);
    return;
  }
  if (existsSync(runtimeRoot)) {
    throw new Error(`Runtime root appeared during M1 setup: ${runtimeRoot}`);
  }
}

function assertExactHostAbsent() {
  const pids = exactHostPids();
  if (pids.length > 0) {
    throw new Error(`Cannot stage M1 proof while exact MeetlessHost processes are live: ${pids.join(", ")}`);
  }
}

function exactHostPids() {
  const executablePath = path.join(homedir(), "Applications", "Meetless.app", "Contents", "MacOS", "MeetlessHost");
  const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    throw new Error("Cannot inspect the exact MeetlessHost process");
  }
  return inspected.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match && match[3] === executablePath && Number(match[2]) === 1 ? [Number(match[1])] : [];
  });
}

async function waitForIosMeetingLog(udid, meetingId) {
  let matched = "";
  await waitFor(() => {
    const shown = spawnSync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "log",
        "show",
        "--info",
        "--last",
        "2m",
        "--style",
        "compact",
        "--predicate",
        'process == "Meetless" AND eventMessage CONTAINS "[meetless-surface]"',
      ],
      { encoding: "utf8" },
    );
    matched = shown.stdout;
    return shown.status === 0 && matched.includes(meetingId) && matched.includes('"platform":"ios"');
  }, 45_000, `iOS surface log for meeting ${meetingId}`);
  return matched;
}

function listenerIsAbsent(port) {
  const inspected = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
  });
  return !inspected.error && inspected.status === 1 && inspected.stdout.trim() === "";
}

function productionSnapshot() {
  const files = observedProductionFiles.map(snapshotFile);
  const lock = files.find((entry) => path.basename(entry.path) === "paseo.pid");
  const pid = lock && !lock.absent && typeof lock.value?.pid === "number" ? lock.value.pid : null;
  const processIdentity = pid
    ? commandOutput("ps", ["-p", String(pid), "-o", "pid=,lstart=,command="])
    : "";
  const listener = commandOutput("lsof", ["-nP", "-iTCP:6767", "-sTCP:LISTEN", "-Fpctn"]);
  return { files, listener, processIdentity };
}

function snapshotFile(file) {
  try {
    const body = readFileSync(file);
    const stats = statSync(file);
    return {
      path: file,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      value: path.basename(file) === "paseo.pid" ? JSON.parse(body.toString("utf8")) : undefined,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { path: file, absent: true };
    throw error;
  }
}

function commandOutput(command, args) {
  const completed = spawnSync(command, args, { encoding: "utf8" });
  if (completed.status !== 0 && completed.status !== 1) {
    throw new Error(`${command} ${args.join(" ")} failed (${completed.status})`);
  }
  return completed.stdout.trim();
}

function productionUnchanged(left, right) {
  if (!right || right.inspectionFailed) return false;
  const stable = (snapshot) => ({
    ...snapshot,
    files: snapshot.files.map((entry) => {
      if (path.basename(entry.path) !== "paseo.pid") return entry;
      const { mtimeMs: _heartbeatMtime, ...withoutHeartbeatMtime } = entry;
      return withoutHeartbeatMtime;
    }),
  });
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function candidateSnapshot() {
  const completed = spawnSync(process.execPath, ["scripts/candidate-snapshot.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (completed.error || completed.status !== 0) {
    throw new Error("Could not compute the pre-evidence candidate source digest");
  }
  return JSON.parse(completed.stdout);
}

function normalizeOcrText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function resolveMeetingRowTestId(titleLocator, surface) {
  const titleCount = await titleLocator.count();
  if (titleCount === 0) {
    throw new Error(`${surface} meeting title is absent`);
  }
  if (titleCount !== 1) {
    throw new Error(`${surface} meeting title is ambiguous (${titleCount})`);
  }

  const rowLocator = titleLocator.first().locator("xpath=ancestor::*[@data-testid and @role='button']");
  const rowCount = await rowLocator.count();
  if (rowCount === 0) {
    throw new Error(`${surface} meeting-row ancestor is absent`);
  }
  if (rowCount !== 1) {
    throw new Error(`${surface} meeting-row ancestor is ambiguous (${rowCount})`);
  }

  const testId = await rowLocator.first().getAttribute("data-testid");
  if (!testId?.startsWith("meeting-")) {
    throw new Error(`${surface} meeting-row ancestor is absent or invalid (${testId})`);
  }

  const meetingId = testId.slice("meeting-".length);
  if (!meetingId) {
    throw new Error(`${surface} meeting-row ancestor is absent or invalid (${testId})`);
  }
  return testId;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
