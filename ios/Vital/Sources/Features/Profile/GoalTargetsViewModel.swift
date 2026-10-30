import Foundation
import SwiftUI

/// The two profile calls the Targets card makes — a seam so tests can drive the
/// real view model without a network.
@MainActor
protocol GoalTargetsAPIProviding {
    func fetchProfile() async throws -> ProfileResponse
    func updateGoalTargets(
        targetWeightKg: Double?,
        targetDate: String?,
        includeTargetDate: Bool,
        weeklySessionsTarget: Int?,
        weeklyDistanceKmTarget: Double?,
        raceDate: String?,
        raceDistanceKm: Double?
    ) async throws
}

extension APIClient: GoalTargetsAPIProviding {}

/// Backs the "Targets" card on Profile → Goal: target weight (unit-aware),
/// target date, workouts per week and (endurance) weekly distance. Loads from GET /api/profile, saves via
/// PATCH /api/profile (explicit nulls clear a field), then posts
/// `.vitalGoalTargetsChanged` so Today/Trends can refresh.
///
/// A stored target date that is today or earlier (`passedTargetDay`) is shown as
/// "Target date passed (Sep 30)" with "Pick a new date" / "Remove date" instead
/// of a picker the server would reject, and a target date the user hasn't
/// changed is never sent — so a passed date can't make every other edit fail.
@MainActor
final class GoalTargetsViewModel: ObservableObject {

    /// What gets sent to the server; compared against the last loaded/saved
    /// value to drive the Save button.
    struct Payload: Equatable {
        var targetWeightKg: Double?
        var targetDate: String?
        var weeklySessionsTarget: Int?
        var weeklyDistanceKmTarget: Double?
        var raceDate: String?
        var raceDistanceKm: Double?
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
    /// Display-unit text (km or mi, per `UnitPreference`); empty = no distance target.
    @Published var weeklyDistanceText = ""
    /// Optional endurance race: date toggle + picker, distance via presets.
    @Published var hasRaceDate = false
    @Published var raceDate: Date = Calendar.current.date(byAdding: .day, value: 84, to: Date()) ?? Date()
    @Published var raceDistanceKm: Double = RaceLogic.defaultDistanceKm

    @Published private(set) var startWeightKg: Double?
    @Published private(set) var startedAtISO: String?
    /// Latest known body weight (profile.weightKg), used for pace/sanity hints.
    @Published private(set) var currentWeightKg: Double?
    /// The stored 'YYYY-MM-DD' target date while it is today or earlier and the
    /// user hasn't picked a new one or removed it; `nil` otherwise. Non-nil
    /// swaps the date toggle + picker for the "Target date passed" choice.
    @Published private(set) var passedTargetDay: String?

    private var baseline = Payload()
    /// Server value + the text it was rendered as, so an untouched weight
    /// field round-trips the exact kg (imperial display rounds to whole lb).
    private var loadedTargetKg: Double?
    private var seededWeightText = ""
    /// Same round-trip trick for the weekly distance field.
    private var loadedDistanceKm: Double?
    private var seededDistanceText = ""

    private let api: GoalTargetsAPIProviding
    /// Injected so tests can pin "today" for the passed-date check.
    private let now: () -> Date

    init(api: GoalTargetsAPIProviding = APIClient.shared, now: @escaping () -> Date = { Date() }) {
        self.api = api
        self.now = now
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

    /// The target weight saved on the server (last loaded / saved), in kg. The
    /// sanity warning compares the field against it: an unchanged saved target
    /// that the current weight already meets reads as "reached", a newly typed
    /// target on the wrong side of the current weight stays a validation warning.
    var storedTargetKg: Double? { loadedTargetKg }

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

    /// Parsed km for the distance text; nil when empty or unparseable.
    private var parsedDistanceKm: Double? {
        let trimmed = weeklyDistanceText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return UnitFormat.km(fromDistanceEntry: trimmed, units)
    }

    /// Weekly distance target in km: the exact server value while the field is
    /// untouched, else the validated parse of what was typed.
    var weeklyDistanceKm: Double? {
        if weeklyDistanceText == seededDistanceText { return loadedDistanceKm }
        return GoalTargetLogic.validWeeklyDistanceKm(parsedDistanceKm)
    }

    /// Non-nil when the text is non-empty but not a usable distance.
    var distanceError: String? {
        let trimmed = weeklyDistanceText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, weeklyDistanceText != seededDistanceText else { return nil }
        guard GoalTargetLogic.validWeeklyDistanceKm(parsedDistanceKm) != nil else {
            let lo = UnitFormat.distanceEntryText(km: GoalTargetLogic.minWeeklyDistanceKm, units)
            let hi = UnitFormat.distanceEntryText(km: GoalTargetLogic.maxWeeklyDistanceKm, units)
            return "Enter a distance between \(lo) and \(hi) \(units.distanceUnit)."
        }
        return nil
    }

    var payload: Payload {
        Payload(
            targetWeightKg: targetKg,
            targetDate: hasTargetDate ? GoalTargetLogic.dayString(from: targetDate) : nil,
            weeklySessionsTarget: hasWeeklySessions ? GoalTargetLogic.clampSessions(weeklySessions) : nil,
            weeklyDistanceKmTarget: weeklyDistanceKm,
            raceDate: hasRaceDate ? GoalTargetLogic.dayString(from: raceDate) : nil,
            raceDistanceKm: hasRaceDate ? raceDistanceKm : nil
        )
    }

    /// Drops the race (date and distance) — the Save button then sends nulls.
    func clearRace() {
        hasRaceDate = false
    }

    // MARK: - Passed target date

    /// "Target date passed (Sep 30)" while the stored date is today or earlier.
    var passedTargetDateText: String? {
        passedTargetDay.flatMap { GoalTargetLogic.passedTargetDateLabel(day: $0, now: now()) }
    }

    /// The target date to weigh pace against (the sanity warning): `nil` when
    /// there is none or it has passed — a past date is not a deadline.
    var activeTargetDate: Date? {
        hasTargetDate && passedTargetDay == nil ? targetDate : nil
    }

    /// "Pick a new date": leaves the passed state with a fresh future date
    /// (the usual default, 10 weeks out), which the user can then adjust.
    func pickNewTargetDate() {
        passedTargetDay = nil
        hasTargetDate = true
        targetDate = Self.defaultTargetDate(from: now())
    }

    /// "Remove date": leaves the passed state with no target date — the Save
    /// button then sends an explicit null.
    func removeTargetDate() {
        passedTargetDay = nil
        hasTargetDate = false
    }

    private static func defaultTargetDate(from now: Date) -> Date {
        Calendar.current.date(byAdding: .day, value: 70, to: now) ?? now
    }

    /// True when the target date differs from what the server last gave us /
    /// accepted — the only time the request carries it. An untouched date (above
    /// all a passed one, which the server rejects as a "new" date) is omitted.
    var targetDateChanged: Bool { payload.targetDate != baseline.targetDate }

    var isDirty: Bool { payload != baseline }
    var canSave: Bool { isDirty && weightError == nil && distanceError == nil && !isSaving && !isLoading }

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
            // A date that is today or earlier can't be re-sent (the server only
            // accepts a new date after today): keep it as the baseline so an
            // untouched sheet isn't dirty, but show the "passed" choice instead
            // of a picker whose range excludes it.
            passedTargetDay = GoalTargetLogic.isPassedTargetDay(day, now: now()) ? day : nil
        } else {
            hasTargetDate = false
            passedTargetDay = nil
        }
        if let n = r.weeklySessionsTarget {
            hasWeeklySessions = true
            weeklySessions = n
        } else {
            hasWeeklySessions = false
        }
        loadedDistanceKm = r.weeklyDistanceKmTarget
        seededDistanceText = UnitFormat.distanceEntryText(km: r.weeklyDistanceKmTarget, units)
        weeklyDistanceText = seededDistanceText
        // A race that has already passed reads as "no race": re-saving other
        // targets must not resend a date the server would now reject.
        if let day = r.raceDate, let date = GoalTargetLogic.date(fromDay: day),
           date >= Calendar.current.startOfDay(for: Date()) {
            hasRaceDate = true
            raceDate = date
            raceDistanceKm = RaceLogic.validDistanceKm(r.raceDistanceKm) ?? RaceLogic.defaultDistanceKm
        } else {
            hasRaceDate = false
            raceDistanceKm = RaceLogic.defaultDistanceKm
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
        // Decided before `baseline` moves: only a date the user actually changed
        // (picked, toggled on/off, removed) goes on the wire.
        let sendsTargetDate = targetDateChanged
        do {
            try await api.updateGoalTargets(
                targetWeightKg: p.targetWeightKg,
                targetDate: p.targetDate,
                includeTargetDate: sendsTargetDate,
                weeklySessionsTarget: p.weeklySessionsTarget,
                weeklyDistanceKmTarget: p.weeklyDistanceKmTarget,
                raceDate: p.raceDate,
                raceDistanceKm: p.raceDistanceKm
            )
            baseline = p
            loadedTargetKg = p.targetWeightKg
            seededWeightText = targetWeightText
            loadedDistanceKm = p.weeklyDistanceKmTarget
            seededDistanceText = weeklyDistanceText
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
