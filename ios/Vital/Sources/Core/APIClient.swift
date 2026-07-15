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
indirect enum JSONValue: Codable, Equatable {
    case int(Int)
    case double(Double)
    case string(String)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Int.self) { self = .int(value) }
        else if let value = try? c.decode(Double.self) { self = .double(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .int(let v):    try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        case .array(let v):  try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null:          try c.encodeNil()
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
        // Send the device's current timezone so the server buckets the diet
        // budget by the user's local day (resets at local midnight, tracks
        // travel). TimeZone.current re-reads the device zone on each call.
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/today?tz=\(encoded)")
    }

    func fetchStreak() async throws -> StreakResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/streak?tz=\(encoded)")
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

    // MARK: - Today's plan

    /// Fetches today's plan timeline. Sends the device's current timezone —
    /// same convention as `fetchToday()` — so the server resolves the same
    /// local day both endpoints agree on.
    func fetchPlan() async throws -> PlanResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/plan?tz=\(encoded)")
    }

    @discardableResult
    func addPlanItem(
        timeMinutes: Int,
        title: String,
        subtitle: String?,
        kind: String,
        kcal: Int? = nil
    ) async throws -> PlanItemDTO {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/plan") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let timeMinutes: Int
            let title: String
            let subtitle: String?
            let kind: String
            let kcal: Int?
        }
        request.httpBody = try encoder.encode(
            Body(timeMinutes: timeMinutes, title: title, subtitle: subtitle, kind: kind, kcal: kcal)
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(PlanItemDTO.self, from: data)
    }

    @discardableResult
    func updatePlanItem(id: String, status: String) async throws -> PlanItemDTO {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/plan") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let id: String; let status: String }
        request.httpBody = try encoder.encode(Body(id: id, status: status))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(PlanItemDTO.self, from: data)
    }

    func deletePlanItem(id: String) async throws {
        guard let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(AppConfig.apiBaseURL)/api/plan?id=\(encodedId)")
        else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    // MARK: - Activity logs

    func fetchLogs(days: Int = 7) async throws -> LogsResponse {
        try await get("/api/logs?days=\(days)")
    }

    // MARK: - Profile

    func fetchProfile() async throws -> ProfileResponse {
        try await get("/api/profile")
    }

    /// PATCH /api/profile — partial update of personal details + sleep goal
    /// (redesign v3 Phase 9). All fields optional; nil fields are omitted from
    /// the request body by JSONEncoder, so only changed fields are sent.
    /// Server units: heightCm in cm, weightKg in kg, sleep values in minutes.
    func updateProfile(
        name: String? = nil,
        age: Int? = nil,
        heightCm: Double? = nil,
        weightKg: Double? = nil,
        sleepGoalMinutes: Int? = nil,
        lightsOutMinutes: Int? = nil
    ) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/profile") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let name: String?
            let age: Int?
            let heightCm: Double?
            let weightKg: Double?
            let sleepGoalMinutes: Int?
            let lightsOutMinutes: Int?
        }
        request.httpBody = try encoder.encode(
            Body(
                name: name, age: age, heightCm: heightCm, weightKg: weightKg,
                sleepGoalMinutes: sleepGoalMinutes, lightsOutMinutes: lightsOutMinutes
            )
        )
        let (_, response) = try await session.data(for: request)
        try validate(response)
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

    /// Restores the server-authoritative transcript, persona, and pending
    /// specialist card. The backend deliberately owns these values; clients
    /// must never infer a persona transition from assistant prose.
    func fetchCoachRestoration() async throws -> CoachRestorationResponse {
        try await get("/api/coach")
    }

    // MARK: - Coach TTS

    /// Fetches ElevenLabs-synthesized speech for one sentence from the backend
    /// TTS proxy (POST /api/tts). Returns nil on any failure — network error,
    /// non-200 (including 503 when the server has no ElevenLabs key), or an
    /// empty body — so the caller can fall back to on-device speech.
    func fetchTTSAudio(text: String) async -> Data? {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/tts") else { return nil }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let text: String }
        guard let body = try? encoder.encode(Body(text: text)) else { return nil }
        request.httpBody = body
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else {
                return nil
            }
            return data
        } catch {
            return nil
        }
    }

    // MARK: - Coach STT

    /// Uploads a recorded `.m4a` clip to the backend STT proxy (POST
    /// /api/stt, ElevenLabs Scribe) and returns the transcript. Returns nil
    /// on any failure — network error, non-200 (including 503 when the
    /// server has no ElevenLabs key), or an empty/missing transcript — so the
    /// caller can fall back to the on-device Apple transcript.
    func uploadSTTAudio(fileURL: URL) async -> String? {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/stt") else { return nil }
        guard let audioData = try? Data(contentsOf: fileURL) else { return nil }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = audioData
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            struct STTResponse: Decodable { let text: String }
            guard let decoded = try? decoder.decode(STTResponse.self, from: data) else { return nil }
            let trimmed = decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        } catch {
            return nil
        }
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
                        guard let event = try? Self.decodeCoachSSELine(line) else { continue }
                        switch event {
                        case .done:
                            continuation.finish()
                            return
                        case .error(let message):
                            continuation.finish(throwing: APIError.coachStreamError(message))
                            return
                        default:
                            continuation.yield(event)
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Sends one explicit specialist-card action over the same SSE endpoint.
    /// `actionId` is supplied by state management so retries remain idempotent.
    func streamCoachAction(
        sessionId: String,
        cardOccurrenceId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
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
                    request.timeoutInterval = 30
                    request.httpBody = try encoder.encode(CoachActionRequestBody(
                        sessionId: sessionId,
                        cardOccurrenceId: cardOccurrenceId,
                        actionId: actionId,
                        action: action
                    ))

                    let (bytes, response) = try await session.bytes(for: request)
                    try validate(response)
                    for try await line in bytes.lines {
                        guard let event = try? Self.decodeCoachSSELine(line) else { continue }
                        switch event {
                        case .done:
                            continuation.finish()
                            return
                        case .error(let message):
                            continuation.finish(throwing: APIError.coachStreamError(message))
                            return
                        default:
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    static func decodeCoachRestoration(_ data: Data) throws -> CoachRestorationResponse {
        try JSONDecoder().decode(CoachRestorationResponse.self, from: data)
    }

    /// Decodes one wire-format SSE line. Unknown event types return nil so
    /// older clients remain forward-compatible with future server additions.
    static func decodeCoachSSELine(_ line: String) throws -> CoachStreamEvent? {
        guard line.hasPrefix("data: ") else { return nil }
        let payload = String(line.dropFirst(6))
        guard let data = payload.data(using: .utf8) else { return nil }
        let event = try JSONDecoder().decode(SSEEvent.self, from: data)
        switch event.type {
        case "text":
            return event.delta.map(CoachStreamEvent.text)
        case "tool_call":
            guard let id = event.id, let name = event.name, let status = event.status else { return nil }
            return .toolCall(id: id, name: name, label: event.label ?? name, done: status == "done")
        case "tool_data":
            guard let id = event.id, let viz = event.viz else { return nil }
            return .toolData(id: id, viz: viz)
        case "handoff_card":
            guard let card = event.handoffCard else { return nil }
            return .handoffCard(card)
        case "persona_changed":
            return event.persona.map(CoachStreamEvent.personaChanged)
        case "done":
            return .done
        case "error":
            return .error(event.error ?? "Coach stream failed.")
        default:
            return nil
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
        imageThumb: String? = nil,
        slot: String? = nil
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
            let slot: String?
        }
        request.httpBody = try encoder.encode(
            Body(name: name, kcal: kcal, c: c, p: p, f: f, source: source, imageThumb: imageThumb, slot: slot)
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(LogMealResponse.self, from: data)
    }

    // MARK: - Diet sheet (today's logged meals)

    /// Fetches logged meals for a given local day (redesign-v3 Phase 6 Logs
    /// day-pager), or today's when `date` is nil (redesign-v3 Phase 3 diet
    /// sheet). Same tz-encoding convention as `fetchToday()` / `fetchPlan()`.
    func fetchMealLogs(date: String? = nil) async throws -> MealLogsResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        var path = "/api/meals/log?tz=\(encoded)"
        if let date {
            path += "&date=\(date)"
        }
        return try await get(path)
    }

    /// Today's logged meals — thin forwarding wrapper kept so existing call
    /// sites (e.g. `DietSheetViewModel`) don't need to change.
    func fetchTodayMealLogs() async throws -> MealLogsResponse {
        try await fetchMealLogs(date: nil)
    }

    func deleteMealLog(id: String) async throws {
        guard let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/log?id=\(encodedId)")
        else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        let (_, response) = try await session.data(for: request)
        try validate(response)
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

    // MARK: - Coach reset

    func resetCoachConversation() async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/coach/reset") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        struct Body: Encodable {}
        request.httpBody = try encoder.encode(Body())
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }
}

// MARK: - Errors

enum APIError: Error, LocalizedError {
    case invalidURL
    case serverError(Int)
    case coachStreamError(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:         return "Invalid backend URL."
        case .serverError(let c): return "Server returned HTTP \(c)."
        case .coachStreamError(let message): return message
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
    let vo2_max: Double?
    let distance_m: Double?
    let exercise_min: Double?
    let flights: Double?
    let basal_energy_kcal: Double?
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
    let distanceM: Double?
    let avgHr: Double?
    let maxHr: Double?
    let paceMinPerKm: Double?
    let elevationGainM: Double?
    let startTime: String?
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
    let grams: Double?
    // NOTE: the backend also sends `per100g` as a macro object, but the app
    // only uses the already-scaled top-level kcal/c/p/f above. It is
    // deliberately not declared here — Decodable ignores undeclared keys.
    // (It was previously typed `Bool?`, which threw a typeMismatch and broke
    // every successful barcode lookup.)
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

struct StreakResponse: Decodable {
    let streakDays: Int
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
    let calibration: CalibrationStatus?
}

// MARK: - Plan types

/// Wire shape of a `/api/plan` row. `status` is server-tracked as
/// pending/done/skipped only — now/next/later is derived client-side from
/// the clock (see `TodayViewModel.computeStatuses`).
struct PlanItemDTO: Decodable {
    let id: String
    let timeMinutes: Int
    let title: String
    let subtitle: String?
    let kind: String   // meal | move | rest | sleep | other
    let source: String // coach | user
    let status: String // pending | done | skipped
    let kcal: Int?
}

struct PlanResponse: Decodable {
    let items: [PlanItemDTO]
}

// MARK: - Meal log types (redesign-v3 diet sheet)

/// Wire shape of a `/api/meals/log` GET row — a single logged meal from
/// today's local day. `slot` is nil for entries logged before the diet sheet
/// existed, or via the photo/barcode/search flow (which doesn't set one).
struct MealLogEntryDTO: Decodable, Identifiable {
    let id: String
    let name: String
    let kcal: Int
    let protein: Int
    let carbs: Int
    let fat: Int
    let slot: String?
    let loggedAt: String
}

struct MealLogsResponse: Decodable {
    let items: [MealLogEntryDTO]
}

// MARK: - Logs types

struct LogItem: Decodable, Identifiable {
    let id: String
    let type: String
    let timestamp: String
    let title: String
    let subtitle: String
    let imageThumb: String?
    /// meal_logged only — kcal eaten (redesign-v3 Phase 6 Logs day-pager).
    let kcal: Double?
    /// workout_completed only — distance in km (redesign-v3 Phase 6).
    let km: Double?
    /// sleep_session only — duration in ms (redesign-v3 Phase 6).
    let sleepMs: Double?
}

struct LogsResponse: Decodable {
    let items: [LogItem]
}

// MARK: - Profile types

struct ProfileIntegration: Decodable {
    let name: String
    let status: String
}

struct ProfileDetails: Decodable {
    let age: Int?
    let biologicalSex: String?
    let heightCm: Double?
    let weightKg: Double?
}

struct ProfileStats: Decodable {
    let loggedDays: Int
    let mealsLogged: Int
    let avgHrv: Double?
    let workouts: Int
}

struct ProfileResponse: Decodable {
    let name: String
    let integrations: [ProfileIntegration]
    let stats: ProfileStats
    let profile: ProfileDetails
    /// ISO timestamp of users.created_at — drives "Member since MMM yyyy".
    let createdAt: String?
    /// Effective sleep goal in minutes (server applies the 480 default).
    let sleepGoalMinutes: Int?
    /// Effective lights-out time as minutes from midnight (server default 1350).
    let lightsOutMinutes: Int?
    /// Same shape Trends/Today carry — decoded here so Profile doesn't need a
    /// separate fetchTrends call just for the calibration banner.
    let calibration: CalibrationStatus?
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

enum SpecialistAction: String, Codable, CaseIterable {
    case acceptHandoff = "accept_handoff"
    case declineHandoff = "decline_handoff"
    case acceptReturn = "accept_return"
    case declineReturn = "decline_return"
}

struct CoachActionRequestBody: Encodable {
    let sessionId: String
    let cardOccurrenceId: String
    let actionId: String
    let action: SpecialistAction
}

struct CoachPersonaSnapshot: Codable, Equatable {
    let id: String
    let title: String
    let subtitle: String
    let accent: String
    let icon: String
    let sessionId: String?

    static let vital = CoachPersonaSnapshot(
        id: "vital",
        title: "Vital Coach",
        subtitle: "Your personal coach",
        accent: "#7C6CF2",
        icon: "sparkles",
        sessionId: nil
    )
}

struct SpecialistMessageMetadata: Codable, Equatable {
    let specialistId: String
    let manifestVersion: String
    let name: String
    let role: String
    let accentColor: String
    let icon: String
}

struct CoachRestoredMessage: Codable, Equatable {
    let id: String
    let role: String
    let speaker: String
    let content: String
    let timestamp: String
    let specialistSessionId: String?
    let specialistMetadata: SpecialistMessageMetadata?
}

enum CoachHandoffPhase: String, Codable, Equatable {
    case proposed
    case returnProposed = "return_proposed"
    case dismissed
}

struct CoachHandoffCard: Codable, Equatable {
    let phase: CoachHandoffPhase
    let sessionId: String
    let cardOccurrenceId: String
    let specialist: CoachPersonaSnapshot
    let objective: String
    let returnSummary: JSONValue?

    init(
        phase: CoachHandoffPhase,
        sessionId: String,
        cardOccurrenceId: String,
        specialist: CoachPersonaSnapshot,
        objective: String,
        returnSummary: JSONValue?
    ) {
        self.phase = phase
        self.sessionId = sessionId
        self.cardOccurrenceId = cardOccurrenceId
        self.specialist = specialist
        self.objective = objective
        self.returnSummary = returnSummary
    }

    var dismissed: CoachHandoffCard {
        CoachHandoffCard(
            phase: .dismissed,
            sessionId: sessionId,
            cardOccurrenceId: cardOccurrenceId,
            specialist: specialist,
            objective: objective,
            returnSummary: returnSummary
        )
    }
}

struct CoachRestorationResponse: Codable, Equatable {
    let messages: [CoachRestoredMessage]
    let activePersona: CoachPersonaSnapshot
    let pendingCard: CoachHandoffCard?
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
    // tool_data field
    let viz: CoachViz?
    // specialist lifecycle fields
    let phase: CoachHandoffPhase?
    let sessionId: String?
    let cardOccurrenceId: String?
    let specialist: CoachPersonaSnapshot?
    let objective: String?
    let returnSummary: JSONValue?
    let persona: CoachPersonaSnapshot?
    let error: String?

    var handoffCard: CoachHandoffCard? {
        guard let phase, let sessionId, let cardOccurrenceId, let specialist, let objective else { return nil }
        return CoachHandoffCard(
            phase: phase,
            sessionId: sessionId,
            cardOccurrenceId: cardOccurrenceId,
            specialist: specialist,
            objective: objective,
            returnSummary: returnSummary
        )
    }
}

// MARK: - Coach inline data-viz

struct CoachVizPoint: Decodable, Hashable {
    let label: String
    let value: Double
}

/// Structured result of a chartable coach tool (get_metric_trend /
/// get_sleep_summary / compare_periods), rendered inline in the chat.
struct CoachViz: Decodable, Hashable {
    let kind: String            // "trend" | "sleep" | "compare"
    let title: String
    let unit: String?
    // trend + sleep
    let points: [CoachVizPoint]?
    // trend
    let mean: Double?
    let baseline: Double?
    let deltaPct: Double?
    // sleep
    let meanMinutes: Double?
    let consistency: String?
    // compare
    let currentMean: Double?
    let previousMean: Double?
    let delta: Double?
}

/// A single event surfaced from the coach SSE stream: a text delta to append to
/// the streaming reply, a tool-call lifecycle update (started/done) rendered as
/// an inline activity row, or the structured data for a chartable tool.
enum CoachStreamEvent: Equatable {
    case text(String)
    case toolCall(id: String, name: String, label: String, done: Bool)
    case toolData(id: String, viz: CoachViz)
    case handoffCard(CoachHandoffCard)
    case personaChanged(CoachPersonaSnapshot)
    case done
    case error(String)
}

@MainActor
protocol CoachAPIProviding {
    func uploadSTTAudio(fileURL: URL) async -> String?
    func fetchCoachRestoration() async throws -> CoachRestorationResponse
    func fetchCoachOpener() async throws -> String
    func resetCoachConversation() async throws
    func streamCoach(
        message: String,
        imageBase64: String?,
        mode: String?
    ) -> AsyncThrowingStream<CoachStreamEvent, Error>
    func streamCoachAction(
        sessionId: String,
        cardOccurrenceId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error>
}

extension APIClient: CoachAPIProviding {}
