import Foundation
import EventKit

/// Posts EventKit busy blocks (titles + times only — never locations,
/// attendees, or notes) to `POST /api/ingest/calendar` so the health coach
/// can see the user's upcoming schedule and plan around it. Mirrors
/// `HealthSyncCoordinator`'s shape: a singleton with an `isSyncing` guard and
/// a short debounce window, driven both by explicit `syncNow()` calls (app
/// launch / foreground, see `RootView`) and by `.EKEventStoreChanged` while
/// the app is running — the user adding/editing/deleting an event, or a
/// subscribed calendar syncing in from iCloud.
@MainActor
final class CalendarSyncCoordinator: ObservableObject {
    static let shared = CalendarSyncCoordinator()

    /// True while a sync (explicit or debounced-observer-triggered) is in
    /// flight. Also doubles as the re-entrancy guard — a fire that lands
    /// mid-sync is dropped rather than queued, since the next debounced or
    /// foreground sync will pick up any changes anyway.
    @Published var isSyncing = false
    @Published var lastSyncError: String?
    @Published var lastSyncDate: Date?

    private let calendarProvider: CalendarEventsProvider
    private let apiClient: APIClient
    private let calendar = Calendar.current

    private var debounceTask: Task<Void, Never>?
    private static let debounceNanoseconds: UInt64 = 3_000_000_000 // 3s

    private var changeObserver: NSObjectProtocol?

    // `calendarProvider` defaults to nil rather than `CalendarEventsProvider()`
    // directly: that type is @MainActor-isolated, and default-argument
    // expressions are evaluated at the call site's isolation, not the
    // initializer body's — so constructing it has to happen inside `init`
    // itself, which *is* MainActor-isolated because the class is.
    init(
        calendarProvider: CalendarEventsProvider? = nil,
        apiClient: APIClient = .shared
    ) {
        self.calendarProvider = calendarProvider ?? CalendarEventsProvider()
        self.apiClient = apiClient
        observeCalendarChanges()
    }

    deinit {
        if let changeObserver {
            NotificationCenter.default.removeObserver(changeObserver)
        }
    }

    /// Posts busy blocks for today's local start-of-day through +7 days.
    /// No-ops unless calendar access is already `.fullAccess` — this never
    /// prompts, same convention as `CalendarEventsProvider.fetchTodayPlanItems`
    /// — and while a sync is already in flight.
    func syncNow() async {
        guard calendarProvider.authorizationStatus == .fullAccess else { return }
        guard !isSyncing else { return }

        isSyncing = true
        defer { isSyncing = false }
        lastSyncError = nil

        let windowStart = calendar.startOfDay(for: Date())
        guard let windowEnd = calendar.date(byAdding: .day, value: 7, to: windowStart) else { return }

        let blocks = calendarProvider.fetchBusyBlocks(windowStart: windowStart, windowEnd: windowEnd)
            .map { CalendarBlockDTO(start: $0.start, end: $0.end, allDay: $0.allDay, title: $0.title) }

        do {
            _ = try await apiClient.postCalendarBlocks(
                windowStart: windowStart, windowEnd: windowEnd, blocks: blocks
            )
            lastSyncDate = Date()
        } catch {
            lastSyncError = error.localizedDescription
            print("[CalendarSync] sync failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Change observation

    /// `.EKEventStoreChanged` is a process-wide notification the system
    /// posts whenever Calendar data changes (local edit, iCloud sync, a
    /// subscribed calendar refreshing) as long as an `EKEventStore` is alive
    /// in-process — `calendarProvider`'s store keeps that true for the life
    /// of this singleton.
    private func observeCalendarChanges() {
        changeObserver = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.scheduleDebouncedSync()
            }
        }
    }

    /// Collapses a burst of `.EKEventStoreChanged` fires (e.g. an iCloud
    /// calendar sync touching many events at once) into a single sync,
    /// same debounce convention as `HealthSyncCoordinator`.
    private func scheduleDebouncedSync() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            guard !Task.isCancelled else { return }
            await self?.syncNow()
        }
    }
}
