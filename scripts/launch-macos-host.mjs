import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertInstalledHostIdentity } from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";

const execFileAsync = promisify(execFile);
const config = resolveRuntimeConfig();
const identity = await assertInstalledHostIdentity(config);
await execFileAsync("open", ["-g", "-a", identity.bundleRealPath]);
process.stdout.write(
  `Launched ${identity.bundleIdentifier} through LaunchServices at ${identity.bundleRealPath} ` +
  `(CDHash ${identity.cdHash}).\n`,
);
