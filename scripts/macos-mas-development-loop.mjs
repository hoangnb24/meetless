import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  copyTreeWithDitto,
  probeMasDevelopmentPlugin,
  parseMasDevelopmentLoopArguments,
  prepareMasDevelopmentCandidate,
  updateMasDevelopmentInstall,
  prepareOwnedInstallDirectory,
  publishCurrentMasDevelopmentArtifact,
  readDevelopmentEnvironment,
  resetMasDevelopmentRuntime,
  resolveMasDevelopmentLoopPaths,
} from "./lib/macos-mas-development-loop.mjs";
import {
  masDevelopmentRuntimeContext,
  validateMasDevelopmentInstallArtifact,
  validateMasDevelopmentInstalledSignatures,
} from "./macos-mas-development-gate.mjs";
import { R5_APP_STORE_DEVELOPMENT_IDENTITY, resolveR5DevelopmentProfilePath } from "./lib/macos-app-store-development.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const paths = resolveMasDevelopmentLoopPaths(repositoryRoot, homedir());
const { command, reuseCurrent } = parseMasDevelopmentLoopArguments(process.argv.slice(2));

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("the MAS development loop requires Apple-silicon macOS");
}

if (command === "fresh") await fresh();
else if (command === "update") await fresh({ preserveData: true, reuseCurrent });
else if (command === "launch") await launchAndVerify();
else throw new Error("Usage: node scripts/macos-mas-development-loop.mjs <fresh|update|launch>");

async function fresh({ preserveData = false, reuseCurrent = false } = {}) {
  const environment = await readDevelopmentEnvironment(path.join(repositoryRoot, ".env.local"));
  const expected = {
    expectedRevenueCatPublicSdkKey: environment.publicSdkKey,
    expectedConvexUrl: environment.convexUrl,
  };
  const validateProofRoot = async (proofRoot) => validateMasDevelopmentInstallArtifact({
    manifestPath: path.join(proofRoot, "release/macos/app-store-development-manifest.json"),
    bundlePath: path.join(proofRoot, "release/macos/Meetless.app"),
    context: masDevelopmentRuntimeContext(),
    dependencies: expected,
  });
  const validation = await prepareMasDevelopmentCandidate({
    reuseCurrent,
    proofRoot: paths.proofRoot,
    validate: validateProofRoot,
    produce: async () => {
      const scratch = await mkdtemp("/private/tmp/meetless-mas-development-");
      try {
        await runVisible("npm", ["run", "build"], { cwd: repositoryRoot });
        await runVisible(process.execPath, [
          path.join(repositoryRoot, "scripts/package-macos-app-store-development.mjs"),
          `--proof-root=${scratch}`,
          `--provisioning-profile=${resolveR5DevelopmentProfilePath()}`,
          `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
        ], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            MEETLESS_REVENUECAT_PUBLIC_SDK_KEY: environment.publicSdkKey,
            MEETLESS_CONVEX_URL: environment.convexUrl,
          },
        });

        await validateProofRoot(scratch);
        await publishCurrentMasDevelopmentArtifact({
          sourceProofRoot: scratch,
          destinationProofRoot: paths.proofRoot,
          validate: validateProofRoot,
        });

      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });
  await quitInstalledApp();
  const validateInstalled = () => validateMasDevelopmentInstalledSignatures({
    manifestPath: paths.manifestPath,
    bundlePath: paths.installPath,
    artifactBinding: validation.artifactBinding,
    dependencies: expected,
  });
  if (preserveData) {
    const backupRoot = await updateMasDevelopmentInstall(paths, { validateInstalled });
    process.stdout.write(`MAS update retained app and runtime backup: ${backupRoot}\n`);
  } else {
    await resetMasDevelopmentRuntime(paths);
    await prepareOwnedInstallDirectory(paths.installPath, { uid: process.getuid(), gid: process.getgid() });
    await copyTreeWithDitto(paths.bundlePath, paths.installPath);
    await validateInstalled();
  }
  await launchAndVerify();
}

async function quitInstalledApp() {
  await execFileAsync("/usr/bin/osascript", ["-e", 'tell application id "com.meetless.app" to quit']).catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await execFileAsync("/usr/sbin/lsof", ["+D", paths.installPath]).catch((error) => {
      if (error?.code === 1) return { stdout: "" };
      throw error;
    });
    if (!String(result.stdout).trim()) return;
    await delay(250);
  }
  throw new Error("Meetless still has open files in the installed app; close it before replacing the development build");
}

async function launchAndVerify() {
  await execFileAsync("/usr/bin/open", [paths.installPath]);
  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const identity = JSON.parse(await readFile(path.join(paths.runtimeRoot, "host-identity.json"), "utf8"));
      if (identity.bundlePath !== paths.installPath || identity.bundleIdentifier !== "com.meetless.app") {
        throw new Error("published host identity does not match the installed Meetless app");
      }
      const { meetingCount } = await probeMasDevelopmentPlugin(
        pathToFileURL(path.join(paths.installPath, "Contents/Resources/meetless/packages/meetless-client/dist/index.js")).href,
      );
      process.stdout.write(`${JSON.stringify({
        status: "owner-test-ready",
        installedApp: paths.installPath,
        durableArtifact: paths.bundlePath,
        runtimeRoot: paths.runtimeRoot,
        plugin: "meetless",
        meetingCount,
      }, null, 2)}\n`);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Meetless opened but did not reach plugin readiness: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function runVisible(file, arguments_, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
