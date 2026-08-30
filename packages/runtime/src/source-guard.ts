import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISOLATION_AUTHORITY = "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md";

export function assertLauncherOrdering(input: {
  daemonLauncher: string;
  desktopLauncher: string;
  electronBootstrap: string;
}): void {
  requireOrder(
    input.daemonLauncher,
    ["await prepareRuntime(config)", "Object.assign(process.env, config.environment)", "await import("],
    "daemon launcher",
  );
  requireOrder(
    input.desktopLauncher,
    ['await prepareRuntime(config)', 'await import("./readiness.js")'],
    "desktop readiness launcher",
  );
  if (/^import\s+.*["']\.\/readiness\.js["']/mu.test(input.desktopLauncher)) {
    fail("desktop readiness statically imports the Paseo client before runtime preparation");
  }
  requireOrder(
    input.electronBootstrap,
    [
      'app.setPath("userData", userData)',
      'app.on("browser-window-created"',
      'window.once("ready-to-show"',
      "app.focus({ steal: true })",
      "window.show()",
      "window.focus()",
      "await import(",
    ],
    "Electron complete interactive startup",
  );
  if (/setAccessibilitySupportEnabled\(\s*true\s*\)|accessibilitySupportEnabled\s*=|appendSwitch\(\s*["']force-renderer-accessibility["']/.test(input.electronBootstrap)) {
    const markerIndex = input.electronBootstrap.indexOf("readConsumedUiTestMarkerSync");
    const guardIndex = input.electronBootstrap.indexOf("if (uiTestMarker?.forceAccessibility === true)");
    const accessibilityIndex = input.electronBootstrap.indexOf("app.setAccessibilitySupportEnabled(true)");
    const switchIndex = input.electronBootstrap.indexOf('app.commandLine.appendSwitch("force-renderer-accessibility")');
    const enabledIndex = accessibilityIndex >= 0 ? accessibilityIndex : switchIndex;
    if (markerIndex < 0 || guardIndex < 0 || enabledIndex < 0 || guardIndex > enabledIndex) {
      fail("Electron enables accessibility without a consumed one-shot UI-test envelope");
    }
  }
  const forbiddenStaticImport = /^import\s+.*(?:@getpaseo|vendor\/paseo)/mu;
  for (const [label, source] of [
    ["daemon launcher", input.daemonLauncher],
    ["Electron bootstrap", input.electronBootstrap],
  ] as const) {
    if (forbiddenStaticImport.test(source)) {
      fail(`${label} statically imports Paseo before isolation is fixed`);
    }
  }
}

function requireOrder(source: string, markers: string[], label: string): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    if (index < 0) fail(`${label} is missing required startup marker: ${marker}`);
    if (index <= previous) fail(`${label} performs ${marker} before isolation is fixed`);
    previous = index;
  }
}

function fail(reason: string): never {
  throw new Error(
    `${reason}. Meetless launcher invariant (${ISOLATION_AUTHORITY}): fix paths, endpoint, and Electron ` +
      "user-data before importing Paseo; activate and focus each BrowserWindow after it is ready to show.",
  );
}

async function main(): Promise<void> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(moduleDirectory, "../../..");
  const daemonLauncher = await readFile(path.join(repositoryRoot, "packages/runtime/src/cli.ts"), "utf8");
  const desktopLauncher = await readFile(path.join(repositoryRoot, "packages/runtime/src/desktop.ts"), "utf8");
  const electronBootstrap = await readFile(
    path.join(repositoryRoot, "scripts/electron-bootstrap.mjs"),
    "utf8",
  );
  assertLauncherOrdering({ daemonLauncher, desktopLauncher, electronBootstrap });
  process.stdout.write(`Meetless launcher ordering satisfies ${ISOLATION_AUTHORITY}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
