import Foundation
import SwiftUI

// MARK: - Stat cell model

struct ProfileStatCell: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let sfSymbol: String
}

enum ProfileUnitSystem: Equatable {
    case metric
    case us

    static func from(measurementSystem: Locale.MeasurementSystem) -> ProfileUnitSystem {
        measurementSystem == .us ? .us : .metric
    }
}

// MARK: - ViewModel

@MainActor
final class ProfileViewModel: ObservableObject {

    @Published var name: String = ""
    @Published var avatarInitial: String = "?"
    @Published var integrations: [ProfileIntegration] = []
    @Published var profileDetails: [ProfileStatCell] = []
    @Published var activityStats: [ProfileStatCell] = []
    @Published var isLoading = true
    @Published var errorMessage: String? = nil

    /// Raw personal details as the server sent them — the editable
    /// `PersonalDetailsView` needs the unformatted values, not the stat cells.
    @Published var details: ProfileDetails? = nil

    /// "Member since Jul 2026" — nil (line omitted) when createdAt is absent.
    @Published var memberSince: String? = nil

    /// Effective sleep goal / lights-out values (server applies the defaults).
    @Published var sleepGoalMinutes: Int = 480
    @Published var lightsOutMinutes: Int = 1350

    // Diet budget summary for the Nutrition entry point.
    @Published var budgetKcal: Int?
    @Published var budgetMode: String = "auto"   // "auto" | "custom"
    @Published var budgetGoalLabel: String = ""

    /// Calibration status for the Profile banner — decoded straight off the
    /// profile response (the route has always returned it; Phase 9 dropped the
    /// old fetchTrends(metric: "rhr") workaround that fetched it separately).
    @Published var calibration: CalibrationStatus? = nil

    private let apiClient = APIClient.shared

    /// "8h · lights out 10:30" — the Sleep goal row's trailing value.
    var sleepGoalSummary: String {
        Self.sleepGoalSummary(goalMinutes: sleepGoalMinutes, lightsOutMinutes: lightsOutMinutes)
    }

    func load() async {
        isLoading = true
        do {
            let response = try await apiClient.fetchProfile()
            name = response.name
            avatarInitial = String(response.name.prefix(1)).uppercased()
            integrations = response.integrations
            details = response.profile
            memberSince = Self.memberSinceLabel(fromISO: response.createdAt)
            sleepGoalMinutes = response.sleepGoalMinutes ?? 480
            lightsOutMinutes = response.lightsOutMinutes ?? 1350
            calibration = response.calibration
            let units = ProfileUnitSystem.from(measurementSystem: Locale.current.measurementSystem)
            profileDetails = Self.profileCells(from: response.profile, units: units)
            activityStats = Self.activityCells(from: response.stats)
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] fetchProfile failed: \(error.localizedDescription)")
        }
        await loadBudget()
        isLoading = false
    }

    /// Loads the diet-budget summary shown on the Nutrition row. Called on
    /// initial load and again when the editor is dismissed so the row updates.
    func loadBudget() async {
        do {
            let r = try await apiClient.fetchDietGoal()
            budgetKcal = r.current.targetKcal
            budgetMode = r.current.mode
            budgetGoalLabel = DietBudgetViewModel.goalLabels[r.current.goal] ?? r.current.goal
        } catch {
            // Non-fatal — the row just shows a neutral placeholder.
            print("[Vital] fetchDietGoal failed: \(error.localizedDescription)")
        }
    }

    /// `min(1, minimum dataDays across metrics / 14)` — same rule
    /// `TodayViewModel.applyTodayResponse` uses for its calibration progress.
    var calibrationPercent: Int {
        guard let calibration else { return 0 }
        let dataDays = [
            calibration.metrics["hrv_sdnn"]?.dataDays ?? 0,
            calibration.metrics["resting_hr"]?.dataDays ?? 0,
            calibration.metrics["sleep_minutes"]?.dataDays ?? 0,
        ].min() ?? 0
        return Int((min(1.0, Double(dataDays) / 14.0) * 100).rounded())
    }

    // MARK: - Pure formatting helpers (testable)

    /// "Member since Jul 2026" from an ISO-8601 createdAt (with or without
    /// fractional seconds). Returns nil for nil/unparseable input so the
    /// avatar-card subtitle is simply omitted.
    static func memberSinceLabel(fromISO iso: String?) -> String? {
        guard let iso else { return nil }

        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = withFractional.date(from: iso) ?? plain.date(from: iso) else { return nil }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        // UTC, matching the server timestamp — a signup on Dec 1 UTC shouldn't
        // read "Nov" on devices west of Greenwich.
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "MMM yyyy"
        return "Member since \(formatter.string(from: date))"
    }

    /// "8h · lights out 10:30" — hours show ".5" only when the goal isn't a
    /// whole number of hours; lights-out renders as a 12-hour clock time
    /// (no am/pm, matching the mock).
    static func sleepGoalSummary(goalMinutes: Int, lightsOutMinutes: Int) -> String {
        let hours = Double(goalMinutes) / 60.0
        let hoursLabel = hours.truncatingRemainder(dividingBy: 1) == 0
            ? "\(Int(hours))"
            : String(format: "%.1f", hours)

        let h24 = (lightsOutMinutes / 60) % 24
        let mm = lightsOutMinutes % 60
        let h12 = ((h24 + 11) % 12) + 1
        return "\(hoursLabel)h · lights out \(h12):\(String(format: "%02d", mm))"
    }

    // MARK: - Private

    static func profileCells(from profile: ProfileDetails, units: ProfileUnitSystem) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Age",            value: profile.age.map(String.init) ?? "--", sfSymbol: "person.fill"),
            ProfileStatCell(label: "Height",         value: formatHeight(profile.heightCm, units: units), sfSymbol: "ruler"),
            ProfileStatCell(label: "Current weight", value: formatWeight(profile.weightKg, units: units), sfSymbol: "scalemass"),
            ProfileStatCell(label: "Biological sex", value: profile.biologicalSex?.capitalized ?? "--", sfSymbol: "person.2.fill"),
        ]
    }

    static func activityCells(from s: ProfileStats) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Logged days",    value: "\(s.loggedDays)", sfSymbol: "calendar"),
            ProfileStatCell(label: "Meals logged",   value: "\(s.mealsLogged)", sfSymbol: "fork.knife"),
            ProfileStatCell(label: "Avg HRV",        value: s.avgHrv.map { "\(Int($0.rounded())) ms" } ?? "--", sfSymbol: "waveform.path.ecg"),
            ProfileStatCell(label: "Workouts",       value: "\(s.workouts)", sfSymbol: "figure.run"),
        ]
    }

    private static func formatHeight(_ heightCm: Double?, units: ProfileUnitSystem) -> String {
        guard let heightCm else { return "--" }

        switch units {
        case .metric:
            return "\(Int(heightCm.rounded())) cm"
        case .us:
            let totalInches = Int((heightCm / 2.54).rounded())
            return "\(totalInches / 12)' \(totalInches % 12)\""
        }
    }

    private static func formatWeight(_ weightKg: Double?, units: ProfileUnitSystem) -> String {
        guard let weightKg else { return "--" }

        switch units {
        case .metric:
            return "\(formatNumber(weightKg, maximumFractionDigits: 1)) kg"
        case .us:
            return "\(Int((weightKg * 2.2046226218).rounded())) lb"
        }
    }

    private static func formatNumber(_ value: Double, maximumFractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = maximumFractionDigits
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
