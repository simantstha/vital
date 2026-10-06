import Foundation

/// Pure copy generator behind the Trends header's one-line summary
/// ("Three things moved this month — 2 good, 1 to watch."), replacing the
/// old static "Last 30 days · N metrics tracked" subtitle. No SwiftUI
/// import, no `Date()` — every input is a plain count so `TrendsHeadlineTests`
/// can pin exact copy for every good/watch/period combination.
///
/// Numbers below nine spell out as words ("Three", "one"); ten and up fall
/// back to digits — this never actually needs to render past the grid's tile
/// count (well under ten), but the fallback keeps the helper honest rather
/// than crashing on an out-of-range index.
enum TrendsHeadline {
    /// `boldText` is the emphasized "N things moved <period>" clause;
    /// `trailingText` is the plain-weight remainder, already including its
    /// leading " — " (or, when nothing moved, the entire sentence — in that
    /// case `boldText` is empty and the view renders `trailingText` alone).
    struct Summary: Equatable {
        let boldText: String
        let trailingText: String

        /// The full sentence, boldText + trailingText concatenated — for
        /// contexts (VoiceOver, tests) that don't care about the bold split.
        var fullText: String { boldText + trailingText }
    }

    static func summary(goodCount: Int, watchCount: Int, period: TrendsPeriod) -> Summary {
        let total = goodCount + watchCount
        guard total > 0 else {
            return Summary(boldText: "", trailingText: "Everything's in your normal range.")
        }

        let thingWord = total == 1 ? "thing" : "things"
        let bold = "\(wordForCount(total).capitalizedFirstLetter) \(thingWord) moved \(period.headlineWord)"

        let detail: String
        if goodCount > 0 && watchCount > 0 {
            detail = "\(wordForCount(goodCount)) good, \(wordForCount(watchCount)) to watch"
        } else if goodCount > 0 {
            detail = sideOnly(goodCount, label: "good")
        } else {
            detail = sideOnly(watchCount, label: "to watch")
        }
        return Summary(boldText: bold, trailingText: " — \(detail).")
    }

    /// "both good" / "both to watch" when the omitted side leaves exactly
    /// two on the other — otherwise a spelled-out (or, past nine, digit)
    /// count word plus the label.
    private static func sideOnly(_ count: Int, label: String) -> String {
        count == 2 ? "both \(label)" : "\(wordForCount(count)) \(label)"
    }

    private static let numberWords = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    ]

    static func wordForCount(_ n: Int) -> String {
        (n >= 0 && n < numberWords.count) ? numberWords[n] : "\(n)"
    }

    // MARK: - Calm-layout revamp: the top-of-screen status (learning /
    // steady / moved), replacing the old always-shown one-line subtitle plus
    // the separate "Baselines are still calibrating" banner (W1/W2 designs).
    //
    // Before this, a new user could see "Everything's in your normal range"
    // (the old `summary(goodCount: 0, watchCount: 0, ...)` copy, still kept
    // below for its own call sites/tests) directly above a banner saying
    // baselines were still calibrating — a direct contradiction, since
    // nothing can be confirmed "normal" before any baseline exists.
    // `status(verdicts:goodCount:watchCount:period:)` is the single place
    // that decides which of the three headline states applies, so the view
    // layer never has to reconcile them itself.

    /// The "Learning your normal" card's progress (W2 design): a ring
    /// labelled "N/14" plus body copy, shown instead of any
    /// normal/moved claim while the screen has no established baseline to
    /// judge against yet.
    struct LearningProgress: Equatable {
        /// The smallest `Verdict.calibrating(daysRemaining:)` among the
        /// metrics shown — see `status(verdicts:...)` for why the smallest
        /// (not an average, not the slowest metric) is the only honest
        /// number: it's the next date at which ANY shown metric's baseline
        /// clears, so "X more days" stays true until that day, and a lower
        /// number never falsely implies a metric is *further* from ready.
        let daysRemaining: Int

        /// Days of history already counted toward the fixed 14-day window,
        /// clamped to 0...14 — the ring's filled fraction is `daysDone/14`.
        var daysDone: Int { max(0, min(14, 14 - daysRemaining)) }

        /// "2/14" — the ring's center label.
        var ringLabel: String { "\(daysDone)/14" }

        /// "12 more days and I'll tell you what's unusual. Until then,
        /// here's what I'm seeing." `daysRemaining == 0` (gate 4/5 of
        /// `TrendsVerdict` — enough calendar history but not enough real
        /// variation yet) has no day count left to name, so it reads as
        /// "not enough variation yet" instead of the false "Zero more days".
        var bodyText: String {
            guard daysRemaining > 0 else {
                return "I don't have enough variation yet to tell you what's unusual. Here's what I'm seeing."
            }
            let dayWord = daysRemaining == 1 ? "day" : "days"
            return "\(wordForCount(daysRemaining).capitalizedFirstLetter) more \(dayWord) and I'll tell you what's unusual. Until then, here's what I'm seeing."
        }
    }

    /// The three mutually-exclusive states the Trends header can be in.
    enum Status: Equatable {
        /// Every metric shown is still calibrating (or none has cleared
        /// enough history to have a verdict at all) — never claims "normal".
        case learning(LearningProgress)
        /// Every metric shown is established and none moved outside its
        /// normal range this period.
        case steady(period: TrendsPeriod)
        /// At least one metric moved — unchanged from the pre-revamp
        /// headline (`Summary`'s existing bold/trailing split).
        case moved(Summary)
    }

    /// `verdicts` is every `Verdict` behind a tile actually rendered as a
    /// `.chart` this period (i.e. it has enough points for a verdict at
    /// all) — a tile still `.sparse`/`.dimmed`/hidden contributes nothing,
    /// which is exactly what makes an empty `verdicts` read as "no metric is
    /// established" below.
    /// Goal-relevant moves that are NOT metric tiles with a verdict — the
    /// weight_loss goal's weight trend and the Strength card's lifts — so the
    /// header can't say "A steady month. Nothing moved" above a +8 kg squat or
    /// a falling weight trend. Plain counts only; `TrendsViewModel` builds it.
    struct GoalMoves: Equatable {
        /// A weight-trend change (kg, first to last trend point) at least this
        /// big counts as a move; smaller is scale noise.
        static let weightThresholdKg = 0.5

        /// First to last smoothed weight-trend point (kg) for the weight_loss
        /// goal; `nil` for other goals, an unestablished trend, or when the
        /// weight metric tile already counted it.
        var weightDeltaKg: Double? = nil
        /// Lifts whose shared 4-week e1RM change (`TrendsStrengthLogic.change`)
        /// is up / down by at least `TrendsStrengthLogic.changeThresholdKg`.
        var liftsUp: Int = 0
        var liftsDown: Int = 0

        static let empty = GoalMoves()

        var goodCount: Int {
            liftsUp + ((weightDeltaKg ?? 0) <= -Self.weightThresholdKg ? 1 : 0)
        }
        var watchCount: Int {
            liftsDown + ((weightDeltaKg ?? 0) >= Self.weightThresholdKg ? 1 : 0)
        }

        /// `goal` is the diet-goal string ("weight_loss" ...). Weight only
        /// counts for weight_loss, where down is good.
        static func make(
            goal: String,
            weightTrend: WeightTrendDTO?,
            strength: TrendsStrengthLogic.Card?,
            weightAlreadyCounted: Bool
        ) -> GoalMoves {
            var moves = GoalMoves()
            if goal == "weight_loss", !weightAlreadyCounted,
               let trend = weightTrend, trend.established, trend.days.count >= 2,
               let first = trend.days.first, let last = trend.days.last {
                moves.weightDeltaKg = last.trendKg - first.trendKg
            }
            for lift in strength?.lifts ?? [] {
                guard let change = lift.changeKg else { continue }
                if change >= TrendsStrengthLogic.changeThresholdKg { moves.liftsUp += 1 }
                if change <= -TrendsStrengthLogic.changeThresholdKg { moves.liftsDown += 1 }
            }
            return moves
        }
    }

    static func status(
        verdicts: [Verdict],
        goodCount rawGoodCount: Int,
        watchCount rawWatchCount: Int,
        period: TrendsPeriod,
        goalMoves: GoalMoves = .empty
    ) -> Status {
        let goodCount = rawGoodCount + goalMoves.goodCount
        let watchCount = rawWatchCount + goalMoves.watchCount
        // `allSatisfy` on an empty array is vacuously `true` — that's
        // intentional: "no metric shown has a verdict yet" is exactly as
        // much "still learning" as "every verdict shown is calibrating".
        let isLearning = verdicts.allSatisfy { verdict in
            if case .calibrating = verdict { return true }
            return false
        }
        if isLearning {
            // Smallest remaining across the calibrating verdicts shown —
            // see `LearningProgress.daysRemaining`'s doc comment. No
            // calibrating verdict at all (the empty-`verdicts` case) has no
            // real "days remaining" to report yet, so it defaults to the
            // full 14 — 0 days done is the only honest starting point.
            let remaining = verdicts.compactMap { verdict -> Int? in
                if case .calibrating(let days) = verdict { return days }
                return nil
            }.min() ?? 14
            return .learning(LearningProgress(daysRemaining: remaining))
        }
        if goodCount == 0 && watchCount == 0 {
            return .steady(period: period)
        }
        return .moved(summary(goodCount: goodCount, watchCount: watchCount, period: period))
    }

    /// "A steady month." — the established/nothing-moved headline (W1
    /// design). Paired with `steadySubline` below it.
    static func steadyHeadlineText(period: TrendsPeriod) -> String {
        "A steady \(period.steadyPeriodWord)."
    }

    /// The fixed subline under `steadyHeadlineText` — never varies by
    /// period, since "nothing moved" is the whole statement regardless of
    /// window length.
    static let steadySubline = "Nothing moved outside your normal."
}

private extension String {
    var capitalizedFirstLetter: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
