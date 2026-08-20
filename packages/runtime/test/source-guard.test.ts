import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertLauncherOrdering } from "../src/source-guard.js";

const interactiveElectronBootstrap = [
  'app.setPath("userData", userData);',
  'app.on("browser-window-created", (_event, window) => {',
  'window.once("ready-to-show", () => {',
  "app.focus({ steal: true });",
  "window.show();",
  "window.focus();",
  "await import(desktopMain);",
].join("\n");

describe("launcher source ordering guard", () => {
  test("accepts the checked-in launchers", async () => {
    await expect(
      Promise.all([
        readFile(path.join(process.cwd(), "packages/runtime/src/cli.ts"), "utf8"),
        readFile(path.join(process.cwd(), "packages/runtime/src/desktop.ts"), "utf8"),
        readFile(path.join(process.cwd(), "scripts/electron-bootstrap.mjs"), "utf8"),
      ]).then(([daemonLauncher, desktopLauncher, electronBootstrap]) =>
        assertLauncherOrdering({ daemonLauncher, desktopLauncher, electronBootstrap }),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects a Paseo import that moves before runtime preparation", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          'import "@getpaseo/server";\nawait prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);',
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: interactiveElectronBootstrap,
      }),
    ).toThrow(/statically imports Paseo.*fix paths, endpoint, and Electron user-data/s);
  });

  test("rejects Electron import ordering that can select production user-data", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: 'await import(desktopMain);\napp.setPath("userData", userData);',
      }),
    ).toThrow(/Electron bootstrap performs.*before isolation is fixed/);
  });

  test("rejects recording readiness import before isolated runtime preparation", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'import "./readiness.js";\nawait prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: interactiveElectronBootstrap,
      }),
    ).toThrow(/readiness statically imports.*before runtime preparation/s);
  });

  test("rejects showing the renderer without activating its Electron application", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: interactiveElectronBootstrap.replace("app.focus({ steal: true });\n", ""),
      }),
    ).toThrow(/interactive-window activation is missing.*app\.focus.*activate and focus each BrowserWindow/s);
  });

  test("rejects activation that leaves the renderer window unfocused", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: interactiveElectronBootstrap.replace("window.focus();\n", ""),
      }),
    ).toThrow(/interactive-window activation is missing.*window\.focus.*activate and focus each BrowserWindow/s);
  });
});
