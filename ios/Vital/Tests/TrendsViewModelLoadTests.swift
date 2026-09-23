import XCTest
@testable import Vital

/// Regression coverage for the Trends error-copy leak: `load()` and
/// `loadSummary()` used to assign `error.localizedDescription` straight into
/// published state, which could surface things like "Server returned HTTP
/// 500." to a user who just wanted to see their sleep trend. Both paths now
/// route through `UserFacingError`, and the state that drives the empty vs.
/// error UI must never overlap (see `TrendsView.gridBody`/`subtitle`).
@MainActor
final class TrendsViewModelLoadTests: XCTestCase {

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
}

/// Same leak, same fix, in the metric detail screen's loader.
@MainActor
final class MetricDetailViewModelLoadTests: XCTestCase {

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
private final class FakeTrendsLoadAPI: TrendsAPIProviding {
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
}
