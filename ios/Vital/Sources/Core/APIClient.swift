import Foundation

// MARK: - App configuration

enum AppConfig {
    /// Base URL for the Vital backend.
    /// Simulator talks to the local dev server; device builds use Fly.io.
    static let apiBaseURL: String = {
        #if targetEnvironment(simulator)
        return "http://localhost:3000"
        #else
        return "https://vital-coach.fly.dev"
        #endif
    }()
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

// MARK: - Session lifecycle

extension Notification.Name {
    /// Posted by `APIClient` when the backend rejects the session token with a
    /// 401. `AuthViewModel` observes this and signs the user out, so an expired
    /// or invalidated token returns them to the sign-in screen instead of
    /// leaving a "signed in" session where every request silently 401s.
    static let vitalSessionExpired = Notification.Name("vitalSessionExpired")
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
    /// Only the signed-in user's Keychain session token is ever attached —
    /// there is deliberately no fallback credential, so signing out revokes
    /// API access. Unauthenticated requests go out without an Authorization
    /// header and are rejected by the server.
    private func authorizedRequest(_ url: URL) -> URLRequest {
        var r = URLRequest(url: url)
        if let token = KeychainStore.loadSessionToken() {
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return r
    }

    /// Single choke point for HTTP status handling: throws
    /// `APIError.serverError` for any >= 400 response, and additionally
    /// broadcasts `.vitalSessionExpired` on a 401 so the app can drop a dead
    /// session. Every request path routes its response through this.
    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode >= 400 else { return }
        if http.statusCode == 401 {
            NotificationCenter.default.post(name: .vitalSessionExpired, object: nil)
        }
        throw APIError.serverError(http.statusCode)
    }

    // MARK: - Generic GET

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)\(path)") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Today dashboard

    func fetchToday() async throws -> TodayResponse {
        try await get("/api/today")
    }

    // MARK: - Diet goal / budget

    func fetchDietGoal() async throws -> DietGoalResponse {
        try await get("/api/diet-goal")
    }

    /// PATCH the diet goal and/or the calorie+macro override. Pass `mode: "auto"`
    /// to clear the override, or `mode: "custom"` with all four numbers to pin it.
    /// nil fields are omitted from the request body by JSONEncoder.
    @discardableResult
    func updateDietGoal(
        goal: String? = nil,
        mode: String? = nil,
        targetKcal: Int? = nil,
        protein: Int? = nil,
        carbs: Int? = nil,
        fat: Int? = nil
    ) async throws -> DietGoalResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/diet-goal") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let goal: String?
            let mode: String?
            let targetKcal: Int?
            let protein: Int?
            let carbs: Int?
            let fat: Int?
        }
        request.httpBody = try encoder.encode(
            Body(goal: goal, mode: mode, targetKcal: targetKcal, protein: protein, carbs: carbs, fat: fat)
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(DietGoalResponse.self, from: data)
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
        try validate(response)
    }

    // MARK: - Coach opener (fresh, data-aware greeting per open)

    /// Fetches a short, data-aware opening line for the Coach tab. Generated
    /// fresh on every open and never persisted server-side, so the chat opens
    /// with something new about the user's data instead of a static greeting.
    func fetchCoachOpener() async throws -> String {
        struct OpenerResponse: Decodable { let text: String }
        let r: OpenerResponse = try await get("/api/coach/opener")
        return r.text
    }

    // MARK: - Coach (SSE streaming)

    func streamCoach(message: String, imageBase64: String? = nil, mode: String? = nil) -> AsyncThrowingStream<CoachStreamEvent, Error> {
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

                    let body = CoachRequestBody(message: message, imageBase64: imageBase64, mode: mode)
                    request.httpBody = try encoder.encode(body)

                    let (bytes, response) = try await session.bytes(for: request)

                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        if http.statusCode == 401 {
                            NotificationCenter.default.post(name: .vitalSessionExpired, object: nil)
                        }
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
                                continuation.yield(.text(delta))
                            }
                        case "tool_call":
                            // Requires id/name/status; unrecognized shapes are dropped
                            // rather than crashing the stream.
                            guard let id = event.id, let name = event.name, let status = event.status else { break }
                            let label = event.label ?? name
                            continuation.yield(.toolCall(id: id, name: name, label: label, done: status == "done"))
                        case "done":
                            continuation.finish()
                            return
                        default:
                            // Forward-compatible: unknown event types are ignored so the
                            // stream stays robust to backend additions.
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
        try validate(response)
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
        try validate(response)
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
        try validate(response)
        return try decoder.decode(NutritionResult.self, from: data)
    }

    // MARK: - Meal plan (modify + recipe)

    /// Estimates/edits a planned meal. With `instruction == nil` (or empty) the
    /// server keeps `kcal` and just fills macros (auto-estimate on modal open);
    /// with an instruction it applies the natural-language edit and re-estimates.
    func modifyMeal(name: String, kcal: Double, instruction: String?) async throws -> MealModifyResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/modify") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        struct Body: Encodable { let name: String; let kcal: Double; let instruction: String? }
        request.httpBody = try encoder.encode(Body(name: name, kcal: kcal, instruction: instruction))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(MealModifyResult.self, from: data)
    }

    /// Fetches a markdown recipe (ingredients + numbered steps) for a meal by name.
    func mealRecipe(name: String, servings: Int? = nil) async throws -> String {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/recipe") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        struct Body: Encodable { let name: String; let servings: Int? }
        request.httpBody = try encoder.encode(Body(name: name, servings: servings))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        struct RecipeResponse: Decodable { let recipe: String }
        return try decoder.decode(RecipeResponse.self, from: data).recipe
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
        try validate(response)
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
        try validate(response)
    }

    // MARK: - Daily ingest (1-year backfill + background sync)

    /// Posts day-keyed HealthKit summaries to `/api/ingest/daily`, which
    /// upserts into `daily_metrics` (unique on user/date/metric) and
    /// recomputes baselines server-side. Idempotent — re-posting the same
    /// day is a no-op write, which is what makes chunk retries and resume
    /// safe. Returns the server-reported upserted row count.
    func postDailyIngest(days: [DailyIngestDay]) async throws -> Int {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/ingest/daily") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try encoder.encode(DailyIngestRequestBody(days: days))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(DailyIngestResponse.self, from: data).upserted
    }

    // MARK: - Onboarding

    /// Submits the full onboarding questionnaire in one shot. The server
    /// fills per-user memory files from these answers and marks
    /// `users.onboarded_at`, which is what `/api/profile` and the auth
    /// endpoints subsequently report back as `onboarded`.
    func postOnboarding(
        basics: OnboardingBasics,
        training: OnboardingTraining,
        health: OnboardingHealth,
        lifestyle: OnboardingLifestyle
    ) async throws -> OnboardingResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/onboarding") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        request.httpBody = try encoder.encode(OnboardingRequestBody(
            basics: basics, training: training, health: health, lifestyle: lifestyle
        ))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(OnboardingResponse.self, from: data)
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

// MARK: - Daily ingest DTOs
//
// Mirror app/api/ingest/daily/route.ts's request schema exactly — including
// its snake_case metric keys — so the encoder can rely on Swift's default
// key encoding (no CodingKeys needed). Property names ARE the wire format.

/// One day's HealthKit summary, as posted to `/api/ingest/daily`.
struct DailyIngestDay: Encodable {
    let date: String // 'YYYY-MM-DD'
    let metrics: DailyIngestMetrics?
    let sleep: DailyIngestSleep?
    let workouts: [DailyIngestWorkout]?
}

struct DailyIngestMetrics: Encodable {
    let hrv_sdnn: Double?
    let resting_hr: Double?
    let hr_avg: Double?
    let steps: Double?
    let active_energy_kcal: Double?
    let body_mass_kg: Double?
}

struct DailyIngestSleep: Encodable {
    let minutes: Int
    let stages: DailyIngestSleepStages?
}

struct DailyIngestSleepStages: Encodable {
    let core: Int?
    let deep: Int?
    let rem: Int?
    let awake: Int?
}

struct DailyIngestWorkout: Encodable {
    let hkUuid: String
    let type: String
    let durationMin: Double
    let kcal: Double
}

private struct DailyIngestRequestBody: Encodable {
    let days: [DailyIngestDay]
}

private struct DailyIngestResponse: Decodable {
    let upserted: Int
}

// MARK: - Onboarding DTOs
//
// Mirror POST /api/onboarding's request schema exactly (see hand-off plan,
// Phase 5): { basics, training, health, lifestyle } → { ok, onboarded }.

struct OnboardingBasics: Encodable {
    let name: String
    let dob: String // 'YYYY-MM-DD'
    let sex: String
    let heightCm: Double
    let weightKg: Double
    let units: String
    let goal: String
    let targetDate: String? // 'YYYY-MM-DD'
}

struct OnboardingTraining: Encodable {
    let frequency: Int
    let types: [String]
    let experience: String
    let volumeNotes: String?
}

struct OnboardingHealth: Encodable {
    let injuries: String?
    let conditions: String?
    let medications: String?
}

struct OnboardingLifestyle: Encodable {
    let sleepSchedule: String?
    let stress: String?
    let diet: String?
}

private struct OnboardingRequestBody: Encodable {
    let basics: OnboardingBasics
    let training: OnboardingTraining
    let health: OnboardingHealth
    let lifestyle: OnboardingLifestyle
}

struct OnboardingResponse: Decodable {
    let ok: Bool
    let onboarded: Bool
}

// MARK: - Nutrition & Meal

struct NutritionResult: Decodable {
    let name: String
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
}

/// Result of POST /api/meals/modify — an estimated/edited planned meal.
struct MealModifyResult: Decodable {
    let name: String
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    let why: String
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
    // value/deltaPct are null for a user with no data yet (fresh account
    // before any ingest) — non-optional decoding would reject the whole
    // /api/today payload and silently drop insight + calibration with it.
    let value: Double?
    let unit: String
    let deltaPct: Int?
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
    // Macro TARGETS — server-authoritative (was a fixed 30/40/30 split on-device).
    // Optional for backwards-compat with an older backend during rollout.
    let proteinTarget: Int?
    let carbsTarget: Int?
    let fatTarget: Int?
    let mode: String?  // "auto" | "custom"
    let goal: String?
}

struct TodayPlanItem: Decodable {
    let name: String
    let kcal: Int
    let why: String
}

struct CalibrationMetric: Decodable {
    let dataDays: Int
    let established: Bool
}

struct CalibrationStatus: Decodable {
    let status: String // "calibrating" or "ready"
    let metrics: [String: CalibrationMetric]
}

struct TodayResponse: Decodable {
    let metrics: TodayMetrics
    let dietBudget: TodayDietBudget
    let insight: String
    let plan: [TodayPlanItem]
    let calibration: CalibrationStatus?
}

// MARK: - Diet goal types

struct DietBudgetDTO: Decodable {
    let mode: String       // "auto" | "custom"
    let goal: String       // "weight_loss" | "muscle" | "endurance" | "general"
    let targetKcal: Int
    let protein: Int
    let carbs: Int
    let fat: Int
    let tdee: Int?         // present for auto only
}

struct DietGoalResponse: Decodable {
    let current: DietBudgetDTO
    let auto: DietBudgetDTO
    let goals: [String]
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
    let mode: String?
}

private struct SSEEvent: Decodable {
    let type: String
    let delta: String?
    let messageId: String?
    // tool_call fields
    let id: String?
    let name: String?
    let label: String?
    let status: String?
}

/// A single event surfaced from the coach SSE stream: either a text delta to
/// append to the streaming reply, or a tool-call lifecycle update (started/done)
/// that the UI renders as an inline activity row.
enum CoachStreamEvent {
    case text(String)
    case toolCall(id: String, name: String, label: String, done: Bool)
}
