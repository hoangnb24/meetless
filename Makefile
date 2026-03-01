APP_NAME := SequoiaCapture
BIN_NAME := sequoia_capture
TRANSCRIBE_BIN := transcribe-live
TRANSCRIBE_APP_NAME := SequoiaTranscribe
APP_DIR := dist/$(APP_NAME).app
APP_EXE := $(APP_DIR)/Contents/MacOS/$(APP_NAME)
TRANSCRIBE_APP_DIR := dist/$(TRANSCRIBE_APP_NAME).app
TRANSCRIBE_APP_EXE := $(TRANSCRIBE_APP_DIR)/Contents/MacOS/$(TRANSCRIBE_APP_NAME)
INFO_PLIST := packaging/Info.plist
ENTITLEMENTS := packaging/entitlements.plist
SIGN_IDENTITY ?= -
CAPTURE_SECS ?= 10
OUT ?= artifacts/hello-world.wav
SAMPLE_RATE ?= 48000
CAPTURE_MISMATCH_POLICY ?= adapt-stream-rate
CAPTURE_CALLBACK_MODE ?= warn
TRANSCRIBE_SECS ?= 10
TRANSCRIBE_OUT_WAV ?= artifacts/transcribe-live.wav
TRANSCRIBE_OUT_JSONL ?= artifacts/transcribe-live.jsonl
TRANSCRIBE_OUT_MANIFEST ?= artifacts/transcribe-live.manifest.json
TRANSCRIBE_LIVE_STREAM_SECS ?= 10
TRANSCRIBE_LIVE_STREAM_INPUT_WAV ?= artifacts/transcribe-live-stream.input.wav
TRANSCRIBE_LIVE_STREAM_OUT_WAV ?= artifacts/transcribe-live-stream.wav
TRANSCRIBE_LIVE_STREAM_OUT_JSONL ?= artifacts/transcribe-live-stream.jsonl
TRANSCRIBE_LIVE_STREAM_OUT_MANIFEST ?= artifacts/transcribe-live-stream.manifest.json
TRANSCRIBE_LIVE_STREAM_ARGS ?=
TRANSCRIBE_APP_ARTIFACT_ROOT ?= $(HOME)/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta
TRANSCRIBE_APP_SESSION_STEM ?= session
TRANSCRIBE_APP_OUT_WAV ?= $(TRANSCRIBE_APP_ARTIFACT_ROOT)/$(TRANSCRIBE_APP_SESSION_STEM).wav
TRANSCRIBE_APP_OUT_JSONL ?= $(TRANSCRIBE_APP_ARTIFACT_ROOT)/$(TRANSCRIBE_APP_SESSION_STEM).jsonl
TRANSCRIBE_APP_OUT_MANIFEST ?= $(TRANSCRIBE_APP_ARTIFACT_ROOT)/$(TRANSCRIBE_APP_SESSION_STEM).manifest.json
TRANSCRIBE_APP_LIVE_STREAM_INPUT_WAV ?= $(TRANSCRIBE_APP_ARTIFACT_ROOT)/$(TRANSCRIBE_APP_SESSION_STEM).input.wav
TRANSCRIBE_APP_LIVE_STREAM_ARGS ?=
TRANSCRIBE_APP_SHOW_LIVE_INPUT ?= 0
WHISPERCPP_HELPER_BIN ?= /opt/homebrew/bin/whisper-cli
WHISPERCPP_HELPER_LIB_GLOBS ?= libwhisper*.dylib libggml*.dylib
TRANSCRIBE_APP_HELPER_BIN_DIR ?= $(TRANSCRIBE_APP_DIR)/Contents/Resources/bin
TRANSCRIBE_APP_HELPER_LIB_DIR ?= $(TRANSCRIBE_APP_DIR)/Contents/Resources/lib
WHISPERCPP_MODEL_DEFAULT ?= artifacts/bench/models/whispercpp/ggml-tiny.en.bin
ASR_MODEL ?= $(WHISPERCPP_MODEL_DEFAULT)
TRANSCRIBE_ARGS ?=
PIPELINE_SECS ?= 10
PIPELINE_CAPTURE_WAV ?= artifacts/capture-transcribe.input.wav
PIPELINE_OUT_WAV ?= artifacts/capture-transcribe.wav
PIPELINE_OUT_JSONL ?= artifacts/capture-transcribe.jsonl
PIPELINE_OUT_MANIFEST ?= artifacts/capture-transcribe.manifest.json
PIPELINE_CHANNEL_MODE ?= separate
PIPELINE_ASR_MODEL ?=
PIPELINE_ARGS ?=
BENCH_CORPUS ?= bench/corpus/v1/corpus.tsv
BENCH_OUT ?= artifacts/bench
BENCH_BACKEND ?= noop-cat
BENCH_CMD ?= cat {input} > /dev/null
GATE_D_SECONDS ?= 3600
SMOKE_OFFLINE_SECS ?= 8
SMOKE_NEAR_LIVE_SECS ?= 8
SMOKE_OFFLINE_DIR ?= artifacts/smoke/offline
SMOKE_NEAR_LIVE_DIR ?= artifacts/smoke/near-live
SMOKE_NEAR_LIVE_DETERMINISTIC_DIR ?= artifacts/smoke/near-live-deterministic
SMOKE_NEAR_LIVE_INPUT_WAV ?= $(SMOKE_NEAR_LIVE_DIR)/capture.input.wav
SMOKE_NEAR_LIVE_DETERMINISTIC_INPUT_WAV ?= artifacts/bench/corpus/gate_c/tts_phrase_stereo.wav

.PHONY: help build build-release probe capture transcribe-live transcribe-live-stream capture-transcribe transcribe-preflight transcribe-model-doctor smoke smoke-offline smoke-near-live smoke-near-live-deterministic setup-whispercpp-model run-transcribe-app run-transcribe-live-stream-app run-transcribe-preflight-app run-transcribe-model-doctor-app bench-harness gate-backlog-pressure gate-transcript-completeness gate-v1-acceptance gate-packaged-live-smoke gate-d-soak bundle bundle-transcribe sign sign-transcribe verify run-app reset-perms clean

help:
	@echo "Targets:"
	@echo "  build         - Build debug binaries"
	@echo "  build-release - Build release capture binary"
	@echo "  probe         - Run API probe (debug)"
	@echo "  capture       - Run WAV recorder (debug)"
	@echo "  transcribe-live   - Validate transcribe-live CLI contract (debug)"
	@echo "  transcribe-live-stream - Run the true live-stream debug path with captured input + printed artifact paths"
	@echo "  capture-transcribe - One-command capture then transcription workflow (debug)"
	@echo "  transcribe-preflight - Run transcribe-live preflight diagnostics (debug)"
	@echo "  transcribe-model-doctor - Run transcribe-live model/backend diagnostics (debug)"
	@echo "  smoke         - CI-safe smoke bundle (offline + near-live deterministic fallback)"
	@echo "  smoke-offline - Smoke the offline journey on representative fixture input"
	@echo "  smoke-near-live - Smoke the host near-live journey via live capture (machine-dependent)"
	@echo "  smoke-near-live-deterministic - CI-safe near-live fallback smoke using deterministic stereo fixture"
	@echo "  setup-whispercpp-model - Bootstrap default local whispercpp model asset"
	@echo "  run-transcribe-app - Run signed transcribe-live app bundle (recommended packaged beta entrypoint)"
	@echo "  run-transcribe-live-stream-app - Run signed transcribe-live app bundle with explicit --live-stream selector"
	@echo "  run-transcribe-preflight-app - Run signed transcribe-live preflight diagnostics (packaged companion path)"
	@echo "  run-transcribe-model-doctor-app - Run signed transcribe-live model/backend diagnostics (packaged companion path)"
	@echo "  bench-harness - Run benchmark harness and emit machine-readable artifacts"
	@echo "  gate-backlog-pressure - Run deterministic near-live backlog pressure gate harness"
	@echo "  gate-transcript-completeness - Run reconciliation completeness gate harness under induced backlog"
	@echo "  gate-v1-acceptance - Run cold/warm first-emit + artifact/trust v1 acceptance gate harness"
	@echo "  gate-packaged-live-smoke - Run signed-app live-stream smoke gate with machine-readable summary"
	@echo "  gate-d-soak - Run deterministic near-live 60-minute soak gate harness and emit runs/summary artifacts"
	@echo "  bundle        - Create minimal .app bundle"
	@echo "  sign          - Codesign app bundle"
	@echo "  verify        - Verify signature and print entitlements"
	@echo "  run-app       - Run signed recorder app bundle (engineering support surface)"
	@echo "  reset-perms   - Reset TCC permissions for transcribe and capture bundle ids"
	@echo "  clean         - Remove build artifacts"

build:
	cargo build --bins

build-release:
	cargo build --release --bin $(BIN_NAME) --bin $(TRANSCRIBE_BIN)

probe: build
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run -- $(CAPTURE_SECS)

capture: build
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(BIN_NAME) -- $(CAPTURE_SECS) $(OUT) $(SAMPLE_RATE) $(CAPTURE_MISMATCH_POLICY) $(CAPTURE_CALLBACK_MODE)

transcribe-live: build
	@echo "Transcribe-live absolute artifact paths:"
	@echo "  WAV:      $(abspath $(TRANSCRIBE_OUT_WAV))"
	@echo "  JSONL:    $(abspath $(TRANSCRIBE_OUT_JSONL))"
	@echo "  Manifest: $(abspath $(TRANSCRIBE_OUT_MANIFEST))"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(TRANSCRIBE_SECS) --out-wav "$(abspath $(TRANSCRIBE_OUT_WAV))" --out-jsonl "$(abspath $(TRANSCRIBE_OUT_JSONL))" --out-manifest "$(abspath $(TRANSCRIBE_OUT_MANIFEST))" --asr-model "$(ASR_MODEL)" $(TRANSCRIBE_ARGS)

transcribe-live-stream: build
	@echo "Transcribe-live-stream absolute artifact paths:"
	@echo "  Input WAV: $(abspath $(TRANSCRIBE_LIVE_STREAM_INPUT_WAV))"
	@echo "  WAV:       $(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_WAV))"
	@echo "  JSONL:     $(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_JSONL))"
	@echo "  Manifest:  $(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_MANIFEST))"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(TRANSCRIBE_LIVE_STREAM_SECS) --live-stream --input-wav "$(abspath $(TRANSCRIBE_LIVE_STREAM_INPUT_WAV))" --out-wav "$(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_WAV))" --out-jsonl "$(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_JSONL))" --out-manifest "$(abspath $(TRANSCRIBE_LIVE_STREAM_OUT_MANIFEST))" --asr-model "$(ASR_MODEL)" $(TRANSCRIBE_LIVE_STREAM_ARGS)

capture-transcribe: build
	@echo "Capture+Transcribe absolute artifact paths:"
	@echo "  Input WAV:  $(abspath $(PIPELINE_CAPTURE_WAV))"
	@echo "  WAV:        $(abspath $(PIPELINE_OUT_WAV))"
	@echo "  JSONL:      $(abspath $(PIPELINE_OUT_JSONL))"
	@echo "  Manifest:   $(abspath $(PIPELINE_OUT_MANIFEST))"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(BIN_NAME) -- $(PIPELINE_SECS) "$(abspath $(PIPELINE_CAPTURE_WAV))" $(SAMPLE_RATE) $(CAPTURE_MISMATCH_POLICY) $(CAPTURE_CALLBACK_MODE)
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(PIPELINE_SECS) --input-wav "$(abspath $(PIPELINE_CAPTURE_WAV))" --out-wav "$(abspath $(PIPELINE_OUT_WAV))" --out-jsonl "$(abspath $(PIPELINE_OUT_JSONL))" --out-manifest "$(abspath $(PIPELINE_OUT_MANIFEST))" --asr-backend whispercpp --transcribe-channels "$(PIPELINE_CHANNEL_MODE)" $(if $(strip $(PIPELINE_ASR_MODEL)),--asr-model "$(PIPELINE_ASR_MODEL)",) $(PIPELINE_ARGS)

transcribe-preflight: TRANSCRIBE_ARGS += --preflight
transcribe-preflight: transcribe-live

transcribe-model-doctor: TRANSCRIBE_ARGS += --model-doctor
transcribe-model-doctor: transcribe-live

smoke: smoke-offline smoke-near-live-deterministic

smoke-offline: build
	@mkdir -p "$(abspath $(SMOKE_OFFLINE_DIR))"
	@echo "Smoke offline artifact paths:"
	@echo "  WAV:      $(abspath $(SMOKE_OFFLINE_DIR)/session.wav)"
	@echo "  JSONL:    $(abspath $(SMOKE_OFFLINE_DIR)/session.jsonl)"
	@echo "  Manifest: $(abspath $(SMOKE_OFFLINE_DIR)/session.manifest.json)"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_OFFLINE_SECS) --out-wav "$(abspath $(SMOKE_OFFLINE_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_OFFLINE_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_OFFLINE_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --model-doctor
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_OFFLINE_SECS) --input-wav "$(abspath artifacts/bench/corpus/gate_a/tts_phrase.wav)" --out-wav "$(abspath $(SMOKE_OFFLINE_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_OFFLINE_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_OFFLINE_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --benchmark-runs 1 --transcribe-channels mixed-fallback

smoke-near-live: build
	@mkdir -p "$(abspath $(SMOKE_NEAR_LIVE_DIR))"
	@echo "Smoke near-live (host capture required) artifact paths:"
	@echo "  Input WAV: $(abspath $(SMOKE_NEAR_LIVE_INPUT_WAV))"
	@echo "  WAV:       $(abspath $(SMOKE_NEAR_LIVE_DIR)/session.wav)"
	@echo "  JSONL:     $(abspath $(SMOKE_NEAR_LIVE_DIR)/session.jsonl)"
	@echo "  Manifest:  $(abspath $(SMOKE_NEAR_LIVE_DIR)/session.manifest.json)"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_NEAR_LIVE_SECS) --out-wav "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --model-doctor
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_NEAR_LIVE_SECS) --live-chunked --input-wav "$(abspath $(SMOKE_NEAR_LIVE_INPUT_WAV))" --out-wav "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_NEAR_LIVE_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --benchmark-runs 1 --transcribe-channels mixed-fallback

smoke-near-live-deterministic: build
	@mkdir -p "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR))"
	@echo "Smoke near-live deterministic fallback artifact paths:"
	@echo "  Input WAV: $(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_INPUT_WAV))"
	@echo "  WAV:       $(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.wav)"
	@echo "  JSONL:     $(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.jsonl)"
	@echo "  Manifest:  $(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.manifest.json)"
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_NEAR_LIVE_SECS) --out-wav "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --model-doctor
	DYLD_LIBRARY_PATH=/usr/lib/swift cargo run --bin $(TRANSCRIBE_BIN) -- --duration-sec $(SMOKE_NEAR_LIVE_SECS) --input-wav "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_INPUT_WAV))" --out-wav "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.wav)" --out-jsonl "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.jsonl)" --out-manifest "$(abspath $(SMOKE_NEAR_LIVE_DETERMINISTIC_DIR)/session.manifest.json)" --asr-model "$(ASR_MODEL)" --benchmark-runs 1 --transcribe-channels mixed-fallback

setup-whispercpp-model:
	scripts/setup_whispercpp_model.sh --dest "$(abspath $(WHISPERCPP_MODEL_DEFAULT))"

bench-harness: build
	cargo run --bin benchmark_harness -- --corpus "$(BENCH_CORPUS)" --out-dir "$(BENCH_OUT)" --backend-id "$(BENCH_BACKEND)" --cmd "$(BENCH_CMD)"

gate-backlog-pressure:
	MODEL="$(abspath $(ASR_MODEL))" scripts/gate_backlog_pressure.sh

gate-transcript-completeness:
	MODEL="$(abspath $(ASR_MODEL))" scripts/gate_transcript_completeness.sh

gate-v1-acceptance:
	MODEL="$(abspath $(ASR_MODEL))" scripts/gate_v1_acceptance.sh

gate-packaged-live-smoke: PATH := $(abspath $(TRANSCRIBE_APP_HELPER_BIN_DIR)):$(PATH)
gate-packaged-live-smoke:
	MODEL="$(abspath $(ASR_MODEL))" PACKAGED_ROOT="$(TRANSCRIBE_APP_ARTIFACT_ROOT)" SIGN_IDENTITY="$(SIGN_IDENTITY)" scripts/gate_packaged_live_smoke.sh

gate-d-soak:
	SOAK_SECONDS=$(GATE_D_SECONDS) scripts/gate_d_soak.sh

bundle: build-release
	rm -rf $(APP_DIR)
	mkdir -p $(APP_DIR)/Contents/MacOS
	cp target/release/$(BIN_NAME) $(APP_EXE)
	chmod +x $(APP_EXE)
	cp $(INFO_PLIST) $(APP_DIR)/Contents/Info.plist
	install_name_tool -add_rpath /usr/lib/swift $(APP_EXE) || true

bundle-transcribe: build-release
	rm -rf $(TRANSCRIBE_APP_DIR)
	mkdir -p $(TRANSCRIBE_APP_DIR)/Contents/MacOS
	cp target/release/$(TRANSCRIBE_BIN) $(TRANSCRIBE_APP_EXE)
	chmod +x $(TRANSCRIBE_APP_EXE)
	cp $(INFO_PLIST) $(TRANSCRIBE_APP_DIR)/Contents/Info.plist
	/usr/libexec/PlistBuddy -c "Set :CFBundleName $(TRANSCRIBE_APP_NAME)" $(TRANSCRIBE_APP_DIR)/Contents/Info.plist
	/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $(TRANSCRIBE_APP_NAME)" $(TRANSCRIBE_APP_DIR)/Contents/Info.plist
	/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.recordit.sequoiatranscribe" $(TRANSCRIBE_APP_DIR)/Contents/Info.plist
	/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $(TRANSCRIBE_APP_NAME)" $(TRANSCRIBE_APP_DIR)/Contents/Info.plist
	install_name_tool -add_rpath /usr/lib/swift $(TRANSCRIBE_APP_EXE) || true
	@mkdir -p "$(TRANSCRIBE_APP_HELPER_BIN_DIR)" "$(TRANSCRIBE_APP_HELPER_LIB_DIR)"
	@if [ -x "$(WHISPERCPP_HELPER_BIN)" ]; then \
		cp "$(WHISPERCPP_HELPER_BIN)" "$(TRANSCRIBE_APP_HELPER_BIN_DIR)/whisper-cli"; \
		chmod +x "$(TRANSCRIBE_APP_HELPER_BIN_DIR)/whisper-cli"; \
		helper_real_bin="$$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).expanduser().resolve(strict=False))' "$(WHISPERCPP_HELPER_BIN)")"; \
		helper_lib_dir="$$(python3 -c 'from pathlib import Path; import sys; print((Path(sys.argv[1]).parent / ".." / "lib").resolve(strict=False))' "$$helper_real_bin")"; \
		for pattern in $(WHISPERCPP_HELPER_LIB_GLOBS); do \
			for lib_path in "$$helper_lib_dir"/$$pattern; do \
				[ -f "$$lib_path" ] || continue; \
				cp "$$lib_path" "$(TRANSCRIBE_APP_HELPER_LIB_DIR)/$$(basename "$$lib_path")"; \
			done; \
		done; \
	else \
		echo "warning: whispercpp helper binary not found at $(WHISPERCPP_HELPER_BIN); signed-app live runtime may fail helper prewarm"; \
	fi

sign: bundle
	codesign --force --deep --options runtime --entitlements $(ENTITLEMENTS) --sign "$(SIGN_IDENTITY)" $(APP_DIR)

sign-transcribe: bundle-transcribe
	codesign --force --deep --options runtime --entitlements $(ENTITLEMENTS) --sign "$(SIGN_IDENTITY)" $(TRANSCRIBE_APP_DIR)

verify:
	codesign --verify --deep --strict --verbose=2 $(APP_DIR)
	codesign -d --entitlements :- --verbose=2 $(APP_DIR)

run-app:
	open -W $(APP_DIR) --args $(CAPTURE_SECS) $(OUT) $(SAMPLE_RATE)

run-transcribe-app: sign-transcribe
	@mkdir -p "$(dir $(TRANSCRIBE_APP_OUT_WAV))"
	@echo "Signed app transcribe-live absolute artifact paths:"
	@echo "  Root:     $(TRANSCRIBE_APP_ARTIFACT_ROOT)"
	@echo "  Helper bin search prefix: $(abspath $(TRANSCRIBE_APP_HELPER_BIN_DIR))"
	@if [ "$(TRANSCRIBE_APP_SHOW_LIVE_INPUT)" = "1" ]; then \
		echo "  Input WAV: $(TRANSCRIBE_APP_LIVE_STREAM_INPUT_WAV)"; \
	fi
	@echo "  WAV:      $(TRANSCRIBE_APP_OUT_WAV)"
	@echo "  JSONL:    $(TRANSCRIBE_APP_OUT_JSONL)"
	@echo "  Manifest: $(TRANSCRIBE_APP_OUT_MANIFEST)"
	PATH="$(abspath $(TRANSCRIBE_APP_HELPER_BIN_DIR)):$$PATH" open -W $(TRANSCRIBE_APP_DIR) --args --duration-sec $(TRANSCRIBE_SECS) --out-wav "$(TRANSCRIBE_APP_OUT_WAV)" --out-jsonl "$(TRANSCRIBE_APP_OUT_JSONL)" --out-manifest "$(TRANSCRIBE_APP_OUT_MANIFEST)" --asr-model "$(ASR_MODEL)" $(TRANSCRIBE_ARGS)
	@echo "Signed app session summary:"
	@echo "  Artifacts root: $(TRANSCRIBE_APP_ARTIFACT_ROOT)"
	@echo "  Manifest:       $(TRANSCRIBE_APP_OUT_MANIFEST)"
	@if [ -f "$(TRANSCRIBE_APP_OUT_MANIFEST)" ]; then \
		echo "  Manifest present: true"; \
		if command -v jq >/dev/null 2>&1; then \
			echo "  Trust degraded mode: $$(jq -r '.trust.degraded_mode_active // false' \"$(TRANSCRIBE_APP_OUT_MANIFEST)\")"; \
			echo "  Trust notice count:  $$(jq -r '.trust.notice_count // 0' \"$(TRANSCRIBE_APP_OUT_MANIFEST)\")"; \
			echo "  Degradation events:  $$(jq -r '(.degradation_events // []) | length' \"$(TRANSCRIBE_APP_OUT_MANIFEST)\")"; \
		else \
			echo "  Install jq to print trust/degradation summary fields automatically."; \
		fi; \
	else \
		echo "  Manifest present: false"; \
	fi

run-transcribe-live-stream-app: TRANSCRIBE_ARGS += --live-stream --input-wav "$(TRANSCRIBE_APP_LIVE_STREAM_INPUT_WAV)" $(TRANSCRIBE_APP_LIVE_STREAM_ARGS)
run-transcribe-live-stream-app: TRANSCRIBE_APP_SHOW_LIVE_INPUT := 1
run-transcribe-live-stream-app: run-transcribe-app

run-transcribe-preflight-app: TRANSCRIBE_ARGS += --preflight
run-transcribe-preflight-app: run-transcribe-app

run-transcribe-model-doctor-app: TRANSCRIBE_ARGS += --model-doctor
run-transcribe-model-doctor-app: run-transcribe-app

reset-perms:
	tccutil reset ScreenCapture com.recordit.sequoiatranscribe || true
	tccutil reset Microphone com.recordit.sequoiatranscribe || true
	tccutil reset ScreenCapture com.recordit.sequoiacapture || true
	tccutil reset Microphone com.recordit.sequoiacapture || true

clean:
	rm -rf dist artifacts
	cargo clean
