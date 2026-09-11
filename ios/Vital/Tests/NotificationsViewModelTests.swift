import XCTest
@testable import Vital

@MainActor
final class NotificationsViewModelTests: XCTestCase {

    private final class FakeNotificationsAPI: NotificationsAPIProviding {
        var listResponse = NotificationsListResponse(items: [], unreadCount: 0)
        var listError: Error?
        var markReadCalls: [(ids: [String]?, all: Bool?)] = []
        var markReadError: Error?

        func fetchNotifications(limit: Int) async throws -> NotificationsListResponse {
            if let listError { throw listError }
            return listResponse
        }

        func markNotificationsRead(ids: [String]?, all: Bool?) async throws -> Int {
            markReadCalls.append((ids, all))
            if let markReadError { throw markReadError }
            return ids?.count ?? 0
        }

        func fetchNudge(id: String) async throws -> NudgeDetailResponse {
            NudgeDetailResponse(id: id, title: "Title", body: "Body", createdAt: Date())
        }
    }

    private func makeItem(id: String = "n1", type: String = "coach_nudge", readAt: Date? = nil) -> NotificationItemDTO {
        NotificationItemDTO(
            id: id, type: type, targetId: "target-\(id)", title: "Title", body: "Body",
            deepLink: "vital://coach-nudge/\(id)", createdAt: Date(), readAt: readAt
        )
    }

    func testDecodesNotificationsListIncludingNullReadAt() throws {
        let json = """
        {"items":[{"id":"n1","type":"coach_nudge","targetId":"t1","title":"Hi","body":"Body text",\
        "deepLink":"vital://coach-nudge/t1","createdAt":"2026-09-11T08:04:00.000Z","readAt":null}],"unreadCount":1}
        """
        let decoded = try JSONDecoder.vital.decode(NotificationsListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.unreadCount, 1)
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertNil(decoded.items[0].readAt)
        XCTAssertEqual(decoded.items[0].type, "coach_nudge")
        XCTAssertEqual(decoded.items[0].targetId, "t1")
    }

    func testDecodesNotificationWithNonNullReadAt() throws {
        let json = """
        {"items":[{"id":"n2","type":"sleep_analysis","targetId":"t2","title":"Slept poorly","body":"Body",\
        "deepLink":"vital://sleep-analysis/t2","createdAt":"2026-09-10T08:00:00.000Z","readAt":"2026-09-10T09:00:00.000Z"}],"unreadCount":0}
        """
        let decoded = try JSONDecoder.vital.decode(NotificationsListResponse.self, from: Data(json.utf8))
        XCTAssertNotNil(decoded.items[0].readAt)
    }

    func testMarkReadOptimisticallyDecrementsUnreadCount() async {
        let api = FakeNotificationsAPI()
        let item = makeItem(readAt: nil)
        api.listResponse = NotificationsListResponse(items: [item], unreadCount: 1)
        let vm = NotificationsViewModel(apiClient: api)
        await vm.load()
        XCTAssertEqual(vm.unreadCount, 1)

        await vm.markRead(id: item.id)

        XCTAssertEqual(vm.unreadCount, 0)
        XCTAssertNotNil(vm.items.first?.readAt)
        XCTAssertEqual(api.markReadCalls.count, 1)
        XCTAssertEqual(api.markReadCalls.first?.ids, [item.id])
        XCTAssertNil(api.markReadCalls.first?.all)
    }

    /// Marking an already-read row must be a no-op — otherwise a double tap
    /// (or re-tapping a row already opened once) would decrement
    /// `unreadCount` below the server's actual count.
    func testMarkReadOnAlreadyReadRowDoesNotDoubleDecrement() async {
        let api = FakeNotificationsAPI()
        let readDate = Date(timeIntervalSince1970: 1_700_000_000)
        let item = makeItem(readAt: readDate)
        api.listResponse = NotificationsListResponse(items: [item], unreadCount: 0)
        let vm = NotificationsViewModel(apiClient: api)
        await vm.load()
        XCTAssertEqual(vm.unreadCount, 0)

        await vm.markRead(id: item.id)

        XCTAssertEqual(vm.unreadCount, 0)
        XCTAssertEqual(api.markReadCalls.count, 0)
        XCTAssertEqual(vm.items.first?.readAt, readDate)
    }

    func testMarkAllReadClearsUnreadCountAndSendsAllFlag() async {
        let api = FakeNotificationsAPI()
        let items = [makeItem(id: "a"), makeItem(id: "b"), makeItem(id: "c", readAt: Date())]
        api.listResponse = NotificationsListResponse(items: items, unreadCount: 2)
        let vm = NotificationsViewModel(apiClient: api)
        await vm.load()

        await vm.markAllRead()

        XCTAssertEqual(vm.unreadCount, 0)
        XCTAssertTrue(vm.items.allSatisfy { $0.readAt != nil })
        XCTAssertEqual(api.markReadCalls.count, 1)
        XCTAssertEqual(api.markReadCalls.first?.all, true)
        XCTAssertNil(api.markReadCalls.first?.ids)
    }

    /// A `URLError.cancelled` from a superseded fetch (sheet dismissed mid
    /// load, tab switch) must never surface as a user-facing error — this is
    /// the exact bug class behind the "Couldn't load today's data" incident
    /// on `TodayViewModel`.
    func testLoadCancellationDoesNotProduceUserFacingError() async {
        let api = FakeNotificationsAPI()
        api.listError = URLError(.cancelled)
        let vm = NotificationsViewModel(apiClient: api)

        await vm.load()

        XCTAssertNil(vm.errorMessage)
        XCTAssertNotEqual(vm.loadState, .failed)
    }

    func testLoadFailureSurfacesUserFacingErrorMessage() async {
        let api = FakeNotificationsAPI()
        api.listError = URLError(.notConnectedToInternet)
        let vm = NotificationsViewModel(apiClient: api)

        await vm.load()

        XCTAssertEqual(vm.loadState, .failed)
        XCTAssertNotNil(vm.errorMessage)
    }
}
