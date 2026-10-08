import Foundation
import SwiftUI

// MARK: - Stat cell model

struct ProfileStatCell: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let sfSymbol: String
}

// MARK: - ViewModel

@MainActor
final class ProfileViewModel: ObservableObject {

    @Published var name: String = ""
    @Published var avatarInitial: String = "?"
    @Published var integrations: [ProfileIntegration] = []
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
    /// Canonical goal id ("weight_loss" …) behind `budgetGoalLabel`, and the
    /// targets that make up the Goal row's suffix.
    @Published var budgetGoalId: String = ""
    @Published var targetWeightKg: Double? = nil
    @Published var weeklySessionsTarget: Int? = nil
    @Published var weeklyDistanceKmTarget: Double? = nil
    /// Endurance race ('YYYY-MM-DD' / km) — appended to the Goal row.
    @Published var raceDate: String? = nil
    @Published var raceDistanceKm: Double? = nil

    /// "Lose weight · 76 kg" / "Build muscle · 4×/week" — the goal plus its
    /// target when one is set. Reads the live unit preference like
    /// `profileDetails`.
    var goalRowLabel: String {
        Self.goalRowLabel(
            goalLabel: budgetGoalLabel, goalId: budgetGoalId,
            targetWeightKg: targetWeightKg, weeklySessions: weeklySessionsTarget,
            weeklyDistanceKm: weeklyDistanceKmTarget,
            raceDate: raceDate, raceDistanceKm: raceDistanceKm,
            system: UnitPreference.shared.current
        )
    }

    /// Pure composition of the Goal row label. Weight-loss shows the target
    /// weight; muscle prefers the weekly session target, falling back to the
    /// target weight; endurance shows the weekly distance ("30 km/week", unit-
    /// aware), falling back to the weekly sessions, then the upcoming race
    /// ("Endurance · 30 km/week · Half marathon Dec 30"); general just the goal
    /// name. A missing target leaves the bare goal label. `now`/`calendar`
    /// only decide whether the race is still ahead.
    nonisolated static func goalRowLabel(
        goalLabel: String, goalId: String, targetWeightKg: Double?, weeklySessions: Int?,
        weeklyDistanceKm: Double? = nil, raceDate: String? = nil, raceDistanceKm: Double? = nil,
        now: Date = Date(), calendar: Calendar = .current, system: UnitSystem
    ) -> String {
        guard !goalLabel.isEmpty else { return goalLabel }
        let weight = targetWeightKg.map { UnitFormat.weight(kg: $0, system) }
        let sessions = weeklySessions.map { "\($0)\u{00D7}/week" }
        let distance = weeklyDistanceKm.map { "\(UnitFormat.distance(km: $0, system))/week" }
        let suffix: String?
        switch goalId {
        case "weight_loss": suffix = weight
        case "muscle":      suffix = sessions ?? weight
        case "endurance":
            let race = RaceLogic.goalRowSuffix(raceDate: raceDate, distanceKm: raceDistanceKm, now: now, calendar: calendar)
            let parts = [distance ?? sessions, race].compactMap { $0 }
            suffix = parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
        default:            suffix = nil
        }
        guard let suffix else { return goalLabel }
        return "\(goalLabel) \u{00B7} \(suffix)"
    }

    /// Re-reads the goal + its targets (after the goal editor closes) so the
    /// Goal row reflects a just-saved target.
    func refreshGoalRow() async {
        await loadBudget()
        if let r = try? await apiClient.fetchProfile() {
            targetWeightKg = r.targetWeightKg
            weeklySessionsTarget = r.weeklySessionsTarget
            weeklyDistanceKmTarget = r.weeklyDistanceKmTarget
            raceDate = r.raceDate
            raceDistanceKm = r.raceDistanceKm
        }
    }

    /// Calibration status for the Profile banner — decoded straight off the
    /// profile response (the route has always returned it; Phase 9 dropped the
    /// old fetchTrends(metric: "rhr") workaround that fetched it separately).
    @Published var calibration: CalibrationStatus? = nil

    private let apiClient = APIClient.shared

    /// "8h · lights out 10:30" — the Sleep goal row's trailing value.
    var sleepGoalSummary: String {
        Self.sleepGoalSummary(goalMinutes: sleepGoalMinutes, lightsOutMinutes: lightsOutMinutes)
    }

    /// Computed (not `@Published`) so flipping the Units picker re-renders
    /// this without waiting for a fresh `load()` — it reads
    /// `UnitPreference.shared.current` fresh on every access. `details` being
    /// `@Published` is what actually triggers the view refresh.
    var profileDetails: [ProfileStatCell] {
        guard let details else { return [] }
        return Self.profileCells(from: details, units: UnitPreference.shared.current)
    }

    func load() async {
        withAnimation(Theme.Motion.appear) { isLoading = true }
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
            targetWeightKg = response.targetWeightKg
            weeklySessionsTarget = response.weeklySessionsTarget
            weeklyDistanceKmTarget = response.weeklyDistanceKmTarget
            raceDate = response.raceDate
            raceDistanceKm = response.raceDistanceKm
            // Locale-default adoption PATCH: opportunistic housekeeping, not a
            // user-initiated action, so failure is silent and simply retries
            // next launch (see UnitPreference.applyServerValue).
            if UnitPreference.shared.applyServerValue(response.unitSystem) {
                try? await apiClient.updateProfile(unitSystem: UnitPreference.shared.current.rawValue)
            }
            activityStats = Self.activityCells(from: response.stats)
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchProfile", includesAction: false)
        }
        await loadBudget()
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    /// Loads the diet-budget summary shown on the Nutrition row. Called on
    /// initial load and again when the editor is dismissed so the row updates.
    func loadBudget() async {
        do {
            let r = try await apiClient.fetchDietGoal()
            budgetKcal = r.current.targetKcal
            budgetMode = r.current.mode
            budgetGoalId = r.current.goal
            budgetGoalLabel = DietBudgetViewModel.goalLabels[r.current.goal] ?? r.current.goal
        } catch {
            // Non-fatal — the row just shows a neutral placeholder.
            print("[Vital] fetchDietGoal failed: \(error.localizedDescription)")
        }
    }

    /// `min(1, minimum dataDays across metrics / 14)` — same rule
    /// `TodayViewModel.applyTodayResponse` uses for its calibration progress.
    var calibrationPercent: Int {
        Int((CalibrationProgress.fraction(calibration) * 100).rounded())
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

    static func profileCells(from profile: ProfileDetails, units: UnitSystem) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Age",            value: profile.age.map(String.init) ?? "--", sfSymbol: "person.fill"),
            ProfileStatCell(label: "Height",         value: UnitFormat.height(cm: profile.heightCm, units), sfSymbol: "ruler"),
            ProfileStatCell(label: "Current weight", value: UnitFormat.weight(kg: profile.weightKg, units), sfSymbol: "scalemass"),
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
}
