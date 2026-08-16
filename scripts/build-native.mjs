import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("swift", ["build", "-c", "release", "--package-path", "native/macos-capture"], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    SWIFTPM_MODULECACHE_OVERRIDE: "/private/tmp/meetless-swift-module-cache",
    CLANG_MODULE_CACHE_PATH: "/private/tmp/meetless-clang-module-cache",
  },
  stdio: "inherit",
});
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
