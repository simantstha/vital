import Foundation
import UIKit
import SwiftUI

/// Backs the notification inbox (`NotificationsView`) and the Today header's
/// bell badge. A singleton (mirroring `AppRouter.shared` /
/// `PushNotificationService.shared`) rather than something threaded through
/// every initializer: the unread count has to stay in sync across the Today
/// bell, the inbox sheet, app-foreground, and a just-arrived push — all
/// independent call sites that would otherwise need the same instance passed
/// down through several view inits.
@MainActor
final class NotificationsViewModel: ObservableObject {
    static let shared = NotificationsViewModel()

    enum LoadState: Equatable {
        case loading
        case loaded
        case failed
    }

    @Published private(set) var items: [NotificationItemDTO] = []
    @Published private(set) var unreadCount: Int = 0
    @Published private(set) var loadState: LoadState = .loading
    @Published private(set) var errorMessage: String?

    private let apiClient: NotificationsAPIProviding
    private var foregroundObserverToken: NSObjectProtocol?

    init(apiClient: NotificationsAPIProviding = APIClient.shared) {
        self.apiClient = apiClient
        // Keeps the bell badge current after a backgrounded app resumes,
        // without the inbox sheet needing to be open — same idiom as
        // `TodayViewModel`'s `willEnterForegroundNotification` observer.
        foregroundObserverToken = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    deinit {
        if let foregroundObserverToken {
            NotificationCenter.default.removeObserver(foregroundObserverToken)
        }
    }

    /// Full load for the inbox screen: shows a skeleton on first load and
    /// surfaces a real failure via `errorMessage` when there is nothing else
    /// on screen to protect.
    func load() async {
        if items.isEmpty {
            withAnimation(Theme.Motion.appear) { loadState = .loading }
        }
        errorMessage = nil
        await fetch(silent: false)
    }

    /// Same fetch, but never flips `loadState` into `.loading` or surfaces a
    /// failure — used for the Today bell's background refresh (load, app
    /// foreground, push arrival) where a spinner or error card would be a
    /// distracting non-sequitur on a screen the user isn't looking at.
    func refresh() async {
        await fetch(silent: true)
    }

    private func fetch(silent: Bool) async {
        do {
            let response = try await apiClient.fetchNotifications(limit: 50)
            items = response.items
            unreadCount = response.unreadCount
            withAnimation(Theme.Motion.appear) { loadState = .loaded }
        } catch {
            // A superseded request (sheet dismissed mid-fetch, tab switch)
            // carries no data and must never be shown as a failure — see
            // `TodayViewModel.loadStateAfterCancellation` for the sibling rule.
            if error.isCancellation {
                if loadState == .loading { loadState = .loaded }
                return
            }
            guard !silent else { return }
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchNotifications")
            withAnimation(Theme.Motion.appear) { loadState = .failed }
        }
    }

    /// Optimistic mark-read: flips `readAt` and decrements the badge locally
    /// so the UI feels instant, then fires the network call best-effort. A
    /// failure is reconciled by the next `load()`/`refresh()` rather than
    /// rolled back or surfaced — the same "eventually consistent" shrug
    /// `PushNotificationService` takes on preference writes. Guarded on the
    /// row already being unread so a double-tap (or marking an
    /// already-read row) can never double-decrement `unreadCount`.
    func markRead(id: String) async {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].readAt == nil else { return }
        items[index].readAt = Date()
        unreadCount = max(0, unreadCount - 1)
        _ = try? await apiClient.markNotificationsRead(ids: [id], all: nil)
    }

    func markAllRead() async {
        guard unreadCount > 0 else { return }
        let now = Date()
        for index in items.indices where items[index].readAt == nil {
            items[index].readAt = now
        }
        unreadCount = 0
        _ = try? await apiClient.markNotificationsRead(ids: nil, all: true)
    }
}
