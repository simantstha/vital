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

    /// "−0.4 kg this week" — `nil` (never a bare "0" or a stale number) until
    /// the trend is established. Prefers the 7-day rate; a fresh trend can
    /// have `established == true` (>= 3 weigh-ins over >= 5 days) while still
    /// lacking a full 7-day window, in which case `weeklyDelta` already
    /// reports a partial-window rate over whatever span exists — still an
    /// honest, non-fabricated number.
    static func weeklyChangeText(trend: WeightTrendDTO?, system: UnitSystem) -> String? {
        guard let trend, trend.established,
              let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek
        else { return nil }
        return "\(UnitFormat.weightDelta(kgPerWeek: deltaPerWeek, system)) this week"
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
    /// when present the chip reads "Confirm <value>" and is a 1-tap log;
    /// otherwise it reads "Weigh in · <last>?" (or plain "Weigh in" with no
    /// prior reading) and opens the manual sheet.
    static func weighInChip(
        lastWeightKg: Double?,
        healthKitTodayKg: Double?,
        system: UnitSystem
    ) -> WeighInChip {
        if let hkKg = healthKitTodayKg {
            return WeighInChip(
                title: "Confirm \(UnitFormat.weight(kg: hkKg, system))",
                isOneTapConfirm: true,
                confirmValueKg: hkKg
            )
        }
        guard let lastWeightKg else {
            return WeighInChip(title: "Weigh in", isOneTapConfirm: false, confirmValueKg: nil)
        }
        return WeighInChip(
            title: "Weigh in · \(UnitFormat.weight(kg: lastWeightKg, system))?",
            isOneTapConfirm: false,
            confirmValueKg: nil
        )
    }

    /// The most recent entry's weight (kg) — used to prefill the manual
    /// weigh-in sheet and the chip's "· <last>?" copy. `entries` need not be
    /// sorted; picks the max by `date` (YYYY-MM-DD sorts lexicographically).
    static func lastWeightKg(entries: [WeightLogEntryDTO]) -> Double? {
        entries.max(by: { $0.date < $1.date })?.weight
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
