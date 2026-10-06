import Foundation
import SwiftUI
import UIKit

extension JSONDecoder {
    static let vital: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

struct NotificationPreferences: Codable, Equatable {
    let morningBriefEnabled: Bool
    let morningBriefTimeMinutes: Int
    let workoutNotificationsEnabled: Bool
    let sleepNotificationsEnabled: Bool
    let mealsEnabled: Bool
    let mealBreakfastTimeMinutes: Int
    let mealLunchTimeMinutes: Int
    let mealSnackTimeMinutes: Int
    let mealDinnerTimeMinutes: Int
    let timezone: String
    /// Proactive coach check-ins (insight nudges). Server default true.
    let coachNudgesEnabled: Bool
    /// Monday weekly-review push. Server default true.
    let weeklyReviewEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case morningBriefEnabled, morningBriefTimeMinutes, workoutNotificationsEnabled
        case sleepNotificationsEnabled, mealsEnabled, mealBreakfastTimeMinutes
        case mealLunchTimeMinutes, mealSnackTimeMinutes, mealDinnerTimeMinutes, timezone
        case coachNudgesEnabled, weeklyReviewEnabled
    }

    static func fromLocal(morningEnabled: Bool, morningMinutes: Int, workoutEnabled: Bool,
                          sleepEnabled: Bool, mealsEnabled: Bool, breakfastMinutes: Int,
                          lunchMinutes: Int, snackMinutes: Int, dinnerMinutes: Int,
                          timezone: String, coachNudgesEnabled: Bool = true,
                          weeklyReviewEnabled: Bool = true) -> Self {
        Self(morningBriefEnabled: morningEnabled, morningBriefTimeMinutes: morningMinutes,
             workoutNotificationsEnabled: workoutEnabled, sleepNotificationsEnabled: sleepEnabled,
             mealsEnabled: mealsEnabled, mealBreakfastTimeMinutes: breakfastMinutes,
             mealLunchTimeMinutes: lunchMinutes, mealSnackTimeMinutes: snackMinutes,
             mealDinnerTimeMinutes: dinnerMinutes, timezone: timezone,
             coachNudgesEnabled: coachNudgesEnabled, weeklyReviewEnabled: weeklyReviewEnabled)
    }

    static func current(defaults: UserDefaults = .standard, timezone: TimeZone = .current) -> Self {
        fromLocal(morningEnabled: defaults.bool(forKey: NotificationPrefsKeys.briefEnabled),
                  morningMinutes: defaults.integer(forKey: NotificationPrefsKeys.briefMinutes),
                  workoutEnabled: defaults.bool(forKey: NotificationPrefsKeys.workoutEnabled),
                  sleepEnabled: defaults.bool(forKey: NotificationPrefsKeys.sleepEnabled),
                  mealsEnabled: defaults.bool(forKey: NotificationPrefsKeys.mealsEnabled),
                  breakfastMinutes: defaults.integer(forKey: NotificationPrefsKeys.mealsBreakfastMinutes),
                  lunchMinutes: defaults.integer(forKey: NotificationPrefsKeys.mealsLunchMinutes),
                  snackMinutes: defaults.integer(forKey: NotificationPrefsKeys.mealsSnackMinutes),
                  dinnerMinutes: defaults.integer(forKey: NotificationPrefsKeys.mealsDinnerMinutes),
                  timezone: timezone.identifier,
                  coachNudgesEnabled: defaults.bool(forKey: NotificationPrefsKeys.coachNudgesEnabled),
                  weeklyReviewEnabled: defaults.bool(forKey: NotificationPrefsKeys.weeklyReviewEnabled))
    }
}

extension NotificationPreferences {
    /// Tolerant decode: an older server that predates the coach/weekly-review
    /// toggles omits those keys, which default to true (the server default).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        morningBriefEnabled = try c.decode(Bool.self, forKey: .morningBriefEnabled)
        morningBriefTimeMinutes = try c.decode(Int.self, forKey: .morningBriefTimeMinutes)
        workoutNotificationsEnabled = try c.decode(Bool.self, forKey: .workoutNotificationsEnabled)
        sleepNotificationsEnabled = try c.decode(Bool.self, forKey: .sleepNotificationsEnabled)
        mealsEnabled = try c.decode(Bool.self, forKey: .mealsEnabled)
        mealBreakfastTimeMinutes = try c.decode(Int.self, forKey: .mealBreakfastTimeMinutes)
        mealLunchTimeMinutes = try c.decode(Int.self, forKey: .mealLunchTimeMinutes)
        mealSnackTimeMinutes = try c.decode(Int.self, forKey: .mealSnackTimeMinutes)
        mealDinnerTimeMinutes = try c.decode(Int.self, forKey: .mealDinnerTimeMinutes)
        timezone = try c.decode(String.self, forKey: .timezone)
        coachNudgesEnabled = try c.decodeIfPresent(Bool.self, forKey: .coachNudgesEnabled) ?? true
        weeklyReviewEnabled = try c.decodeIfPresent(Bool.self, forKey: .weeklyReviewEnabled) ?? true
    }
}

struct AnalysisResult: Codable, Equatable {
    let headline: String
    let shortInsight: String
    let narrative: String
    let observations: [String]
    let nextSteps: [String]
}

/// Raw HealthKit numbers the analysis was generated from — echoed by the API
/// as `metrics`. One all-optional shape covers both kinds: workout payloads
/// carry type/durationMin/kcal/distanceM/avgHr/maxHr/paceMinPerKm/
/// elevationGainM/startTime; sleep payloads carry minutes and stage minutes.
struct AnalysisMetrics: Codable, Equatable {
    struct SleepStages: Codable, Equatable {
        let core: Double?
        let deep: Double?
        let rem: Double?
        let awake: Double?
    }

    // Workout shape
    let type: String?
    let durationMin: Double?
    let kcal: Double?
    let distanceM: Double?
    let avgHr: Double?
    let maxHr: Double?
    let paceMinPerKm: Double?
    let elevationGainM: Double?
    let startTime: String?

    // Sleep shape
    let minutes: Double?
    let stages: SleepStages?
}

/// `vsNormal`/comparison-tone shape shared by every recovery-metric reading
/// in `AnalysisContext` (goingIn/nextMorning/thisMorning HRV and resting HR).
/// `vsNormal` is only ever present once the metric's 30-day baseline is
/// established server-side — its absence, not a `"normal"` value, is how the
/// UI knows to omit the comparison chip.
struct AnalysisRecoveryReading: Codable, Equatable {
    let value: Double
    let unit: String       // "ms" | "bpm"
    let vsNormal: String?  // "above" | "normal" | "below"
    let source: String     // "whoop" | "apple"
}

/// Additive, fully-optional context computed server-side at request time
/// (analysis-v2-contract.md §1) — every field, at every nesting level, is
/// optional so a section with no underlying data simply decodes to `nil`
/// and its UI section hides rather than showing fabricated numbers.
struct AnalysisContext: Codable, Equatable {

    // MARK: Workout

    struct Usual: Codable, Equatable {
        let sessions: Int
        let distanceM: Double?
        let durationMin: Double?
        let paceMinPerKm: Double?
        let avgHr: Double?
    }

    struct PaceHistory: Codable, Equatable {
        let previous: [Double] // min/km, oldest → newest
        let rank: Int          // 1 = fastest among previous + this one
    }

    struct Effort: Codable, Equatable {
        let restingHr: Double
        let maxHr: Double
        let avgPct: Double
        let zone: String // "easy" | "steady" | "hard" | "max"
    }

    struct GoingIn: Codable, Equatable {
        let sleepMinutes: Double?
        let hrv: AnalysisRecoveryReading?
        let daysSinceLastSameType: Int?
    }

    struct NextMorning: Codable, Equatable {
        let hrv: AnalysisRecoveryReading?
        let restingHr: AnalysisRecoveryReading?
    }

    // MARK: Sleep

    struct SleepUsual: Codable, Equatable {
        struct Stages: Codable, Equatable {
            let core: Double?
            let deep: Double?
            let rem: Double?
            let awake: Double?
        }
        let nights: Int
        let minutes: Double
        let stages: Stages?
    }

    struct WeekNight: Codable, Equatable {
        let date: String // 'YYYY-MM-DD'
        let minutes: Double
    }

    struct Timing: Codable, Equatable {
        let bedTime: Date
        let wakeTime: Date
    }

    struct BeforeBed: Codable, Equatable {
        let lastWorkoutEndedAt: Date?
        let lastMealAt: Date?
    }

    struct ThisMorning: Codable, Equatable {
        let hrv: AnalysisRecoveryReading?
        let restingHr: AnalysisRecoveryReading?
    }

    // MARK: Devices (phase 2 "both devices" contract, PR C — mirrors
    // `lib/analysisContext.ts`'s `WorkoutDevicesContext`/`SleepDevicesContext`
    // exactly; only present when BOTH devices recorded the workout/sleep).

    /// One device's running-form averages for a workout — nil per-field, same
    /// as everywhere else in this file, so a device that never reported a
    /// given metric simply omits it rather than showing a fabricated 0.
    struct DeviceRunning: Codable, Equatable {
        let cadenceSpm: Double?
        let groundContactMs: Double?
        let powerW: Double?
        let strideM: Double?
    }

    /// One device's recording of the session. Workout-only fields
    /// (`durationMin`…`running`) and sleep-only fields (`minutes`, `stages`)
    /// never collide on a JSON key, so a single all-optional shape covers
    /// both `WorkoutDeviceSession` and `SleepDeviceSession` without the
    /// `usual`/`sleepUsual` discriminator dance above — an unused field for
    /// whichever kind this analysis is just decodes to nil.
    struct DeviceSession: Codable, Equatable {
        let source: DevicesLogic.DeviceKind?
        // Workout fields
        let durationMin: Double?
        let distanceM: Double?
        let avgHr: Double?
        let maxHr: Double?
        /// Only present on the primary session (contract: "kcal appears only
        /// on the primary session... the UI says 'not counted'").
        let kcal: Double?
        let strain: Double?
        let zonesSec: [Double]?
        let zoneBasis: String? // "reserve" | "maxHr"
        let hrSeries: [Double]?
        let running: DeviceRunning?
        // Sleep fields
        let minutes: Double?
        let stages: AnalysisMetrics.SleepStages?
    }

    struct Devices: Codable, Equatable {
        let primary: DevicesLogic.DeviceKind?
        /// Primary session first (contract) — callers look up a specific
        /// device's session by `source` rather than relying on order.
        let sessions: [DeviceSession]?
    }

    // Workout fields
    let usual: Usual?
    let paceHistory: PaceHistory?
    let effort: Effort?
    let goingIn: GoingIn?
    let nextMorning: NextMorning?

    // Sleep fields
    let goalMinutes: Int?
    let sleepUsual: SleepUsual?
    let week: [WeekNight]?
    let timing: Timing?
    let beforeBed: BeforeBed?
    let thisMorning: ThisMorning?

    // Shared (workout + sleep)
    let devices: Devices?

    private enum CodingKeys: String, CodingKey {
        case usual, paceHistory, effort, goingIn, nextMorning
        case goalMinutes, week, timing, beforeBed, thisMorning
        case devices
    }

    /// Workout's `usual` (session count + distance/duration/pace/avgHr median)
    /// and sleep's `usual` (nights + minutes + stage median) are two different
    /// shapes sharing the same top-level JSON key `usual` — a response only
    /// ever carries one or the other, never both. Both shapes have all-optional
    /// fields other than their one distinguishing field (`sessions` for
    /// workout, `nights` for sleep), so a plain `try?` decode of either shape
    /// against the other's JSON would silently succeed as an empty-but-non-nil
    /// value instead of failing. Peek at `.usual` once as a discriminator
    /// (both fields optional, at most one present) and decode only the shape
    /// whose distinguishing field is actually there.
    private struct UsualDiscriminator: Decodable {
        let sessions: Int?
        let nights: Int?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let discriminator = try c.decodeIfPresent(UsualDiscriminator.self, forKey: .usual)
        if discriminator?.sessions != nil {
            usual = try c.decodeIfPresent(Usual.self, forKey: .usual)
            sleepUsual = nil
        } else if discriminator?.nights != nil {
            usual = nil
            sleepUsual = try c.decodeIfPresent(SleepUsual.self, forKey: .usual)
        } else {
            usual = nil
            sleepUsual = nil
        }
        paceHistory = try c.decodeIfPresent(PaceHistory.self, forKey: .paceHistory)
        effort = try c.decodeIfPresent(Effort.self, forKey: .effort)
        goingIn = try c.decodeIfPresent(GoingIn.self, forKey: .goingIn)
        nextMorning = try c.decodeIfPresent(NextMorning.self, forKey: .nextMorning)
        goalMinutes = try c.decodeIfPresent(Int.self, forKey: .goalMinutes)
        week = try c.decodeIfPresent([WeekNight].self, forKey: .week)
        timing = try c.decodeIfPresent(Timing.self, forKey: .timing)
        beforeBed = try c.decodeIfPresent(BeforeBed.self, forKey: .beforeBed)
        thisMorning = try c.decodeIfPresent(ThisMorning.self, forKey: .thisMorning)
        devices = try c.decodeIfPresent(Devices.self, forKey: .devices)
    }

    /// Memberwise init retained for fixtures/tests building a context
    /// literally rather than decoding it from JSON.
    init(usual: Usual? = nil, paceHistory: PaceHistory? = nil, effort: Effort? = nil,
         goingIn: GoingIn? = nil, nextMorning: NextMorning? = nil,
         goalMinutes: Int? = nil, sleepUsual: SleepUsual? = nil, week: [WeekNight]? = nil,
         timing: Timing? = nil, beforeBed: BeforeBed? = nil, thisMorning: ThisMorning? = nil,
         devices: Devices? = nil) {
        self.usual = usual
        self.paceHistory = paceHistory
        self.effort = effort
        self.goingIn = goingIn
        self.nextMorning = nextMorning
        self.goalMinutes = goalMinutes
        self.sleepUsual = sleepUsual
        self.week = week
        self.timing = timing
        self.beforeBed = beforeBed
        self.thisMorning = thisMorning
        self.devices = devices
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // `usual`/`sleepUsual` are mutually exclusive (see `init(from:)`) and
        // share the single `.usual` JSON key — encode whichever is set.
        if let usual {
            try c.encode(usual, forKey: .usual)
        } else if let sleepUsual {
            try c.encode(sleepUsual, forKey: .usual)
        }
        try c.encodeIfPresent(paceHistory, forKey: .paceHistory)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encodeIfPresent(goingIn, forKey: .goingIn)
        try c.encodeIfPresent(nextMorning, forKey: .nextMorning)
        try c.encodeIfPresent(goalMinutes, forKey: .goalMinutes)
        try c.encodeIfPresent(week, forKey: .week)
        try c.encodeIfPresent(timing, forKey: .timing)
        try c.encodeIfPresent(beforeBed, forKey: .beforeBed)
        try c.encodeIfPresent(thisMorning, forKey: .thisMorning)
        try c.encodeIfPresent(devices, forKey: .devices)
    }
}

struct AnalysisResponse: Codable, Equatable {
    let id: String
    let date: String
    let result: AnalysisResult
    /// Absent in older API responses; the metrics card is hidden when nil.
    let metrics: AnalysisMetrics?
    let createdAt: Date
    /// Additive (analysis-v2-contract.md §1) — nil for older responses or
    /// when the server has nothing to add; every `AnalysisView` section
    /// backed by it hides itself rather than showing fabricated data.
    let context: AnalysisContext?
}

// MARK: - Notification inbox wire types

/// A single row from `GET /api/notifications` — `type` drives both the row's
/// icon/label and which detail screen a tap opens (see `NotificationsView`).
/// `readAt` is `var` (not `let`) so `NotificationsViewModel` can flip it
/// in place for the optimistic mark-read update.
struct NotificationItemDTO: Codable, Equatable, Identifiable {
    let id: String
    let type: String
    let targetId: String
    let title: String
    let body: String
    let deepLink: String
    let createdAt: Date
    var readAt: Date?
}

struct NotificationsListResponse: Codable, Equatable {
    let items: [NotificationItemDTO]
    let unreadCount: Int
}

/// `POST /api/notifications/read` accepts either `{"ids":[...]}` or
/// `{"all":true}` — never both — so encoding is hand-written to omit
/// whichever side is nil rather than emitting a spurious `null` field.
struct MarkNotificationsReadRequest: Encodable {
    let ids: [String]?
    let all: Bool?

    private enum CodingKeys: String, CodingKey { case ids, all }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(ids, forKey: .ids)
        try container.encodeIfPresent(all, forKey: .all)
    }
}

struct MarkNotificationsReadResponse: Decodable, Equatable {
    let updated: Int
}

/// `GET /api/nudges/{id}` — deliberately narrower than `AnalysisResponse`:
/// no `metrics`/`result` breakdown, just the finding's own title/body.
struct NudgeDetailResponse: Codable, Equatable {
    let id: String
    let title: String
    let body: String
    let createdAt: Date
}

/// A coach-analysis-shaped detail screen: which resource to fetch, how to title
/// it, and which metrics layout (if any) its payload carries.
struct AnalysisKind: Equatable {
    let resource: String   // API path segment
    let title: String
    let subject: String    // coach-context wording
    let metrics: String?   // nil = payload never carries metrics

    static let workout = AnalysisKind(resource: "workout-analyses", title: "Workout Analysis",
                                      subject: "workout analysis", metrics: "workout")
    static let sleep = AnalysisKind(resource: "sleep-analyses", title: "Sleep Analysis",
                                    subject: "sleep analysis", metrics: "sleep")
    static let morningBrief = AnalysisKind(resource: "morning-briefs", title: "Morning Brief",
                                           subject: "morning brief", metrics: nil)
}

enum PushRoute: Equatable, Identifiable {
    case workoutAnalysis(String)
    case sleepAnalysis(String)
    case morningBrief(String?)   // nil = legacy `vital://today` payload
    case coachNudge(String)      // pending_nudges.id — see lib/insights/nudgeWorker.ts
    case weeklyReview(String)    // weekly_reviews.id — see lib/weeklyReviewWorker.ts

    var id: String {
        switch self {
        case .workoutAnalysis(let id): "workout:\(id)"
        case .sleepAnalysis(let id): "sleep:\(id)"
        case .morningBrief(let id): "morning:\(id ?? "legacy")"
        case .coachNudge(let id): "nudge:\(id)"
        case .weeklyReview(let id): "weekly:\(id)"
        }
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let type = userInfo["type"] as? String else { return nil }
        guard let deepLink = userInfo["deepLink"] as? String, let url = URL(string: deepLink),
              url.scheme == "vital", url.host != nil else { return nil }
        // Legacy: briefs delivered before they were persisted carry no id.
        if type == "morning_brief", url.host == "today", url.path.isEmpty, userInfo["id"] == nil {
            self = .morningBrief(nil); return
        }
        guard let id = userInfo["id"] as? String, UUID(uuidString: id) != nil,
              url.path == "/\(id)" else { return nil }
        switch type {
        case "workout_analysis" where url.host == "workout-analysis": self = .workoutAnalysis(id)
        case "sleep_analysis" where url.host == "sleep-analysis": self = .sleepAnalysis(id)
        case "morning_brief" where url.host == "morning-brief": self = .morningBrief(id)
        case "coach_nudge" where url.host == "coach-nudge": self = .coachNudge(id)
        case "weekly_review" where url.host == "weekly-review": self = .weeklyReview(id)
        default: return nil
        }
    }
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()
    @Published var route: PushRoute?
    @Published var coachContext: String?
    /// Set from `RootView.onOpenURL` for a `vital://log` deep link (Siri/App
    /// Intents, Shortcuts, the Home Screen quick action, a notification's
    /// "Edit in Vital"). `TodayView` observes this to open the Diet sheet
    /// (and optionally auto-present LogMealView in a given input method);
    /// `RootTabView` observes it to switch to the Today tab first. See
    /// `LogDeepLinkRoute`.
    @Published var logDeepLink: LogDeepLinkRoute?
    private var sessionScope: Int?
    func activateSession(token: String?) { sessionScope = token.map(\.hashValue) }
    func handle(_ userInfo: [AnyHashable: Any]) {
        guard sessionScope != nil, let route = PushRoute(userInfo: userInfo) else { return }
        self.route = route
    }
    func resetSession() { sessionScope = nil; route = nil; coachContext = nil; logDeepLink = nil }
}

@MainActor
enum NotificationDelegateRouter {
    static func route(_ userInfo: [AnyHashable: Any]) { AppRouter.shared.handle(userInfo) }
    static func route(_ userInfo: [AnyHashable: Any], to router: AppRouter) { router.handle(userInfo) }
}

enum APNSEnvironment: String, Codable { case sandbox, production }

protocol APNSEnvironmentResolving { func resolve() -> APNSEnvironment? }

struct SignedEntitlementEnvironmentResolver: APNSEnvironmentResolving {
    func resolve() -> APNSEnvironment? {
        Self.map(Bundle.main.object(forInfoDictionaryKey: "VitalAPNSEnvironment") as? String)
    }
    static func map(_ value: String?) -> APNSEnvironment? {
        switch value { case "development": .sandbox; case "production": .production; default: nil }
    }
}

protocol NotificationPreferencesTransport {
    func get() async throws -> NotificationPreferences
    func put(_ value: NotificationPreferences) async throws
}

struct LiveNotificationPreferencesTransport: NotificationPreferencesTransport {
    func get() async throws -> NotificationPreferences { try await request(method: "GET", body: nil) }
    func put(_ value: NotificationPreferences) async throws { let _: NotificationPreferences = try await request(method: "PUT", body: value) }
    private func request<T: Decodable>(method: String, body: NotificationPreferences?) async throws -> T {
        guard let url = URL(string: AppConfig.apiBaseURL + "/api/notification-preferences") else { throw APIError.invalidURL }
        var request = URLRequest(url: url); request.httpMethod = method
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        try APIClient.shared.validate(response)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

@MainActor
final class PushNotificationService: ObservableObject {
    static let shared = PushNotificationService()
    private let installationKey = "push.installationId"
    private let dirtyKey = "push.preferences.dirty"
    private let dirtyValueKey = "push.preferences.pending"
    private let transport: NotificationPreferencesTransport
    private let environmentResolver: APNSEnvironmentResolving
    private let debounceMilliseconds: Int?
    private var queued: NotificationPreferences?
    private var version = 0
    private var queuedVersion = 0
    private var isFlushing = false
    private var syncTask: Task<Void, Never>?
    @Published private(set) var preferencesPending = false
    @Published private(set) var preferencesError: String?

    init(transport: NotificationPreferencesTransport = LiveNotificationPreferencesTransport(),
         environmentResolver: APNSEnvironmentResolving = SignedEntitlementEnvironmentResolver(),
         debounceMilliseconds: Int? = 300) {
        self.transport = transport; self.environmentResolver = environmentResolver
        self.debounceMilliseconds = debounceMilliseconds
    }

    func resolvedEnvironment() -> APNSEnvironment? { environmentResolver.resolve() }

    var installationId: String {
        if let id = UserDefaults.standard.string(forKey: installationKey), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: installationKey)
        return id
    }

    func register(token data: Data) async {
        guard KeychainStore.loadSessionToken() != nil else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard let environment = resolvedEnvironment() else { return }
        struct Body: Encodable { let installationId: String; let token: String; let environment: String }
        try? await request("/api/push-devices", method: "POST", body: Body(installationId: installationId, token: token, environment: environment.rawValue))
    }

    func invalidate(sessionToken: String? = KeychainStore.loadSessionToken()) async {
        struct Body: Encodable { let installationId: String }
        try? await request("/api/push-devices", method: "DELETE", body: Body(installationId: installationId), sessionToken: sessionToken)
    }

    func hydratePreferences(defaults: UserDefaults = .standard, timezone: TimeZone = .current) async {
        if defaults.bool(forKey: dirtyKey), let data = defaults.data(forKey: dirtyValueKey),
           let pending = try? JSONDecoder().decode(NotificationPreferences.self, from: data) {
            enqueuePreferences(pending, defaults: defaults); return
        }
        let hydrationVersion = version
        do {
            let remote = try await transport.get()
            guard version == hydrationVersion, !defaults.bool(forKey: dirtyKey) else { return }
            defaults.set(remote.morningBriefEnabled, forKey: NotificationPrefsKeys.briefEnabled)
            defaults.set(remote.morningBriefTimeMinutes, forKey: NotificationPrefsKeys.briefMinutes)
            defaults.set(remote.workoutNotificationsEnabled, forKey: NotificationPrefsKeys.workoutEnabled)
            defaults.set(remote.sleepNotificationsEnabled, forKey: NotificationPrefsKeys.sleepEnabled)
            defaults.set(remote.mealsEnabled, forKey: NotificationPrefsKeys.mealsEnabled)
            defaults.set(remote.mealBreakfastTimeMinutes, forKey: NotificationPrefsKeys.mealsBreakfastMinutes)
            defaults.set(remote.mealLunchTimeMinutes, forKey: NotificationPrefsKeys.mealsLunchMinutes)
            defaults.set(remote.mealSnackTimeMinutes, forKey: NotificationPrefsKeys.mealsSnackMinutes)
            defaults.set(remote.mealDinnerTimeMinutes, forKey: NotificationPrefsKeys.mealsDinnerMinutes)
            defaults.set(remote.coachNudgesEnabled, forKey: NotificationPrefsKeys.coachNudgesEnabled)
            defaults.set(remote.weeklyReviewEnabled, forKey: NotificationPrefsKeys.weeklyReviewEnabled)
            preferencesError = nil
            if remote.timezone != timezone.identifier {
                enqueuePreferences(.fromLocal(morningEnabled: remote.morningBriefEnabled,
                    morningMinutes: remote.morningBriefTimeMinutes,
                    workoutEnabled: remote.workoutNotificationsEnabled,
                    sleepEnabled: remote.sleepNotificationsEnabled,
                    mealsEnabled: remote.mealsEnabled, breakfastMinutes: remote.mealBreakfastTimeMinutes,
                    lunchMinutes: remote.mealLunchTimeMinutes, snackMinutes: remote.mealSnackTimeMinutes,
                    dinnerMinutes: remote.mealDinnerTimeMinutes, timezone: timezone.identifier,
                    coachNudgesEnabled: remote.coachNudgesEnabled,
                    weeklyReviewEnabled: remote.weeklyReviewEnabled), defaults: defaults)
            }
            // Server-owned meal times feed ReminderScheduler's local
            // notification window directly (unlike brief*, which is
            // server-scheduled remote push) — resync so a fresh install or
            // a value changed on another device takes effect immediately.
            await ReminderScheduler.shared.resync()
        } catch { preferencesError = "Couldn’t load notification preferences." }
    }

    func retryPreferences(defaults: UserDefaults = .standard, timezone: TimeZone = .current) async {
        await hydratePreferences(defaults: defaults, timezone: timezone)
        if preferencesPending { await flush(defaults: defaults) }
    }

    func resetSession(defaults: UserDefaults = .standard) {
        version += 1; syncTask?.cancel(); syncTask = nil; queued = nil
        defaults.removeObject(forKey: dirtyKey); defaults.removeObject(forKey: dirtyValueKey)
        preferencesPending = false; preferencesError = nil
    }

    func enqueuePreferences(_ preferences: NotificationPreferences, defaults: UserDefaults = .standard) {
        version += 1; queuedVersion = version; queued = preferences
        preferencesPending = true; preferencesError = nil
        defaults.set(true, forKey: dirtyKey)
        defaults.set(try? JSONEncoder().encode(preferences), forKey: dirtyValueKey)
        syncTask?.cancel()
        guard let debounceMilliseconds else { return }
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(debounceMilliseconds)); guard !Task.isCancelled else { return }
            await self?.flush(defaults: defaults)
        }
    }

    func flush(defaults: UserDefaults = .standard) async {
        guard !isFlushing else { return }
        isFlushing = true
        defer {
            isFlushing = false
            if queued != nil && preferencesError == nil {
                Task { [weak self] in await self?.flush(defaults: defaults) }
            }
        }
        while let value = queued {
            let sendingVersion = queuedVersion
            queued = nil
            do { try await transport.put(value) }
            catch {
                guard version == sendingVersion || queued != nil else { return }
                if queued != nil { continue }
                queued = value; queuedVersion = sendingVersion
                preferencesPending = true; preferencesError = "Changes are saved and will retry when you’re online."
                return
            }
        }
        defaults.removeObject(forKey: dirtyKey); defaults.removeObject(forKey: dirtyValueKey)
        preferencesPending = false; preferencesError = nil
    }

    private func request<T: Encodable>(_ path: String, method: String, body: T, sessionToken: String? = KeychainStore.loadSessionToken()) async throws {
        guard let url = URL(string: AppConfig.apiBaseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let sessionToken { request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(body)
        let (_, response) = try await URLSession.shared.data(for: request)
        try APIClient.shared.validate(response)
    }
}

extension APIClient {
    func fetchAnalysis(resource: String, id: String) async throws -> AnalysisResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/\(resource)/\(id)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
    }

    func fetchNotifications(limit: Int) async throws -> NotificationsListResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/notifications?limit=\(limit)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return try JSONDecoder.vital.decode(NotificationsListResponse.self, from: data)
    }

    func markNotificationsRead(ids: [String]?, all: Bool?) async throws -> Int {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/notifications/read") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(MarkNotificationsReadRequest(ids: ids, all: all))
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return try JSONDecoder.vital.decode(MarkNotificationsReadResponse.self, from: data).updated
    }

    func fetchNudge(id: String) async throws -> NudgeDetailResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/nudges/\(id)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return try JSONDecoder.vital.decode(NudgeDetailResponse.self, from: data)
    }
}

/// Same seam as `TrendsAPIProviding`/`CoachAPIProviding` in `APIClient.swift`
/// — lets `NotificationsViewModel` be tested against a fake without a live
/// network stack.
@MainActor
protocol NotificationsAPIProviding {
    func fetchNotifications(limit: Int) async throws -> NotificationsListResponse
    func markNotificationsRead(ids: [String]?, all: Bool?) async throws -> Int
    func fetchNudge(id: String) async throws -> NudgeDetailResponse
}

extension APIClient: NotificationsAPIProviding {}
