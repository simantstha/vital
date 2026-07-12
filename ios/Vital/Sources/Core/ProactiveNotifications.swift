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
        if type == "morning_brief" { self = .morningBrief; return }
        guard let id = userInfo["id"] as? String, UUID(uuidString: id) != nil else { return nil }
        switch type {
        case "workout_analysis": self = .workoutAnalysis(id)
        case "sleep_analysis": self = .sleepAnalysis(id)
        default: return nil
        }
    }
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()
    @Published var route: PushRoute?
    @Published var coachContext: String?
    func handle(_ userInfo: [AnyHashable: Any]) { if let route = PushRoute(userInfo: userInfo) { self.route = route } }
}

@MainActor
final class PushNotificationService {
    static let shared = PushNotificationService()
    private let installationKey = "push.installationId"

    var installationId: String {
        if let id = UserDefaults.standard.string(forKey: installationKey), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: installationKey)
        return id
    }

    func register(token data: Data) async {
        guard KeychainStore.loadSessionToken() != nil else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        struct Body: Encodable { let installationId: String; let token: String; let environment: String }
        try? await request("/api/push-devices", method: "POST", body: Body(installationId: installationId, token: token, environment: environment))
    }

    func invalidate(sessionToken: String? = KeychainStore.loadSessionToken()) async {
        struct Body: Encodable { let installationId: String }
        try? await request("/api/push-devices", method: "DELETE", body: Body(installationId: installationId), sessionToken: sessionToken)
    }

    func syncPreferences(_ preferences: NotificationPreferences) async {
        try? await request("/api/notification-preferences", method: "PUT", body: preferences)
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
