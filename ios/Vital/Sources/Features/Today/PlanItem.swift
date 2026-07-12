import Foundation

/// A single row in the "Today's plan" timeline: a meal, movement block,
/// rest/sleep block, or (eventually, Phase 8) calendar event — each anchored
/// to a time-of-day and a status.
///
/// Phase 2: persisted server-side via `/api/plan` (see `TodayViewModel`); `id`
/// is the server row's uuid string, so it survives relaunch and round-trips
/// through PATCH/DELETE. Locally-generated ids (calendar items, and the brief
/// Phase-1-derivation fallback for an old backend) use a client-synthesized
/// string — anything unique works since the server never sees those.
struct PlanItem: Identifiable, Equatable {

    enum Status: String, Equatable {
        case done, now, next, later, skipped

        /// Uppercase status word + color key shown next to the title, mirrors
        /// the mock's `PLAN_STATUS` map.
        var label: String {
            switch self {
            case .done:    return "Done"
            case .now:     return "Now"
            case .next:    return "Next"
            case .later:   return "Later"
            case .skipped: return "Skipped"
            }
        }
    }

    enum Source: String, Equatable {
        case coach, user, calendar
    }

    enum Kind: String, Equatable {
        case meal, move, rest, sleep, other
    }

    /// Mutable so an optimistically-added item's client-side temp id can be
    /// swapped for the server-issued id once `POST /api/plan` returns (see
    /// `TodayViewModel.addItem`), without disturbing its position/status.
    var id: String
    var timeMinutes: Int   // minutes from midnight, local time
    var title: String
    var subtitle: String
    var sfSymbol: String
    var status: Status
    var source: Source
    var kind: Kind
    /// Optional inline "Log" affordance shown only while `status == .now`.
    var actionLabel: String?
    /// Meal-kind items keep a reference to the underlying `MealRow` so the
    /// actions sheet can still open `MealDetailView` (suggest/log flow).
    var meal: MealRow?

    init(
        id: String = UUID().uuidString,
        timeMinutes: Int,
        title: String,
        subtitle: String,
        sfSymbol: String,
        status: Status,
        source: Source,
        kind: Kind,
        actionLabel: String? = nil,
        meal: MealRow? = nil
    ) {
        self.id = id
        self.timeMinutes = timeMinutes
        self.title = title
        self.subtitle = subtitle
        self.sfSymbol = sfSymbol
        self.status = status
        self.source = source
        self.kind = kind
        self.actionLabel = actionLabel
        self.meal = meal
    }

    /// "7:30 AM"-style formatted time, matching the mock's `toMins`/12h format.
    var timeLabel: String {
        let hour24 = (timeMinutes / 60) % 24
        let minute = timeMinutes % 60
        let period = hour24 >= 12 ? "PM" : "AM"
        let hour12raw = hour24 % 12
        let hour12 = hour12raw == 0 ? 12 : hour12raw
        return String(format: "%d:%02d %@", hour12, minute, period)
    }
}
