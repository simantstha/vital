import XCTest
@testable import Vital

final class CoachWorkspacePresentationTests: XCTestCase {
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
          }
        }
        """#

        let recommendation = try APIClient.decodeCoachWorkspace(Data(json.utf8))

        XCTAssertEqual(recommendation.action.durationMinutes, 45)
        XCTAssertEqual(recommendation.evidence.sources.first?.label, "HRV")
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
