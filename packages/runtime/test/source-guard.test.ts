import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertLauncherOrdering } from "../src/source-guard.js";

describe("launcher source ordering guard", () => {
  test("accepts the checked-in launchers", async () => {
    await expect(
      Promise.all([
        readFile(path.join(process.cwd(), "packages/runtime/src/cli.ts"), "utf8"),
        readFile(path.join(process.cwd(), "scripts/electron-bootstrap.mjs"), "utf8"),
      ]).then(([daemonLauncher, electronBootstrap]) =>
        assertLauncherOrdering({ daemonLauncher, electronBootstrap }),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects a Paseo import that moves before runtime preparation", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          'import "@getpaseo/server";\nawait prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);',
        electronBootstrap: 'app.setPath("userData", userData);\nawait import(desktopMain);',
      }),
    ).toThrow(/statically imports Paseo.*fix paths, endpoint, and Electron user-data/s);
  });

  test("rejects Electron import ordering that can select production user-data", () => {
    expect(() =>
      assertLauncherOrdering({
        daemonLauncher:
          "await prepareRuntime(config);\nObject.assign(process.env, config.environment);\nawait import(entry);",
        electronBootstrap: 'await import(desktopMain);\napp.setPath("userData", userData);',
      }),
    ).toThrow(/Electron bootstrap performs.*before isolation is fixed/);
  });
});
