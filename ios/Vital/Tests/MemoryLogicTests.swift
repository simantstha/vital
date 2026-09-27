import XCTest
@testable import Vital

final class MemoryLogicTests: XCTestCase {

    // MARK: - group(forType:) — the client-side fallback (memory-contract.md §1)

    func testGroupForTypeMapsHealthTypes() {
        for type in ["Condition", "Medication", "Allergy", "Intolerance", "Injury", "LabMarker", "FamilyHistory"] {
            XCTAssertEqual(MemoryLogic.group(forType: type), .health, "\(type) should map to .health")
        }
    }

    func testGroupForTypeMapsGoal() {
        XCTAssertEqual(MemoryLogic.group(forType: "Goal"), .goals)
    }

    func testGroupForTypeMapsRoutineLikeTypes() {
        for type in ["Habit", "Schedule", "Routine"] {
            XCTAssertEqual(MemoryLogic.group(forType: type), .routines, "\(type) should map to .routines")
        }
    }

    func testGroupForTypeMapsFoodTypes() {
        for type in ["FoodPreference", "Cuisine", "PantryItem"] {
            XCTAssertEqual(MemoryLogic.group(forType: type), .food, "\(type) should map to .food")
        }
    }

    func testGroupForTypeMapsUnknownToOther() {
        XCTAssertEqual(MemoryLogic.group(forType: "SomeFutureType"), .other)
    }

    // MARK: - group(for:) — server value wins, fallback only when missing/unrecognized

    func testGroupForFactUsesServerGroupWhenPresent() {
        let fact = MemoryFact(id: "1", type: "Allergy", label: "Peanut", isConstraint: true, group: "food")
        XCTAssertEqual(MemoryLogic.group(for: fact), .food, "an explicit server group should win over the type-based fallback")
    }

    func testGroupForFactFallsBackToTypeWhenGroupMissing() {
        let fact = MemoryFact(id: "1", type: "Allergy", label: "Peanut", isConstraint: true)
        XCTAssertEqual(MemoryLogic.group(for: fact), .health)
    }

    func testGroupForFactFallsBackToTypeWhenGroupUnrecognized() {
        let fact = MemoryFact(id: "1", type: "Goal", label: "Run a 10k", isConstraint: false, group: "not-a-real-group")
        XCTAssertEqual(MemoryLogic.group(for: fact), .goals)
    }

    // MARK: - groupedSections — order, titles, empty-group omission

    func testGroupedSectionsOrdersHealthGoalsRoutinesFoodOther() {
        let facts = [
            MemoryFact(id: "1", type: "PantryItem", label: "Oat milk", isConstraint: false),
            MemoryFact(id: "2", type: "Goal", label: "Lose 5kg", isConstraint: false),
            MemoryFact(id: "3", type: "Allergy", label: "Peanuts", isConstraint: true),
        ]
        let sections = MemoryLogic.groupedSections(facts: facts)
        XCTAssertEqual(sections.map(\.group), [.health, .goals, .food])
        XCTAssertEqual(sections.map(\.group.title), ["Health", "Goals", "Food"])
    }

    func testGroupedSectionsOmitsEmptyGroups() {
        let facts = [MemoryFact(id: "1", type: "Goal", label: "Lose 5kg", isConstraint: false)]
        let sections = MemoryLogic.groupedSections(facts: facts)
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].group, .goals)
    }

    func testGroupedSectionsHandlesEmptyInput() {
        XCTAssertTrue(MemoryLogic.groupedSections(facts: []).isEmpty)
    }

    func testGroupedSectionsPreservesOriginalOrderWithinAGroup() {
        let facts = [
            MemoryFact(id: "1", type: "Allergy", label: "Peanut allergy", isConstraint: true),
            MemoryFact(id: "2", type: "Injury", label: "Knee pain", isConstraint: false),
            MemoryFact(id: "3", type: "Intolerance", label: "Lactose intolerant", isConstraint: true),
        ]
        let sections = MemoryLogic.groupedSections(facts: facts)
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].facts.map(\.label), ["Peanut allergy", "Knee pain", "Lactose intolerant"])
    }

    // MARK: - Routines & preferences title (exact copy from memory-contract.md §4)

    func testRoutinesGroupTitleMatchesContractCopy() {
        XCTAssertEqual(MemoryLogic.Group.routines.title, "Routines & preferences")
    }

    // MARK: - originPhrase

    func testOriginPhraseMapsEveryKnownOrigin() {
        XCTAssertEqual(MemoryLogic.originPhrase("told"), "You told me")
        XCTAssertEqual(MemoryLogic.originPhrase("noticed"), "Noticed from your data")
        XCTAssertEqual(MemoryLogic.originPhrase("confirmed"), "You confirmed")
        XCTAssertEqual(MemoryLogic.originPhrase("onboarding"), "Set in onboarding")
    }

    func testOriginPhraseFallsBackToToldForNilOrUnknown() {
        XCTAssertEqual(MemoryLogic.originPhrase(nil), "You told me")
        XCTAssertEqual(MemoryLogic.originPhrase("some-future-origin"), "You told me")
    }

    // MARK: - sourceLine

    func testSourceLineCombinesPhraseAndFormattedDate() {
        let now = DateComponents(calendar: .init(identifier: .gregorian), year: 2026, month: 9, day: 27).date!
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("dMMM")
        let expected = formatter.string(from: DateComponents(calendar: .init(identifier: .gregorian), year: 2026, month: 9, day: 12).date!)
        XCTAssertEqual(
            MemoryLogic.sourceLine(origin: "confirmed", recordedAt: "2026-09-12", now: now),
            "You confirmed · \(expected)"
        )
    }

    func testSourceLineOmitsDateWhenRecordedAtIsMissing() {
        XCTAssertEqual(MemoryLogic.sourceLine(origin: "told", recordedAt: nil), "You told me")
    }

    func testSourceLineOmitsDateWhenRecordedAtIsEmpty() {
        XCTAssertEqual(MemoryLogic.sourceLine(origin: "noticed", recordedAt: ""), "Noticed from your data")
    }

    // MARK: - pendingReasonText

    func testPendingReasonTextUsesReasonWhenPresent() {
        XCTAssertEqual(
            MemoryLogic.pendingReasonText("Noticed from your workouts over the last 3 weeks"),
            "Noticed from your workouts over the last 3 weeks"
        )
    }

    func testPendingReasonTextFallsBackWhenNilOrBlank() {
        XCTAssertEqual(MemoryLogic.pendingReasonText(nil), "Noticed from your data")
        XCTAssertEqual(MemoryLogic.pendingReasonText("   "), "Noticed from your data")
    }

    // MARK: - headerSubline

    func testHeaderSublineUsesSingularForOne() {
        XCTAssertEqual(MemoryLogic.headerSubline(factCount: 1), "What I know about you — 1 thing, only visible to you.")
    }

    func testHeaderSublineUsesPluralForZeroAndMany() {
        XCTAssertEqual(MemoryLogic.headerSubline(factCount: 0), "What I know about you — 0 things, only visible to you.")
        XCTAssertEqual(MemoryLogic.headerSubline(factCount: 14), "What I know about you — 14 things, only visible to you.")
    }

    // MARK: - Search matching — case- and diacritic-insensitive

    func testMatchesIsCaseInsensitive() {
        XCTAssertTrue(MemoryLogic.matches("Peanut allergy", query: "PEANUT"))
    }

    func testMatchesIsDiacriticInsensitive() {
        XCTAssertTrue(MemoryLogic.matches("café before 10am", query: "cafe"))
        XCTAssertTrue(MemoryLogic.matches("Jose", query: "josé"))
    }

    func testMatchesEmptyQueryMatchesEverything() {
        XCTAssertTrue(MemoryLogic.matches("Peanut allergy", query: ""))
        XCTAssertTrue(MemoryLogic.matches("Peanut allergy", query: "   "))
    }

    func testMatchesFailsForUnrelatedQuery() {
        XCTAssertFalse(MemoryLogic.matches("Peanut allergy", query: "marathon"))
    }

    func testFilterFactsKeepsOnlyMatchingLabels() {
        let facts = [
            MemoryFact(id: "1", type: "Allergy", label: "Peanut allergy", isConstraint: true),
            MemoryFact(id: "2", type: "Goal", label: "Break 4 hours in the marathon", isConstraint: false),
        ]
        XCTAssertEqual(MemoryLogic.filterFacts(facts, query: "marathon").map(\.id), ["2"])
    }

    func testFilterEntitiesKeepsOnlyMatchingLabels() {
        let entities = [
            MemoryEntitySummary(id: "e1", label: "Dad", kind: "Father", factCount: 3),
            MemoryEntitySummary(id: "e2", label: "Maya", kind: "Partner", factCount: 2),
        ]
        XCTAssertEqual(MemoryLogic.filterEntities(entities, query: "may").map(\.id), ["e2"])
    }
}
