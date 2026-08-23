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
  rmSync,
  statSync,
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

await main();

async function main() {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:.]/gu, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const workingRoot = mkdtempSync(path.join(tmpdir(), `meetless-m1-${runId}-`));
  const runtimeRoot = path.join(workingRoot, "runtime");
  const workingEvidence = path.join(workingRoot, "evidence");
  const preEvidenceSourceDigest = candidateSnapshot().digest;
  const before = productionSnapshot();
  const owned = [];
  let electronBrowser;
  let webBrowser;
  let electronPage;
  let webTabletPage;
  let webDesktopPage;
  let fixtureClient;
  let authorizedStopChecked = false;
  let operationError = null;
  let proofFacts = null;
  let ports = null;

  try {
    run("npm", ["run", "build:meetless"], { logPath: path.join(workingRoot, "build-meetless.log") });
    run("npm", ["run", "build:app"], { logPath: path.join(workingRoot, "build-app.log") });
    const publication = await import("../packages/runtime/dist/proof-publication.js");
    void publication;

    const [daemonPort, rendererPort, cdpPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePort(),
    ]);
    if ([daemonPort, rendererPort, cdpPort].includes(6767)) {
      throw new Error("Ephemeral port allocation selected forbidden production port 6767");
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
    };

    const renderer = start(
      "npm",
      ["run", "start:web", "--workspace=@meetless/app", "--", "--port", String(rendererPort)],
      { env: environment, logPath: path.join(workingRoot, "renderer.log") },
    );
    owned.push(renderer);
    await waitFor(async () => (await fetch(rendererOrigin)).ok, 90_000, "Expo web renderer");

    const desktop = start("npm", ["run", "runtime:desktop"], {
      env: {
        ...environment,
        MEETLESS_RENDERER_URL: rendererOrigin,
        PASEO_ELECTRON_FLAGS:
          `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
      },
      logPath: path.join(workingRoot, "desktop.log"),
    });
    owned.push(desktop);
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
    const webPage = await webBrowser.newPage({ viewport: { width: 390, height: 844 } });
    await webPage.addInitScript((profile) => {
      window.localStorage.setItem("meetless.companion.profile.v1", JSON.stringify(profile));
    }, {
      version: 1,
      id: `direct:127.0.0.1:${daemonPort}`,
      label: "M1 Direct LAN proof host",
      type: "direct",
      endpoint: `127.0.0.1:${daemonPort}`,
      useTls: false,
      password: "m1-proof-direct-password",
    });
    await webPage.goto(
      `${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}&mode=desktop`,
    );
    assertEqual(new URL(webPage.url()).searchParams.get("mode"), "desktop", "web attack query");
    const webBridgePresent = await webPage.evaluate(
      () => typeof window.paseoDesktop !== "undefined",
    );
    assertEqual(webBridgePresent, false, "ordinary Chrome desktop bridge");
    await webPage.getByText("Host online", { exact: true }).waitFor({ timeout: 30_000 });
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
    const webScreenshot = path.join(workingEvidence, "web-phone.png");
    await webPage.screenshot({ path: webScreenshot, fullPage: true });
    webTabletPage = await webBrowser.newPage({ viewport: { width: 834, height: 1112 } });
    await webTabletPage.goto(`${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}`);
    await webTabletPage.getByText("M1 Surface Proof", { exact: true }).waitFor({ timeout: 30_000 });
    const webTabletScreenshot = path.join(workingEvidence, "web-tablet.png");
    await webTabletPage.screenshot({ path: webTabletScreenshot, fullPage: true });
    webDesktopPage = await webBrowser.newPage({ viewport: { width: 1440, height: 900 } });
    await webDesktopPage.goto(`${rendererOrigin}/?daemon=${encodeURIComponent(daemonUrl)}`);
    await webDesktopPage.getByText("M1 Surface Proof", { exact: true }).waitFor({ timeout: 30_000 });
    const webDesktopScreenshot = path.join(workingEvidence, "web-desktop.png");
    await webDesktopPage.screenshot({ path: webDesktopScreenshot, fullPage: true });

    await fixtureClient.close();
    fixtureClient = null;
    const runtimeStopLog = path.join(workingEvidence, "runtime-stop.log");
    run("npm", ["run", "runtime:stop"], { env: environment, logPath: runtimeStopLog });
    authorizedStopChecked = true;

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
      },
      evidenceFiles: [
        { sourcePath: electronScreenshot, name: "electron.png", kind: "screenshot" },
        { sourcePath: webScreenshot, name: "web-phone.png", kind: "screenshot" },
        { sourcePath: webTabletScreenshot, name: "web-tablet.png", kind: "screenshot" },
        { sourcePath: webDesktopScreenshot, name: "web-desktop.png", kind: "screenshot" },
        { sourcePath: runtimeStopLog, name: "runtime-stop.log", kind: "log" },
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
  try {
    rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (error) {
    operationError ??= error;
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
    disposableSimulatorAbsent: true,
    simulatorTerminateChecked: false,
    simulatorUninstallChecked: false,
    simulatorShutdownChecked: false,
    simulatorDeleteChecked: false,
    productionPreserved: productionUnchanged(before, after),
  };

  if (operationError || !proofFacts) {
    rmSync(workingRoot, { recursive: true, force: true });
    const reason = operationError instanceof Error ? operationError.stack : String(operationError);
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
