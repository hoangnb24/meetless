import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MACOS_BRANDING_INFO = Object.freeze({
  CFBundleName: "Meetless",
  CFBundleDisplayName: "Meetless",
  CFBundleIconFile: "Meetless.icns",
});

export function validateMacOSBrandingInfo(info) {
  for (const [key, value] of Object.entries(MACOS_BRANDING_INFO)) {
    if (info?.[key] !== value) throw new Error(`Meetless branding: ${key} must be ${value}`);
  }
}

export async function readApprovedMacOSBranding(repositoryRoot) {
  const provenance = JSON.parse(await readFile(path.join(repositoryRoot, "native/macos-host/MeetlessIcon.provenance.json"), "utf8"));
  const icns = await readFile(path.join(repositoryRoot, "native/macos-host/Meetless.icns"));
  const source = await readFile(path.join(repositoryRoot, provenance.source));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (sha256(icns) !== provenance.artifactSha256 || sha256(source) !== provenance.sourceSha256) {
    throw new Error("Meetless branding: restore the approved icon and its source provenance");
  }
  // Reuse the approved ICNS's 1024px representation for Electron nativeImage.
  // nativeImage consumes PNG; there is no second rasterization or new design.
  if (icns.toString("ascii", 0, 4) !== "icns" || icns.readUInt32BE(4) !== icns.length) {
    throw new Error("Meetless branding: invalid approved ICNS container");
  }
  for (let offset = 8; offset + 8 <= icns.length;) {
    const size = icns.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > icns.length) break;
    if (icns.toString("ascii", offset, offset + 4) === "ic10") {
      const png = icns.subarray(offset + 8, offset + size);
      if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024) break;
      return { icns, png };
    }
    offset += size;
  }
  throw new Error("Meetless branding: approved ICNS must contain a 1024px PNG");
}

export async function writeMacOSBrandingResources(contentsPath, branding) {
  const resources = path.join(contentsPath, "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, "Meetless.icns"), branding.icns, { mode: 0o644 });
  await writeFile(path.join(resources, "Meetless.png"), branding.png, { mode: 0o644 });
}

export async function validateMacOSBrandingResources(contentsPath, branding) {
  for (const [name, expected] of [["Meetless.icns", branding.icns], ["Meetless.png", branding.png]]) {
    const actual = await readFile(path.join(contentsPath, "Resources", name));
    if (!actual.equals(expected)) throw new Error(`Meetless branding: packaged ${name} differs from the approved icon`);
  }
}
