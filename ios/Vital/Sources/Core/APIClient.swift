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

    // MARK: Coach (SSE streaming)

    /// Streams coach reply tokens from `POST /api/coach` via Server-Sent Events.
    ///
    /// The backend emits `data: {"type":"text","delta":"…"}` lines as tokens arrive
    /// and terminates with `data: {"type":"done","messageId":"…"}`.
    /// Each yielded `String` is one text delta.
    func streamCoach(message: String, imageBase64: String? = nil) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/coach") else {
                        continuation.finish(throwing: APIError.invalidURL)
                        return
                    }

                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.timeoutInterval = 60

                    let body = CoachRequestBody(message: message, imageBase64: imageBase64)
                    request.httpBody = try encoder.encode(body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        continuation.finish(throwing: APIError.serverError(http.statusCode))
                        return
                    }

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: ") else { continue }
                        let jsonSlice = line.dropFirst(6) // strip "data: "
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

    // MARK: Nutrition search

    /// `POST /api/nutrition/search` — free-text food lookup.
    func searchFood(_ query: String) async throws -> NutritionResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/search") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let query: String }
        request.httpBody = try encoder.encode(Body(query: query))
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try JSONDecoder().decode(NutritionResult.self, from: data)
    }

    /// `POST /api/nutrition/barcode` — barcode product lookup.
    func barcodeFood(_ barcode: String, grams: Double? = nil) async throws -> BarcodeResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/barcode") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let barcode: String; let grams: Double? }
        request.httpBody = try encoder.encode(Body(barcode: barcode, grams: grams))
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try JSONDecoder().decode(BarcodeResult.self, from: data)
    }

    /// `POST /api/nutrition/photo` — AI food identification from a JPEG base-64 string.
    func photoFood(imageBase64: String) async throws -> NutritionResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nutrition/photo") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        struct Body: Encodable { let imageBase64: String }
        request.httpBody = try encoder.encode(Body(imageBase64: imageBase64))
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try JSONDecoder().decode(NutritionResult.self, from: data)
    }

    /// `POST /api/meals/log` — persist a meal event; returns coach reaction.
    @discardableResult
    func logMeal(
        name: String,
        kcal: Double,
        c: Double,
        p: Double,
        f: Double,
        source: String
    ) async throws -> LogMealResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/log") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let name: String; let kcal: Double
            let c: Double; let p: Double; let f: Double; let source: String
        }
        request.httpBody = try encoder.encode(Body(name: name, kcal: kcal, c: c, p: p, f: f, source: source))
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.serverError(http.statusCode)
        }
        return try JSONDecoder().decode(LogMealResponse.self, from: data)
    }

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

// MARK: - Nutrition & Meal response types

struct NutritionResult: Decodable {
    let name: String
    let kcal: Double
    let c: Double    // carbs
    let p: Double    // protein
    let f: Double    // fat
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
