import Foundation

/// Bridges server-side coach nudges (`pending_nudges`, written by the
/// `schedule_nudge` coach tool) to local one-shot notifications. Never talks
/// to `UNUserNotificationCenter` directly — goes through `NotificationManager`,
/// same as `ReminderScheduler`.
///
/// Flow (D4/D5, PR2 plan): GET /api/nudges → schedule each row as
/// `vital.nudge.<id>` (idempotent replace — a failed ack + refetch just
/// reschedules under the same identifier, never a duplicate) → POST
/// /api/nudges/ack { ids } to set sent_at = now(), meaning "a device fetched
/// this and scheduled it locally" (not "delivered to the user").
///
/// Three buckets per item, by how `scheduledFor` compares to now:
///   - more than 60 min in the past → dead nudge; ack without ever scheduling
///     a notification (nothing useful to show this late).
///   - up to 60 min in the past, or now → fires almost immediately via a
///     `UNTimeIntervalNotificationTrigger` (a calendar trigger for a past
///     date/time never fires).
///   - in the future → a normal calendar trigger, same as ReminderScheduler.
@MainActor
final class NudgeSyncer {

    static let shared = NudgeSyncer()

    private let manager = NotificationManager.shared
    private let api = APIClient.shared

    private let throttleInterval: TimeInterval = 60
    private let deadThreshold: TimeInterval = 60 * 60 // 60 minutes

    private var lastSyncAt: Date?
    private var isSyncing = false

    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        return cal
    }

    private init() {}

    // MARK: - Sync

    func sync() async {
        guard !isSyncing else { return }
        if let last = lastSyncAt, Date().timeIntervalSince(last) < throttleInterval { return }
        // Rows stay pending server-side either way — a future remote-push
        // path can still dispatch them even if this device never has
        // notification permission.
        guard manager.permissionState == .authorized else { return }

        isSyncing = true
        defer { isSyncing = false }
        lastSyncAt = Date()

        guard let response = try? await api.fetchNudges(), !response.items.isEmpty else { return }

        let now = Date()
        var ackIds: [String] = []

        for item in response.items {
            guard let scheduledFor = parseDate(item.scheduledFor) else { continue }
            let secondsUntil = scheduledFor.timeIntervalSince(now)

            if secondsUntil < -deadThreshold {
                // Dead — too stale to be useful. Ack so it stops being refetched.
                ackIds.append(item.id)
                continue
            }

            let id = NotificationIdentifiers.nudge(item.id)
            if secondsUntil <= 0 {
                manager.scheduleImmediate(
                    id: id, title: "Coach", body: item.message,
                    category: NotificationIdentifiers.nudgeCategory, delay: 5
                )
            } else {
                let components = calendar.dateComponents(
                    [.year, .month, .day, .hour, .minute, .second], from: scheduledFor
                )
                manager.schedule(
                    id: id, title: "Coach", body: item.message,
                    category: NotificationIdentifiers.nudgeCategory, dateComponents: components
                )
            }
            ackIds.append(item.id)
        }

        guard !ackIds.isEmpty else { return }
        // Ack failure (network drop, etc.) is silently swallowed — the rows
        // stay sent_at IS NULL server-side, so the next sync (60s later, or
        // next foreground) refetches and reschedules under the same
        // identifiers. That's a no-op replace, not a duplicate notification.
        try? await api.ackNudges(ids: ackIds)
    }

    // MARK: - Date parsing

    /// `scheduledFor` comes from `Date.toISOString()` server-side, which
    /// always includes fractional-second milliseconds — try that first, then
    /// fall back to the no-fraction form for robustness.
    private func parseDate(_ raw: String) -> Date? {
        Self.fractionalFormatter.date(from: raw) ?? Self.plainFormatter.date(from: raw)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plainFormatter = ISO8601DateFormatter()
}
