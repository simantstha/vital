#if DEBUG
import Foundation

/// DEBUG-only breadcrumb trail for diagnosing the analysis-sheet
/// presentation path (PR #249's "sleep sheet never presents" investigation)
/// from a UI test, without relying on `print()` — `xcbeautify` strips stdout
/// before it reaches the CI log, so a UI test can't see it, but it CAN read
/// an on-screen accessibility label (`LogsView`'s hidden
/// `logs.debugLastAnalysisEvent` `Text`, which observes this singleton).
///
/// Active only when `FixtureMode.isActive` — a real user, a TestFlight
/// build, or the ordinary `VitalTests` run never appends anything here, and
/// the whole file compiles out of Release entirely (guarded by `#if DEBUG`,
/// same as `FixtureMode` itself).
///
/// Deliberately a PLAIN class, not `ObservableObject` — an earlier version
/// published `text` and `LogsView` observed it with `@ObservedObject` so its
/// hidden label would update live. That created an infinite update loop:
/// appending from inside the `.sheet(item:)` content closure mutated a
/// `@Published` value LogsView was observing, which invalidated LogsView,
/// which re-evaluated the sheet content, which appended again — hanging the
/// screenshot run entirely (CI's "Timed out while evaluating UI query").
/// `LogsView`'s hidden `Text` instead re-reads `text` on a timer
/// (`TimelineView(.periodic)`), never observes it — see `LogsView.body`.
@MainActor
final class AnalysisDebugLog {
    static let shared = AnalysisDebugLog()

    /// Append-only; each call adds one more `" | "`-separated event. Kept
    /// short and un-cleared for the life of the process — this is a
    /// throwaway diagnostic aid, not a real log. Plain `var`, not
    /// `@Published` — see the type's doc comment for why.
    private(set) var text = ""

    private init() {}

    func append(_ event: String) {
        guard FixtureMode.isActive else { return }
        text += (text.isEmpty ? "" : " | ") + event
    }
}
#endif
