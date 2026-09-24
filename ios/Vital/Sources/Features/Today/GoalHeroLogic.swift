import Foundation

/// Pure decision logic backing the muscle and endurance Today heroes
/// (docs/ux-spec-v4.md §4, §4.1) — kept free of SwiftUI/APIClient so it's
/// cheap to unit test exhaustively, same convention as `WeightHeroLogic`.
///
/// P4 honesty rule: neither hero fabricates a number it doesn't have.
/// "Last time" lift values and weekly session/volume totals need history
/// this client doesn't load today (see each type's doc comment for the
/// exact backend gap) — every function below either takes that data as an
/// explicit optional, or is left unimplemented on purpose with a comment
/// pointing at what would be needed. Callers must omit the corresponding UI
/// line when the input is `nil`/empty, never invent a placeholder number.
enum MuscleHeroLogic {

    // MARK: - Today's session

    /// The single strength/move-kind item Today's plan is built around, or
    /// `nil` for a rest day. Skipped items don't count as "today's session"
    /// (the user already dismissed it); a `.done` item still counts so the
    /// hero keeps showing what was trained rather than flipping to the rest-
    /// day copy the moment it's logged.
    static func todaySession(from items: [PlanItem]) -> PlanItem? {
        items.first { $0.kind == .move && $0.status != .skipped }
    }

    /// §4.1 exact copy for "no session planned today" — protein still has a
    /// target regardless of training, so the rest-day state says so rather
    /// than leaving the hero looking empty.
    static let restDayText = "Rest day. Protein still counts."

    // MARK: - "Last time" (fed by GET /api/training/summary, #202)

    /// Short weekday abbreviation ("Mon") for a `YYYY-MM-DD` day string, as
    /// used in `lib/localDay.ts` day keys and `/api/training/summary`'s
    /// `lastLift.date`. Parsed/formatted in a fixed UTC calendar with a
    /// POSIX locale so a date-only string never shifts a day from a local
    /// timezone offset and output doesn't vary with the device's locale —
    /// `nil` only for a malformed date string (never fabricated).
    static func weekdayShortLabel(forDateString dateString: String) -> String? {
        guard let date = Self.dayKeyFormatter.date(from: dateString) else { return nil }
        return Self.weekdayFormatter.string(from: date)
    }

    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()

    /// "Last (Mon): Deadlift 2×5 @ 150 kg" — or "... 2×5 bodyweight" when
    /// `weightKg` is `nil` (a bodyweight-only lift genuinely has no load to
    /// show, never a fabricated "@ 0 kg"). `nil` only when `date` can't be
    /// parsed — the honesty rule enforced at the call site the same way as
    /// every other function here.
    static func lastLiftText(
        exercise: String,
        date: String,
        sets: Int,
        reps: Int,
        weightKg: Double?,
        system: UnitSystem
    ) -> String? {
        guard let weekday = weekdayShortLabel(forDateString: date) else { return nil }
        let load = weightKg.map { "@ \(UnitFormat.weight(kg: $0, system))" } ?? "bodyweight"
        return "Last (\(weekday)): \(exercise) \(sets)×\(reps) \(load)"
    }

    // MARK: - Sessions this week (fed by GET /api/training/summary, #202)
    //
    // `plannedSessions` in the response is `null` when the user has never
    // added a planned ('move') session for any day this week — distinct
    // from a real zero. `sessionsThisWeekFallbackText` covers exactly that
    // case: no dots (nothing planned to compare against), just an honest
    // count of what was actually completed.

    struct WeeklySessionRecord: Equatable {
        /// True for a day the plan called for a strength session.
        let planned: Bool
        /// True if that planned session was logged done. Ignored when
        /// `planned` is false.
        let completed: Bool
    }

    /// Counts planned-and-completed sessions among `records` — `total` is
    /// every planned day (regardless of completion), `done` is the subset
    /// also completed. An unplanned day never contributes to either count.
    static func sessionsThisWeek(_ records: [WeeklySessionRecord]) -> (done: Int, total: Int) {
        let planned = records.filter(\.planned)
        let done = planned.filter(\.completed).count
        return (done, planned.count)
    }

    /// "● ● ○ ○"-style dot row for `done` of `total` — filled circles first,
    /// mirrors the ux-spec mock. `nil` for `total == 0` (nothing planned
    /// this week yet) rather than an empty string, so callers can tell
    /// "no data" apart from "zero of zero".
    static func sessionDots(done: Int, total: Int) -> String? {
        guard total > 0 else { return nil }
        let filled = min(max(done, 0), total)
        return (Array(repeating: "●", count: filled) + Array(repeating: "○", count: total - filled))
            .joined(separator: " ")
    }

    /// "2 of 4 sessions" — `nil` alongside `sessionDots` when there's
    /// nothing planned this week to count.
    static func sessionsThisWeekText(done: Int, total: Int) -> String? {
        guard total > 0 else { return nil }
        return "\(min(max(done, 0), total)) of \(total) sessions"
    }

    /// "N sessions this week" — the no-plan-data fallback for when
    /// `plannedSessions` is `null` (see the MARK above): there's nothing
    /// planned to compare against, so no dots and no "of M", just the honest
    /// completed count. Always non-nil — a real `completedSessions` (even 0)
    /// is never itself missing data, unlike `plannedSessions`.
    static func sessionsThisWeekFallbackText(completed: Int) -> String {
        let n = max(completed, 0)
        return "\(n) session\(n == 1 ? "" : "s") this week"
    }
}

/// Pure decision logic backing the endurance Today hero (docs/ux-spec-v4.md
/// §4.1). Readiness is derived ONLY from `Verdict` — the same gated,
/// no-fabrication judgment `TrendsVerdict.evaluate` already produces for the
/// Trends tab — never a synthesized "readiness score".
enum EnduranceHeroLogic {

    /// Which direction of a metric's verdict counts as "good" for
    /// readiness — mirrors `MetricSpec.polarity` (Trends/MetricCatalog.swift)
    /// for the three metrics Today already loads.
    enum Polarity {
        case higherIsBetter
        case lowerIsBetter
    }

    /// +1 when `verdict` sits on the good side of `polarity`, -1 on the bad
    /// side, 0 for `.normal`/`.noData`/`.calibrating` (nothing to score —
    /// `.noData`/`.calibrating` are never treated as "bad", since that would
    /// be inventing a judgment from an absence of data).
    static func score(_ verdict: Verdict, polarity: Polarity) -> Int {
        switch verdict {
        case .noData, .calibrating, .normal:
            return 0
        case .above:
            return polarity == .higherIsBetter ? 1 : -1
        case .below:
            return polarity == .lowerIsBetter ? 1 : -1
        }
    }

    enum ReadinessWord: String, Equatable {
        case readyToPush = "Ready to push"
        case goodToTrain = "Good to train"
        case keepItEasy = "Keep it easy"
        case recoverToday = "Recover today"
    }

    /// A `|z| >= 2` on the BAD side of `polarity` — a stronger signal than
    /// the `abs(z) >= 1` that already separates `.above`/`.below` from
    /// `.normal` in `TrendsVerdict`. Used only to gate `.recoverToday`: a
    /// single metric sitting merely one σ off normal (the common `.above`/
    /// `.below` case) is not "recover today" territory, but a metric two or
    /// more σ into the bad direction is a strong enough signal on its own,
    /// independent of what the other two metrics say.
    private static func isStronglyBad(_ verdict: Verdict, polarity: Polarity) -> Bool {
        switch verdict {
        case .below(let z): return polarity == .higherIsBetter && z <= -2
        case .above(let z): return polarity == .lowerIsBetter && z >= 2
        case .noData, .calibrating, .normal: return false
        }
    }

    /// The hero's headline word — coaching review, 2026-09-23: a normal
    /// reading across the board (score 0, the common case) means "nothing
    /// is flagged, train as planned," not "hold back" — so it reads "Good
    /// to train", never "Keep it easy". The sum of the three gated
    /// verdicts' scores (HRV and sleep: higher is better; resting HR: lower
    /// is better) still drives the rest: net-positive → "Ready to push";
    /// a genuinely strong negative signal — `total <= -2`, OR any single
    /// metric landing `|z| >= 2` on its bad side even if the other two
    /// offset it (`isStronglyBad`) — → "Recover today"; anything milder in
    /// the negative direction (`total == -1`, no strongly-bad metric) →
    /// the soft "Keep it easy", never the stronger "Recover today" claim
    /// the data doesn't support.
    static func readinessWord(hrv: Verdict, sleep: Verdict, restingHR: Verdict) -> ReadinessWord {
        let total = score(hrv, polarity: .higherIsBetter)
            + score(sleep, polarity: .higherIsBetter)
            + score(restingHR, polarity: .lowerIsBetter)
        let anyStronglyBad = isStronglyBad(hrv, polarity: .higherIsBetter)
            || isStronglyBad(sleep, polarity: .higherIsBetter)
            || isStronglyBad(restingHR, polarity: .lowerIsBetter)

        if total >= 1 { return .readyToPush }
        if total <= -2 || anyStronglyBad { return .recoverToday }
        if total <= -1 { return .keepItEasy }
        return .goodToTrain
    }

    /// §4.1's calibrating override — takes priority over any verdict-derived
    /// word while baselines are still being built. `daysCollected` mirrors
    /// `TodayView.calibrationCard`'s own `Int((progress * 14).rounded())`
    /// derivation so the two surfaces never disagree.
    static func calibratingText(daysCollected: Int) -> String {
        "Calibrating · day \(min(max(daysCollected, 0), 14)) of 14"
    }

    // MARK: - Today's session

    /// Same rule as `MuscleHeroLogic.todaySession` — the plan's move-kind
    /// row for today, or `nil` for a rest day.
    static func todaySession(from items: [PlanItem]) -> PlanItem? {
        items.first { $0.kind == .move && $0.status != .skipped }
    }

    static let restDayText = "No session planned today."

    // MARK: - Weekly volume (fed by GET /api/training/summary, #202)
    //
    // `volume.target` is always `null` today (no plan/goal in the schema
    // defines a weekly distance target — see `lib/trainingSummary.ts`), but
    // this still supports it so the richer "X of Y km" copy is ready the
    // moment a target exists, with no call-site change needed.

    /// `nil` when `kmDone` is missing — never show a fabricated weekly
    /// total. "X km this week" when there's no target to compare against
    /// (the common case today); "X of Y km" once a target exists.
    static func weeklyVolumeText(kmDone: Double?, kmTarget: Double?, system: UnitSystem) -> String? {
        guard let kmDone else { return nil }
        if let kmTarget, kmTarget > 0 {
            return "\(UnitFormat.distance(km: kmDone, system)) of \(UnitFormat.distance(km: kmTarget, system))"
        }
        return "\(UnitFormat.distance(km: kmDone, system)) this week"
    }
}
