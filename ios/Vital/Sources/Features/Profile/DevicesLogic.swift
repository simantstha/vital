import Foundation

/// Pure, stateless logic for the Devices settings screen (phase 2 "both
/// devices" contract, PR C item 1; mockup D1). Mirrors the backend's
/// `lib/devicesContext.ts` shapes exactly — see `app/api/devices/route.ts` /
/// `lib/devicesHttp.ts` for the wire contract this talks to. No SwiftUI here;
/// `DevicesView` only turns these into styled rows — see
/// `AnalysisLogic`'s doc comment for the same split in the Analysis screen.
enum DevicesLogic {

    // MARK: - Devices

    enum DeviceKind: String, Codable, Equatable, Hashable, CaseIterable {
        case apple, whoop
    }

    static func deviceName(_ kind: DeviceKind) -> String {
        switch kind {
        case .apple: return "Apple Watch"
        case .whoop: return "WHOOP"
        }
    }

    // MARK: - Metrics

    /// The three families a primary device is chosen for — one row each
    /// under "Primary device for".
    enum Metric: String, CaseIterable {
        case workouts, sleep, recovery

        var title: String {
            switch self {
            case .workouts: return "Workouts"
            case .sleep:    return "Sleep"
            case .recovery: return "Recovery"
            }
        }

        var subtitle: String {
            switch self {
            case .workouts: return "Heart rate, pace, route, calories"
            case .sleep:    return "Duration, stages, sleep need"
            case .recovery: return "HRV, resting heart rate"
            }
        }
    }

    // MARK: - Preferences (mirrors `DevicePreferences` / `ResolvedPrimaryDevices`)

    /// The user's explicit override per metric — `nil` means "automatic".
    /// Mirrors the server's `explicit` field.
    struct ExplicitPreferences: Equatable {
        var workouts: DeviceKind? = nil
        var sleep: DeviceKind? = nil
        var recovery: DeviceKind? = nil

        subscript(metric: Metric) -> DeviceKind? {
            get {
                switch metric {
                case .workouts: return workouts
                case .sleep:    return sleep
                case .recovery: return recovery
                }
            }
            set {
                switch metric {
                case .workouts: workouts = newValue
                case .sleep:    sleep = newValue
                case .recovery: recovery = newValue
                }
            }
        }
    }

    /// The effective, resolved device per metric — mirrors the server's
    /// `primary` field. Always a concrete device, never "automatic": the
    /// server has already applied its own auto-resolution order.
    struct ResolvedPrimaries: Equatable {
        var workouts: DeviceKind
        var sleep: DeviceKind
        var recovery: DeviceKind

        subscript(metric: Metric) -> DeviceKind {
            switch metric {
            case .workouts: return workouts
            case .sleep:    return sleep
            case .recovery: return recovery
            }
        }
    }

    // MARK: - Picker options

    /// One choice in a metric's "Automatic / Apple Watch / WHOOP" picker.
    enum PrimaryOption: Equatable, Hashable {
        case automatic
        case device(DeviceKind)
    }

    /// The options to offer for a metric's picker — Automatic is always
    /// offered; a specific device is offered only when it's connected, so
    /// the user can never explicitly pin a device with no data.
    static func availableOptions(appleConnected: Bool, whoopConnected: Bool) -> [PrimaryOption] {
        var options: [PrimaryOption] = [.automatic]
        if appleConnected { options.append(.device(.apple)) }
        if whoopConnected { options.append(.device(.whoop)) }
        return options
    }

    /// The PATCH body's value for one metric after picking `option` —
    /// `nil` resets that metric to automatic, matching
    /// `lib/devicesContext.ts`'s `parseDevicePatch` contract exactly.
    static func patchValue(for option: PrimaryOption) -> DeviceKind? {
        switch option {
        case .automatic:        return nil
        case .device(let kind): return kind
        }
    }

    /// The `PrimaryOption` a metric's explicit preference maps back to, for
    /// showing the current selection as checked in the picker.
    static func selectedOption(explicit: DeviceKind?) -> PrimaryOption {
        explicit.map(PrimaryOption.device) ?? .automatic
    }

    // MARK: - Row value label

    /// The metric row's trailing value: "Apple Watch" / "WHOOP" when the
    /// user pinned a device explicitly, or "Automatic · <resolved>" when
    /// it's on auto — the resolved device is always shown alongside
    /// "Automatic" so the row never reads as a mystery.
    static func rowValueLabel(explicit: DeviceKind?, resolved: DeviceKind) -> String {
        if let explicit {
            return deviceName(explicit)
        }
        return "Automatic · \(deviceName(resolved))"
    }

    // MARK: - Sync status

    /// "Synced 4 min ago" when connected with a known last-sync time,
    /// "Synced just now" when connected but the sync is less than a minute
    /// old (`RelativeDateTimeFormatter` would otherwise print "in 0
    /// seconds"-style noise for a timestamp fractionally after `now`), or
    /// "Not connected" otherwise. `now`/`formatter` are injected so this is
    /// deterministic under test.
    static func syncStatusLabel(
        connected: Bool,
        lastSyncAt: Date?,
        now: Date = Date(),
        formatter: RelativeDateTimeFormatter = RelativeDateTimeFormatter()
    ) -> String {
        guard connected, let lastSyncAt else { return "Not connected" }
        guard now.timeIntervalSince(lastSyncAt) >= 60 else { return "Synced just now" }
        return "Synced \(formatter.localizedString(for: lastSyncAt, relativeTo: now))"
    }

    // MARK: - Duplicates

    /// "3 merged this month" — `nil` (the caption line omitted entirely)
    /// when nothing was merged, so the card never claims a count of zero.
    static func duplicatesCaption(mergedThisMonth: Int) -> String? {
        guard mergedThisMonth > 0 else { return nil }
        return "\(mergedThisMonth) merged this month"
    }
}
