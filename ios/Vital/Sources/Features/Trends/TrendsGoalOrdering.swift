import Foundation

/// Reorders `TrendsIndexSections.build`'s output to lead with whatever
/// matters most for the user's diet goal (customer-panel finding, 2026-09-23:
/// a weight_loss user's Trends led with generic recovery cards instead of
/// their own weight trend — docs/ux-spec-v4.md §9's screenshot acceptance
/// table requires "Weight card first" for weight_loss).
///
/// Pure reshuffle only — it never changes *which* tiles/sections exist (that
/// stays entirely `TrendsIndexSections`'s job) and never touches
/// `MetricCatalog`. The weight_loss goal's actual weight *card* (the
/// smoothed trend + weekly rate, reusing `WeightHeroLogic`) is a separate
/// concern rendered by `TrendsView` ahead of every section here — this type
/// only orders the metric-group sections that follow it.
enum TrendsGoalOrdering {
    /// The order every goal falls back to — identical to
    /// `TrendsIndexSections`'s own fixed `groupOrder`, duplicated as a literal
    /// (rather than referencing it) so this file stays a self-contained,
    /// easily-reviewed policy table independent of that type's internals.
    static let defaultOrder: [MetricGroup] = [.recovery, .sleep, .activity, .body, .whoop]

    /// Per-goal section priority, before filtering to what's actually
    /// `available`. Keys are the raw `dietBudget.goal` / `/api/diet-goal`
    /// values TrendsViewModel decodes ("weight_loss" | "muscle" |
    /// "endurance" | "general").
    ///
    /// - `weight_loss`: `.activity` (steps/distance/active+basal energy —
    ///   the closest thing MetricCatalog has to "energy/intake") moves ahead
    ///   of recovery, since a weight_loss user's day is organized around the
    ///   calorie budget the weight card already leads with. Recovery/sleep
    ///   stay next, then body/whoop unchanged.
    /// - `muscle`: MetricCatalog has no protein/macro metric at all (those
    ///   are diet-log rows, not `daily_metrics`) and `.activity` mixes
    ///   genuinely training-related signals (`exercise_min`) with ones that
    ///   aren't (`steps`, `basal_energy_kcal`), so there's no honest
    ///   "training metrics" group to promote. Falls through to the
    ///   recovery-first default per the plan's own fallback — recovery state
    ///   is what actually determines whether today's lifting session should
    ///   be pushed hard or backed off.
    /// - `endurance`: recovery/readiness (`.recovery`, `.sleep`) already
    ///   lead in `defaultOrder`, with `.activity` (volume) right after —
    ///   exactly what the plan asks for, so this is the default order too.
    /// - anything else (`general`, empty, or an unrecognized value): kept
    ///   byte-for-byte as `defaultOrder` — never reordered.
    private static let priority: [String: [MetricGroup]] = [
        "weight_loss": [.activity, .recovery, .sleep, .body, .whoop],
    ]

    /// The group order to render sections in for `goal`, restricted to the
    /// groups present in `available` — a group `available` doesn't contain
    /// (no tiles for it at all) is simply skipped, never inserted empty.
    static func groupOrder(for goal: String, available: Set<MetricGroup>) -> [MetricGroup] {
        let wanted = priority[goal] ?? defaultOrder
        let placed = wanted.filter { available.contains($0) }
        // Safety net: if `priority` for a goal is ever edited to omit a
        // group, that group still appears (in its default-order position)
        // rather than silently vanishing from Trends.
        let remaining = defaultOrder.filter { available.contains($0) && !placed.contains($0) }
        return placed + remaining
    }

    /// Reorders an already-built `[TrendsSection]` (from
    /// `TrendsIndexSections.build`) per `goal`. `available` is that build's
    /// output — its section order is what gets reshuffled, its tile content
    /// is untouched.
    static func sections(for goal: String, available: [TrendsSection]) -> [TrendsSection] {
        let availableGroups = Set(available.map(\.group))
        let order = groupOrder(for: goal, available: availableGroups)
        let byGroup = Dictionary(uniqueKeysWithValues: available.map { ($0.group, $0) })
        return order.compactMap { byGroup[$0] }
    }
}
