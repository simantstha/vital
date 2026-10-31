import XCTest
@testable import Vital

/// Regression coverage for the Trends error-copy leak: `load()` and
/// `loadSummary()` used to assign `error.localizedDescription` straight into
/// published state, which could surface things like "Server returned HTTP
/// 500." to a user who just wanted to see their sleep trend. Both paths now
/// route through `UserFacingError`, and the state that drives the empty vs.
/// error UI must never overlap (see `TrendsView.gridBody`/`subtitle`).
@MainActor
final class TrendsViewModelErrorCopyTests: XCTestCase {

    func testLoadFailureProducesNoRawHTTPOrStatusCodeText() async {
        let api = FakeTrendsLoadAPI()
        api.batchError = APIError.serverError(500)
        let viewModel = TrendsViewModel(apiClient: api)

        await viewModel.load()

        let message = try? XCTUnwrap(viewModel.errorMessage)
        XCTAssertNotNil(message)
        XCTAssertFalse(message?.contains("500") ?? true)
        XCTAssertFalse(message?.localizedCaseInsensitiveContains("HTTP") ?? true)
        XCTAssertFalse(message?.localizedCaseInsensitiveContains("server returned") ?? true)
    }

    func testLoadFailureLeavesLoadedEmpty() async {
        let api = FakeTrendsLoadAPI()
        api.batchError = APIError.serverError(500)
        let viewModel = TrendsViewModel(apiClient: api)

        await viewModel.load()

        // This is the precondition `TrendsView.gridBody` relies on to gate
        // the "No trends yet" empty state out of a failed-load render — see
        // the `errorMessage != nil` branch added there.
        XCTAssertTrue(viewModel.loaded.isEmpty)
        XCTAssertNotNil(viewModel.errorMessage)
    }

    func testLoadSummaryFailureProducesNoRawHTTPOrStatusCodeText() async {
        let api = FakeTrendsLoadAPI()
        api.singleError = APIError.serverError(503)
        let viewModel = TrendsViewModel(apiClient: api)

        await viewModel.loadSummary()

        let message = try? XCTUnwrap(viewModel.summaryErrorMessage)
        XCTAssertNotNil(message)
        XCTAssertFalse(message?.contains("503") ?? true)
        XCTAssertFalse(message?.localizedCaseInsensitiveContains("HTTP") ?? true)
    }

    func testLoadOfflineFailureReadsAsOfflineNotGenericServerCopy() async {
        let api = FakeTrendsLoadAPI()
        api.batchError = URLError(.notConnectedToInternet)
        let viewModel = TrendsViewModel(apiClient: api)

        await viewModel.load()

        let message = viewModel.errorMessage ?? ""
        XCTAssertTrue(message.localizedCaseInsensitiveContains("offline") || message.localizedCaseInsensitiveContains("connection"))
    }

    // MARK: Learning card gating (server_error__trends: "0 of 14" above the error card)

    func testLearningCardHiddenBeforeAnyLoad() {
        let viewModel = TrendsViewModel(apiClient: FakeTrendsLoadAPI())
        // The default status is a `.learning(14 left)` placeholder; it must not render as a card.
        XCTAssertNil(viewModel.learningCardProgress)
        XCTAssertFalse(viewModel.hasLoadedGrid)
    }

    func testLearningCardHiddenWhenLoadFails() async {
        let api = FakeTrendsLoadAPI()
        api.batchError = APIError.serverError(500)
        let viewModel = TrendsViewModel(apiClient: api)

        await viewModel.load()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.learningCardProgress)
    }

    func testLearningCardShownAfterSuccessfulLoadWithNoEstablishedMetric() async {
        let viewModel = TrendsViewModel(apiClient: FakeTrendsLoadAPI())

        await viewModel.load()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.hasLoadedGrid)
        XCTAssertNotNil(viewModel.learningCardProgress)
    }

    func testLearningCardHidesAgainWhenARefreshFailsAfterASuccess() async {
        let api = FakeTrendsLoadAPI()
        let viewModel = TrendsViewModel(apiClient: api)
        await viewModel.load()
        XCTAssertNotNil(viewModel.learningCardProgress)

        api.batchError = URLError(.notConnectedToInternet)
        await viewModel.load()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.learningCardProgress)
    }

    func testLearningCardProgressHelperOnlyPassesLearningStatus() {
        let learning = TrendsHeadline.Status.learning(TrendsHeadline.LearningProgress(daysRemaining: 9))
        XCTAssertEqual(
            TrendsViewModel.learningCardProgress(status: learning, hasLoadedGrid: true, errorMessage: nil)?.daysRemaining, 9
        )
        XCTAssertNil(TrendsViewModel.learningCardProgress(status: learning, hasLoadedGrid: false, errorMessage: nil))
        XCTAssertNil(TrendsViewModel.learningCardProgress(status: learning, hasLoadedGrid: true, errorMessage: "x"))
        XCTAssertNil(TrendsViewModel.learningCardProgress(status: .steady(period: .thirtyDays), hasLoadedGrid: true, errorMessage: nil))
    }

    // MARK: Connected-source lookup behind the sleep card's empty line

    func testConnectedSourceKnownCombinesIntegrationsAndDevices() {
        let apple = ProfileIntegration(name: "Apple Health", status: "connected")
        let off = ProfileIntegration(name: "Apple Health", status: "disconnected")
        let whoop = DeviceStatusDTO(id: .whoop, connected: true, lastSyncAt: nil)
        XCTAssertEqual(TrendsViewModel.connectedSourceKnown(integrations: [apple], devices: nil), true)
        XCTAssertEqual(TrendsViewModel.connectedSourceKnown(integrations: nil, devices: [whoop]), true)
        XCTAssertEqual(TrendsViewModel.connectedSourceKnown(integrations: [off], devices: []), false)
        XCTAssertNil(TrendsViewModel.connectedSourceKnown(integrations: nil, devices: nil), "both lookups failed: unknown")
    }

    func testHasConnectedSourceIsUnknownBeforeTheSummaryLoads() {
        XCTAssertNil(TrendsViewModel(apiClient: FakeTrendsLoadAPI()).hasConnectedSource)
    }
}

/// Same leak, same fix, in the metric detail screen's loader.
@MainActor
final class MetricDetailViewModelErrorCopyTests: XCTestCase {

    func testLoadFailureProducesNoRawHTTPOrStatusCodeText() async {
        let api = FakeTrendsLoadAPI()
        api.batchError = APIError.serverError(500)
        let viewModel = MetricDetailViewModel(metricKey: "hrv_sdnn", apiClient: api)

        await viewModel.load()

        let message = viewModel.errorMessage ?? ""
        XCTAssertFalse(message.isEmpty)
        XCTAssertFalse(message.contains("500"))
        XCTAssertFalse(message.localizedCaseInsensitiveContains("HTTP"))
    }
}

@MainActor
private final class FakeTrendsLoadAPI: MetricDetailAPIProviding {
    var batchError: Error?
    var singleError: Error?
    var batchResponse = TrendsBatchResponse(days: 30, series: [:], unknownMetrics: [], calibration: nil)

    func fetchTrends(metric: String, days: Int) async throws -> TrendsResponse {
        if let singleError { throw singleError }
        return TrendsResponse(metric: metric, points: [], calibration: nil)
    }

    func fetchTrendsBatch(metrics: [String], days: Int) async throws -> TrendsBatchResponse {
        if let batchError { throw batchError }
        return batchResponse
    }

    func fetchTrendsDrivers(metric: String) async throws -> TrendsDriversResponse {
        return TrendsDriversResponse(metric: metric, computedFor: nil, drivers: [])
    }

    func fetchTrendsMarkers(days: Int) async throws -> TrendsMarkersResponse {
        return TrendsMarkersResponse(days: days, markers: [])
    }
}
