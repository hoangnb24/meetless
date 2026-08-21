const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("@expo/config-plugins");

const MARKER = "Meetless Xcode 26 fmt workaround";

module.exports = function withFmtXcode26Fix(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const podfilePath = path.join(
        modConfig.modRequest.platformProjectRoot,
        "Podfile",
      );
      const podfile = fs.readFileSync(podfilePath, "utf8");
      if (podfile.includes(MARKER)) {
        return modConfig;
      }

      const postInstallEnd = /(    react_native_post_install\([\s\S]*?\n    \))(\n  end\nend)/;
      if (!postInstallEnd.test(podfile)) {
        throw new Error("Cannot install the Xcode 26 fmt workaround in the generated Podfile.");
      }

      const workaround = `

    # ${MARKER}: React Native 0.81 pins fmt 11.0.2, whose consteval
    # detection is incompatible with Apple Clang 21. Remove after React Native
    # includes the upstream fmt fix.
    fmt_base = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      fmt_source = File.read(fmt_base)
      fmt_patched = fmt_source.sub(
        '#elif defined(__apple_build_version__) && __apple_build_version__ < 14000029L',
        '#elif defined(__apple_build_version__)'
      )
      if fmt_patched != fmt_source
        File.chmod(0644, fmt_base)
        File.write(fmt_base, fmt_patched)
      end
    end`;

      fs.writeFileSync(
        podfilePath,
        podfile.replace(postInstallEnd, `$1${workaround}$2`),
      );
      return modConfig;
    },
  ]);
};
