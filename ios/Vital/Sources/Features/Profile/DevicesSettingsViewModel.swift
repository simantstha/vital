import Foundation
import SwiftUI

/// Drives the "Primary device for" section of `DevicesView` (phase 2 "both
/// devices" contract, PR C item 1). Loads `GET /api/devices` and PATCHes one
/// metric at a time when the user picks a new value — optimistic, same
/// revert-on-failure idiom as `MemoryViewModel.saveEdit`/`SleepGoalView`.
@MainActor
final class DevicesSettingsViewModel: ObservableObject {

    @Published var devices: [DeviceStatusDTO] = []
    @Published var primary = DevicesLogic.ResolvedPrimaries(workouts: .apple, sleep: .apple, recovery: .apple)
    @Published var explicit = DevicesLogic.ExplicitPreferences()
    @Published var mergedThisMonth: Int = 0

    @Published var isLoading = true
    @Published var errorMessage: String? = nil
    @Published var toastMessage: String? = nil

    private let apiClient: DevicesAPIProviding
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoFormatterNoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    init(apiClient: DevicesAPIProviding = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Load

    func load() async {
        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil
        do {
            apply(try await apiClient.fetchDevices())
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchDevices", includesAction: false)
        }
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    private func apply(_ response: DevicesResponse) {
        devices = response.devices
        primary = DevicesLogic.ResolvedPrimaries(
            workouts: response.primary.workouts ?? .apple,
            sleep: response.primary.sleep ?? .apple,
            recovery: response.primary.recovery ?? .apple
        )
        explicit = DevicesLogic.ExplicitPreferences(
            workouts: response.explicit.workouts,
            sleep: response.explicit.sleep,
            recovery: response.explicit.recovery
        )
        mergedThisMonth = response.mergedThisMonth
    }

    // MARK: - Device status rows

    var appleConnected: Bool { status(for: .apple)?.connected ?? false }
    var whoopConnected: Bool { status(for: .whoop)?.connected ?? false }

    private func status(for kind: DevicesLogic.DeviceKind) -> DeviceStatusDTO? {
        devices.first { $0.id == kind }
    }

    /// "Synced 4 min ago" / "Not connected" for a device's row.
    func syncStatusLabel(for kind: DevicesLogic.DeviceKind) -> String {
        let device = status(for: kind)
        return DevicesLogic.syncStatusLabel(
            connected: device?.connected ?? false,
            lastSyncAt: (device?.lastSyncAt).flatMap(Self.parseISO)
        )
    }

    /// Freshness of a device's last sync, for the row's status dot.
    func syncFreshness(for kind: DevicesLogic.DeviceKind) -> DevicesLogic.SyncFreshness {
        let device = status(for: kind)
        return DevicesLogic.syncFreshness(
            connected: device?.connected ?? false,
            lastSyncAt: (device?.lastSyncAt).flatMap(Self.parseISO)
        )
    }

    private static func parseISO(_ iso: String) -> Date? {
        Self.isoFormatter.date(from: iso) ?? Self.isoFormatterNoFractional.date(from: iso)
    }

    // MARK: - Primary device rows

    func options(for metric: DevicesLogic.Metric) -> [DevicesLogic.PrimaryOption] {
        DevicesLogic.availableOptions(appleConnected: appleConnected, whoopConnected: whoopConnected)
    }

    func selectedOption(for metric: DevicesLogic.Metric) -> DevicesLogic.PrimaryOption {
        DevicesLogic.selectedOption(explicit: explicit[metric])
    }

    func valueLabel(for metric: DevicesLogic.Metric) -> String {
        DevicesLogic.rowValueLabel(explicit: explicit[metric], resolved: primary[metric])
    }

    /// Applies `option` to `metric` — optimistic: the explicit preference
    /// (and, when a concrete device was picked, the resolved value too)
    /// update immediately, then a single-metric PATCH confirms it. On
    /// failure both revert to their pre-tap values and a toast shows, the
    /// same idiom `MemoryViewModel.saveEdit`/`forget` use.
    func select(_ option: DevicesLogic.PrimaryOption, for metric: DevicesLogic.Metric) {
        let previousExplicit = explicit
        let previousPrimary = primary

        explicit[metric] = DevicesLogic.patchValue(for: option)
        if case .device(let kind) = option {
            setPrimary(kind, for: metric)
        }

        Task {
            do {
                apply(try await apiClient.updateDevicePrimary(metric: metric, value: DevicesLogic.patchValue(for: option)))
            } catch {
                explicit = previousExplicit
                primary = previousPrimary
                if !error.isCancellation { toastMessage = "Couldn't save — try again" }
            }
        }
    }

    private func setPrimary(_ kind: DevicesLogic.DeviceKind, for metric: DevicesLogic.Metric) {
        switch metric {
        case .workouts: primary.workouts = kind
        case .sleep:    primary.sleep = kind
        case .recovery: primary.recovery = kind
        }
    }

    // MARK: - Duplicates

    var duplicatesCaption: String? {
        DevicesLogic.duplicatesCaption(mergedThisMonth: mergedThisMonth)
    }
}
