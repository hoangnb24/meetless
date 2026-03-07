from pathlib import Path
import unittest


class XcodeEmbedRuntimePhaseContractTests(unittest.TestCase):
    def test_embed_runtime_phase_tracks_model_and_manifest(self) -> None:
        project_text = Path("Recordit.xcodeproj/project.pbxproj").read_text(encoding="utf-8")

        phase_name = 'name = "Embed Runtime Binaries";'
        self.assertIn(phase_name, project_text)

        expected_literals = [
            '"$(SRCROOT)/.build/recordit-runtime-inputs/$(CONFIGURATION)/runtime/models/whispercpp/ggml-tiny.en.bin"',
            '"$(SRCROOT)/.build/recordit-runtime-inputs/$(CONFIGURATION)/runtime/artifact-manifest.json"',
            '"$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/runtime/models/whispercpp/ggml-tiny.en.bin"',
            '"$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/runtime/artifact-manifest.json"',
        ]

        for literal in expected_literals:
            self.assertIn(literal, project_text, f"missing build-phase contract path: {literal}")


    def test_embed_script_requires_model_and_manifest_for_release(self) -> None:
        script_text = Path("scripts/embed_recordit_runtime_binaries.sh").read_text(encoding="utf-8")

        self.assertIn('if [[ "$configuration" == "Release" ]]; then', script_text)
        self.assertIn('fail_or_warn "prebuilt whispercpp model not found at $default_model_src; standard app runtime parity requires a bundled default model"', script_text)
        self.assertIn('fail_or_warn "runtime artifact manifest not found at $runtime_artifact_manifest_src; bundled runtime parity verification requires this manifest"', script_text)


if __name__ == "__main__":
    unittest.main()
