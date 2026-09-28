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
@MainActor
final class AnalysisDebugLog: ObservableObject {
    static let shared = AnalysisDebugLog()

    /// Append-only; each call adds one more `" | "`-separated event. Kept
    /// short and un-cleared for the life of the process — this is a
    /// throwaway diagnostic aid, not a real log.
    @Published private(set) var text = ""

    private init() {}

    func append(_ event: String) {
        guard FixtureMode.isActive else { return }
        text += (text.isEmpty ? "" : " | ") + event
    }
}
#endif
