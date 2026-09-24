import Foundation

/// A single "quick log" — the abridged view of `QuickLogResponse` that App
/// Intents/notification code actually needs (dialog text + slot + the id
/// Undo/"Edit in Vital" act on). All-`Sendable` stored properties, so this
/// is `Sendable` without an explicit conformance.
struct QuickLogResult: Equatable, Sendable {
    let id: String
    let name: String
    let kcal: Int
    let slot: String
}

/// Abstraction over `APIClient.quickLogMeal`/`deleteMealLog` for the "quick
/// log" entry points (Siri/App Intents, Shortcuts, the meal-reminder
/// notification's text action) — lets `LogMealIntent`/`UndoQuickLogIntent`
/// and the notification `route(response:)` helper be unit-tested against a
/// fake instead of a live network call.
///
/// `Sendable`: `LogMealIntent`/`UndoQuickLogIntent` store a `(any
/// QuickLogServicing)?` on an `AppIntent`, which App Intents itself requires
/// to be `Sendable`; without this conformance, that stored property is a
/// Swift 5 warning that becomes a hard error under Swift 6 (see
/// `FakeQuickLogService` in `Tests/` for how the test double satisfies it —
/// its mutable recorded-call state lives behind an `NSLock`, since a plain
/// class can't otherwise promise `Sendable`).
protocol QuickLogServicing: Sendable {
    /// Logs `text` as a meal via `POST /api/meals/quick` (source: 'quick' —
    /// never reachable by the coach's `delete_meal`, and never produces a
    /// coach reaction). Throws `APIError.mealNotFound` when no nutrition
    /// candidate matched, `APIError.serverError(401)` when the session is
    /// unauthenticated.
    func quickLog(text: String) async throws -> QuickLogResult
    /// Undoes a quick log via `DELETE /api/meals/log?id=` — the same route
    /// the Diet sheet's manual-correction Undo uses.
    func undo(id: String) async throws
}

/// Live `QuickLogServicing` backed by `APIClient.shared`. On a successful
/// log, it also does what every other meal-logging surface does (see
/// `CoachViewModel.applyMealLogged`, PR #209): tells `ReminderScheduler` the
/// slot was just logged (so its own reminder for that window is cancelled),
/// and posts `.vitalCoachMealLogChanged` so `TodayViewModel`'s fuel strip
/// refreshes without waiting for pull-to-refresh.
///
/// Has no stored properties (calls `APIClient.shared` directly rather than
/// holding an injected instance — nothing actually needs a different one)
/// so it's trivially, automatically `Sendable`; `APIClient` itself holds a
/// reference-typed `AuthRedirectGuard` and so is not `Sendable`, which would
/// otherwise infect this type too.
struct LiveQuickLogService: QuickLogServicing {
    func quickLog(text: String) async throws -> QuickLogResult {
        let response = try await APIClient.shared.quickLogMeal(text: text, tz: TimeZone.current.identifier)
        await MainActor.run {
            ReminderScheduler.shared.mealLogged(slot: DietSlot(rawValue: response.slot))
            NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
        }
        return QuickLogResult(id: response.id, name: response.name, kcal: response.kcal, slot: response.slot)
    }

    func undo(id: String) async throws {
        try await APIClient.shared.deleteMealLog(id: id)
        await MainActor.run {
            NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
        }
    }
}
