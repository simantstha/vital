import Foundation

/// Pure decision logic backing the weight_loss hero (docs/ux-spec-v4.md §4.1,
/// §5.3) and the "Next up" row (owner decision, 2026-09-23) — kept free of
/// SwiftUI/APIClient so it's cheap to unit test exhaustively. Every function
/// here takes its inputs explicitly rather than reading a view model.
enum WeightHeroLogic {

    // MARK: - Next up (replaces the full plan list on Today for every goal)

    /// The single row Today shows in place of the full plan timeline: the
    /// next item that isn't already done or skipped, ordered by time of day.
    /// `nil` when every item is done/skipped or the plan is empty — callers
    /// must hide the row entirely rather than show an empty card shell.
    static func nextUpItem(from items: [PlanItem]) -> PlanItem? {
        items
            .filter { $0.status != .done && $0.status != .skipped }
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
    static func weeklyChangeText(trend: WeightTrendDTO?, entries: [WeightLogEntryDTO], system: UnitSystem) -> String? {
        guard let trend, trend.established else { return nil }
        guard let span = daySpan(entries: entries), span >= minimumSpanDaysForWeeklyRate else { return nil }
        guard let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek else { return nil }

        var text = "\(UnitFormat.weightDelta(kgPerWeek: deltaPerWeek, system)) this week"
        if isFasterThanRecommended(deltaPerWeek: deltaPerWeek, currentTrendKg: trend.days.last?.trendKg) {
            text += " · faster than recommended"
        }
        return text
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
    static func weighInToastMessage(entries: [WeightLogEntryDTO], trend: WeightTrendDTO?, system: UnitSystem) -> String {
        if let trend, trend.established, let latest = trend.days.last,
           let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek {
            let weight = UnitFormat.weight(kg: latest.trendKg, system)
            let rate = UnitFormat.weightDeltaCompact(kgPerWeek: deltaPerWeek, system)
            return "Logged · trend \(weight) (\(rate))"
        }
        let distinctDays = min(3, Set(entries.map(\.date)).count)
        return "Logged — trend appears after 3 weigh-ins (\(distinctDays) of 3)"
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
