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

        // The old-server payload above carries none of memory-contract.md
        // §1's new fields — they must decode as nil, not throw.
        XCTAssertNil(response.selfSummary.facts[0].recordedAt)
        XCTAssertNil(response.selfSummary.facts[0].origin)
        XCTAssertNil(response.selfSummary.facts[0].group)
    }

    /// memory-contract.md §1's new, additive fields on a fact — a newer
    /// server. All three must decode straight through untouched.
    func testMemoryResponseDecodesNewOptionalFactFields() throws {
        let data = Data(
            """
            { "self": { "factCount": 1, "facts": [
                { "id": "n1", "type": "Allergy", "label": "Peanut allergy", "isConstraint": true,
                  "recordedAt": "2026-09-12", "origin": "confirmed", "group": "health" }
              ] },
              "entities": [] }
            """.utf8
        )

        let response = try JSONDecoder().decode(MemoryResponse.self, from: data)

        let fact = response.selfSummary.facts[0]
        XCTAssertEqual(fact.recordedAt, "2026-09-12")
        XCTAssertEqual(fact.origin, "confirmed")
        XCTAssertEqual(fact.group, "health")
    }

    /// A pending fact's optional `reason` (memory-contract.md §1) — present
    /// on a newer server, absent (decodes to nil) on an older one.
    func testPendingFactDecodesOptionalReason() throws {
        let withReason = Data(
            """
            { "id": "p1", "proposedNode": { "type": "Habit", "label": "Trains at 6am" },
              "evidence": "e", "salience": 0.8, "createdAt": "2026-09-01",
              "reason": "Noticed from your workouts over the last 3 weeks" }
            """.utf8
        )
        let decodedWithReason = try JSONDecoder().decode(PendingFact.self, from: withReason)
        XCTAssertEqual(decodedWithReason.reason, "Noticed from your workouts over the last 3 weeks")

        let withoutReason = Data(
            """
            { "id": "p2", "proposedNode": { "type": "Habit", "label": "Trains at 6am" },
              "evidence": "e", "salience": 0.8, "createdAt": "2026-09-01" }
            """.utf8
        )
        let decodedWithoutReason = try JSONDecoder().decode(PendingFact.self, from: withoutReason)
        XCTAssertNil(decodedWithoutReason.reason)
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

    // MARK: - load() — the states the user actually hits on device

    private func makePendingFact(id: String) -> PendingFact {
        PendingFact(
            id: id,
            proposedNode: ProposedNode(type: "Allergy", label: "Peanut allergy"),
            evidence: "I think I'm allergic to peanuts",
            salience: 0.8,
            createdAt: "2026-08-14T10:00:00.000Z"
        )
    }

    /// The most likely first screen: a nearly-empty ontology. Must land in a
    /// clean empty state, not an error.
    func testLoadWithEmptyMemoryAndNoPendingFactsLandsInCleanEmptyState() async {
        let api = FakeMemoryAPI() // defaults are already all-empty
        let vm = MemoryViewModel(apiClient: api)

        await vm.load()

        XCTAssertEqual(vm.selfFactCount, 0)
        XCTAssertTrue(vm.selfFacts.isEmpty)
        XCTAssertTrue(vm.entities.isEmpty)
        XCTAssertTrue(vm.pendingFacts.isEmpty)
        XCTAssertNil(vm.errorMessage)
        XCTAssertFalse(vm.isLoading)
    }

    /// `fetchMemory()` throwing — e.g. the endpoint isn't deployed yet — must
    /// surface as a user-facing error and never leave `isLoading` stuck.
    func testLoadWhenFetchMemoryThrowsSetsErrorMessageAndClearsIsLoading() async {
        let api = FakeMemoryAPI()
        api.memoryError = URLError(.notConnectedToInternet)
        let vm = MemoryViewModel(apiClient: api)

        await vm.load()

        XCTAssertNotNil(vm.errorMessage)
        XCTAssertFalse(vm.isLoading)
        XCTAssertTrue(vm.selfFacts.isEmpty)
        XCTAssertTrue(vm.entities.isEmpty)
    }

    /// `fetchPendingFacts()` failing is best-effort by design
    /// (`MemoryViewModel.swift:27-29`) — the About you / People cards must
    /// still populate from the successful `fetchMemory()` call, with
    /// `pendingFacts` simply left empty and no error surfaced.
    func testLoadWhenPendingFactsThrowsStillPopulatesMemoryDataWithNoError() async {
        let api = FakeMemoryAPI()
        api.memoryResponse = MemoryResponse(
            selfSummary: MemorySelfSummary(
                factCount: 1,
                facts: [MemoryFact(id: "n1", type: "Allergy", label: "Peanut allergy", isConstraint: true)]
            ),
            entities: [MemoryEntitySummary(id: "e1", label: "Father", kind: "Person", factCount: 2)]
        )
        api.pendingFactsError = URLError(.timedOut)
        let vm = MemoryViewModel(apiClient: api)

        await vm.load()

        XCTAssertEqual(vm.selfFactCount, 1)
        XCTAssertEqual(vm.selfFacts.map(\.label), ["Peanut allergy"])
        XCTAssertEqual(vm.entities.map(\.label), ["Father"])
        XCTAssertTrue(vm.pendingFacts.isEmpty)
        XCTAssertNil(vm.errorMessage)
    }

    /// `isLoading` must be true while `fetchMemory()` is still in flight —
    /// not just false-before/false-after, which a bug that skipped setting
    /// it entirely would also satisfy.
    func testIsLoadingIsTrueWhileFetchMemoryIsInFlightAndFalseAfterOnSuccess() async {
        let api = FakeMemoryAPI()
        api.delayNextMemory = true
        let suspended = expectation(description: "load suspends inside fetchMemory")
        api.onMemorySuspended = { suspended.fulfill() }
        let vm = MemoryViewModel(apiClient: api)

        let task = Task { await vm.load() }
        await fulfillment(of: [suspended], timeout: 10)
        XCTAssertTrue(vm.isLoading)

        api.releaseMemory()
        await task.value

        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
    }

    /// Same lifecycle, but the in-flight fetch ends in failure — `isLoading`
    /// must still come back down to false rather than getting stuck because
    /// the error path took a different route out of `load()`.
    func testIsLoadingIsTrueWhileFetchMemoryIsInFlightAndFalseAfterOnFailure() async {
        let api = FakeMemoryAPI()
        api.delayNextMemory = true
        api.memoryError = URLError(.notConnectedToInternet)
        let suspended = expectation(description: "load suspends inside fetchMemory before failing")
        api.onMemorySuspended = { suspended.fulfill() }
        let vm = MemoryViewModel(apiClient: api)

        let task = Task { await vm.load() }
        await fulfillment(of: [suspended], timeout: 10)
        XCTAssertTrue(vm.isLoading)

        api.releaseMemory()
        await task.value

        XCTAssertFalse(vm.isLoading)
        XCTAssertNotNil(vm.errorMessage)
    }

    // MARK: - resolveFact

    func testResolveFactSuccessRemovesRowFromPendingFacts() async {
        let api = FakeMemoryAPI()
        let vm = MemoryViewModel(apiClient: api)
        vm.pendingFacts = [makePendingFact(id: "p1"), makePendingFact(id: "p2")]

        await vm.resolveFact(id: "p1", action: "confirm")

        XCTAssertEqual(vm.pendingFacts.map(\.id), ["p2"])
        XCTAssertEqual(api.resolveCalls.count, 1)
        XCTAssertEqual(api.resolveCalls.first?.id, "p1")
        XCTAssertEqual(api.resolveCalls.first?.action, "confirm")
        XCTAssertNil(vm.toastMessage)
    }

    func testResolveFactFailureLeavesRowInPlaceAndSetsToastMessage() async {
        let api = FakeMemoryAPI()
        api.resolveError = URLError(.notConnectedToInternet)
        let vm = MemoryViewModel(apiClient: api)
        vm.pendingFacts = [makePendingFact(id: "p1")]

        await vm.resolveFact(id: "p1", action: "reject")

        XCTAssertEqual(vm.pendingFacts.map(\.id), ["p1"])
        XCTAssertEqual(vm.toastMessage, "Couldn't save — try again")
    }

    /// A cancelled resolve (e.g. the user navigated away mid-request) must
    /// leave the row in place — same as any other failure — but must never
    /// surface a toast, matching the `!error.isCancellation` guard.
    func testResolveFactCancellationLeavesRowInPlaceWithoutToast() async {
        let api = FakeMemoryAPI()
        api.resolveError = URLError(.cancelled)
        let vm = MemoryViewModel(apiClient: api)
        vm.pendingFacts = [makePendingFact(id: "p1")]

        await vm.resolveFact(id: "p1", action: "confirm")

        XCTAssertEqual(vm.pendingFacts.map(\.id), ["p1"])
        XCTAssertNil(vm.toastMessage)
    }

    // MARK: - saveEdit

    /// Success replaces the row wholesale with the server's SUPERSEDEd node
    /// (a new id, per memory-contract.md §2) — never just the label in place.
    func testSaveEditSuccessReplacesRowWithServersSupersedingFact() async {
        let api = FakeMemoryAPI()
        let original = MemoryFact(id: "n1", type: "Habit", label: "Prefers running in the morning", isConstraint: false)
        api.editResult = MemoryFact(id: "n2", type: "Habit", label: "Prefers running at dawn", isConstraint: false, recordedAt: "2026-09-27", origin: "told", group: "routines")
        let vm = MemoryViewModel(apiClient: api)
        vm.selfFacts = [original]

        await vm.saveEdit(fact: original, newLabel: "Prefers running at dawn")

        XCTAssertEqual(vm.selfFacts.map(\.id), ["n2"])
        XCTAssertEqual(vm.selfFacts.map(\.label), ["Prefers running at dawn"])
        XCTAssertEqual(api.editCalls.count, 1)
        XCTAssertEqual(api.editCalls.first?.id, "n1")
        XCTAssertEqual(api.editCalls.first?.label, "Prefers running at dawn")
        XCTAssertNil(vm.editingFact, "the edit sheet should have dismissed")
        XCTAssertNil(vm.toastMessage)
    }

    /// Failure restores the ORIGINAL fact (undoing the optimistic label
    /// change) and surfaces a toast — same rollback idiom as `resolveFact`.
    func testSaveEditFailureRollsBackToOriginalFactAndShowsToast() async {
        let api = FakeMemoryAPI()
        api.editError = URLError(.notConnectedToInternet)
        let original = MemoryFact(id: "n1", type: "Habit", label: "Prefers running in the morning", isConstraint: false)
        let vm = MemoryViewModel(apiClient: api)
        vm.selfFacts = [original]

        await vm.saveEdit(fact: original, newLabel: "Prefers running at dawn")

        XCTAssertEqual(vm.selfFacts, [original])
        XCTAssertEqual(vm.toastMessage, "Couldn't save — try again")
    }

    /// An empty or unchanged label is a no-op: no API call, no row change —
    /// the sheet's own Save button is disabled for this, but the view model
    /// guards it too.
    func testSaveEditNoOpForEmptyOrUnchangedLabel() async {
        let api = FakeMemoryAPI()
        let original = MemoryFact(id: "n1", type: "Habit", label: "Prefers running in the morning", isConstraint: false)
        let vm = MemoryViewModel(apiClient: api)
        vm.selfFacts = [original]
        vm.editingFact = original

        await vm.saveEdit(fact: original, newLabel: "   ")
        await vm.saveEdit(fact: original, newLabel: original.label)

        XCTAssertEqual(vm.selfFacts, [original])
        XCTAssertTrue(api.editCalls.isEmpty)
        XCTAssertNil(vm.editingFact)
    }

    // MARK: - forget

    /// Success removes the row immediately and calls the existing undo
    /// endpoint — memory-contract.md §3 reuses `POST .../undo` verbatim.
    func testForgetSuccessRemovesRowAndCallsUndo() async {
        let api = FakeMemoryAPI()
        let fact = MemoryFact(id: "n1", type: "Habit", label: "Prefers running in the morning", isConstraint: false)
        let vm = MemoryViewModel(apiClient: api)
        vm.selfFacts = [fact]
        vm.factPendingForget = fact

        await vm.forget(fact)

        XCTAssertTrue(vm.selfFacts.isEmpty)
        XCTAssertEqual(api.undoCalls, ["n1"])
        XCTAssertNil(vm.factPendingForget, "the confirmation dialog should have dismissed")
        XCTAssertNil(vm.toastMessage)
    }

    /// Failure restores the row in place and shows a toast.
    func testForgetFailureRestoresRowAndShowsToast() async {
        let api = FakeMemoryAPI()
        api.undoError = URLError(.notConnectedToInternet)
        let first = MemoryFact(id: "n1", type: "Habit", label: "First", isConstraint: false)
        let second = MemoryFact(id: "n2", type: "Habit", label: "Second", isConstraint: false)
        let vm = MemoryViewModel(apiClient: api)
        vm.selfFacts = [first, second]

        await vm.forget(first)

        XCTAssertEqual(vm.selfFacts, [first, second])
        XCTAssertEqual(vm.toastMessage, "Couldn't save — try again")
    }

    // MARK: - EntityDocumentViewModel.load

    func testEntityDocumentLoadSuccessPopulatesDocument() async {
        let api = FakeMemoryAPI()
        api.entityDocumentResponse = EntityDocumentResponse(
            id: "e1", label: "Father", kind: "Person", isSelf: false,
            facts: [EntityFact(type: "Condition", label: "Type 2 diabetes", evidence: "e", source: "coach", createdAt: "2026-08-14T10:00:00.000Z")]
        )
        let vm = EntityDocumentViewModel(apiClient: api)

        await vm.load(id: "e1")

        XCTAssertEqual(vm.document?.id, "e1")
        XCTAssertEqual(vm.document?.label, "Father")
        XCTAssertEqual(vm.document?.facts.count, 1)
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
    }

    func testEntityDocumentLoadFailureSetsErrorMessageAndClearsIsLoading() async {
        let api = FakeMemoryAPI()
        api.entityDocumentError = URLError(.notConnectedToInternet)
        let vm = EntityDocumentViewModel(apiClient: api)

        await vm.load(id: "e1")

        XCTAssertNil(vm.document)
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertFalse(vm.isLoading)
    }

    /// `isSelf: true` is the branch that suppresses `EntityDocumentView`'s
    /// third-party safety banner — the view model must pass it through
    /// untouched rather than normalizing or dropping it.
    func testEntityDocumentLoadHandlesIsSelfTrueDocument() async {
        let api = FakeMemoryAPI()
        api.entityDocumentResponse = EntityDocumentResponse(id: "u1", label: "You", kind: "Person", isSelf: true, facts: [])
        let vm = EntityDocumentViewModel(apiClient: api)

        await vm.load(id: "u1")

        XCTAssertEqual(vm.document?.isSelf, true)
        XCTAssertNil(vm.errorMessage)
    }
}

// MARK: - FakeMemoryAPI

/// Same idiom as `FakeTrendsAPI`/`FakeNotificationsAPI` — a fake conforming
/// to the seam protocol, with a gated `fetchMemory()` (mirroring
/// `FakeTrendsAPI.delayNextBatch`/`onBatchSuspended`) so a test can observe
/// `MemoryViewModel.isLoading` while the fetch is genuinely still in flight,
/// instead of betting on a `Task.yield()` scheduling hop.
@MainActor
private final class FakeMemoryAPI: MemoryAPIProviding {
    var memoryResponse = MemoryResponse(
        selfSummary: MemorySelfSummary(factCount: 0, facts: []),
        entities: []
    )
    var memoryError: Error?
    var delayNextMemory = false
    private var memoryContinuation: CheckedContinuation<Void, Never>?
    var onMemorySuspended: (@MainActor () -> Void)?

    var pendingFactsResponse = PendingFactsResponse(items: [])
    var pendingFactsError: Error?

    var entityDocumentResponse = EntityDocumentResponse(id: "e0", label: "", kind: "", isSelf: false, facts: [])
    var entityDocumentError: Error?

    var resolveError: Error?
    var resolveCalls: [(id: String, action: String)] = []

    var editError: Error?
    var editCalls: [(id: String, label: String)] = []
    /// The fact `editMemoryFact` returns on success — a caller sets this to
    /// whatever the "new, superseding" node should look like.
    var editResult: MemoryFact = MemoryFact(id: "edited", type: "Habit", label: "", isConstraint: false)

    var undoError: Error?
    var undoCalls: [String] = []

    func fetchMemory() async throws -> MemoryResponse {
        if delayNextMemory {
            delayNextMemory = false
            await withCheckedContinuation { continuation in
                memoryContinuation = continuation
                onMemorySuspended?()
            }
        }
        if let memoryError { throw memoryError }
        return memoryResponse
    }

    func fetchEntityDocument(id: String) async throws -> EntityDocumentResponse {
        if let entityDocumentError { throw entityDocumentError }
        return entityDocumentResponse
    }

    func fetchPendingFacts() async throws -> PendingFactsResponse {
        if let pendingFactsError { throw pendingFactsError }
        return pendingFactsResponse
    }

    func resolvePendingFact(id: String, action: String) async throws -> String? {
        resolveCalls.append((id, action))
        if let resolveError { throw resolveError }
        return nil
    }

    func releaseMemory() {
        memoryContinuation?.resume()
        memoryContinuation = nil
    }

    func editMemoryFact(id: String, label: String) async throws -> MemoryFact {
        editCalls.append((id, label))
        if let editError { throw editError }
        return editResult
    }

    func undoMemoryFact(id: String) async throws {
        undoCalls.append(id)
        if let undoError { throw undoError }
    }
}
