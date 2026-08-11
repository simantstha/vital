import XCTest
@testable import Vital

final class CoachWorkspacePresentationTests: XCTestCase {
    func testDisabledWorkspaceResponseDecodesAsUnavailable() throws {
        let data = Data(#"{"error":"Coach Workspace is disabled.","code":"COACH_WORKSPACE_DISABLED"}"#.utf8)

        let availability = try APIClient.decodeCoachWorkspaceAvailability(statusCode: 404, data: data)

        XCTAssertEqual(availability, .disabled)
    }

    func testUnrelatedNotFoundResponseRemainsAServerError() {
        let data = Data(#"{"error":"Not found"}"#.utf8)

        XCTAssertThrowsError(try APIClient.decodeCoachWorkspaceAvailability(statusCode: 404, data: data)) { error in
            XCTAssertEqual(error as? APIError, .serverError(404))
        }
    }

    func testUnauthorizedWorkspaceResponseExpiresTheSessionExactlyOnce() {
        var expirationCount = 0

        XCTAssertThrowsError(try APIClient.decodeCoachWorkspaceAvailability(
            statusCode: 401,
            data: Data(),
            onSessionExpired: { expirationCount += 1 }
        )) { error in
            XCTAssertEqual(error as? APIError, .serverError(401))
        }
        XCTAssertEqual(expirationCount, 1)
    }

    func testDisabledWorkspaceActionResponseDecodesAsTypedDisabledError() {
        let data = Data(#"{"error":"Coach Workspace is disabled.","code":"COACH_WORKSPACE_DISABLED"}"#.utf8)

        XCTAssertThrowsError(try APIClient.decodeCoachWorkspaceAction(
            statusCode: 404,
            data: data
        )) { error in
            XCTAssertEqual(error as? APIError, .coachWorkspaceDisabled)
        }
    }

    func testUnrelatedWorkspaceActionNotFoundRemainsAServerError() {
        let data = Data(#"{"error":"Not found"}"#.utf8)

        XCTAssertThrowsError(try APIClient.decodeCoachWorkspaceAction(
            statusCode: 404,
            data: data
        )) { error in
            XCTAssertEqual(error as? APIError, .serverError(404))
        }
    }

    func testMoveRecommendationOffersOnlyBoundedMoveAdjustments() {
        let recommendation = CoachWorkspaceRecommendation.fixture(kind: "move")

        XCTAssertEqual(
            CoachWorkspacePresentation.adjustmentOptions(for: recommendation),
            [.moveDuration(minutes: 20), .moveDuration(minutes: 30), .moveDuration(minutes: 45)]
        )
    }

    func testSleepRecommendationOffersOnlyEarlierWindDownOptions() {
        let recommendation = CoachWorkspaceRecommendation.fixture(kind: "sleep")

        XCTAssertEqual(
            CoachWorkspacePresentation.adjustmentOptions(for: recommendation),
            [.sleepTime(minutes: 1_230), .sleepTime(minutes: 1_260), .sleepTime(minutes: 1_290)]
        )
    }

    func testEvidenceSummaryDoesNotClaimFreshnessForStaleSignals() {
        let recommendation = CoachWorkspaceRecommendation.fixture(fresh: false)

        XCTAssertEqual(
            CoachWorkspacePresentation.evidenceSummary(for: recommendation),
            "Waiting for fresh signals"
        )
    }

    func testWorkspaceDTOAcceptsTheServerRecommendationContract() throws {
        let json = #"""
        {
          "recommendation": {
            "id": "recommendation-1",
            "localDay": "2026-08-11",
            "category": "training",
            "action": {
              "title": "Keep it easy",
              "copy": "A comfortable session supports recovery.",
              "kind": "move",
              "timeMinutes": 1020,
              "durationMinutes": 45,
              "intensity": "easy"
            },
            "evidence": {
              "fresh": true,
              "sources": [{ "metric": "hrv", "observedAt": "2026-08-11T12:00:00.000Z", "baseline": 56, "value": 61 }],
              "constraintGate": false
            },
            "materialSignature": "signature"
          },
          "state": { "status": "ready", "planItemId": null, "effectiveAction": null }
        }
        """#

        let workspace = try APIClient.decodeCoachWorkspace(Data(json.utf8))

        XCTAssertEqual(workspace.recommendation.action.durationMinutes, 45)
        XCTAssertEqual(workspace.recommendation.evidence.sources.first?.label, "HRV")
    }

    func testWorkspaceDTOHydratesAuthoritativePlanStateAndEffectiveAction() throws {
        let json = #"""
        {
          "recommendation": {
            "id": "recommendation-1", "localDay": "2026-08-11", "category": "training",
            "action": { "title": "Keep it easy", "copy": "Comfortable work.", "kind": "move", "timeMinutes": 1020, "durationMinutes": 45, "intensity": "easy" },
            "evidence": { "fresh": true, "sources": [], "constraintGate": false }, "materialSignature": "signature"
          },
          "state": {
            "status": "planned", "planItemId": "plan-1",
            "effectiveAction": { "title": "Keep it easy", "copy": "Comfortable work.", "kind": "move", "timeMinutes": 1080, "durationMinutes": 30, "intensity": "easy" }
          }
        }
        """#

        let workspace = try APIClient.decodeCoachWorkspace(Data(json.utf8))

        XCTAssertEqual(workspace.state.status, .planned)
        XCTAssertEqual(workspace.state.planItemId, "plan-1")
        XCTAssertEqual(workspace.effectiveAction.durationMinutes, 30)
    }

    func testCalibrationNeverOffersPlanControlsEvenWhenActionLooksRunnable() {
        let workspace = CoachWorkspaceSnapshot.fixture(status: .calibration)

        XCTAssertFalse(CoachWorkspacePresentation.allowsPlanControls(for: workspace))
        XCTAssertTrue(CoachWorkspacePresentation.isCalibrationGuidance(for: workspace))
    }

    func testEvidenceUsesMetricUnitsAndAnObservedTimestamp() {
        let hrv = CoachWorkspaceEvidenceSource(metric: "hrv", observedAt: "2026-08-11T12:00:00.000Z", baseline: 56, value: 61)
        let restingHr = CoachWorkspaceEvidenceSource(metric: "restingHr", observedAt: "2026-08-11T12:00:00.000Z", baseline: 50, value: 52)
        let sleep = CoachWorkspaceEvidenceSource(metric: "sleep", observedAt: "2026-08-11T12:00:00.000Z", baseline: 480, value: 462)

        XCTAssertEqual(hrv.measurementText, "61 ms · Baseline 56 ms")
        XCTAssertEqual(restingHr.measurementText, "52 bpm · Baseline 50 bpm")
        XCTAssertEqual(sleep.measurementText, "7h 42m · Baseline 8h 0m")
        XCTAssertTrue(sleep.observedText.hasPrefix("Observed "))
    }

    func testWorkspaceActionResponseDecodesTheServerInteraction() throws {
        let json = #"""
        { "interaction": { "id": "interaction-1", "recommendationId": "recommendation-1", "actionId": "ios-workspace:1:accept:default", "action": "accept", "planItemId": "plan-1", "createdAt": "2026-08-11T12:00:00.000Z" } }
        """#

        let interaction = try APIClient.decodeCoachWorkspaceAction(Data(json.utf8))

        XCTAssertEqual(interaction.action, .accept)
        XCTAssertEqual(interaction.planItemId, "plan-1")
    }
}

private extension CoachWorkspaceRecommendation {
    static func fixture(kind: String = "move", fresh: Bool = true) -> CoachWorkspaceRecommendation {
        CoachWorkspaceRecommendation(
            id: "recommendation-1",
            localDay: "2026-08-11",
            category: "training",
            action: CoachWorkspaceAction(
                title: "Keep it easy",
                copy: "A comfortable session supports recovery.",
                kind: kind,
                timeMinutes: 1_020,
                durationMinutes: 40,
                intensity: "easy"
            ),
            evidence: CoachWorkspaceEvidence(
                fresh: fresh,
                sources: [],
                constraintGate: false
            ),
            materialSignature: "signature"
        )
    }
}

private extension CoachWorkspaceSnapshot {
    static func fixture(status: CoachWorkspaceStatus) -> CoachWorkspaceSnapshot {
        CoachWorkspaceSnapshot(
            recommendation: CoachWorkspaceRecommendation.fixture(),
            state: CoachWorkspaceState(status: status, planItemId: nil, effectiveAction: nil)
        )
    }
}
