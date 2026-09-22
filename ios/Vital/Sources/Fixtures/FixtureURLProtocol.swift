#if DEBUG
import Foundation

/// Intercepts every HTTP(S) request to the app's own backend while a fixture
/// scenario is active and answers from `FixtureData` instead. Registered
/// process-wide via `URLProtocol.registerClass` (from `AppDelegate`), which is
/// what lets it cover every session in the app — `APIClient`'s dedicated
/// session, the ad hoc `URLSession.shared` calls in
/// `Core/ProactiveNotifications.swift`, and any other `.default`-configuration
/// session — without threading a custom session through every call site.
///
/// A request to any other host (e.g. WHOOP's OAuth authorize page, reached
/// only via an explicit user action the screenshot harness never exercises)
/// is declined in `canInit` and falls through to real networking — harmless
/// since fixture scenarios never trigger one.
final class FixtureURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        guard FixtureMode.isActive else { return false }
        guard let host = request.url?.host else { return false }
        return host == URL(string: AppConfig.apiBaseURL)?.host
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
