import XCTest
import SwiftUI
@testable import Vital

/// D4 (one coach voice, specialists invisible behind it — ux-spec-v4 §7,
/// roadmap 1.1): the accept/decline handoff card and "Stay with …"
/// confirmation UI these tests used to cover were removed from `CoachView`.
/// What's left to test at this layer is the specialist attribution
/// *footer* mapping (`CoachViewPresentation.specialistFooter`) and the
/// unchanged "specialist joined" system row.
@MainActor
final class CoachSpecialistViewTests: XCTestCase {
    private let runningCoach = CoachPersonaSnapshot(
        id: "running-coach",
        title: "Running Coach",
        subtitle: "Vital Specialist",
        accent: "#4CC9F0",
        icon: "figure.run",
        sessionId: "session-1"
    )

    private let nutritionist = CoachPersonaSnapshot(
        id: "nutritionist",
        title: "Nutritionist",
        subtitle: "Vital Specialist",
        accent: "#57CC99",
        icon: "fork.knife",
        sessionId: "session-2"
    )

    private let strengthCoach = CoachPersonaSnapshot(
        id: "strength-coach",
        title: "Strength Coach",
        subtitle: "Vital Specialist",
        accent: "#F4A261",
        icon: "dumbbell.fill",
        sessionId: "session-3"
    )

    func testFooterIsNilForVitalPersonaAndMetadata() {
        XCTAssertNil(CoachViewPresentation.specialistFooter(for: CoachPersonaSnapshot.vital))
        XCTAssertNil(CoachViewPresentation.specialistFooter(for: nil as SpecialistMessageMetadata?))
    }

    func testFooterMapsEachKnownSpecialistToItsOwnIconAndCopy() {
        let nutritionFooter = CoachViewPresentation.specialistFooter(for: nutritionist)
        XCTAssertEqual(nutritionFooter?.icon, "fork.knife")
        XCTAssertEqual(nutritionFooter?.text, "Checked with your nutritionist")

        let strengthFooter = CoachViewPresentation.specialistFooter(for: strengthCoach)
        XCTAssertEqual(strengthFooter?.icon, "dumbbell.fill")
        XCTAssertEqual(strengthFooter?.text, "Checked with your strength coach")

        let runningFooter = CoachViewPresentation.specialistFooter(for: runningCoach)
        XCTAssertEqual(runningFooter?.icon, "figure.run")
        XCTAssertEqual(runningFooter?.text, "Checked with your running coach")
    }

    func testFooterFallsBackToGenericCopyForAnUnrecognizedSpecialistId() {
        let unknown = CoachPersonaSnapshot(
            id: "sleep-coach",
            title: "Sleep Coach",
            subtitle: "Vital Specialist",
            accent: "#9B5DE5",
            icon: "moon.stars.fill",
            sessionId: "session-4"
        )
        let footer = CoachViewPresentation.specialistFooter(for: unknown)
        XCTAssertEqual(footer?.icon, "person.fill.checkmark")
        XCTAssertEqual(footer?.text, "Checked with a specialist")
    }

    func testHistoricalMessageMetadataMapsToTheSameFooterAsTheLivePersona() {
        let metadata = SpecialistMessageMetadata(
            specialistId: "nutritionist",
            manifestVersion: "1.0.0",
            name: "Nutritionist",
            role: "Vital Specialist",
            accentColor: "#57CC99",
            icon: "fork.knife"
        )
        let footer = CoachViewPresentation.specialistFooter(for: metadata)
        XCTAssertEqual(footer?.icon, "fork.knife")
        XCTAssertEqual(footer?.text, "Checked with your nutritionist")
    }

    func testJoinedSystemRowTextUsesSpecialistTitle() {
        XCTAssertEqual(
            CoachViewPresentation.joinedSystemRowText(for: runningCoach),
            "Running Coach joined."
        )
    }

    func testJoinedSystemRowStaysSingleLineUntilAccessibilityDynamicType() {
        XCTAssertEqual(
            CoachViewPresentation.joinedSystemRowLineLimit(for: .large),
            1
        )
        XCTAssertNil(
            CoachViewPresentation.joinedSystemRowLineLimit(for: .accessibility1)
        )
    }

    func testSpecialistColorsAdaptForLightAndDarkMode() {
        let lightTraits = UITraitCollection(userInterfaceStyle: .light)
        let darkTraits = UITraitCollection(userInterfaceStyle: .dark)
        let accent = UIColor(Theme.Colors.specialistAccent)
        let edgeGlow = UIColor(Theme.Colors.specialistEdgeGlow)

        XCTAssertNotEqual(
            accent.resolvedColor(with: lightTraits),
            accent.resolvedColor(with: darkTraits)
        )
        XCTAssertEqual(
            edgeGlow.resolvedColor(with: lightTraits),
            edgeGlow.resolvedColor(with: darkTraits)
        )
    }
}
