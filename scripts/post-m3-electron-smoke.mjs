import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join("/private/tmp", `meetless-electron-smoke-${Date.now()}`);
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
const electronExecutable = createRequire(import.meta.url)("electron");
const tracePath = path.join(artifactRoot, "renderer-trace.zip");
const screenshotPath = path.join(artifactRoot, "renderer.png");
let electronApp = null;
let context = null;
let tracing = false;
try {
  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [path.join(repositoryRoot, "scripts/electron-renderer-smoke.mjs")],
    env: { ...process.env, ELECTRON_IS_DEV: "0" },
    tracesDir: artifactRoot,
  });
  context = electronApp.context();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  const page = await electronApp.firstWindow();
  await page.getByTestId("recording-title-input").fill("renderer smoke");
  await page.getByTestId("recording-start").click();
  await page.getByTestId("recording-stop").click();
  await page.getByTestId("visible-state").filter({ hasText: "saved" }).waitFor();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await context.tracing.stop({ path: tracePath });
  tracing = false;
} finally {
  if (tracing && context) await context.tracing.stop({ path: tracePath }).catch(() => undefined);
  if (electronApp) await electronApp.close().catch(() => undefined);
}

process.stdout.write(`${JSON.stringify({
  schema: "MEETLESS_POST_M3_ELECTRON_SMOKE v1",
  status: "passed",
  support: "experimental-playwright-electron",
  evidenceClass: "renderer-only",
  recording: false,
  tcc: false,
  physicalClick: false,
  liveSource: false,
  screenshot: screenshotPath,
  trace: tracePath,
}, null, 2)}\n`);
