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
    const importBeforeUserData = `await import(desktopMain);\n${interactiveElectronBootstrap.replace(
      /\nawait import\(desktopMain\);$/u,
      "",
    )}`;
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: importBeforeUserData,
      }),
    ).toThrow(/complete interactive startup performs await import.*before isolation is fixed/);
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
    ).toThrow(/complete interactive startup is missing.*app\.focus.*activate and focus each BrowserWindow/s);
  });

  test("rejects activation that leaves the renderer window unfocused", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: interactiveElectronBootstrap.replace("window.focus();\n", ""),
      }),
    ).toThrow(/complete interactive startup is missing.*window\.focus.*activate and focus each BrowserWindow/s);
  });

  test("rejects importing Paseo before the interactive-window listener is registered", () => {
    const importBeforeListener = interactiveElectronBootstrap
      .replace(
        'app.on("browser-window-created"',
        'await import(desktopMain);\napp.on("browser-window-created"',
      )
      .replace(/\nawait import\(desktopMain\);$/u, "");
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: importBeforeListener,
      }),
    ).toThrow(/complete interactive startup performs await import.*activate and focus each BrowserWindow/s);
  });

  test("rejects accessibility enablement without a consumed controlled marker", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        desktopLauncher: 'await prepareRuntime(config);\nawait import("./readiness.js");',
        electronBootstrap: `${interactiveElectronBootstrap}\napp.setAccessibilitySupportEnabled(true);`,
      }),
    ).toThrow(/enables accessibility without a consumed one-shot UI-test envelope/);
  });
});
