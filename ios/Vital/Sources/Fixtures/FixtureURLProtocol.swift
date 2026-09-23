#if DEBUG
import Foundation

/// Intercepts every HTTP(S) request to the app's own backend while a fixture
/// scenario is active and answers from `FixtureData` instead.
///
/// Registered two ways, both needed: process-wide via
/// `URLProtocol.registerClass` (from `AppDelegate`) — which reliably covers
/// `URLSession.shared` (the ad hoc calls in `Core/ProactiveNotifications
/// .swift`) — and explicitly via `FixtureMode.apply(to:)` on every
/// `URLSessionConfiguration` the app builds its own `URLSession` from
/// (`APIClient`'s dedicated session). The process-wide registration alone
/// does **not** reliably reach a custom-configured session (verified: it was
/// silently missed, sending every APIClient request out over real — and in
/// CI, absent — networking), which is why every such call site must also call
/// `FixtureMode.apply(to:)` right after building its `URLSessionConfiguration`.
///
/// A request to any other host (e.g. WHOOP's OAuth authorize page, reached
/// only via an explicit user action the screenshot harness never exercises)
/// is declined in `canInit` and falls through to real networking — harmless
/// since fixture scenarios never trigger one.
final class FixtureURLProtocol: URLProtocol {
    /// `AppConfig.apiBaseURL`'s host + port, computed once. Matching on both
    /// (not host alone) avoids accidentally intercepting some other
    /// `localhost`-hosted service running on a different port.
    private static let backendURL = URL(string: AppConfig.apiBaseURL)

    override class func canInit(with request: URLRequest) -> Bool {
        guard FixtureMode.isActive else { return false }
        guard let url = request.url, let host = url.host, let backendURL else { return false }
        return host == backendURL.host && url.port == backendURL.port
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        let (status, data) = FixtureData.response(
            scenario: FixtureMode.scenario,
            method: request.httpMethod ?? "GET",
            path: url.path,
            query: url.query ?? ""
        )

        // POST /api/coach (SSE streaming) is never reached by the screenshot
        // harness — Coach screenshots are driven entirely by the
        // restoration/opener GETs — but this keeps a stray call from hanging
        // instead of finishing immediately with a well-formed empty stream.
        let contentType = (request.httpMethod == "POST" && url.path == "/api/coach")
            ? "text/event-stream"
            : "application/json"

        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": contentType]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// Registers this protocol process-wide. Called once, from
    /// `AppDelegate.application(_:didFinishLaunchingWithOptions:)`, only when
    /// `FixtureMode.isActive` — a normal launch never registers it, so
    /// ordinary networking (and `VitalTests`, which never sets
    /// `-VitalFixture`) is completely unaffected.
    static func registerIfNeeded() {
        guard FixtureMode.isActive else { return }
        URLProtocol.registerClass(FixtureURLProtocol.self)
    }
}
#endif
