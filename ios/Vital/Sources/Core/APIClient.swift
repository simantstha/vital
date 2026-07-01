import Foundation

// MARK: - App configuration

enum AppConfig {
    /// Base URL for the Vital backend.
    /// Production (Fly.io): "https://vital-coach.fly.dev"
    /// Local dev: "http://localhost:3000"
    static let apiBaseURL = "https://vital-coach.fly.dev"
}

// MARK: - JSON value

/// Minimal Encodable wrapper for heterogeneous JSON payloads.
/// Avoids a dependency on external AnyCodable packages.
enum JSONValue: Encodable {
    case int(Int)
    case double(Double)
    case string(String)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .int(let v):    try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        }
    }
}

// MARK: - HealthDelta

/// A single health observation to be persisted in the event ledger.
struct HealthDelta: Encodable {
    let type: String
    let timestamp: Date
    let payload: [String: JSONValue]
}

// MARK: - APIClient

struct APIClient {
    static let shared = APIClient()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private let decoder = JSONDecoder()

    /// Session whose delegate strips the bearer token on cross-host redirects,
    /// so the credential can never leak to another origin.
    private let session: URLSession
    private let redirectGuard: AuthRedirectGuard

    init() {
        let delegate = AuthRedirectGuard()
        redirectGuard = delegate
        // Disable HTTP caching so a fresh launch never renders a stale cached
        // response before live data loads. Covers every current/future GET.
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    /// Builds a request carrying the bearer token. The header is set per-request
    /// (not on the session) so the redirect delegate controls its propagation.
    ///
    /// Prefers the signed-in user's session token from Keychain; falls back to
    /// the shared dev secret so the app keeps working against the currently
    /// deployed backend before/without a session (e.g. pre-auth call sites).
    private func authorizedRequest(_ url: URL) -> URLRequest {
        var r = URLRequest(url: url)
        let bearer = KeychainStore.loadSessionToken() ?? AppSecrets.apiToken
        r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        return r
    }

    // MARK: - Generic GET

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)\(path)") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Today dashboard

    func fetchToday() async throws -> TodayResponse {
        try await get("/api/today")
    }

    // MARK: - Trends

    func fetchTrends(metric: String, days: Int) async throws -> TrendsResponse {
        try await get("/api/trends?metric=\(metric)&days=\(days)")
    }

    // MARK: - Activity logs

    func fetchLogs(days: Int = 7) async throws -> LogsResponse {
        try await get("/api/logs?days=\(days)")
    }

    // MARK: - Profile

    func fetchProfile() async throws -> ProfileResponse {
        try await get("/api/profile")
    }

    // MARK: - Pending facts

    func fetchPendingFacts() async throws -> PendingFactsResponse {
        try await get("/api/pending-facts")
    }

    func resolvePendingFact(id: String, action: String) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/pending-facts/resolve") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        struct Body: Encodable { let id: String; let action: String }
        request.httpBody = try encoder.encode(Body(id: id, action: action))
        let (_, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
    }

    // MARK: - Coach (SSE streaming)

    func streamCoach(message: String, imageBase64: String? = nil) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/coach") else {
                        continuation.finish(throwing: APIError.invalidURL)
                        return
                    }

                    var request = authorizedRequest(url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.timeoutInterval = 60

                    let body = CoachRequestBody(message: message, imageBase64: imageBase64)
                    request.httpBody = try encoder.encode(body)

                    let (bytes, response) = try await session.bytes(for: request)

                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        continuation.finish(throwing: APIError.serverError(http.statusCode))
                        return
                    }

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: ") else { continue }
                        let jsonSlice = line.dropFirst(6)
                        guard let data = jsonSlice.data(using: .utf8),
                              let event = try? JSONDecoder().decode(SSEEvent.self, from: data)
                        else { continue }

                        switch event.type {
                        case "text":
                            if let delta = event.delta {
                                continuation.yield(delta)
                            }
                        case "done":
                            continuation.finish()
                            return
                        default:
                            break
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Nutrition search

    func searchFood(_ query: String) async throws -> NutritionResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/search") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let query: String }
        request.httpBody = try encoder.encode(Body(query: query))
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try decoder.decode(NutritionResult.self, from: data)
    }

    func barcodeFood(_ barcode: String, grams: Double? = nil) async throws -> BarcodeResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/barcode") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let barcode: String; let grams: Double? }
        request.httpBody = try encoder.encode(Body(barcode: barcode, grams: grams))
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try decoder.decode(BarcodeResult.self, from: data)
    }

    func photoFood(imageBase64: String) async throws -> NutritionResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/photo") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        struct Body: Encodable { let imageBase64: String }
        request.httpBody = try encoder.encode(Body(imageBase64: imageBase64))
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try decoder.decode(NutritionResult.self, from: data)
    }

    @discardableResult
    func logMeal(
        name: String,
        kcal: Double,
        c: Double,
        p: Double,
        f: Double,
        source: String,
        imageThumb: String? = nil
    ) async throws -> LogMealResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/log") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let name: String; let kcal: Double
            let c: Double; let p: Double; let f: Double; let source: String
            let imageThumb: String?
        }
        request.httpBody = try encoder.encode(Body(name: name, kcal: kcal, c: c, p: p, f: f, source: source, imageThumb: imageThumb))
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try decoder.decode(LogMealResponse.self, from: data)
    }

    // MARK: - Ingest

    func postIngest(_ deltas: [HealthDelta]) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/ingest") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = try encoder.encode(IngestRequestBody(deltas: deltas))
        let (_, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
    }
}

// MARK: - Errors

enum APIError: Error, LocalizedError {
    case invalidURL
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:         return "Invalid backend URL."
        case .serverError(let c): return "Server returned HTTP \(c)."
        }
    }
}

// MARK: - Redirect guard

/// Drops the Authorization header when a redirect targets a host other than the
/// backend, so the bearer token is never forwarded to a different origin.
private final class AuthRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        let backendHost = URL(string: AppConfig.apiBaseURL)?.host
        guard request.url?.host == backendHost else {
            var stripped = request
            stripped.setValue(nil, forHTTPHeaderField: "Authorization")
            completionHandler(stripped)
            return
        }
        completionHandler(request)
    }
}

// MARK: - Ingest body

private struct IngestRequestBody: Encodable {
    let deltas: [HealthDelta]
}

// MARK: - Nutrition & Meal

struct NutritionResult: Decodable {
    let name: String
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
}

struct BarcodeResult: Decodable {
    let name: String
    let brand: String?
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    let per100g: Bool?
    let grams: Double?
}

struct LogMealResponse: Decodable {
    let ok: Bool
    let eventId: String
    let coachReaction: String
}

// MARK: - Today dashboard types

struct TodayMetricValue: Decodable {
    let value: Double
    let unit: String
    let deltaPct: Int
}

struct TodayMetrics: Decodable {
    let hrv: TodayMetricValue
    let sleep: TodayMetricValue
    let restingHr: TodayMetricValue
}

struct TodayDietBudget: Decodable {
    let targetKcal: Int
    let consumedKcal: Int
    let remaining: Int
    let protein: Int   // consumed grams
    let carbs: Int     // consumed grams
    let fat: Int       // consumed grams
}

struct TodayPlanItem: Decodable {
    let name: String
    let kcal: Int
    let why: String
}

struct TodayResponse: Decodable {
    let metrics: TodayMetrics
    let dietBudget: TodayDietBudget
    let insight: String
    let plan: [TodayPlanItem]
}

// MARK: - Trends types

struct TrendPoint: Decodable {
    let date: String
    let value: Double
}

struct TrendsResponse: Decodable {
    let metric: String
    let points: [TrendPoint]
}

// MARK: - Logs types

struct LogItem: Decodable, Identifiable {
    let id: String
    let type: String
    let timestamp: String
    let title: String
    let subtitle: String
    let imageThumb: String?
}

struct LogsResponse: Decodable {
    let items: [LogItem]
}

// MARK: - Profile types

struct ProfileIntegration: Decodable {
    let name: String
    let status: String
}

struct ProfileStats: Decodable {
    let loggedDays: Int
    let mealsLogged: Int
    let avgHrv: Double
    let workouts: Int
}

struct ProfileResponse: Decodable {
    let name: String
    let integrations: [ProfileIntegration]
    let stats: ProfileStats
}

// MARK: - Pending facts types

struct ProposedNode: Decodable {
    let type: String
    let label: String
}

struct PendingFact: Decodable, Identifiable {
    let id: String
    let proposedNode: ProposedNode
    let evidence: String
    let salience: Double
    let createdAt: String
}

struct PendingFactsResponse: Decodable {
    let items: [PendingFact]
}

// MARK: - Coach SSE types

private struct CoachRequestBody: Encodable {
    let message: String
    let imageBase64: String?
}

private struct SSEEvent: Decodable {
    let type: String
    let delta: String?
    let messageId: String?
}
