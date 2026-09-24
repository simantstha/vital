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

    // MARK: - "Last time" (backend gap)
    //
    // The ux-spec asks for "Last (Mon) Bench 3×5 @ 185 lb" — set/rep/load
    // history for the session's main lift. That data exists server-side
    // (`getExerciseHistory` / `get_training_history`, lib/brain/tools.ts) but
    // is currently reachable ONLY through the coach's tool-call path, not a
    // REST endpoint `APIClient` can call from Today. There is deliberately
    // no function here that fabricates or guesses this line — see the PR
    // report for the exact endpoint this needs
    // (e.g. `GET /api/training-history?exercise=`).

    // MARK: - Sessions this week (backend gap)
    //
    // `/api/plan` only ever returns TODAY's rows — Today has no client-side
    // view of the last 7 days' planned-vs-completed strength sessions, so
    // the real count can't be shown yet either (see PR report). This type
    // documents the intended shape so the counting/formatting logic is
    // ready the moment a weekly endpoint exists; `TodayViewModel` currently
    // never constructs `WeeklySessionRecord`s, so `MuscleHeroView` never
    // renders this row until it does.

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

    // MARK: - Weekly volume (backend gap)
    //
    // Same gap as `MuscleHeroLogic`'s weekly-session count: `/api/plan` is
    // today-only, so there's no client-side week of completed distance to
    // sum. `weeklyVolumeText` takes the total as an explicit optional so the
    // honesty rule is enforced at the call site (never invent a total), and
    // is ready for a `GET /api/training-volume?range=week`-shaped response —
    // see the PR report.

    /// `nil` when `kmDone`/`kmTarget` aren't both available — never show a
    /// partial or fabricated weekly total.
    static func weeklyVolumeText(kmDone: Double?, kmTarget: Double?, system: UnitSystem) -> String? {
        guard let kmDone, let kmTarget, kmTarget > 0 else { return nil }
        return "Week \(UnitFormat.distance(km: kmDone, system)) of \(UnitFormat.distance(km: kmTarget, system))"
    }
}
