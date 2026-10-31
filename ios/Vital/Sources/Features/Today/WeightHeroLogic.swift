import Foundation

/// Pure decision logic backing the weight_loss hero (docs/ux-spec-v4.md §4.1,
/// §5.3) and the "Next up" row (owner decision, 2026-09-23) — kept free of
/// SwiftUI/APIClient so it's cheap to unit test exhaustively. Every function
/// here takes its inputs explicitly rather than reading a view model.
enum WeightHeroLogic {

    // MARK: - Next up (replaces the full plan list on Today for every goal)

    /// Screenshot-review fix (2026-09-23): a not-done item hours in the past
    /// (breakfast, at 3pm) is not "next" by any reasonable reading — this is
    /// how far back an item can sit and still count as upcoming, so
    /// something that just started a few minutes ago doesn't flicker out.
    static let nextUpGraceMinutes = 30

    /// The single row Today shows in place of the full plan timeline: the
    /// earliest not-done/not-skipped item whose time is no more than
    /// `nextUpGraceMinutes` in the past relative to `nowMinutes` (minutes
    /// since local midnight). `nil` when every remaining candidate has
    /// already passed that grace window, everything is done/skipped, or the
    /// plan is empty — callers must hide the row entirely (never show an
    /// empty card shell) but keep "See full plan" reachable some other way.
    static func nextUpItem(from items: [PlanItem], nowMinutes: Int) -> PlanItem? {
        items
            .filter { $0.status != .done && $0.status != .skipped }
            .filter { $0.timeMinutes >= nowMinutes - nextUpGraceMinutes }
            .min { $0.timeMinutes < $1.timeMinutes }
    }

    // MARK: - Trend headline / weekly-change text (honesty rule, §4.1)

    /// Owner override (2026-09-23) of the mock's "Trend appears after 3
    /// weigh-ins · 1 of 3": exact copy is "Your trend appears after 3
    /// weigh-ins" — never a fabricated number before the server marks the
    /// trend `established`.
    static let trendPlaceholderText = "Your trend appears after 3 weigh-ins"

    /// The hero's small "Trend 182.4 lb" line, or the honest placeholder
    /// when `trend` is nil / not yet established / has no computed days.
    static func trendHeadline(trend: WeightTrendDTO?, system: UnitSystem) -> String {
        guard let trend, trend.established, let latest = trend.days.last else {
            return trendPlaceholderText
        }
        return "Trend \(UnitFormat.weight(kg: latest.trendKg, system))"
    }

    /// Today hero header variant of `trendHeadline`: once the trend is
    /// established the number is already shown as "Now 82 kg" under the
    /// sparkline, so the header drops "Trend 82 kg" (persona review: same
    /// number twice) and leads with the rate line. Only the honest
    /// placeholder still renders here.
    static func heroHeaderTrendText(trend: WeightTrendDTO?, system: UnitSystem) -> String? {
        guard let trend, trend.established, trend.days.last != nil else {
            return trendPlaceholderText
        }
        return nil
    }

    /// Dietitian-review guard (2026-09-23): a weekly rate loses more meaning
    /// as noise dominates the shorter the observed history is, so it stays
    /// hidden entirely until weigh-ins span at least this many calendar
    /// days — stricter than `established`'s >= 5 days gate on the headline.
    static let minimumSpanDaysForWeeklyRate = 7

    /// Dietitian-review guard (2026-09-23): a sustained loss rate above 1%
    /// of current trend weight per week is faster than generally
    /// recommended — flagged neutrally (never red/alarming, never
    /// celebratory) rather than blocked, since only a clinician has the
    /// context to say whether it's appropriate for this person.
    static let fastLossPercentPerWeekThreshold = 1.0

    /// Earliest-to-latest calendar-day span covered by `entries`, or `nil`
    /// for fewer than 2 distinct days. Derived client-side from raw
    /// `WeightLogEntryDTO.date` strings (`YYYY-MM-DD`, so lexicographic
    /// min/max already gives the earliest/latest) rather than the trend's
    /// `days` series — `lib/weightTrend.ts` (see `app/api/weight-log
    /// /route.ts`) exposes no explicit span field, only `established`
    /// (>= 3 entries over >= 5 days), which is a looser gate than the >= 7
    /// days this function enforces for the weekly-rate line specifically.
    static func daySpan(entries: [WeightLogEntryDTO]) -> Int? {
        let days = entries.map(\.date)
        guard let earliest = days.min(), let latest = days.max(), earliest != latest else { return nil }
        guard let earliestNumber = dayNumber(earliest), let latestNumber = dayNumber(latest) else { return nil }
        return latestNumber - earliestNumber
    }

    /// Epoch day number for a `YYYY-MM-DD` string — pure calendar
    /// arithmetic, mirrors `lib/weightTrend.ts`'s `dayNumber`.
    private static func dayNumber(_ day: String) -> Int? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let date = utc.date(from: components) else { return nil }
        return Int((date.timeIntervalSince1970 / 86_400).rounded())
    }

    /// "−0.4 kg/wk this week" (plus a neutral pace note — see
    /// `fastLossPercentPerWeekThreshold`) — `nil` (never a bare "0" or a
    /// stale number) until the trend is established AND `entries` span at
    /// least `minimumSpanDaysForWeeklyRate` days. Prefers the 7-day rate; a
    /// fresh trend can have `established == true` (>= 3 weigh-ins over >= 5
    /// days) while still lacking a full 7-day window, in which case
    /// `weeklyDelta` already reports a partial-window rate over whatever
    /// span exists — still an honest, non-fabricated number once the span
    /// gate above is satisfied.
    ///
    /// `goalRateKgPerWeek`: when the goal-progress card has a 4-week rate, the
    /// hero shows that SAME number ("−0.9 lb/wk over 3 weeks") so the hero and
    /// the card never disagree; without it the 7-day rate above is used.
    ///
    /// `goalRateWindowDays`: the days the server fitted that rate over
    /// (`weightRead.paceWindowDays`: 21, or 28 while a gap is bridged). The hero
    /// names that window ("over 3 weeks"); without it (an older server) it
    /// names none rather than guess - see `paceWindowPhrase`.
    ///
    /// `goalRateRange` (wave 22w): when the server's card shows a RANGE for an
    /// on-pace week (`GoalProgressLogic.paceRange`: "Down 0.4–0.6 kg/wk"), the hero
    /// says that same range, never the one rate ("−0.6 kg/wk over 4 weeks") that
    /// argues with it. It wins over `goalRateKgPerWeek`; `nil` (an older server, any
    /// other week) keeps today's behaviour exactly.
    ///
    /// `withholdsLocalRate` / `serverRead`: while the server is reading the scale
    /// itself (`GoalProgressLogic.usesServerWeightRead` — an early read, a
    /// return after a gap, a plateau) it sends no weekly pace on purpose, so the
    /// 7-day fallback must NOT fill the gap with a jumpier number of its own.
    /// The same while the newest weigh-in is a week old or more
    /// (`GoalProgressLogic.withholdsWeeklyRate`): a rate off it must not read as
    /// this week's, and the goal line below carries the stale-weigh-in nudge.
    /// The hero then shows `serverRead` — the slot text from `serverReadSlotText`
    /// (a short complement while the goal line says the read, the full read
    /// otherwise; it wraps, the hero's rate line has no line limit) — or nothing
    /// when there is none. Both default to "no server read", so an older server
    /// keeps today's behaviour exactly.
    static func weeklyChangeText(
        trend: WeightTrendDTO?, entries: [WeightLogEntryDTO], system: UnitSystem,
        goalRateKgPerWeek: Double? = nil, goalRateWindowDays: Int? = nil,
        goalRateRange: GoalProgressLogic.PaceRange? = nil,
        withholdsLocalRate: Bool = false, serverRead: String? = nil
    ) -> String? {
        guard let trend, trend.established else { return nil }
        if withholdsLocalRate {
            guard let serverRead, !serverRead.isEmpty else { return nil }
            return GoalProgressLogic.nonBreaking(serverRead)
        }
        if let goalRateRange {
            return GoalProgressLogic.paceRangeText(goalRateRange, system: system)
        }
        if let goalRate = goalRateKgPerWeek, goalRate.isFinite {
            var text = UnitFormat.weightDelta(kgPerWeek: goalRate, system)
            if let window = paceWindowPhrase(days: goalRateWindowDays) { text += " \(window)" }
            if isFasterThanRecommended(deltaPerWeek: goalRate, currentTrendKg: trend.days.last?.trendKg) {
                text += " · faster than recommended"
            }
            return text
        }
        guard let span = daySpan(entries: entries), span >= minimumSpanDaysForWeeklyRate else { return nil }
        guard let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek else { return nil }

        var text = "\(UnitFormat.weightDelta(kgPerWeek: deltaPerWeek, system)) this week"
        if isFasterThanRecommended(deltaPerWeek: deltaPerWeek, currentTrendKg: trend.days.last?.trendKg) {
            text += " · faster than recommended"
        }
        return text
    }

    /// "over 3 weeks" for the server's 21-day pace window, "over 4 weeks" for 28;
    /// whole weeks, rounded, as the coach's prompt names it. `nil` when the server
    /// sent no window (or one under half a week), so the hero says no window
    /// rather than a guessed one.
    static func paceWindowPhrase(days: Int?) -> String? {
        guard let days, days > 0 else { return nil }
        let weeks = Int((Double(days) / 7).rounded())
        guard weeks >= 1 else { return nil }
        return weeks == 1 ? "over 1 week" : "over \(weeks) weeks"
    }

    /// True only for a LOSS (`deltaPerWeek < 0`) whose magnitude exceeds
    /// `fastLossPercentPerWeekThreshold`% of the current trend weight per
    /// week — a gaining rate, or a missing/non-positive trend weight to
    /// compare against, never triggers this.
    static func isFasterThanRecommended(deltaPerWeek: Double, currentTrendKg: Double?) -> Bool {
        guard deltaPerWeek < 0, let currentTrendKg, currentTrendKg > 0 else { return false }
        let percentPerWeek = abs(deltaPerWeek) / currentTrendKg * 100
        return percentPerWeek > fastLossPercentPerWeekThreshold
    }

    /// The weigh-in confirmation toast (§5.5 / dietitian review, 2026-09-23):
    /// "Logged · trend <weight> (<rate>/wk)" once the refreshed trend is
    /// established, else the honest "Logged — trend appears after 3
    /// weigh-ins (<n> of 3)" with the real distinct-day count — never a
    /// raw scale reading leading the message.
    ///
    /// `withholdsLocalRate`: while the server is reading the scale itself
    /// (`GoalProgressLogic.usesServerWeightRead` — an early read, a return after
    /// a gap, a plateau) it withholds a pace on purpose, so the toast says
    /// "Logged · trend 82.1 kg" with no rate of its own. Defaults to `false`
    /// (older server): the message is exactly as before.
    static func weighInToastMessage(
        entries: [WeightLogEntryDTO], trend: WeightTrendDTO?, system: UnitSystem,
        withholdsLocalRate: Bool = false
    ) -> String {
        if withholdsLocalRate, let trend, trend.established, let latest = trend.days.last {
            return "Logged · trend \(UnitFormat.weight(kg: latest.trendKg, system))"
        }
        if let trend, trend.established, let latest = trend.days.last,
           let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek {
            let weight = UnitFormat.weight(kg: latest.trendKg, system)
            let rate = UnitFormat.weightDeltaCompact(kgPerWeek: deltaPerWeek, system)
            return "Logged · trend \(weight) (\(rate))"
        }
        let distinctDays = min(3, Set(entries.map(\.date)).count)
        return "Logged — trend appears after 3 weigh-ins (\(distinctDays) of 3)"
    }

    // MARK: - The server's weight read: one place says it in full

    /// While the server reads the scale itself (early / returning / plateau / moving
    /// again) the FULL read ("Early read — down 0.7 kg on the scale in 7 days") is said in
    /// exactly one place on Today. Its goal line under the hero already says it
    /// (`GoalProgressLogic.goalLineShowsServerRead`), so the hero's rate slot
    /// carries a short complementary line instead of repeating it.
    static let earlyReadHeroText = "Pace settles after 3 weeks"
    static let returningReadHeroText = "Welcome back — weigh in a few more days"
    static let plateauReadHeroText = "Flat for 3 weeks"
    /// Wave 22w: the flat fortnight — two flat weeks after a confirmed loss pace
    /// (`weightRead.plan.flatWeeks` 2). Not yet a plateau: a calm hold, "common, your
    /// plan holds" (the goal line says "Two flat weeks — common; your plan holds").
    static let flatFortnightReadHeroText = "Flat for 2 weeks — common"
    /// Moving again (wave 21): the 14 days after a plateau ends. Never `plateauReadHeroText`
    /// — the plateau is over. The fallback when the payload carries no week plan.
    static let movingAgainReadHeroText = "Moving again after a plateau"

    /// Goal age (calendar days) from which an early read is no longer "the pace
    /// settles after 3 weeks": the goal is past that point and only short of
    /// weigh-ins (`PACE_SETTLE_DAYS` in `lib/weightPace.ts`).
    static let paceSettleDays = 21
    /// The same slot for a goal that is 21+ days old — the server's own wording for
    /// it (`paceWaitClause` in `lib/brain/openerText.ts`), capitalised for the slot.
    static let olderGoalEarlyReadHeroText = "A few more weigh-ins and your pace is back"

    /// The early read's short complement: "Pace settles after 3 weeks" for a young
    /// goal, the older-goal wording once `weightRead.goalAgeDays` says the goal has
    /// run `paceSettleDays` or more. A server that doesn't send the age (`nil`)
    /// keeps `earlyReadHeroText`, exactly as before.
    static func earlyReadSlotText(goalAgeDays: Int?) -> String {
        guard let goalAgeDays, goalAgeDays >= paceSettleDays else { return earlyReadHeroText }
        return olderGoalEarlyReadHeroText
    }

    /// The plateau's short complement: "Flat for 2 weeks — common" for the server's flat
    /// fortnight (`weightRead.plan.flatWeeks == 2`), `plateauReadHeroText` for a plateau
    /// (3) — and for an older server that sends no `flatWeeks` (`nil`), which only ever
    /// named a plateau of three flat weeks, exactly as before.
    static func plateauSlotText(flatWeeks: Int?) -> String {
        flatWeeks == 2 ? flatFortnightReadHeroText : plateauReadHeroText
    }

    /// The text for the hero's rate slot during a server weight read, `nil` when
    /// the server is not reading the scale (the hero then keeps its own rate
    /// logic) or has nothing to say:
    ///  - the goal line below carries the read -> the short complement above;
    ///  - the goal line carries something else (the stale-weigh-in nudge) -> the
    ///    hero carries the full read, so it is still said once.
    static func serverReadSlotText(_ progress: GoalProgressDTO) -> String? {
        guard GoalProgressLogic.usesServerWeightRead(progress), let state = progress.weightRead?.state else { return nil }
        guard GoalProgressLogic.goalLineShowsServerRead(progress) else {
            return GoalProgressLogic.serverWeightRead(progress)
        }
        switch state {
        case .early:       return earlyReadSlotText(goalAgeDays: progress.weightRead?.goalAgeDays)
        case .returning:   return returningReadHeroText
        case .plateau:     return plateauSlotText(flatWeeks: progress.weightRead?.plan?.flatWeeks)
        case .movingAgain: return movingAgainSlotText(plan: progress.weightRead?.plan)
        case .pace, .reached: return nil
        }
    }

    /// The moving-again complement: the week plan's own one action ("Keep doing what
    /// restarted it" — decided once a week, the same line the goal card's reasons end
    /// on) while the plan says moving again, so the goal line's "Moving again — weekly
    /// average down 0.5 kg from the plateau" is not said twice; `movingAgainReadHeroText`
    /// for a payload with no plan (or one whose state or text is missing).
    static func movingAgainSlotText(plan: GoalProgressDTO.WeightRead.Plan?) -> String {
        guard let plan, plan.state == .movingAgain, let action = plan.action else { return movingAgainReadHeroText }
        let text = action.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? movingAgainReadHeroText : text
    }

    // MARK: - Sparkline Y-domain (screenshot-review fix, 2026-09-23)

    /// Swift Charts includes 0 in a numeric y-domain by default, so an
    /// ~82 kg trend rendered without an explicit domain pins to the very
    /// top of the chart's frame with a huge dead zone below it — reading as
    /// a flat divider line, not a chart. Callers pass this to
    /// `.chartYScale(domain:)` instead of leaving it to the default.
    ///
    /// `minSpan` enforces a floor on the visible range so near-flat data
    /// (a stable weight over the window) doesn't get zoomed in so far that
    /// sub-100g noise reads as a dramatic swing — pass e.g. 1.0 kg / 2.0 lb.
    /// A range that already exceeds `minSpan` gets `sparklinePadding`
    /// headroom on each side instead (so the line never touches the frame's
    /// top/bottom edge); a range at or under `minSpan` — including a
    /// perfectly flat series — is centered on the data's midpoint at
    /// exactly `minSpan` wide, with no extra padding on top of that floor.
    /// `nil` for an empty series — callers must hide the chart entirely
    /// rather than pass a meaningless domain.
    static let sparklinePadding = 0.15

    static func sparklineDomain(values: [Double], minSpan: Double) -> ClosedRange<Double>? {
        guard let lo = values.min(), let hi = values.max() else { return nil }
        let span = hi - lo
        let mid = (lo + hi) / 2

        if span >= minSpan {
            let padding = span * sparklinePadding
            return (lo - padding)...(hi + padding)
        }
        return (mid - minSpan / 2)...(mid + minSpan / 2)
    }

    /// A target further than this many (floored) spans from the data would
    /// flatten the sparkline to a straight line if the domain stretched to
    /// include it. Past that the line is drawn at a COMPRESSED position
    /// (`sparklineLayout`) rather than at its true value.
    static let sparklineTargetReach = 3.0

    /// How much extra room (as a fraction of the trend's span) a far target
    /// adds below/above the trend, and where inside it the dashed line sits.
    /// The trend keeps ~62% of the height; the line sits ~9% from the edge.
    static let sparklineCompressedRoom = 0.6
    static let sparklineCompressedLineOffset = 0.45

    /// Whether the dashed target line can be drawn without flattening the trend.
    static func sparklineTargetVisible(values: [Double], minSpan: Double, target: Double?) -> Bool {
        guard let target, let lo = values.min(), let hi = values.max() else { return false }
        let gap = target < lo ? lo - target : (target > hi ? target - hi : 0)
        return gap <= max(hi - lo, minSpan) * sparklineTargetReach
    }

    /// `sparklineDomain` widened to include `target` when it is close enough
    /// to draw (`sparklineTargetVisible`); identical to the plain domain
    /// otherwise.
    static func sparklineDomain(values: [Double], minSpan: Double, target: Double?) -> ClosedRange<Double>? {
        sparklineLayout(values: values, minSpan: minSpan, target: target)?.domain
    }

    /// Everything the sparkline needs to draw: the y-domain, the dashed target
    /// line's y position (`nil` without a target) and whether that position is
    /// compressed (the real target is far outside the trend, so the line is a
    /// marker near the edge, not to scale — the caption flags it with "↓"/"↑").
    struct SparklineLayout: Equatable {
        let domain: ClosedRange<Double>
        let targetLine: Double?
        let targetCompressed: Bool
    }

    static func sparklineLayout(values: [Double], minSpan: Double, target: Double?) -> SparklineLayout? {
        guard let base = sparklineDomain(values: values, minSpan: minSpan) else { return nil }
        guard let target, target.isFinite, let lo = values.min(), let hi = values.max() else {
            return SparklineLayout(domain: base, targetLine: nil, targetCompressed: false)
        }
        if sparklineTargetVisible(values: values, minSpan: minSpan, target: target) {
            let domain = sparklineDomain(values: values + [target], minSpan: minSpan) ?? base
            return SparklineLayout(domain: domain, targetLine: target, targetCompressed: false)
        }
        let span = base.upperBound - base.lowerBound
        if target < lo {
            return SparklineLayout(
                domain: (base.lowerBound - span * sparklineCompressedRoom)...base.upperBound,
                targetLine: base.lowerBound - span * sparklineCompressedLineOffset,
                targetCompressed: true
            )
        }
        guard target > hi, target.isFinite else { return SparklineLayout(domain: base, targetLine: nil, targetCompressed: false) }
        return SparklineLayout(
            domain: base.lowerBound...(base.upperBound + span * sparklineCompressedRoom),
            targetLine: base.upperBound + span * sparklineCompressedLineOffset,
            targetCompressed: true
        )
    }

    /// Arrow before the goal caption: "↓ Goal 76 kg" when the dashed line is
    /// a compressed marker for a target below the trend, "↑" above, "→" when
    /// the line is to scale.
    static func sparklineTargetArrow(layout: SparklineLayout?, targetKg: Double?, lastKg: Double?) -> String {
        guard let layout, layout.targetCompressed, let targetKg, let lastKg else { return "→" }
        return targetKg < lastKg ? "↓" : "↑"
    }

    /// Captions under the sparkline: "Start 83.7 kg" (first point of the
    /// window), "Now 82 kg" (latest trend point) and, when a target weight
    /// exists, "Goal 76 kg" — all in the user's unit. `nil` without points.
    ///
    /// `progressWeight` (wave 21, weight loss): the weight the goal card measures from
    /// (`GoalProgressLogic.progressWeight`), with its label. The line itself is still the
    /// smoothed trend, but the number a weight-loss goal quotes everywhere else (the headline's
    /// "to go", the goal sheet's stat row, the Trends weight card) is the progress weight, so
    /// the middle caption says "This week 82.3 kg" / "Weekly avg 82.3 kg" / "Latest 82.3 kg"
    /// (whichever it truly is) instead of the trend's "Now 82 kg". `nil` (an older server,
    /// other goals) keeps "Now" and the trend, exactly as before.
    static func sparklineCaptions(
        firstKg: Double?, lastKg: Double?, targetKg: Double?, system: UnitSystem,
        progressWeight: GoalProgressLogic.ProgressWeight? = nil
    ) -> (start: String, now: String, target: String?)? {
        guard let firstKg, let lastKg else { return nil }
        let now: String
        if let progressWeight {
            now = "\(progressWeight.label) \(UnitFormat.weight(kg: progressWeight.kg, system))"
        } else {
            now = "Now \(UnitFormat.weight(kg: lastKg, system))"
        }
        return (
            "Start \(UnitFormat.weight(kg: firstKg, system))",
            now,
            targetKg.map { "Goal \(UnitFormat.weight(kg: $0, system))" }
        )
    }

    // MARK: - Weigh-in chip (§5.3)

    struct WeighInChip: Equatable {
        let title: String
        /// True when HealthKit already has a scale reading for today —
        /// tapping the chip logs that value directly (1 tap, `success`)
        /// instead of opening the manual entry sheet.
        let isOneTapConfirm: Bool
        /// The value (kg) a one-tap confirm would log; nil when
        /// `isOneTapConfirm` is false.
        let confirmValueKg: Double?
    }

    /// Builds the weigh-in chip's title and behavior. `healthKitTodayKg`
    /// takes priority (§5.3: "If HealthKit has a scale reading today") —
    /// when present the chip reads "Confirm today's weight" and is a 1-tap
    /// log; otherwise it reads plain "Weigh in" and opens the manual sheet.
    /// Dietitian review (2026-09-23): the chip never leads with a raw scale
    /// number — a bare weigh-in count is not a diagnosis, but a number
    /// printed on the home screen reads like a demand.
    static func weighInChip(healthKitTodayKg: Double?) -> WeighInChip {
        if let hkKg = healthKitTodayKg {
            return WeighInChip(title: "Confirm today's weight", isOneTapConfirm: true, confirmValueKg: hkKg)
        }
        return WeighInChip(title: "Weigh in", isOneTapConfirm: false, confirmValueKg: nil)
    }

    /// The most recent entry's weight (kg) — used to prefill the manual
    /// weigh-in sheet's field. `entries` need not be sorted; picks the max
    /// by `date` (YYYY-MM-DD sorts lexicographically).
    static func lastWeightKg(entries: [WeightLogEntryDTO]) -> Double? {
        entries.max(by: { $0.date < $1.date })?.weight
    }

    // MARK: - Weigh-in sheet plausibility bounds (dietitian review, 2026-09-23)

    static let minPlausibleWeightKg = 25.0
    static let maxPlausibleWeightKg = 350.0

    /// Rejects a typed weigh-in value outside a physiologically plausible
    /// human body-weight range — catches unit mistakes (typing lb into a
    /// metric field, a stray extra digit) before they corrupt the trend.
    static func isPlausibleWeight(kg: Double) -> Bool {
        kg >= minPlausibleWeightKg && kg <= maxPlausibleWeightKg
    }

    /// A typed value more than this % away from the current trend weight
    /// gets a one-line confirm before saving (§5.5-adjacent: logging still
    /// never blocks outright, it just asks once) — catches a fat-finger or
    /// a genuinely surprising reading either way, without second-guessing a
    /// real, if unusual, day-to-day swing.
    static let trendDeltaConfirmThresholdPercent = 3.0

    /// True when `enteredKg` differs from `currentTrendKg` by more than
    /// `trendDeltaConfirmThresholdPercent`%. `nil`/non-positive
    /// `currentTrendKg` (no trend yet to compare against) never triggers a
    /// confirm — there's nothing honest to compare the entry to.
    static func exceedsTrendDeltaThreshold(enteredKg: Double, currentTrendKg: Double?) -> Bool {
        guard let currentTrendKg, currentTrendKg > 0 else { return false }
        let percent = abs(enteredKg - currentTrendKg) / currentTrendKg * 100
        return percent > trendDeltaConfirmThresholdPercent
    }

    // MARK: - New-user first-run checklist gating (§4.2)

    /// True only for a genuinely fresh account — still calibrating and with
    /// no biometric reading of any kind yet. Once any of HRV/sleep/resting-HR
    /// has a value, the real metric tiles return even mid-calibration —
    /// never keep showing the checklist once real data exists.
    static func shouldShowFirstRunChecklist(
        calibrationStatus: String?,
        hasAnyBiometric: Bool
    ) -> Bool {
        calibrationStatus == "calibrating" && !hasAnyBiometric
    }
}
