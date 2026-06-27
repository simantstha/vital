import Foundation

// MARK: - App configuration

enum AppConfig {
    /// Base URL for the Vital backend. Override via scheme env vars for staging/prod.
    static let apiBaseURL = "http://localhost:3000"
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
    /// Matches the `type` column in the `events` table (e.g. "hrv_reading", "sleep_session").
    let type: String
    /// ISO8601 timestamp of when the reading was captured on-device.
    let timestamp: Date
    /// Metric-specific key/value pairs (e.g. `{"valueMs": 71}`).
    let payload: [String: JSONValue]
}

// MARK: - APIClient

/// Async URLSession client for the Vital Next.js backend.
/// Methods are fire-and-forget friendly — callers typically wrap in `try?`.
struct APIClient {
    static let shared = APIClient()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    // MARK: Ingest

    /// Posts an array of HealthKit deltas to `POST /api/ingest`.
    func postIngest(_ deltas: [HealthDelta]) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/ingest") else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10

        let body = IngestRequestBody(deltas: deltas)
        request.httpBody = try encoder.encode(body)

        let (_, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
    }
}

// MARK: - Supporting types

private struct IngestRequestBody: Encodable {
    let deltas: [HealthDelta]
}

enum APIError: Error, LocalizedError {
    case invalidURL
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:          return "Invalid backend URL."
        case .serverError(let c):  return "Server returned HTTP \(c)."
        }
    }
}
