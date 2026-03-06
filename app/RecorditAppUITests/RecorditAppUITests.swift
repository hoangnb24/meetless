import XCTest

final class RecorditAppUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testFirstRunOnboardingHappyPathTransitionsToMainRuntime() {
        let app = launchApp()
        completeOnboardingHappyPath(app)
        XCTAssertTrue(app.buttons["start_live_transcribe"].waitForExistence(timeout: 5))
    }

    func testLiveRunStartStopShowsRuntimeStatusTranscriptAndSummary() {
        let app = launchApp()
        completeOnboardingHappyPath(app)

        let runtimeStatus = app.staticTexts["runtime_status"]
        XCTAssertTrue(runtimeStatus.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Idle", timeout: 5))

        let startButton = app.buttons["start_live_transcribe"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        activate(startButton)

        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Running", timeout: 8))

        let stopButton = app.buttons["stop_live_transcribe"]
        XCTAssertTrue(stopButton.waitForExistence(timeout: 5))
        activate(stopButton)

        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Completed", timeout: 10))
        XCTAssertTrue(app.staticTexts["Session Summary"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Open Session Detail"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Start New Session"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Dismiss"].waitForExistence(timeout: 5))
    }

    func testRuntimeStopFailureShowsRecoveryAffordances() {
        let app = launchApp(runtimeScenario: "stop_failure")
        completeOnboardingHappyPath(app)

        let runtimeStatus = app.staticTexts["runtime_status"]
        XCTAssertTrue(runtimeStatus.waitForExistence(timeout: 5))

        let startButton = app.buttons["start_live_transcribe"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        activate(startButton)
        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Running", timeout: 8))

        let stopButton = app.buttons["stop_live_transcribe"]
        XCTAssertTrue(stopButton.waitForExistence(timeout: 5))
        activate(stopButton)

        XCTAssertTrue(app.staticTexts["Runtime Recovery"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["retry_stop_action"].waitForExistence(timeout: 10))
        XCTAssertTrue(
            waitForAnyElement(
                [
                    app.buttons["start_new_session_action"],
                    app.buttons["resume_interrupted_session"],
                    app.buttons["safe_finalize_session"],
                    app.buttons["open_session_artifacts"],
                ],
                timeout: 10
            )
        )
    }

    func testRuntimeRetryStopRecoversToCompletedSummary() {
        let app = launchApp(runtimeScenario: "stop_failure_then_recover")
        completeOnboardingHappyPath(app)

        let runtimeStatus = app.staticTexts["runtime_status"]
        XCTAssertTrue(runtimeStatus.waitForExistence(timeout: 5))

        let startButton = app.buttons["start_live_transcribe"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        activate(startButton)
        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Running", timeout: 8))

        let stopButton = app.buttons["stop_live_transcribe"]
        XCTAssertTrue(stopButton.waitForExistence(timeout: 5))
        activate(stopButton)

        let retryStopButton = app.buttons["retry_stop_action"]
        XCTAssertTrue(retryStopButton.waitForExistence(timeout: 15))
        activate(retryStopButton)

        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Completed", timeout: 15))
        XCTAssertTrue(app.staticTexts["Session Summary"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Open Session Detail"].waitForExistence(timeout: 5))
    }

    private func completeOnboardingHappyPath(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))

        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        XCTAssertFalse(nextButton.isEnabled)
        activate(runPermissionChecksButton)
        XCTAssertTrue(waitForEnabled(nextButton, timeout: 8))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Model Setup")

        let validateModelSetupButton = app.buttons["onboarding_validate_model_setup"]
        XCTAssertTrue(validateModelSetupButton.waitForExistence(timeout: 5))
        activate(validateModelSetupButton)

        let runPreflightButton = app.buttons["onboarding_run_preflight"]
        XCTAssertTrue(runPreflightButton.waitForExistence(timeout: 5))
        activate(runPreflightButton)
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Ready")

        let completeOnboardingButton = app.buttons["onboarding_complete"]
        XCTAssertTrue(completeOnboardingButton.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForEnabled(completeOnboardingButton, timeout: 5))
        activate(completeOnboardingButton)
    }

    func testPermissionDenialRemediationRecoversToOnboardingProgression() {
        let app = launchApp(preflightScenario: "permission_recovery")

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)

        let openScreenSettingsButton = app.buttons["onboarding_open_screen_settings"]
        let openMicrophoneSettingsButton = app.buttons["onboarding_open_microphone_settings"]
        XCTAssertTrue(openScreenSettingsButton.waitForExistence(timeout: 5))
        XCTAssertTrue(openMicrophoneSettingsButton.waitForExistence(timeout: 5))
        XCTAssertFalse(nextButton.isEnabled)

        activate(openScreenSettingsButton)
        XCTAssertTrue(app.staticTexts["onboarding_screen_restart_advisory"].waitForExistence(timeout: 5))
        activate(app.buttons["onboarding_dismiss_restart_advisory"])

        activate(app.buttons["onboarding_recheck_permissions"])

        XCTAssertTrue(waitForNotExists(openScreenSettingsButton, timeout: 8))
        XCTAssertTrue(waitForNotExists(openMicrophoneSettingsButton, timeout: 8))
        XCTAssertTrue(waitForEnabled(nextButton, timeout: 8))

        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Model Setup")
        XCTAssertTrue(app.buttons["onboarding_validate_model_setup"].waitForExistence(timeout: 5))
    }

    func testPermissionCheckFailureStillShowsDeepLinksAndMissingRows() {
        let app = launchApp(preflightScenario: "permission_check_failure")

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)

        XCTAssertTrue(app.staticTexts["permission_row_screen_missing"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_microphone_missing"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["onboarding_open_screen_settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["onboarding_open_microphone_settings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboarding_open_main_runtime"].exists)
        XCTAssertFalse(nextButton.isEnabled)
    }

    func testModelPathBlockKeepsLiveOnboardingBlockedButRecordOnlyStillWorks() {
        let app = launchApp(
            preflightScenario: "model_path_blocked",
            defaultRuntimeMode: "record_only"
        )

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))

        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)
        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)
        XCTAssertTrue(waitForEnabled(nextButton, timeout: 8))

        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Model Setup")
        let validateModelSetupButton = app.buttons["onboarding_validate_model_setup"]
        XCTAssertTrue(validateModelSetupButton.waitForExistence(timeout: 5))
        activate(validateModelSetupButton)

        let runPreflightButton = app.buttons["onboarding_run_preflight"]
        XCTAssertTrue(runPreflightButton.waitForExistence(timeout: 5))
        activate(runPreflightButton)

        XCTAssertTrue(app.staticTexts["preflight_row_model_path_fail"].waitForExistence(timeout: 5))
        XCTAssertFalse(nextButton.isEnabled)
        let openMainRuntimeButton = app.buttons["onboarding_open_main_runtime"]
        XCTAssertTrue(openMainRuntimeButton.waitForExistence(timeout: 5))
        activate(openMainRuntimeButton)

        let runtimeStatus = app.staticTexts["runtime_status"]
        XCTAssertTrue(runtimeStatus.waitForExistence(timeout: 5))

        let startButton = app.buttons["start_live_transcribe"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        activate(startButton)
        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Running", timeout: 8))

        let stopButton = app.buttons["stop_live_transcribe"]
        XCTAssertTrue(stopButton.waitForExistence(timeout: 5))
        activate(stopButton)
        XCTAssertTrue(waitForLabelContains(runtimeStatus, text: "Completed", timeout: 10))
        XCTAssertTrue(app.staticTexts["Session Summary"].waitForExistence(timeout: 5))
    }

    func testScreenRuntimeFailureShowsDedicatedBlockerWithoutPermissionDeepLinks() {
        let app = launchApp(
            preflightScenario: "screen_runtime_failure",
            nativeScreenPermissionGranted: true,
            nativeMicrophonePermissionGranted: true
        )

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)

        XCTAssertTrue(app.staticTexts["permission_row_screen_runtime_failure"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_display_granted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_microphone_granted"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboarding_open_screen_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_microphone_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_main_runtime"].exists)
        XCTAssertFalse(nextButton.isEnabled)
    }

    func testMicrophoneRuntimeFailureShowsDedicatedBlockerWithoutPermissionDeepLinks() {
        let app = launchApp(
            preflightScenario: "microphone_runtime_failure",
            nativeScreenPermissionGranted: true,
            nativeMicrophonePermissionGranted: true
        )

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)

        XCTAssertTrue(app.staticTexts["permission_row_screen_granted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_display_granted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_microphone_runtime_failure"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboarding_open_screen_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_microphone_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_main_runtime"].exists)
        XCTAssertFalse(nextButton.isEnabled)
    }

    func testActiveDisplayFailureShowsDedicatedBlockerWithoutPermissionDeepLinks() {
        let app = launchApp(
            preflightScenario: "active_display_unavailable",
            nativeScreenPermissionGranted: true,
            nativeMicrophonePermissionGranted: true
        )

        XCTAssertTrue(app.staticTexts["onboarding_title"].waitForExistence(timeout: 5))
        let nextButton = app.buttons["onboarding_next"]
        XCTAssertTrue(nextButton.waitForExistence(timeout: 5))
        advanceOnboardingStep(app, nextButton: nextButton, expectedStepTitle: "Permissions")
        ensurePermissionsStep(app)

        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 5))
        activate(runPermissionChecksButton)

        XCTAssertTrue(app.staticTexts["permission_row_screen_granted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_display_no_active_display"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["permission_row_microphone_granted"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboarding_open_screen_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_microphone_settings"].exists)
        XCTAssertFalse(app.buttons["onboarding_open_main_runtime"].exists)
        XCTAssertFalse(nextButton.isEnabled)
    }

    private func launchApp(
        preflightScenario: String? = nil,
        runtimeScenario: String? = nil,
        nativeScreenPermissionGranted: Bool? = nil,
        nativeMicrophonePermissionGranted: Bool? = nil,
        defaultRuntimeMode: String? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["--ui-test-mode"]
        app.launchEnvironment["RECORDIT_UI_TEST_MODE"] = "1"
        app.launchEnvironment["RECORDIT_FORCE_FIRST_RUN"] = "1"
        app.launchEnvironment["RECORDIT_RUNTIME_BINARY"] = "/usr/bin/true"
        app.launchEnvironment["SEQUOIA_CAPTURE_BINARY"] = "/usr/bin/true"
        if let preflightScenario {
            app.launchEnvironment["RECORDIT_UI_TEST_PREFLIGHT_SCENARIO"] = preflightScenario
        }
        if let runtimeScenario {
            app.launchEnvironment["RECORDIT_UI_TEST_RUNTIME_SCENARIO"] = runtimeScenario
        }
        if let nativeScreenPermissionGranted {
            app.launchEnvironment["RECORDIT_UI_TEST_NATIVE_SCREEN_PERMISSION"] = nativeScreenPermissionGranted ? "granted" : "denied"
        }
        if let nativeMicrophonePermissionGranted {
            app.launchEnvironment["RECORDIT_UI_TEST_NATIVE_MICROPHONE_PERMISSION"] = nativeMicrophonePermissionGranted ? "granted" : "denied"
        }
        if let defaultRuntimeMode {
            app.launchEnvironment["RECORDIT_UI_TEST_DEFAULT_RUNTIME_MODE"] = defaultRuntimeMode
        }
        app.launch()
        app.activate()
        return app
    }

    private func advanceOnboardingStep(
        _ app: XCUIApplication,
        nextButton: XCUIElement,
        expectedStepTitle: String
    ) {
        let stepLabel = app.staticTexts["onboarding_step_label"]
        XCTAssertTrue(stepLabel.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForEnabled(nextButton, timeout: 5))
        activate(nextButton)
        if !waitForLabelContains(stepLabel, text: expectedStepTitle, timeout: 2) {
            // macOS UI tests can treat the first click as window focus; retry once.
            activate(nextButton)
            if !waitForLabelContains(stepLabel, text: expectedStepTitle, timeout: 5) {
                XCTFail(
                    """
                    Failed to advance onboarding step to '\(expectedStepTitle)'.
                    Current step label/value: '\(textValue(for: stepLabel))'.
                    App hierarchy:
                    \(app.debugDescription)
                    """
                )
            }
        }
    }

    private func activate(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        #if os(macOS)
            element.click()
        #else
            element.tap()
        #endif
    }

    private func ensurePermissionsStep(_ app: XCUIApplication) {
        let runPermissionChecksButton = app.buttons["onboarding_run_permission_checks"]
        if runPermissionChecksButton.waitForExistence(timeout: 2) {
            return
        }

        let modelSetupButton = app.buttons["onboarding_validate_model_setup"]
        let backButton = app.buttons["onboarding_back"]
        if modelSetupButton.exists, backButton.exists {
            activate(backButton)
        }
        XCTAssertTrue(runPermissionChecksButton.waitForExistence(timeout: 8))
    }

    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "isEnabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForLabelContains(_ element: XCUIElement, text: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(
            format: "(label CONTAINS[c] %@) OR (value CONTAINS[c] %@)",
            text,
            text
        )
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func textValue(for element: XCUIElement) -> String {
        if let label = element.label as String?, !label.isEmpty {
            return label
        }
        if let value = element.value as? String, !value.isEmpty {
            return value
        }
        return ""
    }

    private func waitForNotExists(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForAnyElement(_ elements: [XCUIElement], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if elements.contains(where: \.exists) {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return elements.contains(where: \.exists)
    }
}
