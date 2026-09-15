import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MACOS_BRANDING_INFO,
  readApprovedMacOSBranding,
  validateMacOSBrandingInfo,
  validateMacOSBrandingResources,
  writeMacOSBrandingResources,
} from "../../../scripts/lib/macos-branding.mjs";
import { prepareR5DevelopmentElectronInfo, validateR5DevelopmentElectronInfo } from "../../../scripts/lib/macos-app-store-development.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("Meetless bundle and runtime branding", () => {
  it.each([false, true])("supplies the icon before the vendor import (packaged=%s)", async (packaged) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-bootstrap-branding-")));
    try {
      const files = {
        "package.json": JSON.stringify({ type: "module" }),
        "scripts/electron-bootstrap.mjs": await readFile(path.join(repositoryRoot, "scripts/electron-bootstrap.mjs"), "utf8"),
        "node_modules/electron/package.json": JSON.stringify({ type: "module", main: "index.js" }),
        "node_modules/electron/index.js": 'export const app = { setName() {}, setPath() {}, on() {} }; export const Menu = {};',
        "packages/runtime/dist/ui-test-envelope.js": 'export function readConsumedUiTestMarkerSync() { return null; }',
        "vendor/paseo/packages/desktop/dist/main.js": 'console.log(process.env.PASEO_APP_ICON_PATH);',
      };
      for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "scripts/electron-bootstrap.mjs")], {
        env: { MEETLESS_RUNTIME_ROOT: root, PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "userdata"), MEETLESS_RUNTIME_PACKAGED: packaged ? "1" : "0", PASEO_APP_ICON_PATH: "/untrusted/inherited/icon.png" },
      });
      expect(stdout.trim()).toBe(packaged ? path.resolve(root, "../Meetless.png") : path.join(root, "design/assets/meetless-mark-512.png"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("replaces stock Electron metadata while retaining the distinct nested identity", () => {
    const prepared = prepareR5DevelopmentElectronInfo({
      CFBundleName: "Electron", CFBundleDisplayName: "Electron",
      CFBundleIconFile: "electron.icns", CFBundleIdentifier: "com.github.Electron",
      CFBundleExecutable: "Electron", CFBundleVersion: "41.2.0",
    });
    expect(prepared).toMatchObject({ ...MACOS_BRANDING_INFO, CFBundleIdentifier: "com.meetless.app.electron", CFBundleExecutable: "Electron", ElectronTeamID: "63M98WD275" });
    expect(() => validateMacOSBrandingInfo(prepared)).not.toThrow();
    for (const key of Object.keys(MACOS_BRANDING_INFO)) {
      expect(() => validateR5DevelopmentElectronInfo({ ...prepared, [key]: "Electron" }, { requireBundleIdentifier: true, requireBranding: true })).toThrow(key);
    }
  });

  it("copies the approved icon unchanged and extracts its PNG for runtime, rejecting replaced assets", async () => {
    const branding = await readApprovedMacOSBranding(repositoryRoot);
    expect(branding.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(branding.png.readUInt32BE(16)).toBe(1024);
    const root = await mkdtemp(path.join(tmpdir(), "meetless-branding-"));
    try {
      const outer = path.join(root, "Contents");
      const nested = path.join(outer, "Helpers/Electron.app/Contents");
      for (const contents of [outer, nested]) {
        await writeMacOSBrandingResources(contents, branding);
        await validateMacOSBrandingResources(contents, branding);
        expect(await readFile(path.join(contents, "Resources/Meetless.icns"))).toEqual(branding.icns);
      }
      await writeFile(path.join(nested, "Resources/Meetless.png"), "old icon");
      await expect(validateMacOSBrandingResources(nested, branding)).rejects.toThrow(/Meetless.png differs/);
      await writeMacOSBrandingResources(nested, branding);
      await writeFile(path.join(nested, "Resources/Meetless.icns"), "old icon");
      await expect(validateMacOSBrandingResources(nested, branding)).rejects.toThrow(/Meetless.icns differs/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
