import XCTest
@testable import Vital

@MainActor
final class MemoryViewModelTests: XCTestCase {

    // MARK: - Decoding (the real risk: camelCase + date-as-String)

    /// Feeds `APIClient`'s exact bare `JSONDecoder()` — no
    /// `keyDecodingStrategy`, no `dateDecodingStrategy` — the same
    /// configuration the real client uses, so a mismatched key or a `Date`
    /// typed field fails here instead of at runtime against the live
    /// backend (PR #175).
    func testMemoryResponseDecodesSelfAndEntities() throws {
        let data = Data(
            """
            { "self": { "factCount": 3, "facts": [{ "id": "n1", "type": "Allergy", "label": "Peanut allergy", "isConstraint": true }] },
              "entities": [{ "id": "e1", "label": "Father", "kind": "Person", "factCount": 4 }] }
            """.utf8
        )

        let response = try JSONDecoder().decode(MemoryResponse.self, from: data)

        XCTAssertEqual(response.selfSummary.factCount, 3)
        XCTAssertEqual(response.selfSummary.facts.count, 1)
        XCTAssertEqual(response.selfSummary.facts[0].id, "n1")
        XCTAssertEqual(response.selfSummary.facts[0].type, "Allergy")
        XCTAssertEqual(response.selfSummary.facts[0].label, "Peanut allergy")
        XCTAssertTrue(response.selfSummary.facts[0].isConstraint)

        XCTAssertEqual(response.entities.count, 1)
        XCTAssertEqual(response.entities[0].id, "e1")
        XCTAssertEqual(response.entities[0].label, "Father")
        XCTAssertEqual(response.entities[0].kind, "Person")
        XCTAssertEqual(response.entities[0].factCount, 4)
    }

    /// Same for the entity-document endpoint — `createdAt` must decode as a
    /// plain `String` (matching `PendingFact.createdAt`'s convention),
    /// because `APIClient`'s decoder has no ISO-8601 strategy and would
    /// throw decoding this ISO string into a `Date`.
    func testEntityDocumentResponseDecodesFactsWithStringCreatedAt() throws {
        let data = Data(
            """
            { "id": "e1", "label": "Father", "kind": "Person", "isSelf": false,
              "facts": [{ "type": "Condition", "label": "Type 2 diabetes", "evidence": "my dad was diagnosed…", "source": "confirmed", "createdAt": "2026-08-14T10:00:00.000Z" }] }
            """.utf8
        )

        let response = try JSONDecoder().decode(EntityDocumentResponse.self, from: data)

        XCTAssertEqual(response.id, "e1")
        XCTAssertEqual(response.label, "Father")
        XCTAssertEqual(response.kind, "Person")
        XCTAssertFalse(response.isSelf)
        XCTAssertEqual(response.facts.count, 1)

        let fact = response.facts[0]
        XCTAssertEqual(fact.type, "Condition")
        XCTAssertEqual(fact.label, "Type 2 diabetes")
        XCTAssertEqual(fact.evidence, "my dad was diagnosed…")
        XCTAssertEqual(fact.source, "confirmed")
        XCTAssertEqual(fact.createdAt, "2026-08-14T10:00:00.000Z")
    }

    func testEntityDocumentResponseDecodesIsSelfTrueWithNoBannerImplication() throws {
        let data = Data(
            """
            { "id": "u1", "label": "You", "kind": "Person", "isSelf": true, "facts": [] }
            """.utf8
        )

        let response = try JSONDecoder().decode(EntityDocumentResponse.self, from: data)

        XCTAssertTrue(response.isSelf)
        XCTAssertEqual(response.facts.count, 0)
    }

    // MARK: - Fact grouping (pure, testable without SwiftUI)

    func testGroupFactsByTypePreservesFirstSeenOrderAndBucketsCorrectly() {
        let facts = [
            EntityFact(type: "Condition", label: "Type 2 diabetes", evidence: "e1", source: "confirmed", createdAt: "2026-08-14T10:00:00.000Z"),
            EntityFact(type: "Medication", label: "Metformin", evidence: "e2", source: "coach", createdAt: "2026-08-15T10:00:00.000Z"),
            EntityFact(type: "Condition", label: "High blood pressure", evidence: "e3", source: "coach", createdAt: "2026-08-16T10:00:00.000Z"),
        ]

        let groups = EntityDocumentViewModel.groupFactsByType(facts)

        XCTAssertEqual(groups.map(\.type), ["Condition", "Medication"])
        XCTAssertEqual(groups[0].facts.map(\.label), ["Type 2 diabetes", "High blood pressure"])
        XCTAssertEqual(groups[1].facts.map(\.label), ["Metformin"])
    }

    func testGroupFactsByTypeHandlesEmptyInput() {
        XCTAssertTrue(EntityDocumentViewModel.groupFactsByType([]).isEmpty)
    }

    // MARK: - Date formatting

    func testDateLabelFormatsIsoTimestampsWithAndWithoutFractionalSeconds() {
        XCTAssertEqual(
            EntityDocumentViewModel.dateLabel(fromISO: "2026-08-14T10:00:00.000Z"),
            "Aug 14, 2026"
        )
        XCTAssertEqual(
            EntityDocumentViewModel.dateLabel(fromISO: "2025-12-01T00:00:00Z"),
            "Dec 1, 2025"
        )
    }

    func testDateLabelFallsBackToRawStringWhenUnparseable() {
        XCTAssertEqual(EntityDocumentViewModel.dateLabel(fromISO: "not-a-date"), "not-a-date")
    }

    // MARK: - Source badge text

    func testSourceBadgeTextMapsKnownSourcesAndFallsBackForUnknown() {
        XCTAssertEqual(EntityDocumentViewModel.sourceBadgeText("confirmed"), "Confirmed")
        XCTAssertEqual(EntityDocumentViewModel.sourceBadgeText("coach"), "From chat")
        XCTAssertEqual(EntityDocumentViewModel.sourceBadgeText("digest"), "Digest")
    }
}
