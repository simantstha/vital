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
    let timezone: String

    static func fromLocal(morningEnabled: Bool, morningMinutes: Int, workoutEnabled: Bool,
                          sleepEnabled: Bool, timezone: String) -> Self {
        Self(morningBriefEnabled: morningEnabled, morningBriefTimeMinutes: morningMinutes,
             workoutNotificationsEnabled: workoutEnabled, sleepNotificationsEnabled: sleepEnabled,
             timezone: timezone)
    }

    static func current(defaults: UserDefaults = .standard, timezone: TimeZone = .current) -> Self {
        fromLocal(morningEnabled: defaults.bool(forKey: NotificationPrefsKeys.briefEnabled),
                  morningMinutes: defaults.integer(forKey: NotificationPrefsKeys.briefMinutes),
                  workoutEnabled: defaults.bool(forKey: NotificationPrefsKeys.workoutEnabled),
                  sleepEnabled: defaults.bool(forKey: NotificationPrefsKeys.sleepEnabled),
                  timezone: timezone.identifier)
    }
}

struct AnalysisResult: Codable, Equatable {
    let headline: String
    let shortInsight: String
    let narrative: String
    let observations: [String]
    let nextSteps: [String]
}

struct AnalysisResponse: Codable, Equatable {
    let id: String
    let date: String
    let result: AnalysisResult
    let createdAt: Date
}

enum PushRoute: Equatable, Identifiable {
    case workoutAnalysis(String)
    case sleepAnalysis(String)
    case morningBrief

    var id: String {
        switch self {
        case .workoutAnalysis(let id): "workout:\(id)"
        case .sleepAnalysis(let id): "sleep:\(id)"
        case .morningBrief: "morning"
        }
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let type = userInfo["type"] as? String else { return nil }
        guard let deepLink = userInfo["deepLink"] as? String, let url = URL(string: deepLink),
              url.scheme == "vital", url.host != nil else { return nil }
        if type == "morning_brief" {
            guard url.host == "today", url.path.isEmpty else { return nil }
            self = .morningBrief; return
        }
        guard let id = userInfo["id"] as? String, UUID(uuidString: id) != nil,
              url.path == "/\(id)" else { return nil }
        switch type {
        case "workout_analysis" where url.host == "workout-analysis": self = .workoutAnalysis(id)
        case "sleep_analysis" where url.host == "sleep-analysis": self = .sleepAnalysis(id)
        default: return nil
        }
    }
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()
    @Published var route: PushRoute?
    @Published var coachContext: String?
    private var sessionScope: Int?
    func activateSession(token: String?) { sessionScope = token.map(\.hashValue) }
    func handle(_ userInfo: [AnyHashable: Any]) {
        guard sessionScope != nil, let route = PushRoute(userInfo: userInfo) else { return }
        self.route = route
    }
    func resetSession() { sessionScope = nil; route = nil; coachContext = nil }
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
        let status = (response as? HTTPURLResponse)?.statusCode ?? 500
        guard status < 400 else { throw APIError.serverError(status) }
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
            preferencesError = nil
            if remote.timezone != timezone.identifier {
                enqueuePreferences(.fromLocal(morningEnabled: remote.morningBriefEnabled,
                    morningMinutes: remote.morningBriefTimeMinutes,
                    workoutEnabled: remote.workoutNotificationsEnabled,
                    sleepEnabled: remote.sleepNotificationsEnabled, timezone: timezone.identifier), defaults: defaults)
            }
        } catch { preferencesError = "Couldn’t load notification preferences. Pull to retry." }
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
        guard (response as? HTTPURLResponse)?.statusCode ?? 500 < 400 else { throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500) }
    }
}

extension APIClient {
    func fetchAnalysis(kind: String, id: String) async throws -> AnalysisResponse {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/\(kind)-analyses/\(id)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        if let token = KeychainStore.loadSessionToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 500
        guard status < 400 else { throw APIError.serverError(status) }
        return try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
    }
}
