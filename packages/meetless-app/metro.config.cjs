const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");

const projectRoot = __dirname;
const repositoryRoot = path.resolve(projectRoot, "../..");
const relaySourceRoot = path.join(repositoryRoot, "vendor/paseo/packages/relay/src");
const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;

// The pinned relay package publishes TypeScript for Metro but uses NodeNext
// emitted .js specifiers internally. Resolve those specifiers to their source
// .ts peers so the neutral pinned client works in web and React Native bundles.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (origin && origin.startsWith(relaySourceRoot) && moduleName.endsWith(".js")) {
    const sourceModule = moduleName.replace(/\.js$/u, ".ts");
    const candidate = path.resolve(path.dirname(origin), sourceModule);
    if (fs.existsSync(candidate)) {
      return defaultResolveRequest(context, sourceModule, platform);
    }
  }
  return defaultResolveRequest(context, moduleName, platform);
};

module.exports = config;
