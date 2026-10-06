import Foundation
import SwiftUI

/// Backs the "Targets" card on Profile → Goal: target weight (unit-aware),
/// target date and workouts per week. Loads from GET /api/profile, saves via
/// PATCH /api/profile (explicit nulls clear a field), then posts
/// `.vitalGoalTargetsChanged` so Today/Trends can refresh.
@MainActor
final class GoalTargetsViewModel: ObservableObject {

    /// What gets sent to the server; compared against the last loaded/saved
    /// value to drive the Save button.
    struct Payload: Equatable {
        var targetWeightKg: Double?
        var targetDate: String?
        var weeklySessionsTarget: Int?
    }

    @Published var isLoading = true
    @Published var isSaving = false
    @Published var errorMessage: String?

    /// Display-unit text (kg or lb, per `UnitPreference`).
    @Published var targetWeightText = ""
    @Published var hasTargetDate = false
    @Published var targetDate: Date = Calendar.current.date(byAdding: .day, value: 70, to: Date()) ?? Date()
    @Published var hasWeeklySessions = false
    @Published var weeklySessions = 3

    @Published private(set) var startWeightKg: Double?
    @Published private(set) var startedAtISO: String?
    /// Latest known body weight (profile.weightKg), used for pace/sanity hints.
    @Published private(set) var currentWeightKg: Double?

    private var baseline = Payload()
    /// Server value + the text it was rendered as, so an untouched weight
    /// field round-trips the exact kg (imperial display rounds to whole lb).
    private var loadedTargetKg: Double?
    private var seededWeightText = ""

    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
    }

    private var units: UnitSystem { UnitPreference.shared.current }

    // MARK: - Derived

    /// Parsed kg for the current text; nil when empty or unparseable.
    private var parsedTargetKg: Double? {
        let trimmed = targetWeightText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return UnitFormat.kg(fromEntry: trimmed, units)
    }

    var targetKg: Double? {
        if targetWeightText == seededWeightText { return loadedTargetKg }
        return GoalTargetLogic.validTargetKg(parsedTargetKg)
    }

    /// Non-nil when the text is non-empty but not a usable weight.
    var weightError: String? {
        let trimmed = targetWeightText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, targetWeightText != seededWeightText else { return nil }
        guard GoalTargetLogic.validTargetKg(parsedTargetKg) != nil else {
            let lo = UnitFormat.weightEntryText(kg: GoalTargetLogic.minTargetKg, units)
            let hi = UnitFormat.weightEntryText(kg: GoalTargetLogic.maxTargetKg, units)
            return "Enter a weight between \(lo) and \(hi) \(units.weightUnit)."
        }
        return nil
    }

    var payload: Payload {
        Payload(
            targetWeightKg: targetKg,
            targetDate: hasTargetDate ? GoalTargetLogic.dayString(from: targetDate) : nil,
            weeklySessionsTarget: hasWeeklySessions ? GoalTargetLogic.clampSessions(weeklySessions) : nil
        )
    }

    var isDirty: Bool { payload != baseline }
    var canSave: Bool { isDirty && weightError == nil && !isSaving && !isLoading }

    var startedLine: String? {
        GoalTargetLogic.startedLine(weightKg: startWeightKg, startedAtISO: startedAtISO, units: units)
    }

    // MARK: - Load / save

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let r = try await api.fetchProfile()
            apply(r)
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchProfileGoalTargets", includesAction: false)
        }
    }

    private func apply(_ r: ProfileResponse) {
        loadedTargetKg = r.targetWeightKg
        seededWeightText = UnitFormat.weightEntryText(kg: r.targetWeightKg, units)
        targetWeightText = seededWeightText

        if let day = r.targetDate, let date = GoalTargetLogic.date(fromDay: day) {
            hasTargetDate = true
            targetDate = date
        } else {
            hasTargetDate = false
        }
        if let n = r.weeklySessionsTarget {
            hasWeeklySessions = true
            weeklySessions = n
        } else {
            hasWeeklySessions = false
        }
        startWeightKg = r.goalStartWeightKg
        startedAtISO = r.goalStartedAt
        currentWeightKg = r.profile.weightKg
        baseline = payload
    }

    /// Returns true on success.
    @discardableResult
    func save() async -> Bool {
        guard canSave else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let p = payload
        do {
            try await api.updateGoalTargets(
                targetWeightKg: p.targetWeightKg,
                targetDate: p.targetDate,
                weeklySessionsTarget: p.weeklySessionsTarget
            )
            baseline = p
            loadedTargetKg = p.targetWeightKg
            seededWeightText = targetWeightText
            // A changed target weight re-anchors the start weight server-side.
            await reloadStart()
            NotificationCenter.default.post(name: .vitalGoalTargetsChanged, object: nil)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .write, tag: "updateGoalTargets")
            return false
        }
    }

    private func reloadStart() async {
        guard let r = try? await api.fetchProfile() else { return }
        startWeightKg = r.goalStartWeightKg
        startedAtISO = r.goalStartedAt
    }
}
