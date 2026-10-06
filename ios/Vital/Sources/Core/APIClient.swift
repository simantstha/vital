import Foundation
import os

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

    /// Posted by `CoachViewModel` right after a `meal_logged` SSE event lands
    /// (a coach-driven meal log) or a receipt's Undo completes successfully.
    /// `TodayViewModel` observes this and re-fetches `/api/today` so the fuel
    /// strip's diet card updates without waiting for pull-to-refresh — the
    /// same foreground-observer pattern it already uses for calendar/app
    /// lifecycle events (see `TodayViewModel.init`).
    static let vitalCoachMealLogChanged = Notification.Name("vitalCoachMealLogChanged")}

// MARK: - APIClient

struct APIClient {
    static let shared = APIClient()

    /// Subsystem/category shared by every `os.Logger` call in this type —
    /// same convention as `VoiceTurnTimer`'s "voice" category, so Console/
    /// Instruments can filter the whole voice pipeline (timing + STT
    /// fallback visibility) together.
    private static let voiceLogger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.simantstha.vital",
        category: "voice"
    )

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
        // Screenshot harness (`-VitalFixture <scenario>`): process-wide
        // `URLProtocol.registerClass` (AppDelegate) doesn't reliably cover a
        // custom-configured session like this one — see `FixtureMode.apply`.
        // No-op (and compiled out of Release entirely) under a normal launch.
        #if DEBUG
        FixtureMode.apply(to: config)
        #endif
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
    func validate(_ response: URLResponse) throws {
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

    /// Batch fetch — one round trip for every tile on the Trends grid index,
    /// each series carrying its baseline stats (`?metrics=a,b,c`, the branch
    /// added alongside the single-metric `?metric=` route). `metrics` are raw
    /// `daily_metrics` names (`hrv_sdnn`, not the legacy `hrv` alias `fetchTrends`
    /// still speaks). Unknown names are dropped server-side and echoed back in
    /// `unknownMetrics` rather than 400ing the whole request.
    func fetchTrendsBatch(metrics: [String], days: Int) async throws -> TrendsBatchResponse {
        let joined = metrics.joined(separator: ",")
        let encoded = joined.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? joined
        return try await get("/api/trends?metrics=\(encoded)&days=\(days)")
    }

    /// "What moves your HRV" — `metric` is a raw `daily_metrics` outcome name
    /// (e.g. `hrv_sdnn`). See `app/api/trends/drivers/route.ts` for the
    /// contract: `drivers` is empty (never a 400/404) when the engine has no
    /// certified cross-lag findings for this metric yet.
    func fetchTrendsDrivers(metric: String) async throws -> TrendsDriversResponse {
        let encoded = metric.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? metric
        return try await get("/api/trends/drivers?metric=\(encoded)")
    }

    /// Day-keyed chart markers (workouts only, for now) for the detail
    /// chart's floor annotations. See `app/api/trends/markers/route.ts`.
    func fetchTrendsMarkers(days: Int) async throws -> TrendsMarkersResponse {
        try await get("/api/trends/markers?days=\(days)")
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

    /// Sends the device's current timezone so the server buckets
    /// `dietByDay` (and the injected HealthKit nutrition item) by the user's
    /// local day — same tz-encoding convention as `fetchToday()` /
    /// `fetchMealLogs()`.
    func fetchLogs(days: Int = 7) async throws -> LogsResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/logs?days=\(days)&tz=\(encoded)")
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
        lightsOutMinutes: Int? = nil,
        unitSystem: String? = nil
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
            let unitSystem: String?
        }
        request.httpBody = try encoder.encode(
            Body(
                name: name, age: age, heightCm: heightCm, weightKg: weightKg,
                sleepGoalMinutes: sleepGoalMinutes, lightsOutMinutes: lightsOutMinutes,
                unitSystem: unitSystem
            )
        )
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    /// PATCH /api/profile with the three goal targets. Unlike `updateProfile`
    /// (which omits nil fields), every field is always sent and a nil value is
    /// encoded as an explicit JSON `null`, which the server treats as "clear".
    func updateGoalTargets(
        targetWeightKg: Double?,
        targetDate: String?,
        weeklySessionsTarget: Int?
    ) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/profile") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let targetWeightKg: Double?
            let targetDate: String?
            let weeklySessionsTarget: Int?
            enum CodingKeys: String, CodingKey { case targetWeightKg, targetDate, weeklySessionsTarget }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(targetWeightKg, forKey: .targetWeightKg)
                try c.encode(targetDate, forKey: .targetDate)
                try c.encode(weeklySessionsTarget, forKey: .weeklySessionsTarget)
            }
        }
        request.httpBody = try encoder.encode(
            Body(targetWeightKg: targetWeightKg, targetDate: targetDate, weeklySessionsTarget: weeklySessionsTarget)
        )
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    // MARK: - Pending facts

    func fetchPendingFacts() async throws -> PendingFactsResponse {
        try await get("/api/pending-facts")
    }

    /// Confirms or dismisses a pending fact. Returns the newly-promoted
    /// fact's `nodeId` on a `confirm` that actually promoted one (see
    /// `app/api/pending-facts/resolve/route.ts`) — `nil` on `reject`, or on a
    /// `confirm` with nothing to promote. This is the ONLY id
    /// `APIClient.undoMemoryFact(id:)` accepts for a fact confirmed this way;
    /// the pending fact's own `id` (this call's `id` parameter) is a
    /// different row and is never a valid undo target.
    @discardableResult
    func resolvePendingFact(id: String, action: String) async throws -> String? {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/pending-facts/resolve") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        struct Body: Encodable { let id: String; let action: String }
        request.httpBody = try encoder.encode(Body(id: id, action: action))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        struct ResolveResponse: Decodable { let nodeId: String? }
        return (try? decoder.decode(ResolveResponse.self, from: data))?.nodeId
    }

    /// `POST /api/memory/facts/{factId}/undo` — chat-activity-contract.md §2.
    /// Reverts a memory-write's `saved` result. 404 for an unknown id or
    /// another user's fact; 401 without auth (both surfaced via `validate`).
    func undoMemoryFact(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/memory/facts/\(encoded)/undo") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    // MARK: - Weight log (Today weight_loss hero, §5.3)

    /// GET /api/weight-log?days=&tz= — merged manual + HealthKit weigh-in
    /// history plus the smoothed trend (see `app/api/weight-log/route.ts` /
    /// `lib/weightTrend.ts`). Sends the device's current timezone — same
    /// convention as `fetchToday()` — so the server buckets entries by the
    /// user's local day.
    func fetchWeightLog(days: Int = 35) async throws -> WeightLogResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/weight-log?days=\(days)&tz=\(encoded)")
    }

    /// POST /api/weight-log — logs a manual (or HealthKit-confirmed) weigh-in.
    /// `unit` is the wire value the route expects: `"lbs"` or `"kg"` (not
    /// `UnitSystem.weightUnit`'s `"lb"`/`"kg"`), and `date` is `YYYY-MM-DD`.
    func logWeight(weight: Double, unit: String, date: String) async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/weight-log") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let weight: Double; let unit: String; let date: String }
        request.httpBody = try encoder.encode(Body(weight: weight, unit: unit, date: date))
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    // MARK: - Training summary (Today muscle/endurance heroes, #202)

    /// GET /api/training/summary?tz= — feeds the muscle/endurance Today
    /// heroes' "last time" lift, "this week" session dots, and weekly
    /// endurance volume, all omitted from the original heroes (#199) for
    /// lack of this endpoint. Sends the device's current timezone — same
    /// convention as `fetchToday()`/`fetchPlan()` — so the server resolves
    /// the same local week both endpoints agree on. See
    /// `lib/trainingSummary.ts`'s doc comment for the exact honesty-rule
    /// nullability of every field in `TrainingSummaryResponse`.
    func fetchTrainingSummary() async throws -> TrainingSummaryResponse {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/training/summary?tz=\(encoded)")
    }

    // MARK: - Goal progress (v5 Wave 2 - "am I on track?")

    /// GET /api/goal/progress?tz= — target / current / rate / ETA / verdict /
    /// reasons for the user's goal. Sends the device's timezone — same
    /// convention as `fetchToday()` — so the server resolves day math in the
    /// same local zone. See `GoalProgressDTO`.
    func fetchGoalProgress() async throws -> GoalProgressDTO {
        let tz = TimeZone.current.identifier
        let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
        return try await get("/api/goal/progress?tz=\(encoded)")
    }

    // MARK: - Strength tracking (workout_sets — Trends Strength card + lift logger)

    /// GET /api/workouts/summary?days= — weekly best estimated 1RM and weekly
    /// volume per exercise, keyed by canonical exercise name. `exercises` is
    /// `{}` (never an error) for a user with no logged sets.
    func fetchWorkoutSummary(days: Int = 84) async throws -> WorkoutSummaryResponse {
        try await get("/api/workouts/summary?days=\(days)")
    }

    /// GET /api/workouts/last?exercise= — the most recent full session that
    /// included `exercise` (every set in that session, all exercises, ordered
    /// by exercise name then set index). `sets` is `[]` when `exercise` has
    /// never been logged. `exercise` is the canonical (lowercase) key, i.e. a
    /// key of `WorkoutSummaryResponse.exercises`.
    func fetchLastWorkoutSession(exercise: String) async throws -> WorkoutLastSessionResponse {
        let encoded = exercise.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? exercise
        return try await get("/api/workouts/last?exercise=\(encoded)")
    }

    /// POST /api/workouts/sets — logs one session of sets. `sessionId` must be
    /// a client-generated UUID string (the `session_id` column is a uuid); a
    /// retried POST with the same id + set indexes upserts rather than
    /// duplicating. `source` is "manual" | "template" ("coach" is server-side
    /// only in practice).
    @discardableResult
    func logWorkoutSets(
        sessionId: String,
        source: String,
        sets: [WorkoutSetInputDTO],
        performedAt: Date = Date(),
        tz: String? = nil
    ) async throws -> LogWorkoutSetsResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/workouts/sets") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable {
            let sessionId: String
            let performedAt: Date
            let tz: String
            let source: String
            let sets: [WorkoutSetInputDTO]
        }
        request.httpBody = try encoder.encode(
            Body(
                sessionId: sessionId,
                performedAt: performedAt,
                tz: tz ?? TimeZone.current.identifier,
                source: source,
                sets: sets
            )
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(LogWorkoutSetsResponse.self, from: data)
    }

    // MARK: - Memory browser

    /// GET /api/memory — the "About you" fact summary plus every entity
    /// (person, place, etc.) the ontology has learned about, for the Memory
    /// tab. See `MemoryResponse` below for the shape.
    func fetchMemory() async throws -> MemoryResponse {
        try await get("/api/memory")
    }

    /// GET /api/memory/entities/{id} — the full fact document for a single
    /// entity, including verbatim evidence quotes. `id` is percent-encoded
    /// defensively even though entity ids are currently opaque server ids.
    func fetchEntityDocument(id: String) async throws -> EntityDocumentResponse {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await get("/api/memory/entities/\(encoded)")
    }

    /// PATCH /api/memory/facts/{factId} — memory-contract.md §2. The server
    /// SUPERSEDEs the fact rather than overwriting it, so the returned
    /// `fact` is a NEW node with a new `id`; `MemoryViewModel.saveEdit`
    /// replaces the edited row with it wholesale rather than patching the
    /// label in place. 404 for an unknown/foreign/inactive fact, 400 for an
    /// empty or over-length label, 401 without auth (all via `validate`).
    func editMemoryFact(id: String, label: String) async throws -> MemoryFact {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/memory/facts/\(encoded)") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        struct Body: Encodable { let label: String }
        request.httpBody = try encoder.encode(Body(label: label))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        struct EditResponse: Decodable { let ok: Bool; let fact: MemoryFact }
        return try decoder.decode(EditResponse.self, from: data).fact
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
    /// /api/stt, ElevenLabs Scribe) and returns either the transcript or a
    /// self-diagnosing failure. There is no on-device Apple fallback
    /// anymore (per the owner decision to go cloud-STT-only, like the Claude
    /// app) — `CoachVoiceController.beginTranscription()` surfaces
    /// `failure.diagnostic` directly to the user rather than silently
    /// degrading, so every failure branch here must carry a short, real
    /// reason instead of collapsing to `nil`.
    func uploadSTTAudio(fileURL: URL) async -> STTUploadResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/stt") else { return .failure(.network) }
        guard let audioData = try? Data(contentsOf: fileURL) else {
            Self.voiceLogger.error("uploadSTTAudio: could not read recorded file at \(fileURL.lastPathComponent, privacy: .public)")
            return .failure(.file)
        }
        let fileSizeBytes = audioData.count
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = audioData
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                Self.voiceLogger.error("uploadSTTAudio: no HTTP response (bytes=\(fileSizeBytes, privacy: .public))")
                return .failure(.network)
            }
            guard http.statusCode == 200 else {
                struct STTErrorBody: Decodable {
                    let error: String?
                    let upstreamStatus: Int?
                    let detail: String?
                }
                let body = try? decoder.decode(STTErrorBody.self, from: data)
                Self.voiceLogger.error("uploadSTTAudio: non-200 response (status=\(http.statusCode, privacy: .public), error=\(body?.error ?? "?", privacy: .public), bytes=\(fileSizeBytes, privacy: .public))")
                if body?.error == "upstream" {
                    let status = body?.upstreamStatus ?? http.statusCode
                    let detail = body?.detail ?? "unknown"
                    return .failure(.http(status: status, detail: detail))
                }
                let detail = body?.error ?? "status \(http.statusCode)"
                return .failure(.http(status: http.statusCode, detail: detail))
            }
            struct STTResponse: Decodable { let text: String }
            guard let decoded = try? decoder.decode(STTResponse.self, from: data) else {
                Self.voiceLogger.error("uploadSTTAudio: failed to decode response body (bytes=\(fileSizeBytes, privacy: .public))")
                return .failure(.http(status: http.statusCode, detail: "bad_response"))
            }
            let trimmed = decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                Self.voiceLogger.error("uploadSTTAudio: 200 response with empty transcript (bytes=\(fileSizeBytes, privacy: .public))")
                return .failure(.http(status: http.statusCode, detail: "empty_transcript"))
            }
            return .success(trimmed)
        } catch {
            Self.voiceLogger.error("uploadSTTAudio: request threw \(String(describing: error), privacy: .public) (bytes=\(fileSizeBytes, privacy: .public))")
            return .failure(.network)
        }
    }

    // MARK: - Coach (SSE streaming)

    func streamCoach(message: String, imageBase64: String? = nil, mode: String? = nil, findingId: String? = nil, voice: Bool? = nil, clientTurnId: String? = nil) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/coach") else {
                        continuation.finish(throwing: APIError.invalidURL)
                        return
                    }

                    var request = authorizedRequest(url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.timeoutInterval = 60

                    let body = CoachRequestBody(message: message, imageBase64: imageBase64, mode: mode, findingId: findingId, voice: voice, clientTurnId: clientTurnId)
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
                        try Task.checkCancellation()
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
                } catch is CancellationError {
                    // Consumer stopped iterating (view disappeared, enclosing
                    // Task cancelled) — nobody is listening, so finish quietly
                    // instead of surfacing a spurious error.
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
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
            let task = Task {
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
                        try Task.checkCancellation()
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
                } catch is CancellationError {
                    // Consumer stopped iterating — finish quietly rather than
                    // surfacing a spurious error to nobody.
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
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
            return .toolCall(
                id: id, name: name, label: event.label ?? name, done: status == "done",
                kind: event.kind, ok: event.ok, summary: event.summary,
                sources: event.sources, memory: event.memory
            )
        case "tool_data":
            guard let id = event.id, let viz = event.viz else { return nil }
            return .toolData(id: id, viz: viz)
        case "meal_logged":
            guard let id = event.id, let name = event.name,
                  let kcal = event.kcal, let p = event.p, let c = event.c, let f = event.f
            else { return nil }
            return .mealLogged(CoachMealReceipt(id: id, name: name, kcal: kcal, p: p, c: c, f: f, items: event.items))
        case "meal_unlogged":
            guard let id = event.id else { return nil }
            return .mealUnlogged(id: id)
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
        // The barcode endpoint uses 404 exclusively for a genuine "every
        // source missed" lookup miss (bad input is 400, a DB/lookup fault is
        // 500) and pairs it with `{ offerTextSearch: true }` — surface that
        // as a distinguishable case ahead of the generic `validate` choke
        // point so the caller can fall back to text search instead of
        // showing a generic server-error message.
        if let http = response as? HTTPURLResponse, http.statusCode == 404 {
            throw APIError.barcodeNotFound
        }
        try validate(response)
        return try decoder.decode(BarcodeResult.self, from: data)
    }

    /// GET /api/nutrition/recents — the user's own recently logged meals,
    /// deduped and ranked server-side, for the "log again" quick-pick list.
    func fetchNutritionRecents() async throws -> [RecentFood] {
        let wrapper: RecentFoodsResponse = try await get("/api/nutrition/recents")
        return wrapper.items
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
        slot: String? = nil,
        // Opt-out for callers that never display `LogMealResponse
        // .coachReaction` (redesign-v4's instant Diet-sheet log paths —
        // ActionToast's Undo receipt doesn't show it). `nil` (the default)
        // keeps the server's existing behavior of always producing a
        // reaction; `false` skips the slow Haiku call server-side. See
        // `app/api/meals/log/route.ts`'s `reaction` param (PR #206) — an
        // older server simply ignores the unknown key.
        reaction: Bool? = nil,
        // Optional per-item grounded breakdown (see `PhotoEstimatorItem`),
        // round-tripped from `photoFood`'s `NutritionResult.estimatorItems`
        // — see app/api/meals/log/route.ts's doc comment for the server-side
        // validation/5%-totals-match rule. `nil` (every non-photo call site,
        // and a photo save whose totals no longer match after an edit) omits
        // the key entirely, unchanged from before this field existed.
        estimatorItems: [PhotoEstimatorItem]? = nil
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
            let reaction: Bool?
            let estimatorItems: [PhotoEstimatorItem]?
        }
        request.httpBody = try encoder.encode(
            Body(
                name: name, kcal: kcal, c: c, p: p, f: f, source: source, imageThumb: imageThumb, slot: slot,
                reaction: reaction, estimatorItems: estimatorItems
            )
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(LogMealResponse.self, from: data)
    }

    /// POST /api/meals/quick — the Siri/App Intents, Shortcuts, Action
    /// Button and meal-reminder-notification "quick log" entry point.
    /// Unlike `logMeal`, this never produces (or waits on) a coach reaction
    /// — quick logs are instant and silent product-wise (see the route's
    /// doc comment) — and writes `source: 'quick'` server-side, not
    /// `'coach'`, so `delete_meal` can never reach it; undo goes through
    /// `deleteMealLog(id:)` below instead.
    /// Throws `APIError.mealNotFound` (mirroring `.barcodeNotFound`) for the
    /// route's 404 `{ error: 'not_found' }` — no nutrition candidate matched
    /// `text`.
    func quickLogMeal(text: String, tz: String? = nil) async throws -> QuickLogResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/quick") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let text: String; let tz: String? }
        request.httpBody = try encoder.encode(Body(text: text, tz: tz ?? TimeZone.current.identifier))
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 404 {
            throw APIError.mealNotFound
        }
        try validate(response)
        return try decoder.decode(QuickLogResponse.self, from: data)
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

    /// Scales a logged meal by `factor` (the portion chips — ½× · 1× · 1.5×
    /// · 2×) via `POST /api/meals/scale`, which also records the resulting
    /// portion as this user's remembered typical grams for that meal's items
    /// (see the route's doc comment). Server-side only; `grams`-mode isn't
    /// exposed here since the chips only ever send a multiplier.
    func scaleMealLog(id: String, factor: Double) async throws -> MealScaleResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/scale") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let id: String; let factor: Double }
        request.httpBody = try encoder.encode(Body(id: id, factor: factor))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(MealScaleResult.self, from: data)
    }

    /// Per-item fix for a single row of a receipt's breakdown — the
    /// `LogReceiptCard` item stepper. Sets ONLY `itemFood`'s grams (server
    /// rescales that item's macros and folds the delta into the meal's
    /// totals — see `POST /api/meals/scale`'s doc comment); the rest of the
    /// meal, and the portion memory it writes, are untouched.
    func scaleMealLog(id: String, itemFood: String, grams: Double) async throws -> MealScaleResult {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/meals/scale") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        struct Body: Encodable { let id: String; let itemFood: String; let grams: Double }
        request.httpBody = try encoder.encode(Body(id: id, itemFood: itemFood, grams: grams))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(MealScaleResult.self, from: data)
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

    // MARK: - Calendar ingest (busy blocks for the coach)

    /// Posts EventKit busy blocks for `[windowStart, windowEnd)` to
    /// `POST /api/ingest/calendar`, which replaces the stored blocks for that
    /// window and returns how many rows it wrote. Mirrors `postDailyIngest`'s
    /// request pattern; `windowStart`/`windowEnd`/each block's `start`/`end`
    /// encode as ISO8601 via the shared `encoder`.
    func postCalendarBlocks(
        windowStart: Date,
        windowEnd: Date,
        blocks: [CalendarBlockDTO]
    ) async throws -> Int {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/ingest/calendar") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try encoder.encode(
            CalendarIngestRequestBody(windowStart: windowStart, windowEnd: windowEnd, blocks: blocks)
        )
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(CalendarIngestResponse.self, from: data).replaced
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

    // MARK: - WHOOP integration

    /// GET /api/whoop/status — connection state for the "Connected apps"
    /// screen. `connected: false` with null `status`/`lastSyncedAt` covers
    /// both "never connected" and "disconnected"; the server doesn't
    /// distinguish them and neither does the UI.
    func whoopStatus() async throws -> WhoopStatusResponse {
        try await get("/api/whoop/status")
    }

    /// POST /api/whoop/disconnect — deletes the connection row server-side.
    /// Always succeeds (even as a no-op) per the route's contract.
    func whoopDisconnect() async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/whoop/disconnect") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    /// DELETE /api/account — permanently deletes the user's account and all
    /// server-side data (App Store guideline 5.1.1(v)). 204 on success.
    func deleteAccount() async throws {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/account") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 30
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    /// GET /api/whoop/connect returns a 302 to the WHOOP authorize URL
    /// (in the `Location` header) rather than a JSON body — the route is
    /// session-authed via a Bearer header, which a browser-driven redirect
    /// can't carry, so `ASWebAuthenticationSession` must be pointed at the
    /// authorize URL directly rather than at this route. This method makes
    /// the authenticated request itself (attaching the Bearer token this
    /// app already holds) and stops at the redirect using a dedicated
    /// session/delegate — `redirectGuard` on the shared session strips auth
    /// headers on cross-host redirects but still *follows* them, which
    /// would leak this request to WHOOP and discard the Location header we
    /// actually need.
    func whoopAuthorizeURL() async throws -> URL {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/whoop/connect") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.timeoutInterval = 15

        let interceptor = RedirectInterceptingDelegate()
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        // Not exercised by the screenshot harness (WHOOP connect requires an
        // explicit user tap), but kept consistent with the session above.
        #if DEBUG
        FixtureMode.apply(to: config)
        #endif
        let oneOffSession = URLSession(configuration: config, delegate: interceptor, delegateQueue: nil)
        defer { oneOffSession.finishTasksAndInvalidate() }

        let (_, response) = try await oneOffSession.data(for: request)
        return try Self.extractAuthorizeURL(from: response)
    }

    /// Pulls the WHOOP authorize URL out of the intercepted 302 response.
    /// Pure and synchronous (no networking) so it's unit-testable by handing
    /// it a constructed `HTTPURLResponse` directly, without standing up a
    /// real `URLSession`/delegate round-trip.
    static func extractAuthorizeURL(from response: URLResponse) throws -> URL {
        guard let http = response as? HTTPURLResponse, http.statusCode == 302,
              let location = http.value(forHTTPHeaderField: "Location"),
              let authorizeURL = URL(string: location)
        else {
            throw APIError.whoopAuthorizeURLMissing
        }
        return authorizeURL
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

    // MARK: - Devices settings (phase 2 "both devices" contract, PR A/C)

    /// GET /api/devices — see `app/api/devices/route.ts` / `lib/devicesHttp.ts`
    /// for the exact response shape this decodes.
    func fetchDevices() async throws -> DevicesResponse {
        try await get("/api/devices")
    }

    /// PATCH /api/devices — sets ONE metric's explicit preference at a time
    /// (the settings screen's picker rows each patch independently); `value`
    /// nil resets that metric to automatic. Mirrors `lib/devicesContext.ts`'s
    /// `parseDevicePatch` contract: `{ primary: { <metric>: 'apple' |
    /// 'whoop' | null } }`.
    @discardableResult
    func updateDevicePrimary(metric: DevicesLogic.Metric, value: DevicesLogic.DeviceKind?) async throws -> DevicesResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/devices") else {
            throw APIError.invalidURL
        }
        var request = authorizedRequest(url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        // Built by hand (not JSONEncoder) so exactly one metric key is
        // present in `primary` — `parseDevicePatch` on the server treats an
        // absent key as "leave unchanged", so the two untouched metrics must
        // never appear in the body, not even as `null` (which would reset
        // them to automatic too).
        let valueJSON: Any = value.map { $0.rawValue } ?? NSNull()
        let body: [String: Any] = ["primary": [metric.rawValue: valueJSON]]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder.decode(DevicesResponse.self, from: data)
    }
}

// MARK: - Errors

enum APIError: Error, LocalizedError, Equatable {
    case invalidURL
    case serverError(Int)
    case coachStreamError(String)
    /// POST /api/nutrition/barcode genuinely found no match for the scanned
    /// code (mirrors the server's 404 + `offerTextSearch: true`). Distinct
    /// from `.serverError` so callers can fall back to text search instead
    /// of showing a generic failure message.
    case barcodeNotFound
    /// GET /api/whoop/connect didn't reply with the expected 302 + `Location`
    /// header — e.g. WHOOP isn't configured server-side, or the session
    /// token was rejected before the redirect.
    case whoopAuthorizeURLMissing
    /// The WHOOP login sheet redirected back with `?status=error` (WHOOP
    /// denied the request, or our callback route failed the exchange).
    case whoopConnectFailed
    /// POST /api/meals/quick genuinely found no nutrition candidate for the
    /// given text (mirrors the server's 404 `{ error: 'not_found' }`).
    /// Distinct from `.serverError` so `LogMealIntent` can surface its own
    /// "try being more specific" dialog instead of a generic failure.
    case mealNotFound

    var errorDescription: String? {
        switch self {
        case .invalidURL:         return "Invalid backend URL."
        case .serverError(let c): return "Server returned HTTP \(c)."
        case .coachStreamError(let message): return message
        case .barcodeNotFound:    return "Product not found. Try searching by name instead."
        case .whoopAuthorizeURLMissing: return "Couldn't start the WHOOP connection. Try again later."
        case .whoopConnectFailed: return "WHOOP didn't finish connecting. Please try again."
        case .mealNotFound:       return "I couldn't find that food. Try being more specific."
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

// MARK: - Redirect interceptor (WHOOP authorize URL)

/// Stops a redirect dead and hands the 302 response (with its `Location`
/// header intact) back to the caller, instead of following it. Used only by
/// `whoopAuthorizeURL()` — a one-off `URLSession` is built per call so this
/// never affects the shared session's redirect behavior. Internal (not
/// `private`) so `VitalTests` can exercise `urlSession(_:task:willPerformHTTPRedirection:...)`
/// directly without needing a live network round-trip.
final class RedirectInterceptingDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

// MARK: - WHOOP DTOs

/// Wire shape of GET /api/whoop/status.
struct WhoopStatusResponse: Decodable {
    let connected: Bool
    let status: String?       // "active" | "revoked" | "error" | nil
    let lastSyncedAt: String? // ISO8601, nil if never synced

    enum CodingKeys: String, CodingKey {
        case connected
        case status
        case lastSyncedAt = "last_synced_at"
    }
}

// MARK: - Devices settings DTOs (phase 2 "both devices" contract)

/// One entry of GET /api/devices' `devices` array.
struct DeviceStatusDTO: Decodable {
    let id: DevicesLogic.DeviceKind
    let connected: Bool
    let lastSyncAt: String? // ISO8601, nil if never synced
}

/// `primary` (resolved) or `explicit` (user override) — both keyed the same
/// way, so one Decodable shape covers both fields of `DevicesResponse`.
/// `workouts`/`sleep`/`recovery` are `DeviceKind?` here since only
/// `explicit` allows `null`; `primary`'s three fields are never actually
/// null on the wire, but decoding them as optional costs nothing and keeps
/// one shared type instead of two near-identical ones.
struct DevicePrimariesDTO: Decodable {
    let workouts: DevicesLogic.DeviceKind?
    let sleep: DevicesLogic.DeviceKind?
    let recovery: DevicesLogic.DeviceKind?
}

/// Wire shape of GET/PATCH /api/devices — see `lib/devicesHttp.ts`'s
/// `devicesResponseBody`.
struct DevicesResponse: Decodable {
    let devices: [DeviceStatusDTO]
    let primary: DevicePrimariesDTO
    let explicit: DevicePrimariesDTO
    let mergedThisMonth: Int
}

/// Testing seam for `DevicesSettingsViewModel` — same idiom as
/// `MemoryAPIProviding`.
protocol DevicesAPIProviding {
    func fetchDevices() async throws -> DevicesResponse
    @discardableResult
    func updateDevicePrimary(metric: DevicesLogic.Metric, value: DevicesLogic.DeviceKind?) async throws -> DevicesResponse
}

extension APIClient: DevicesAPIProviding {}

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
    /// Names of third-party apps (e.g. "MyFitnessPal") that wrote dietary
    /// samples to Health in the range this day was fetched from — attached
    /// to every day in a `buildIngestDays` batch, not just days with
    /// dietary metrics (see `HealthKitBackfill.buildIngestDays(from:to:)`).
    let nutrition_sources: [String]?
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
    let dietary_energy_kcal: Double?
    let dietary_protein_g: Double?
    let dietary_carbs_g: Double?
    let dietary_fat_g: Double?
}

struct DailyIngestSleep: Encodable {
    let minutes: Int
    let stages: DailyIngestSleepStages?
    /// ISO-8601 instants — earliest start / latest end of the night's asleep
    /// intervals (analysis-v2-contract.md §3). Additive/optional: the server
    /// stores the payload as-is, and old app versions omitting these keep
    /// working.
    let bedTime: String?
    let wakeTime: String?
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
    /// Bundle id of the app that wrote the workout to HealthKit (e.g. the
    /// Apple Watch's health app, or a 3rd-party app like WHOOP's), from
    /// `HKWorkout.sourceRevision.source.bundleIdentifier`. Used server-side
    /// to prioritize which source wins when the same session is recorded
    /// by multiple sources. Additive/optional — the server accepts unknown
    /// keys, so old app versions omitting this field keep working.
    let sourceBundleId: String?
    /// Watch heart-rate curve (phase2-contract.md, PR B): bpm values evenly
    /// spaced across the workout, at most 120 points, built by
    /// `HeartRateResampler` from raw `.heartRate` samples in the workout's
    /// time window. nil when there were fewer than 10 samples. The server
    /// (`app/api/ingest/daily/route.ts`, PR A) stores this as-is under
    /// `input_payload.hrSeries` and derives heart-rate-reserve zones from it
    /// at request time — additive/optional, old servers ignore the key.
    let hrSeries: [Double]?
    /// Running-dynamics averages over the workout window (phase2-contract.md,
    /// PR B) — only populated for running workouts. Additive/optional, same
    /// as `hrSeries`.
    let running: DailyIngestRunning?
}

/// Running-dynamics block for a `DailyIngestWorkout` (phase2-contract.md, PR
/// B). Each field is nil when HealthKit had no samples of that type for the
/// workout; the whole `running` object is nil (not sent) when every field is
/// nil — see `RunningDynamicsAverager.average`.
struct DailyIngestRunning: Encodable {
    /// Steps per minute: `.stepCount` sum over the workout / duration in minutes.
    let cadenceSpm: Double?
    /// Average `.runningGroundContactTime`, in milliseconds.
    let groundContactMs: Double?
    /// Average `.runningPower`, in watts.
    let powerW: Double?
    /// Average `.runningStrideLength`, in meters.
    let strideM: Double?
}

private struct DailyIngestRequestBody: Encodable {
    let days: [DailyIngestDay]
}

private struct DailyIngestResponse: Decodable {
    let upserted: Int
}

// MARK: - Calendar ingest DTOs
//
// Mirror POST /api/ingest/calendar's request schema: { windowStart, windowEnd,
// blocks: [{ start, end, allDay, title? }] } → { replaced: n }.

/// One EventKit busy block, as posted to `/api/ingest/calendar`. Titles-only
/// — never location, attendees, or notes (see `CalendarBusyBlock`).
struct CalendarBlockDTO: Encodable {
    let start: Date
    let end: Date
    let allDay: Bool
    let title: String?
}

private struct CalendarIngestRequestBody: Encodable {
    let windowStart: Date
    let windowEnd: Date
    let blocks: [CalendarBlockDTO]
}

private struct CalendarIngestResponse: Decodable {
    let replaced: Int
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
    let targetWeightKg: Double? // optional; server drops invalid values
    let weeklySessionsTarget: Int? // optional, 1–14
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
    // POST /api/nutrition/search additionally returns the full ranked
    // candidate list this top result was drawn from. Optional so this same
    // type still decodes the flat photoFood/legacy shape, which never sends
    // it, without failing.
    let candidates: [NutritionCandidate]?
    /// POST /api/nutrition/photo's additive per-item grounded breakdown (see
    /// lib/nutrition/estimator.ts's `GroundedItem`) — nil for every other
    /// caller of this same decodable (text search, an older server). Round-
    /// tripped unchanged to POST /api/meals/log on save so the log carries
    /// the per-item breakdown too — see `LogMealViewModel.logMeal()` /
    /// `DietSheetViewModel.logPhotoResult`.
    let estimatorItems: [PhotoEstimatorItem]?
}

/// One item of a grounded meal estimate's per-item breakdown — mirrors
/// lib/nutrition/estimator.ts's `GroundedItem` exactly (same field names/
/// shape) so the JSON round-trips byte-for-byte from POST /api/nutrition/
/// photo's `estimatorItems` straight back into POST /api/meals/log's body
/// without any reshaping. `source`/`confidence` are kept as plain `String`
/// (not a Swift enum) deliberately: this client only ever stores and
/// forwards them, never branches on their value, so a server-added case
/// (e.g. a new grounding source) can't fail to decode here.
struct PhotoEstimatorItem: Codable, Equatable {
    let food: String
    let grams: Double
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    let source: String
    let confidence: String
    let portionNote: String
}

/// One ranked match from POST /api/nutrition/search's `candidates` array —
/// user history, the shared food_cache/USDA lookup, or a CalorieNinjas
/// free-text estimate, in that preference order (see `origin`).
struct NutritionCandidate: Decodable {
    let origin: String // "history" | "cache" | "usda" | "estimate"
    let name: String
    let brand: String?
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    let servingDesc: String?
    let servingGrams: Double?
    let per100g: NutritionCandidatePer100g?
    let lastLoggedAt: String? // ISO8601 — history only
    let slot: String? // history only
}

struct NutritionCandidatePer100g: Decodable {
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
}

/// One entry from GET /api/nutrition/recents — the user's own recently
/// logged meals, deduped by name and ranked by frequency then recency.
/// Codable (not just Decodable) so `LogMealViewModel` can round-trip it
/// through a UserDefaults cache for instant paint on next sheet open.
struct RecentFood: Codable {
    let name: String
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    let slot: String?
    let lastLoggedAt: String?
    let imageThumb: String?
}

private struct RecentFoodsResponse: Decodable {
    let items: [RecentFood]
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

/// Result of POST /api/meals/scale — the scaled meal's new macros.
struct MealScaleResult: Decodable {
    let ok: Bool
    let id: String
    let name: String
    let kcal: Double
    let c: Double
    let p: Double
    let f: Double
    /// Present only for the per-item (`itemFood` + `grams`) mode — that one
    /// item's new grams/macros. `nil` for the whole-meal factor/grams modes.
    let item: MealScaleItemResult?

    init(ok: Bool, id: String, name: String, kcal: Double, c: Double, p: Double, f: Double, item: MealScaleItemResult? = nil) {
        self.ok = ok
        self.id = id
        self.name = name
        self.kcal = kcal
        self.c = c
        self.p = p
        self.f = f
        self.item = item
    }
}

/// The one rescaled item, from `MealScaleResult.item`.
struct MealScaleItemResult: Decodable, Equatable {
    let food: String
    let grams: Double
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
    let grams: Double?
    // Additive fields alongside the legacy kcal/c/p/f above — the serving
    // size the source actually reports (distinct from `grams`, the scaling
    // factor the client requested/received) and which provider resolved
    // the lookup ("cache" | "off" | "usda"). All optional: an old backend
    // during a rollout window won't send them, and the source's own data
    // may not know a serving size.
    let servingGrams: Double?
    let servingDesc: String?
    let source: String?
    // Per-100g breakdown (kcal/c/p/f), additive alongside the legacy
    // already-scaled top-level fields above. Used by the log sheet's
    // portion controls to recompute macros locally as the user adjusts
    // serving size/grams, instead of round-tripping to the server. Optional
    // for backwards-compat with an older backend during a rollout window.
    let per100g: NutritionCandidatePer100g?
}

struct LogMealResponse: Decodable {
    let ok: Bool
    let eventId: String
    let coachReaction: String
}

/// Wire shape of `POST /api/meals/quick`'s 200 response — see that route's
/// doc comment. `kcalLeft` is null when the server's best-effort diet-budget
/// computation failed (non-fatal there; the log itself still succeeded).
struct QuickLogResponse: Decodable {
    let id: String
    let name: String
    let kcal: Int
    let p: Int
    let c: Int
    let f: Int
    let slot: String
    let kcalLeft: Int?
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

/// Present when the effective target is at/under the sex-aware low-energy-
/// availability floor (see lib/brain/dietBudget.ts). `appliedFloor` means the
/// server raised an auto-calculated target to the floor rather than serve a
/// deeper deficit; for a pinned/custom target it's always false and the
/// warning is informational only.
struct LowEnergyWarning: Decodable {
    let thresholdKcal: Int
    let appliedFloor: Bool
    let message: String
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
    // Optional for backwards-compat with an older backend during rollout.
    let lowEnergyWarning: LowEnergyWarning?
    // "logged" | "healthkit" | "none" — where today's `consumedKcal` etc. came
    // from. Optional: older backends and the local mock omit it entirely.
    let consumedSource: String?
    // e.g. "MyFitnessPal" — present only when consumedSource == "healthkit"
    // and the source app reports a name.
    let consumedSourceName: String?
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

// MARK: - Weight log types (§5.3 — mirrors app/api/weight-log/route.ts exactly)

struct WeightLogEntryDTO: Decodable {
    let date: String   // YYYY-MM-DD
    let weight: Double // kg
    let unit: String   // always "kg" on the wire
    let source: String // "manual" | "healthkit" | "coach"
}

struct WeightTrendDayDTO: Decodable {
    let day: String
    let rawKg: Double
    let trendKg: Double
}

struct WeightTrendDTO: Decodable {
    let days: [WeightTrendDayDTO]
    let delta7dKgPerWeek: Double?
    let delta30dKgPerWeek: Double?
    /// True once there are >= 3 distinct weigh-in days spanning >= 5 calendar
    /// days — the UI gate documented in docs/ux-spec-v4.md §4 ("Trend appears
    /// after 3 weigh-ins"). Never fabricate a trend headline when this is false.
    let established: Bool
}

struct WeightLogResponse: Decodable {
    let entries: [WeightLogEntryDTO]
    let trend: WeightTrendDTO
}

// MARK: - Training summary types (Today muscle/endurance heroes, #202)

/// One `Mon..Sun` day of `TrainingWeekDTO.days` — mirrors
/// `lib/trainingSummary.ts`'s `WeekDay`.
struct TrainingWeekDayDTO: Decodable {
    let date: String
    let planned: Bool
    let completed: Bool
}

/// Mirrors `lib/trainingSummary.ts`'s `WeekSummary`. `plannedSessions` is
/// `null` (not zero) when the user has never added a planned 'move' session
/// this week — see that file's honesty-rule doc comment.
struct TrainingWeekDTO: Decodable {
    let start: String
    let plannedSessions: Int?
    let completedSessions: Int
    let days: [TrainingWeekDayDTO]
}

/// Mirrors `lib/trainingSummary.ts`'s `VolumeSummary`. `done` is `null` when
/// no workout this week carries a distance reading at all — distinct from a
/// real 0km; `target` is always `null` today (no plan/goal defines one) but
/// decoded for forward-compatibility.
struct TrainingVolumeDTO: Decodable {
    let unit: String
    let done: Double?
    let target: Double?
}

/// Mirrors `lib/trainingSummary.ts`'s `LastLift` — the top (heaviest)
/// working set of the user's most recent strength session. `weightKg` is
/// `nil` for a bodyweight-only lift, never a fabricated 0.
struct TrainingLastLiftDTO: Decodable {
    let exercise: String
    let date: String
    let sets: Int
    let reps: Int
    let weightKg: Double?
}

/// GET /api/training/summary's response — see `fetchTrainingSummary()`.
struct TrainingSummaryResponse: Decodable {
    let week: TrainingWeekDTO
    let volume: TrainingVolumeDTO
    let lastLift: TrainingLastLiftDTO?
}

// MARK: - Goal progress types (GET /api/goal/progress)

/// `GoalProgress.verdict` on the wire (`lib/goalProgress.ts`). Decoded
/// tolerantly: any value this build doesn't know (a future server verdict)
/// maps to `.insufficientData` — never a decode failure, never a fabricated
/// "on track".
enum GoalVerdict: String, Equatable, Sendable {
    case onTrack = "on_track"
    case ahead
    case tooFast = "too_fast"
    case behind
    case stalled
    case progressing
    case building
    case holding
    case needsTarget = "needs_target"
    case insufficientData = "insufficient_data"

    init(wire: String?) {
        self = wire.flatMap { GoalVerdict(rawValue: $0) } ?? .insufficientData
    }
}

/// `GoalProgressReason.tone` — unknown values read as `.neutral`.
enum GoalReasonTone: String, Equatable, Sendable {
    case good
    case watch
    case neutral

    init(wire: String?) {
        self = wire.flatMap { GoalReasonTone(rawValue: $0) } ?? .neutral
    }
}

struct GoalReasonDTO: Decodable, Equatable {
    let kind: String
    let text: String
    let tone: GoalReasonTone

    private enum CodingKeys: String, CodingKey { case kind, text, tone }

    init(kind: String = "", text: String, tone: GoalReasonTone = .neutral) {
        self.kind = kind
        self.text = text
        self.tone = tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        tone = GoalReasonTone(wire: try? c.decode(String.self, forKey: .tone))
    }
}

/// GET /api/goal/progress's response. Every nullable field may be `null`
/// (the server's honesty rule — never a guessed number), and every field
/// here decodes tolerantly (missing/`null`/wrong-typed -> `nil`, `[]` or the
/// safe default) so a partially-populated or newer payload still renders
/// rather than hiding the card with a decode error.
struct GoalProgressDTO: Decodable, Equatable {
    struct Target: Decodable, Equatable {
        let weightKg: Double?
        let date: String?
        let weeklySessions: Int?

        private enum CodingKeys: String, CodingKey { case weightKg, date, weeklySessions }

        init(weightKg: Double? = nil, date: String? = nil, weeklySessions: Int? = nil) {
            self.weightKg = weightKg
            self.date = date
            self.weeklySessions = weeklySessions
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weightKg = try? c.decode(Double.self, forKey: .weightKg)
            date = try? c.decode(String.self, forKey: .date)
            weeklySessions = try? c.decode(Int.self, forKey: .weeklySessions)
        }
    }

    struct Current: Decodable, Equatable {
        let weightKg: Double?
        let startWeightKg: Double?
        let changeKg: Double?
        /// Nominally 0...100 (the server may exceed on overshoot / go
        /// negative on regress — `GoalProgressLogic.progressFraction` clamps).
        let progressPct: Double?

        private enum CodingKeys: String, CodingKey { case weightKg, startWeightKg, changeKg, progressPct }

        init(weightKg: Double? = nil, startWeightKg: Double? = nil, changeKg: Double? = nil, progressPct: Double? = nil) {
            self.weightKg = weightKg
            self.startWeightKg = startWeightKg
            self.changeKg = changeKg
            self.progressPct = progressPct
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weightKg = try? c.decode(Double.self, forKey: .weightKg)
            startWeightKg = try? c.decode(Double.self, forKey: .startWeightKg)
            changeKg = try? c.decode(Double.self, forKey: .changeKg)
            progressPct = try? c.decode(Double.self, forKey: .progressPct)
        }
    }

    struct Rate: Decodable, Equatable {
        /// Signed: negative = losing.
        let kg: Double?
        let pctBodyweight: Double?

        private enum CodingKeys: String, CodingKey { case kg, pctBodyweight }

        init(kg: Double? = nil, pctBodyweight: Double? = nil) {
            self.kg = kg
            self.pctBodyweight = pctBodyweight
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kg = try? c.decode(Double.self, forKey: .kg)
            pctBodyweight = try? c.decode(Double.self, forKey: .pctBodyweight)
        }
    }

    struct SafeBand: Decodable, Equatable {
        let minPct: Double
        let maxPct: Double
    }

    struct DataSufficiency: Decodable, Equatable {
        let weighIns: Int
        let needed: Int
        let sessionsLast28d: Int

        private enum CodingKeys: String, CodingKey { case weighIns, needed, sessionsLast28d }

        init(weighIns: Int = 0, needed: Int = 3, sessionsLast28d: Int = 0) {
            self.weighIns = weighIns
            self.needed = needed
            self.sessionsLast28d = sessionsLast28d
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weighIns = (try? c.decode(Int.self, forKey: .weighIns)) ?? 0
            needed = (try? c.decode(Int.self, forKey: .needed)) ?? 3
            sessionsLast28d = (try? c.decode(Int.self, forKey: .sessionsLast28d)) ?? 0
        }
    }

    /// "weight_loss" | "muscle" | "endurance" | "general" (kept a raw string
    /// so a future goal never fails decoding).
    let goal: String
    let target: Target
    let current: Current
    let ratePerWeek: Rate
    let safeBand: SafeBand?
    /// "YYYY-MM-DD" — only ever set by the server when it can honestly
    /// project one (never a fake ETA).
    let eta: String?
    let onPaceForTargetDate: Bool?
    let verdict: GoalVerdict
    let headline: String
    let reasons: [GoalReasonDTO]
    let dataSufficiency: DataSufficiency

    private enum CodingKeys: String, CodingKey {
        case goal, target, current, ratePerWeek, safeBand, eta, onPaceForTargetDate
        case verdict, headline, reasons, dataSufficiency
    }

    init(
        goal: String,
        target: Target = Target(),
        current: Current = Current(),
        ratePerWeek: Rate = Rate(),
        safeBand: SafeBand? = nil,
        eta: String? = nil,
        onPaceForTargetDate: Bool? = nil,
        verdict: GoalVerdict,
        headline: String = "",
        reasons: [GoalReasonDTO] = [],
        dataSufficiency: DataSufficiency = DataSufficiency()
    ) {
        self.goal = goal
        self.target = target
        self.current = current
        self.ratePerWeek = ratePerWeek
        self.safeBand = safeBand
        self.eta = eta
        self.onPaceForTargetDate = onPaceForTargetDate
        self.verdict = verdict
        self.headline = headline
        self.reasons = reasons
        self.dataSufficiency = dataSufficiency
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        goal = (try? c.decode(String.self, forKey: .goal)) ?? "general"
        target = (try? c.decode(Target.self, forKey: .target)) ?? Target()
        current = (try? c.decode(Current.self, forKey: .current)) ?? Current()
        ratePerWeek = (try? c.decode(Rate.self, forKey: .ratePerWeek)) ?? Rate()
        safeBand = try? c.decode(SafeBand.self, forKey: .safeBand)
        eta = try? c.decode(String.self, forKey: .eta)
        onPaceForTargetDate = try? c.decode(Bool.self, forKey: .onPaceForTargetDate)
        verdict = GoalVerdict(wire: try? c.decode(String.self, forKey: .verdict))
        headline = (try? c.decode(String.self, forKey: .headline)) ?? ""
        reasons = ((try? c.decode([GoalReasonDTO].self, forKey: .reasons)) ?? []).filter { !$0.text.isEmpty }
        dataSufficiency = (try? c.decode(DataSufficiency.self, forKey: .dataSufficiency)) ?? DataSufficiency()
    }
}

// MARK: - Strength tracking types (mirrors app/api/workouts/{summary,last,sets}/route.ts)

/// One week of one exercise in `GET /api/workouts/summary` — mirrors
/// `lib/workoutRepository.ts`'s `WeeklyExerciseStat`. `weekStart` is the
/// UTC Monday as `YYYY-MM-DD`. `bestEstimatedOneRepMaxKg` is `nil` (never 0)
/// when every set that week was bodyweight.
struct WorkoutWeeklyStatDTO: Decodable, Equatable {
    let weekStart: String
    let bestEstimatedOneRepMaxKg: Double?
    let volumeKg: Double
    let totalSets: Int
    let totalReps: Int
}

/// GET /api/workouts/summary's response. `exercises` is keyed by canonical
/// exercise name ("squat", "bench press"); each array is ascending by
/// `weekStart` and only contains weeks with at least one working set.
struct WorkoutSummaryResponse: Decodable, Equatable {
    let days: Int
    let exercises: [String: [WorkoutWeeklyStatDTO]]
}

/// One logged set as the server returns it (`toWire` in the sets/last
/// routes). `loadKg` is `nil` for a bodyweight set.
struct WorkoutSetDTO: Decodable, Identifiable, Equatable {
    let id: String
    let sessionId: String
    let workoutId: String?
    let performedAt: String
    let localDay: String
    let exercise: String
    let exerciseDisplay: String
    let setIndex: Int
    let reps: Int
    let loadKg: Double?
    let rpe: Double?
    let isWarmup: Bool
    let source: String
}

/// GET /api/workouts/last's response — `sets` is `[]` when never logged.
struct WorkoutLastSessionResponse: Decodable, Equatable {
    let sets: [WorkoutSetDTO]
}

/// POST /api/workouts/sets' response.
struct LogWorkoutSetsResponse: Decodable, Equatable {
    let ok: Bool
    let sets: [WorkoutSetDTO]
}

/// One set in a POST /api/workouts/sets body. `loadKg`/`rpe` are omitted from
/// the JSON when `nil` (synthesized `Encodable` uses `encodeIfPresent`).
struct WorkoutSetInputDTO: Encodable, Equatable {
    let exercise: String
    let exerciseDisplay: String
    let setIndex: Int
    let reps: Int
    let loadKg: Double?
    let rpe: Double?
    let isWarmup: Bool
}

extension Notification.Name {
    /// Posted by `LiftLoggerViewModel` after a successful POST
    /// /api/workouts/sets so Trends' Strength card (a different tab with its
    /// own view model) re-fetches `/api/workouts/summary`.
    static let vitalWorkoutLogged = Notification.Name("vitalWorkoutLogged")
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
    // Optional for backwards-compat with an older backend during rollout.
    let lowEnergyWarning: LowEnergyWarning?
    // See `TodayDietBudget.consumedSource` / `.consumedSourceName`.
    let consumedSource: String?
    let consumedSourceName: String?
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

/// `baselines.stats` snapshot for one metric — every field independently
/// nullable (e.g. `sd30` is null for a user with a single day of data;
/// `stddev_samp` of one row is undefined). Values arrive in the same
/// display units as `points` (the server already applied `toDisplay`/
/// `toDisplayStats` from `lib/metricCatalog.ts` — a pure multiplicative
/// scale, so converting `sd30` alongside the mean/percentiles is exact).
struct TrendsBaselineDTO: Decodable, Equatable {
    let mean7: Double?
    let mean30: Double?
    let mean60: Double?
    let sd30: Double?
    let p25: Double?
    let p50: Double?
    let p75: Double?
}

/// One metric's entry in a `/api/trends?metrics=` batch response. `baseline`
/// is nil when the user has no `baselines` row for this metric yet;
/// `established` is recomputed server-side from the fresh `dataDays` rather
/// than trusting the (possibly stale) `baselines.established` snapshot.
struct TrendsSeriesDTO: Decodable {
    let metric: String
    let label: String
    let unit: String
    let points: [TrendPoint]
    let baseline: TrendsBaselineDTO?
    let dataDays: Int
    let established: Bool
    let lastDate: String?
}

struct TrendsBatchResponse: Decodable {
    let days: Int
    let series: [String: TrendsSeriesDTO]
    let unknownMetrics: [String]
    let calibration: CalibrationStatus?
}

@MainActor
protocol TrendsAPIProviding {
    func fetchTrends(metric: String, days: Int) async throws -> TrendsResponse
    func fetchTrendsBatch(metrics: [String], days: Int) async throws -> TrendsBatchResponse
}


extension APIClient: TrendsAPIProviding {}

// MARK: - Trends drivers ("What moves your HRV")

/// A tercile mean + its sample size — `nil` on the wire (and here) when the
/// engine's `MIN_TERCILE_PAIRS` gate wasn't cleared. See
/// `lib/insights/drivers.ts`'s `DriverBucket`.
struct DriverBucketDTO: Decodable, Equatable {
    let mean: Double
    let n: Int
}

/// One `GET /api/trends/drivers` row. `input`/`metric` are raw
/// `daily_metrics` names (`steps`, `dietary_carbs_g`), never the display
/// name — `MetricDriverCopy` looks the display name/unit up in
/// `MetricCatalog` itself. `direction` is the sign of the association
/// ('up'/'down'), never decoded as a richer enum since the server is the
/// only writer and any other string would just mean "no confident
/// direction" — callers treat non-'down' as 'up', matching the server's own
/// `effect < 0 ? 'down' : 'up'`.
struct DriverDTO: Decodable, Equatable {
    let input: String
    let lag: Int
    let direction: String
    let rho: Double
    let pairs: Int
    let high: DriverBucketDTO?
    let low: DriverBucketDTO?
    let highInputMean: Double?
    let lowInputMean: Double?
}

struct TrendsDriversResponse: Decodable, Equatable {
    let metric: String
    let computedFor: String?
    let drivers: [DriverDTO]
}

// MARK: - Trends markers (chart event annotations)

/// One `GET /api/trends/markers` row. `kind` is decoded as a plain `String`,
/// never a closed enum — see `lib/trendsMarkers.ts`'s `MarkerKind` doc
/// comment: a future kind must decode without failing, and the client only
/// ever draws `"workout"`.
struct TrendsMarkerDTO: Decodable, Equatable {
    let date: String
    let kind: String
    let label: String
    let count: Int
}

struct TrendsMarkersResponse: Decodable, Equatable {
    let days: Int
    let markers: [TrendsMarkerDTO]
}

/// `MetricDetailViewModel`'s own API seam — a superset of `TrendsAPIProviding`
/// kept SEPARATE from it (rather than adding these two methods to that
/// protocol directly) so `TrendsViewModel`'s existing `TrendsAPIProviding`
/// fakes (`TrendsSummaryTests`, `TrendsViewModelErrorCopyTests`) don't need
/// to grow drivers/markers stubs they never exercise.
@MainActor
protocol MetricDetailAPIProviding: TrendsAPIProviding {
    func fetchTrendsDrivers(metric: String) async throws -> TrendsDriversResponse
    func fetchTrendsMarkers(days: Int) async throws -> TrendsMarkersResponse
}

extension APIClient: MetricDetailAPIProviding {}

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
    /// Whether `timestamp` represents the item's exact occurrence time.
    /// Absent in older API responses, which continue to decode as `nil`.
    let hasExactTime: Bool?
    /// Source calendar day for day-level HealthKit data. Additive and absent
    /// from older API responses and exact-time event items.
    let dayKey: String?
    let title: String
    let subtitle: String
    let imageThumb: String?
    /// meal_logged only — kcal eaten (redesign-v3 Phase 6 Logs day-pager).
    let kcal: Double?
    /// workout_completed only — distance in km (redesign-v3 Phase 6).
    let km: Double?
    /// sleep_session only — duration in ms (redesign-v3 Phase 6).
    let sleepMs: Double?
    /// Ready proactive-analysis id for workout_completed / sleep_session
    /// items — present only when the backend has a ready analysis to open.
    let analysisId: String?
}

/// A local day's resolved nutrition intake — `lib/brain/nutritionIntake.ts`'s
/// `resolveDailyIntake` output, keyed by day in `LogsResponse.dietByDay`.
/// `source` is "logged" | "healthkit" | "none"; `sourceName` is the logging
/// app name (HealthKit only) or nil.
struct DietDayIntakeDTO: Decodable {
    let kcal: Int
    let protein: Int
    let carbs: Int
    let fat: Int
    let source: String
    let sourceName: String?
}

struct LogsResponse: Decodable {
    let items: [LogItem]
    let dietByDay: [String: DietDayIntakeDTO]
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
    /// `users.unit_system` — `"metric"` / `"imperial"`, or nil if the column
    /// hasn't been set for this user yet. `UnitPreference.applyServerValue`
    /// treats nil as a no-op rather than forcing metric.
    let unitSystem: String?
    /// Goal targets (users.target_weight_kg / target_date / weekly_sessions_target);
    /// null when unset. `goalStart*` anchor "Started at X on <date>".
    let targetWeightKg: Double?
    /// 'YYYY-MM-DD'.
    let targetDate: String?
    let weeklySessionsTarget: Int?
    let goalStartWeightKg: Double?
    /// ISO timestamp.
    let goalStartedAt: String?
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
    /// Short (≤140 char) evidence/reason text for "Did I get this right?"
    /// (memory-contract.md §1/§4) — optional: an older server, or a pending
    /// row with no stored reason, omits it, and `MemoryLogic.pendingReasonText`
    /// falls back to "Noticed from your data".
    var reason: String? = nil
}

struct PendingFactsResponse: Decodable {
    let items: [PendingFact]
}

// MARK: - Memory browser types

/// One fact under `self` in `GET /api/memory` — `isConstraint` true means the
/// backend treats it as binding on the user's own health guidance (e.g. an
/// allergy), which the Memory screen renders with a distinct lime-bordered
/// chip so the user can tell a note from a rule at a glance.
struct MemoryFact: Decodable, Identifiable, Equatable {
    let id: String
    let type: String
    let label: String
    let isConstraint: Bool
    /// "YYYY-MM-DD", the fact's `created_at` as a day in the user's timezone
    /// (memory-contract.md §1). `var`, not `let` — a `let` with a default
    /// value drops out of the synthesized memberwise initializer, which
    /// every fixture/test call site below relies on. Optional: an older
    /// server won't send it, and `MemoryLogic.sourceLine` falls back to just
    /// the origin phrase when it's absent.
    var recordedAt: String? = nil
    /// "told" | "noticed" | "confirmed" | "onboarding" (memory-contract.md
    /// §1). Optional for the same reason as `recordedAt`; an unrecognized or
    /// missing value reads the same as "told" (`MemoryLogic.originPhrase`).
    var origin: String? = nil
    /// "health" | "goals" | "routines" | "food" | "other" (memory-contract.md
    /// §1). Optional; when absent, `MemoryLogic.group(for:)` derives it
    /// client-side from `type`.
    var group: String? = nil
}

struct MemorySelfSummary: Decodable {
    let factCount: Int
    let facts: [MemoryFact]
}

/// One row in the Memory screen's "People" card.
struct MemoryEntitySummary: Decodable, Identifiable {
    let id: String
    let label: String
    let kind: String
    let factCount: Int
}

struct MemoryResponse: Decodable {
    let selfSummary: MemorySelfSummary
    let entities: [MemoryEntitySummary]

    enum CodingKeys: String, CodingKey {
        case selfSummary = "self"
        case entities
    }
}

/// One fact inside an `EntityDocumentResponse`. `evidence` is the verbatim
/// substring the ontology extracted the fact from — rendered in quotes,
/// never paraphrased, so the user can check the source themselves.
/// `createdAt` stays a `String` — `APIClient`'s decoder has no
/// `dateDecodingStrategy`, matching `PendingFact.createdAt`.
struct EntityFact: Decodable, Identifiable {
    let type: String
    let label: String
    let evidence: String
    let source: String
    let createdAt: String

    /// The payload carries no fact id; the four fields together are unique
    /// enough for `ForEach` identity within one entity document.
    var id: String { "\(type)|\(label)|\(createdAt)" }
}

/// GET /api/memory/entities/{id}. `isSelf` gates
/// `EntityDocumentView`'s safety banner — facts about someone else must
/// never be presented as facts about the user.
struct EntityDocumentResponse: Decodable {
    let id: String
    let label: String
    let kind: String
    let isSelf: Bool
    let facts: [EntityFact]
}

/// Same seam as `NotificationsAPIProviding`/`TrendsAPIProviding` — lets
/// `MemoryViewModel`/`EntityDocumentViewModel` be tested against a fake
/// without a live network stack.
@MainActor
protocol MemoryAPIProviding {
    func fetchMemory() async throws -> MemoryResponse
    func fetchEntityDocument(id: String) async throws -> EntityDocumentResponse
    func fetchPendingFacts() async throws -> PendingFactsResponse
    /// Returns the newly-promoted fact's `nodeId` on `confirm` (`nil` on
    /// `reject`) — see `APIClient.resolvePendingFact(id:action:)`'s doc
    /// comment. `MemoryViewModel`/`TodayViewModel` currently ignore it.
    @discardableResult
    func resolvePendingFact(id: String, action: String) async throws -> String?
    /// PATCH /api/memory/facts/{factId} (memory-contract.md §2) — Edit on a
    /// fact row's "…" menu. See `APIClient.editMemoryFact(id:label:)`'s doc
    /// comment for why the response replaces the row wholesale.
    func editMemoryFact(id: String, label: String) async throws -> MemoryFact
    /// Forget on a fact row's "…" menu — the same undo endpoint
    /// `MemorySavedChip`'s coach-transcript Undo uses (declared for
    /// `CoachAPIProviding` too; `APIClient`'s single implementation
    /// satisfies both).
    func undoMemoryFact(id: String) async throws
}

extension APIClient: MemoryAPIProviding {}

// MARK: - Coach SSE types

private struct CoachRequestBody: Encodable {
    let message: String
    let imageBase64: String?
    let mode: String?
    /// The `pending_nudges.id` behind a tapped coach-nudge deep link, if any
    /// — see `CoachViewModel.openFromNudge` and `/api/coach`'s findingId
    /// support (lib/brain/context.ts's resolveNudgeFinding).
    let findingId: String?
    /// True when this turn was sent by voice — switches `/api/coach`'s reply
    /// style server-side (lib/brain/persona.ts's voiceStyleBlock). Optional
    /// properties on a synthesized Encodable are written via
    /// `encodeIfPresent`, so `nil` omits the key entirely rather than
    /// encoding `null`.
    let voice: Bool?
    /// Client-generated idempotency key for this user turn (a fresh UUID per
    /// send) — see `/api/coach`'s clientTurnId support and
    /// db/schema.ts's messages_user_client_turn_idx.
    let clientTurnId: String?
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
    /// Meal receipts the coach logged during this message's turn — derived
    /// server-side at restore time (lib/specialists/restoration.ts's
    /// `attachMealReceipts`), never persisted directly. Absent on older
    /// backends and on any message with no meals in its turn window.
    let mealReceipts: [CoachMealReceipt]?
    /// The turn's tool-call activity, in call order — chat-activity-contract.md
    /// §3. `nil`/absent on a message with no tool calls, or on an older
    /// backend that doesn't send it yet.
    let activity: [CoachActivityItem]?

    init(
        id: String,
        role: String,
        speaker: String,
        content: String,
        timestamp: String,
        specialistSessionId: String?,
        specialistMetadata: SpecialistMessageMetadata?,
        mealReceipts: [CoachMealReceipt]? = nil,
        activity: [CoachActivityItem]? = nil
    ) {
        self.id = id
        self.role = role
        self.speaker = speaker
        self.content = content
        self.timestamp = timestamp
        self.specialistSessionId = specialistSessionId
        self.specialistMetadata = specialistMetadata
        self.mealReceipts = mealReceipts
        self.activity = activity
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, speaker, content, timestamp
        case specialistSessionId, specialistMetadata, mealReceipts, activity
    }

    // Custom decode so a malformed `mealReceipts`/`activity` (wrong shape,
    // e.g. a future server bug or an intermediary mangling the payload) is
    // dropped instead of failing the whole restoration decode — every other
    // field still decodes normally, and `try?` around just these two keys
    // means one bad element can't sink the entire restored transcript.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = try container.decode(String.self, forKey: .role)
        speaker = try container.decode(String.self, forKey: .speaker)
        content = try container.decode(String.self, forKey: .content)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        specialistSessionId = try container.decodeIfPresent(String.self, forKey: .specialistSessionId)
        specialistMetadata = try container.decodeIfPresent(SpecialistMessageMetadata.self, forKey: .specialistMetadata)
        mealReceipts = (try? container.decodeIfPresent([CoachMealReceipt].self, forKey: .mealReceipts)) ?? nil
        activity = (try? container.decodeIfPresent([CoachActivityItem].self, forKey: .activity)) ?? nil
    }
}

/// One entry of a restored assistant message's `activity` array —
/// chat-activity-contract.md §3. `label` is already the DONE-form label
/// (e.g. "Checked your sleep"), unlike a live `tool_call` event's label,
/// which may still be present-tense while the step is running.
struct CoachActivityItem: Codable, Equatable {
    let name: String
    let label: String
    let kind: String?
    let ok: Bool?
    let summary: String?
    let sources: [CoachToolSource]?
    let memory: CoachMemoryOp?
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
    // meal_logged fields (name/id above are shared with tool_call)
    let kcal: Int?
    let p: Int?
    let c: Int?
    let f: Int?
    let items: [CoachMealReceiptItem]?
    // specialist lifecycle fields
    let phase: CoachHandoffPhase?
    let sessionId: String?
    let cardOccurrenceId: String?
    let specialist: CoachPersonaSnapshot?
    let objective: String?
    let returnSummary: JSONValue?
    let persona: CoachPersonaSnapshot?
    let error: String?
    // chat-activity-contract.md §1 — tool_call started/done extras, all optional.
    let kind: String?
    let ok: Bool?
    let summary: String?
    let sources: [CoachToolSource]?
    let memory: CoachMemoryOp?

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

/// A source note surfaced by a memory READ (`read_memory`/`query_ontology`/
/// `read_entity`) — chat-activity-contract.md §1. `date` is when the fact was
/// recorded, if known.
struct CoachToolSource: Codable, Equatable {
    let text: String
    let date: String?

    init(text: String, date: String? = nil) {
        self.text = text
        self.date = date
    }
}

/// What a memory WRITE tool call did — chat-activity-contract.md §1. An
/// unrecognized future `op` value fails just this nested decode (see
/// `SSEEvent`'s lenient handling and `CoachActivityItem`'s), never the whole
/// event/message.
enum CoachMemoryOpKind: String, Codable, Equatable {
    case saved
    case proposed
    case updated
    case removed
}

struct CoachMemoryOp: Codable, Equatable {
    let op: CoachMemoryOpKind
    let text: String
    /// Present for `saved` (the id `POST /api/memory/facts/{id}/undo`
    /// accepts) and `proposed` (the pending fact's id, for the existing
    /// pending-facts confirm/dismiss API). `nil` for `saved` when the write
    /// has no stable undo target (e.g. a free-text observation append) — the
    /// app then hides Undo — and always `nil` for `updated`/`removed`.
    let factId: String?

    init(op: CoachMemoryOpKind, text: String, factId: String? = nil) {
        self.op = op
        self.text = text
        self.factId = factId
    }
}

/// A single event surfaced from the coach SSE stream: a text delta to append to
/// the streaming reply, a tool-call lifecycle update (started/done) rendered as
/// an inline activity row, or the structured data for a chartable tool.
enum CoachStreamEvent: Equatable {
    case text(String)
    /// `kind`/`ok`/`summary`/`sources`/`memory` are chat-activity-contract.md
    /// §1's new fields — all optional so an older backend (which sends none
    /// of them) still decodes. `kind` can arrive on `started` too; `ok`/
    /// `summary`/`sources`/`memory` are `done`-only per the contract, but
    /// decoding doesn't enforce that — an unexpected value on `started` is
    /// just carried through harmlessly.
    case toolCall(
        id: String, name: String, label: String, done: Bool,
        kind: String? = nil, ok: Bool? = nil, summary: String? = nil,
        sources: [CoachToolSource]? = nil, memory: CoachMemoryOp? = nil
    )
    case toolData(id: String, viz: CoachViz)
    /// A `log_meal` tool call just inserted a meal — enough to render an
    /// inline receipt (name + macros) and issue an Undo (`deleteMealLog`)
    /// without a round trip. See `CoachMealReceipt`.
    case mealLogged(CoachMealReceipt)
    /// A `delete_meal` tool call just removed a meal the coach itself logged
    /// — flips the matching inline receipt to "Removed" (see
    /// `CoachViewModel.applyMealUnlogged`).
    case mealUnlogged(id: String)
    case handoffCard(CoachHandoffCard)
    case personaChanged(CoachPersonaSnapshot)
    case done
    case error(String)
}

/// One item of a receipt's per-item breakdown — mirrors
/// `lib/brain/coach.ts`'s `meal_logged` event `items` field and
/// `lib/specialists/restoration.ts`'s `MealReceiptItem`, so a live event and
/// a restored one decode into the same shape. `confidence` is `"low"` |
/// `"med"` | `"high"` but kept as a plain `String` here — an unrecognized
/// future value should still decode (and just not match any known case)
/// rather than fail the whole receipt.
struct CoachMealReceiptItem: Codable, Equatable {
    let food: String
    let grams: Int
    let kcal: Int
    let confidence: String
}

/// Payload of a `meal_logged` SSE event (lib/brain/coach.ts). `id` is the
/// backend `events` row id — the same id `APIClient.deleteMealLog(id:)` takes
/// for Undo.
struct CoachMealReceipt: Codable, Equatable {
    let id: String
    let name: String
    let kcal: Int
    let p: Int
    let c: Int
    let f: Int
    /// Per-item breakdown — present only for a grounded estimator log
    /// (lib/nutrition/estimator.ts). `nil` for a flat/legacy/barcode log, and
    /// on an older backend that doesn't send it yet — Swift's synthesized
    /// `Codable` conformance already treats a missing key as `nil` for an
    /// `Optional` property, so no custom decode is needed here.
    let items: [CoachMealReceiptItem]?

    init(id: String, name: String, kcal: Int, p: Int, c: Int, f: Int, items: [CoachMealReceiptItem]? = nil) {
        self.id = id
        self.name = name
        self.kcal = kcal
        self.p = p
        self.c = c
        self.f = f
        self.items = items
    }
}

/// Outcome of a `POST /api/stt` upload (`APIClient.uploadSTTAudio(fileURL:)`)
/// — either the cloud transcript, or a self-diagnosing failure. There is no
/// implicit "nil means try something else" here anymore: cloud STT is the
/// only source of the sent transcript (owner decision, spec
/// `voice-cloud-only-stt`), so every failure carries enough to build a real
/// diagnostic line rather than a silent degrade.
enum STTUploadResult: Equatable {
    case success(String)
    case failure(STTUploadFailure)
}

/// Why an STT upload failed. `.http` covers every response the backend
/// proxy returned deliberately (its own `not_configured`/`fetch_failed`/
/// `upstream`/`bad_json` JSON bodies — see `app/api/stt/route.ts`) as well as
/// a response this client itself couldn't parse; `.network` is a local
/// `URLSession` failure (offline, timeout, thrown error) or a non-HTTP
/// response; `.file` is failing to read the recorded clip off disk before
/// any request was even made.
enum STTUploadFailure: Equatable {
    case file
    case network
    case http(status: Int, detail: String)

    /// The short line surfaced to the user, e.g. "ElevenLabs 401:
    /// missing_permissions" — `CoachVoiceController.VoiceError
    /// .transcriptionFailed(_:)`'s payload.
    var diagnostic: String {
        switch self {
        case .file: return "Couldn't read the recording"
        case .network: return "Network error"
        case .http(let status, let detail): return "ElevenLabs \(status): \(detail)"
        }
    }
}

@MainActor
protocol CoachAPIProviding {
    func uploadSTTAudio(fileURL: URL) async -> STTUploadResult
    func fetchCoachRestoration() async throws -> CoachRestorationResponse
    func fetchCoachOpener() async throws -> String
    func resetCoachConversation() async throws
    /// The user's diet goal (`weight_loss | muscle | endurance | general`),
    /// used to pick goal-aware starter chips (`CoachStarterChips`).
    func fetchDietGoal() async throws -> DietGoalResponse
    func streamCoach(
        message: String,
        imageBase64: String?,
        mode: String?,
        findingId: String?,
        voice: Bool?,
        clientTurnId: String?
    ) -> AsyncThrowingStream<CoachStreamEvent, Error>
    func streamCoachAction(
        sessionId: String,
        cardOccurrenceId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error>
    /// Undo for an inline `LogReceiptCard` in the coach transcript — same
    /// `DELETE /api/meals/log?id=` endpoint `DietSheetViewModel` uses.
    func deleteMealLog(id: String) async throws
    /// The portion chips (½× · 1× · 1.5× · 2×) on an inline `LogReceiptCard`.
    func scaleMealLog(id: String, factor: Double) async throws -> MealScaleResult
    /// The per-item stepper on an inline `LogReceiptCard` — fixes ONE item's
    /// grams without touching the rest of the meal.
    func scaleMealLog(id: String, itemFood: String, grams: Double) async throws -> MealScaleResult
    /// Undo for a "Noted: … · Undo" memory chip (chat-activity-contract.md §2).
    func undoMemoryFact(id: String) async throws
    /// Remember / Not now on a `MemoryProposalCard` — the existing
    /// pending-facts confirm/dismiss API, reused verbatim (see
    /// `MemoryViewModel.resolveFact`). Returns the confirmed fact's `nodeId`
    /// — the only id `undoMemoryFact(id:)` accepts for it — or `nil` on
    /// reject, or on a confirm with nothing promoted.
    @discardableResult
    func resolvePendingFact(id: String, action: String) async throws -> String?
}

extension APIClient: CoachAPIProviding {}
