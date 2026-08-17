import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertLauncherOrdering } from "../src/source-guard.js";

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
        electronBootstrap: 'app.setPath("userData", userData);\nawait import(desktopMain);',
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
        electronBootstrap: 'app.setPath("userData", userData);\nawait import(desktopMain);',
      }),
    ).toThrow(/readiness statically imports.*before runtime preparation/s);
  });
});
